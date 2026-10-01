/**
 * What Claude Code keeps that a setup may carry, read from an allowlist of files and keys and from
 * nowhere else (docs/design/TEAM_SETUPS.md §7.3). Checked against Claude Code 2.1.277 and its
 * documentation on 2026-09-30.
 *
 * Project files are offered selected. The person's own, in Claude Code's folder (`~/.claude`, or
 * `CLAUDE_CONFIG_DIR` when it is set) and in `~/.claude.json`, are listed and left out unless asked
 * for. Of `~/.claude.json`, which also holds the account and every project's state, only
 * `mcpServers` is taken. Config is scrubbed by structure: every environment value and header
 * becomes a placeholder. Prose is scanned, and a file that holds a secret, names a folder in this
 * machine's home, or acts in a way a setup may not (hooks in its frontmatter, a permission a setup
 * cannot grant, a command it runs as it loads without an exact version) is refused whole.
 *
 * Nothing here writes or sends anything. Each reason comes in two forms: `detail`, for the member's
 * own preview, may name a path or a package; `why` goes into the committed manifest, so it never
 * repeats a value from the member's files.
 */

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRoomsHook } from "../agent-hooks.js";
import { checkRun, checkShellLine } from "./pins.js";
import { portableText, realForm } from "./paths.js";
import { actingRefusal, frontmatter, injections, lineNaming, toolList } from "./prose.js";
import { modeRefusal, wideRule } from "./permissions.js";
import { neverRead, scanText } from "./secrets.js";

export const CHECKED_AGAINST = "Claude Code 2.1.277";
const MAX_BYTES = 1_000_000;
const MAX_FILES = 500;
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const MODEL = /^[A-Za-z0-9._:[\]-]{1,80}$/;
export const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const HOOK_KEYS = new Set(["type", "command", "args", "timeout", "statusMessage", "async", "shell", "if", "once"]);
const CREDENTIAL_KEYS = new Set(["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh", "otelHeadersHelper"]);

/** Claude Code's folder and its global config file, as Claude Code finds them. */
export function claudeDirs({ env = process.env, home = homedir() } = {}) {
  if (env.CLAUDE_CONFIG_DIR) {
    const config = resolve(String(env.CLAUDE_CONFIG_DIR));
    return { config, globalConfig: join(config, ".claude.json") };
  }
  return { config: join(home, ".claude"), globalConfig: join(home, ".claude.json") };
}

/** Where each kind of file lives, relative to the project or to Claude Code's folder. */
const LAYOUT = {
  project: {
    files: [["instructions", "CLAUDE.md"], ["instructions", ".claude/CLAUDE.md"]],
    dirs: [["rule", ".claude/rules", ".md"], ["agent", ".claude/agents", ".md"], ["command", ".claude/commands", ".md"], ["skill", ".claude/skills", null], ["script", ".claude/hooks", null]],
    settings: ".claude/settings.json",
    elsewhere: [
      [".claude/settings.local.json", "personal to this project on this machine"],
      ["CLAUDE.local.md", "personal to this project on this machine"],
      ["AGENTS.md", "read by Codex too; it goes with Codex, in a later version"],
      [".claude/workflows", "workflows are scripts; not in this version's setups"],
      [".claude/output-styles", "output styles are not in this version's setups"],
    ],
  },
  user: {
    files: [["instructions", "CLAUDE.md"]],
    dirs: [["rule", "rules", ".md"], ["agent", "agents", ".md"], ["command", "commands", ".md"], ["skill", "skills", null], ["script", "hooks", null]],
    settings: "settings.json",
    elsewhere: [
      ["workflows", "workflows are scripts; not in this version's setups"],
      ["output-styles", "output styles are not in this version's setups"],
    ],
  },
};

const labelOf = (scope, rel) => (scope === "user" ? `~/.claude/${rel}` : rel);

function refuse(item, detail, why) {
  return { ...item, refused: detail, refusedWhy: why };
}

async function exists(path) {
  return lstat(path).then(() => true, () => false);
}

/**
 * The first link on the way from `root` down to `rel`, or null. Nothing is read through a link: a
 * linked folder could hold anything, from anywhere. The root itself may be one (a `~/.claude` kept in
 * a dotfiles folder is still the person's own).
 */
async function linkOnTheWay(root, rel) {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const st = await lstat(join(root, sub)).catch(() => null);
    if (!st) return null;
    if (st.isSymbolicLink()) return sub;
  }
  return null;
}

async function walk(root, rel, ext, depth, out, links) {
  let entries = [];
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  // Code-unit order, the same on every machine, so the same files give the same manifest.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const r = `${rel}/${e.name}`;
    if (e.isSymbolicLink()) links.push(r);
    else if (e.isDirectory()) {
      if (depth < 8) await walk(root, r, ext, depth + 1, out, links);
    } else if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(r);
  }
}

/** A few words on what an agent, command or skill is, for the preview. */
function proseInfo(kind, content) {
  const fm = frontmatter(content).keys;
  const parts = [];
  if (fm.model?.text) parts.push(`model ${fm.model.text}`);
  if (kind === "agent" && fm.tools) parts.push(`tools ${toolList(fm.tools).join(", ")}`);
  const allowed = toolList(fm["allowed-tools"]);
  if (allowed.length) parts.push(`runs without asking: ${allowed.join(" ")}`);
  const runs = injections(content).length;
  if (runs) parts.push(`${runs} command${runs === 1 ? "" : "s"} as it loads`);
  return parts.join(" · ");
}

async function readFileItem(root, rel, { scope, kind, where }) {
  const label = labelOf(scope, rel);
  const item = { scope, kind, label, installTo: `${scope}:${rel}`, notes: [], left: [], info: "", refused: "", refusedWhy: "" };
  if (neverRead(rel)) return refuse(item, `${label} is never read: its name says it holds secrets`, "its name says it holds secrets");
  const st = await stat(join(root, rel));
  if (st.size > MAX_BYTES) return refuse(item, `${label} is larger than 1 MB`, "larger than this version exports");
  const buf = await readFile(join(root, rel));
  if (buf.subarray(0, 8000).includes(0)) return refuse(item, `${label} is not text`, "not text");
  const content = buf.toString("utf8").replace(/\r\n/g, "\n");
  const secret = scanText(content)[0];
  if (secret) return refuse(item, `${label} line ${secret.line} looks like ${secret.kind}`, "holds something that looks like a secret");
  const home = lineNaming(content, where.home) || (where.home ? lineNaming(content, realForm(where.home)) : 0);
  if (home) return refuse(item, `${label} line ${home} names a folder in your home: write it as ~/… and export again`, "names a folder on the exporting machine");
  // The project's own folder too, wherever it is: /workspace/web or /tmp/ci/web is not in the home.
  const here = where.project ? lineNaming(content, where.project) || lineNaming(content, realForm(where.project)) : 0;
  if (here) return refuse(item, `${label} line ${here} names this project's folder: write the path relative to the project and export again`, "names a folder on the exporting machine");
  const acts = kind === "agent" || kind === "command" || (kind === "skill" && rel.endsWith("/SKILL.md"));
  if (acts) {
    const no = actingRefusal(content, where);
    if (no) return refuse(item, `${label}: ${no.detail}`, no.why);
    item.info = proseInfo(kind, content);
  }
  const executable = (process.platform !== "win32" && (st.mode & 0o111) !== 0) || content.startsWith("#!");
  return { ...item, content, bytes: buf.length, ...(executable ? { executable: true } : {}) };
}

async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { exists: false };
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? { exists: true, data } : { exists: true, error: true };
  } catch {
    return { exists: true, error: true };
  }
}

// ---- settings --------------------------------------------------------------------------------

/**
 * Whether a permission rule names a place on this machine. Claude Code reads `~/` in a rule but no
 * placeholder, so a rule holding the exporter's home, or an absolute `//path`, cannot be made
 * portable and stays out.
 */
function ruleNamesThisMachine(rule, where) {
  if (/\(\/\/(?!dev\/|tmp\/)/.test(rule)) return true;
  if (where.home && (lineNaming(rule, where.home) || lineNaming(rule, realForm(where.home)))) return true;
  const p = portableText(rule, where);
  return !p.ok || p.value !== rule;
}

/** One hook, made portable and checked, or why it cannot go. */
function scrubHook(hook, where) {
  if (typeof hook.command !== "string" || !hook.command.trim()) return { why: "a hook without a command" };
  if (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((a) => typeof a !== "string"))) {
    return { why: "a hook whose args are not a list of words" };
  }
  const parts = [hook.command, ...(hook.args || [])];
  const strings = [...parts, hook.statusMessage, hook.if].filter((s) => typeof s === "string");
  const secret = strings.map((s) => scanText(s)[0]).find(Boolean);
  if (secret) return { why: "holds something that looks like a secret", detail: `it looks like it holds ${secret.kind}` };
  const portable = parts.map((p) => portableText(p, where));
  const bad = portable.find((p) => !p.ok);
  if (bad) return { why: "names a path on the exporting machine", detail: bad.why };
  // Words shown to the person are not rewritten, so one naming a path here keeps the hook out.
  const shown = [hook.statusMessage, hook.if].filter((s) => typeof s === "string");
  const named = (s) => {
    const p = portableText(s, where);
    return !p.ok || p.value !== s;
  };
  if (shown.some(named)) return { why: "names a path on the exporting machine", detail: "its statusMessage or if names a path" };
  const [command, ...args] = portable.map((p) => p.value);
  const check = hook.args ? checkRun(command, args) : checkShellLine(command);
  if (!check.ok) return { why: "runs something a setup cannot carry", detail: check.why };
  const out = { type: "command", command };
  if (hook.args) out.args = args;
  if (typeof hook.timeout === "number" && hook.timeout > 0) out.timeout = hook.timeout;
  if (typeof hook.statusMessage === "string") out.statusMessage = hook.statusMessage;
  if (typeof hook.async === "boolean") out.async = hook.async;
  if (hook.shell === "bash" || hook.shell === "powershell") out.shell = hook.shell;
  if (typeof hook.if === "string") out.if = hook.if;
  if (typeof hook.once === "boolean") out.once = hook.once;
  const dropped = Object.keys(hook).filter((k) => !HOOK_KEYS.has(k));
  return { value: out, dropped };
}

/**
 * The part of a Claude Code settings file a setup may carry: permission rules, a permission mode
 * that keeps Claude asking, command hooks, the names of environment variables, and the model.
 * Everything else is listed in `left`, by key, with why.
 */
export function scrubSettings(settings, { label, where }) {
  const value = {};
  const notes = [];
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  for (const key of Object.keys(settings)) {
    if (["permissions", "hooks", "env", "model"].includes(key)) continue;
    if (CREDENTIAL_KEYS.has(key)) leave(key, "a command that prints credentials; never exported");
    else if (key === "enabledPlugins" || key === "extraKnownMarketplaces") leave(key, "plugins are not in this version's setups");
    else if (key === "statusLine") leave(key, "runs a command; not in this version's setups");
    else leave(key, "not a key this version exports");
  }

  const perms = settings.permissions;
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    const out = {};
    for (const key of Object.keys(perms)) {
      if (key === "allow" || key === "deny" || key === "ask") {
        if (!Array.isArray(perms[key])) {
          leave(`permissions.${key}`, "not a list of rules");
          continue;
        }
        const kept = [];
        perms[key].forEach((rule, i) => {
          const at = `permissions.${key}[${i}]`;
          if (typeof rule !== "string" || !rule.trim() || rule.length > 500) return leave(at, "not a rule this version reads");
          const wide = key === "allow" ? wideRule(rule) : "";
          if (wide) return leave(at, "would let any command run without asking; a setup cannot give that to someone else", wide);
          if (scanText(rule).length) return leave(at, "holds something that looks like a secret");
          if (ruleNamesThisMachine(rule, where)) return leave(at, "names a path on the exporting machine; write it with ~/ and export again");
          if (!kept.includes(rule)) kept.push(rule);
        });
        if (kept.length) out[key] = kept;
      } else if (key === "defaultMode") {
        const why = modeRefusal(perms.defaultMode);
        if (why) leave("permissions.defaultMode", why);
        else out.defaultMode = perms.defaultMode;
      } else {
        leave(`permissions.${key}`, key === "additionalDirectories" ? "paths on the exporting machine" : "not a key this version exports");
      }
    }
    if (Object.keys(out).length) value.permissions = out;
  } else if (perms !== undefined) {
    leave("permissions", "not permissions this version reads");
  }

  const hooks = settings.hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    const out = {};
    let rooms = false;
    for (const event of Object.keys(hooks)) {
      if (!/^[A-Za-z]{1,40}$/.test(event) || !Array.isArray(hooks[event])) {
        leave("hooks", "an event this version does not read");
        continue;
      }
      const groups = [];
      hooks[event].forEach((group, gi) => {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return leave(`hooks.${event}[${gi}]`, "not hooks this version reads");
        if (group.matcher !== undefined && typeof group.matcher !== "string") return leave(`hooks.${event}[${gi}]`, "a matcher this version does not read");
        const kept = [];
        group.hooks.forEach((hook, hi) => {
          const at = `hooks.${event}[${gi}].hooks[${hi}]`;
          if (isRoomsHook(hook)) {
            rooms = true;
            return;
          }
          if (!hook || typeof hook !== "object") return leave(at, "not a hook this version reads");
          if (hook.type !== "command") return leave(at, `a ${typeof hook.type === "string" && /^[a-z_]{1,20}$/.test(hook.type) ? hook.type : "different"} hook; this version exports command hooks only`);
          const r = scrubHook(hook, where);
          if (!r.value) return leave(at, r.why, r.detail);
          for (const k of r.dropped) leave(`${at}.${k}`, "not a key this version exports");
          kept.push(r.value);
        });
        if (kept.length) groups.push({ ...(group.matcher !== undefined ? { matcher: group.matcher } : {}), hooks: kept });
      });
      if (groups.length) out[event] = groups;
    }
    if (rooms) leave("hooks: Rooms' own", "each machine installs its own, with rooms hooks install");
    if (Object.keys(out).length) value.hooks = out;
  } else if (hooks !== undefined) {
    leave("hooks", "not hooks this version reads");
  }

  if (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)) {
    const env = {};
    for (const name of Object.keys(settings.env)) {
      if (!ENV_NAME.test(name)) {
        leave("env", "a name that is not an environment variable's");
        continue;
      }
      env[name] = { fromEnv: name };
      notes.push(`env ${name}: its value stays here; whoever adopts it sets their own`);
    }
    if (Object.keys(env).length) value.env = env;
  } else if (settings.env !== undefined) {
    leave("env", "not environment variables this version reads");
  }

  if (settings.model !== undefined) {
    if (typeof settings.model === "string" && MODEL.test(settings.model)) value.model = settings.model;
    else leave("model", "not a model name this version reads");
  }
  return { value, notes, left };
}

// ---- MCP servers -----------------------------------------------------------------------------

const VAR_ONLY = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SCHEME_VAR = /^(Bearer|Basic|Token) \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const upperSnake = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

/** Why an address cannot go into a setup, or "": it carries a login, or a parameter that reads like a credential. */
export function urlRefusal(url) {
  let u;
  try {
    u = new URL(url.replace(/\$\{[^}]*\}/g, "x"));
  } catch {
    return "an address this version cannot read";
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return "an address that is not http, https, ws or wss";
  if (u.username || u.password) return "an address with a login in it";
  for (const key of u.searchParams.keys()) {
    if (/token|key|secret|auth|pass|sig|code|credential/i.test(key)) return "an address with what looks like a credential in it";
  }
  return scanText(url).length ? "an address with what looks like a secret in it" : "";
}

/**
 * The MCP servers a setup may carry. A local server keeps its command and arguments, made
 * portable and pinned; a remote one keeps its address. Every `env` value and every header becomes a
 * placeholder naming the variable the adopter sets; the value itself never leaves.
 */
export function scrubMcpServers(servers, { label, where }) {
  const value = {};
  const notes = [];
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { value, notes, left };
  for (const [name, s] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      leave("mcpServers", "a server name this version does not read");
      continue;
    }
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      leave(name, "not a server this version reads");
      continue;
    }
    if (name === "iops-rooms" && Array.isArray(s.args) && s.args.some((a) => /^iops-rooms@/.test(String(a)))) {
      leave(name, "Rooms' own server; rooms mcp install adds it");
      continue;
    }
    const type = s.type ?? "stdio";
    if (type === "stdio") {
      if (typeof s.command !== "string" || !s.command.trim()) {
        leave(name, "a server without a command");
        continue;
      }
      if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) {
        leave(name, "a server whose args are not a list of words");
        continue;
      }
      const parts = [s.command, ...(s.args || [])];
      const secret = parts.map((p) => scanText(p)[0]).find(Boolean);
      if (secret) {
        leave(name, "holds something that looks like a secret", `its command looks like it holds ${secret.kind}`);
        continue;
      }
      const portable = parts.map((p) => portableText(p, where));
      const bad = portable.find((p) => !p.ok);
      if (bad) {
        leave(name, "names a path on the exporting machine", bad.why);
        continue;
      }
      const [command, ...args] = portable.map((p) => p.value);
      const check = checkRun(command, args);
      if (!check.ok) {
        leave(name, "runs something a setup cannot carry", check.why);
        continue;
      }
      const server = { ...(s.type ? { type: "stdio" } : {}), command, ...(s.args ? { args } : {}) };
      if (s.env !== undefined) {
        if (!s.env || typeof s.env !== "object" || Array.isArray(s.env) || Object.keys(s.env).some((k) => !ENV_NAME.test(k))) {
          leave(name, "an env this version does not read");
          continue;
        }
        server.env = {};
        for (const [k, v] of Object.entries(s.env)) {
          const from = VAR_ONLY.exec(String(v))?.[1] || k;
          server.env[k] = { fromEnv: from };
          notes.push(`${name}: env ${k} becomes a placeholder for ${from}; its value stays here`);
        }
      }
      for (const k of Object.keys(s)) if (!["type", "command", "args", "env"].includes(k)) leave(`${name}.${k}`, "not a key this version exports");
      value[name] = server;
    } else if (type === "http" || type === "sse" || type === "ws") {
      const why = typeof s.url === "string" ? urlRefusal(s.url) : "a server without an address";
      if (why) {
        leave(name, why);
        continue;
      }
      const server = { type, url: s.url };
      if (s.headers !== undefined) {
        if (!s.headers || typeof s.headers !== "object" || Array.isArray(s.headers)) {
          leave(name, "headers this version does not read");
          continue;
        }
        server.headers = {};
        for (const [h, v] of Object.entries(s.headers)) {
          const scheme = SCHEME_VAR.exec(String(v));
          const only = VAR_ONLY.exec(String(v));
          const from = scheme ? scheme[2] : only ? only[1] : `${upperSnake(name)}_${upperSnake(h)}`;
          server.headers[h] = { fromEnv: from, ...(scheme ? { prefix: `${scheme[1]} ` } : {}) };
          notes.push(`${name}: header ${h} becomes a placeholder for ${from}; its value stays here`);
        }
      }
      for (const k of Object.keys(s)) if (!["type", "url", "headers"].includes(k)) leave(`${name}.${k}`, "not a key this version exports");
      value[name] = server;
    } else {
      leave(name, "a kind of server this version does not export");
    }
  }
  return { value, notes, left };
}

// ---- the whole reading -------------------------------------------------------------------------

function settingsInfo(v) {
  const parts = [];
  const hooks = Object.values(v.hooks || {}).reduce((n, groups) => n + groups.reduce((m, g) => m + g.hooks.length, 0), 0);
  if (hooks) parts.push(`hooks ${hooks}`);
  for (const k of ["allow", "ask", "deny"]) if (v.permissions?.[k]) parts.push(`${k} ${v.permissions[k].length}`);
  if (v.permissions?.defaultMode) parts.push(`mode ${v.permissions.defaultMode}`);
  if (v.model) parts.push(`model ${v.model}`);
  if (v.env) parts.push(`env ${Object.keys(v.env).length} (names only)`);
  return parts.join(" · ") || "nothing a setup carries";
}

const serversInfo = (v) => {
  const n = Object.keys(v).length;
  return n ? `${n} server${n === 1 ? "" : "s"}` : "nothing a setup carries";
};

/**
 * Everything Claude Code keeps for this project and for this person that a setup could carry, as
 * items the member selects from, and what was left out and why. `bundledSkill` is the text of the
 * skill `rooms mcp install` copies, so an untouched copy of it is left out like Rooms' own hooks.
 */
export async function readClaudeCode({ project = null, env = process.env, home = homedir(), bundledSkill = null } = {}) {
  const { config, globalConfig } = claudeDirs({ env, home });
  const items = [];
  const left = [];
  let count = 0;

  for (const scope of project ? ["project", "user"] : ["user"]) {
    const root = scope === "project" ? project : config;
    const where = scope === "project" ? { home, project } : { home, project: null };
    const layout = LAYOUT[scope];
    const files = [];
    const linked = new Set();
    const noteLink = (rel) => {
      if (linked.has(rel)) return;
      linked.add(rel);
      left.push({ what: labelOf(scope, rel), why: "a link; Rooms does not follow links", local: scope === "user" });
    };
    const reachable = async (rel) => {
      const link = await linkOnTheWay(root, rel);
      if (link) noteLink(link);
      return !link;
    };
    for (const [kind, rel] of layout.files) {
      if (!(await reachable(rel))) continue;
      const st = await lstat(join(root, rel)).catch(() => null);
      if (st?.isFile()) files.push({ kind, rel });
    }
    for (const [kind, dir, ext] of layout.dirs) {
      if (!(await reachable(dir))) continue;
      const found = [];
      const links = [];
      await walk(root, dir, ext, 0, found, links);
      for (const rel of links) noteLink(rel);
      for (const rel of found) {
        if (kind === "skill" && scope === "user" && rel.startsWith("skills/synced/")) continue;
        files.push({ kind, rel });
      }
    }
    if (scope === "user" && (await exists(join(config, "skills", "synced")))) {
      left.push({ what: "~/.claude/skills/synced/", why: "synced from claude.ai; they come with the account", local: true });
    }

    const read = [];
    for (const f of files) {
      if (++count > MAX_FILES) {
        left.push({ what: labelOf(scope, f.rel), why: `more than ${MAX_FILES} files; this version stops there`, local: true });
        continue;
      }
      read.push(await readFileItem(root, f.rel, { scope, kind: f.kind, where }));
    }

    // A skill is its folder: one refused file refuses the skill, since the rest may not work without it.
    const skillDir = (item) => (item.kind === "skill" ? item.installTo.split(":")[1].split("/").slice(0, scope === "project" ? 3 : 2).join("/") : null);
    const groups = new Map();
    for (const item of read) {
      const dir = skillDir(item);
      if (dir) groups.set(dir, [...(groups.get(dir) || []), item]);
    }
    for (const [dir, members] of groups) {
      const group = `${labelOf(scope, dir)}/`;
      const skill = members.find((m) => m.installTo.endsWith(`${dir}/SKILL.md`));
      // The copy `rooms mcp install` made, from this version or an earlier one: only the version it names differs.
      const versionless = (t) => String(t).replace(/\r\n/g, "\n").replace(/iops-rooms@\d+\.\d+\.\d+/g, "iops-rooms@X");
      const own = scope === "project" && dir === ".claude/skills/rooms" && members.length === 1 && skill && bundledSkill !== null && skill.content !== undefined && versionless(skill.content) === versionless(bundledSkill);
      const bad = members.find((m) => m.refused);
      for (const m of members) {
        m.group = group;
        if (own) m.own = true;
        else if (bad && !m.refused) Object.assign(m, { refused: `${group}: ${bad.refused}`, refusedWhy: bad.refusedWhy });
      }
      if (own) left.push({ what: group, why: "Rooms' own skill; rooms mcp install adds it", local: true });
    }
    items.push(...read.filter((i) => !i.own));

    const settings = (await reachable(layout.settings)) ? await readJson(join(root, layout.settings)) : { exists: false };
    if (settings.exists) {
      const label = labelOf(scope, layout.settings);
      const item = { scope, kind: "settings", label, notes: [], left: [], info: "", refused: "", refusedWhy: "" };
      if (settings.error) items.push(refuse(item, `${label} is not valid JSON`, "not valid JSON"));
      else {
        const r = scrubSettings(settings.data, { label, where });
        items.push({ ...item, value: r.value, notes: r.notes, left: r.left, info: settingsInfo(r.value), empty: !Object.keys(r.value).length });
      }
    }

    const mcpPath = scope === "project" ? join(project, ".mcp.json") : globalConfig;
    const mcpLink = (await lstat(mcpPath).catch(() => null))?.isSymbolicLink();
    if (mcpLink) left.push({ what: scope === "project" ? ".mcp.json" : "~/.claude.json", why: "a link; Rooms does not follow links", local: scope === "user" });
    const mcp = mcpLink ? { exists: false } : await readJson(mcpPath);
    if (mcp.exists) {
      const label = scope === "project" ? ".mcp.json" : "~/.claude.json";
      const item = { scope, kind: "mcp", label, notes: [], left: [], info: "", refused: "", refusedWhy: "" };
      if (mcp.error) items.push(refuse(item, `${label} is not valid JSON`, "not valid JSON"));
      else if (mcp.data.mcpServers !== undefined) {
        const r = scrubMcpServers(mcp.data.mcpServers, { label, where });
        items.push({ ...item, value: r.value, notes: r.notes, left: r.left, info: serversInfo(r.value), empty: !Object.keys(r.value).length });
      }
    }

    for (const [rel, why] of layout.elsewhere) {
      if (await exists(join(root, rel))) left.push({ what: labelOf(scope, rel), why, local: scope === "user" });
    }
  }
  return { items, left, config, globalConfig };
}

/**
 * Which items an export takes: the project's by default, the person's own with `user`, then `only`
 * and `skip`, each a name from the preview or a folder ending in `/`. A name that matches nothing is
 * an error, so a mistyped `--skip` cannot quietly export what it meant to leave out.
 */
export function selectItems(items, { user = false, only = [], skip = [] } = {}) {
  const matches = (item, pattern) =>
    item.label === pattern || (pattern.endsWith("/") && (item.label.startsWith(pattern) || (item.group || "").startsWith(pattern)));
  for (const pattern of [...only, ...skip]) {
    if (!items.some((i) => matches(i, pattern))) throw new Error(`Nothing here is called ${pattern}; the list shows every name, and a folder ends in /.`);
  }
  return items.map((item) => {
    let on = only.length ? only.some((p) => matches(item, p)) : item.scope === "project" || user;
    if (skip.some((p) => matches(item, p))) on = false;
    // `meant`: what the member asked for, so a refused file they meant to share is listed as left out.
    return { ...item, meant: on, selected: on && !item.refused && !item.empty };
  });
}
