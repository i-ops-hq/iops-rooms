/**
 * What Cursor keeps that a setup may carry, read from an allowlist of files and keys and from nowhere
 * else (docs/design/TEAM_SETUPS.md §7.3 and §17). Checked on 2026-10-01 against Cursor's CLI,
 * cursor-agent 2026.04.17, by running it, its editor, 3.22.12, by its code, and its documentation.
 *
 * From a project: the rules in `.cursor/rules/` and a legacy `.cursorrules`, the skills in
 * `.cursor/skills/`, the subagents in `.cursor/agents/`, the commands in `.cursor/commands/`, the
 * scripts in `.cursor/hooks/`, and from `.cursor/mcp.json`, `.cursor/hooks.json` and `.cursor/cli.json`
 * the MCP servers, hooks and permission rules. From the person, with `--user`, the same from
 * `~/.cursor`, and from the CLI's `cli-config.json`, wherever the CLI keeps it, the permission rules
 * and nothing else.
 *
 * Never the approval mode or sandbox settings, User Rules (they live inside Cursor's settings, not a
 * file), Cursor's own `skills-cursor`, plugins, an `envFile`, the setup steps in
 * `.cursor/environment.json` and `.cursor/worktrees.json`, or a permission rule that lets any shell
 * command run. `AGENTS.md` and `.agents/skills/`, which Cursor reads too, go with Codex.
 *
 * In its MCP config, the editor fills `${env:NAME}`, `${userHome}` and `${workspaceFolder}`, as its
 * documentation says, but the CLI fills only `${NAME}`: given the others, it passed them on as they
 * were written, a header included. Both fill `${NAME}`, so a setup's servers name variables that way,
 * and their folders as `${PROJECT}` and `${HOME}`, as Claude Code's do.
 */

import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV_NAME, SERVER_NAME, urlRefusal } from "./claude-code.js";
import { exists, linkOnTheWay, readJson, readTextItem, refuse, walk } from "./files.js";
import { checkRun, checkShellLine } from "./pins.js";
import { portableText, realForm } from "./paths.js";
import { lineNaming } from "./prose.js";
import { scanText } from "./secrets.js";

export const CURSOR_CHECKED_AGAINST = "Cursor 2026.04.17 (cursor-agent)";
export const CURSOR = "cursor";
const MAX_FILES = 500;
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Cursor's own folder: `~/.cursor`. */
export const cursorDir = (home = homedir()) => join(home, ".cursor");

/**
 * Where Cursor's CLI keeps `cli-config.json`, found as the CLI finds it: `CURSOR_CONFIG_DIR`, then
 * `$XDG_CONFIG_HOME/cursor`, then `~/.cursor`. Everything else Cursor keeps for a person stays in
 * `~/.cursor`. The label names the variable, never the folder it holds.
 */
export function cursorCliDir(home = homedir(), env = process.env) {
  if (env.CURSOR_CONFIG_DIR?.trim()) return { dir: env.CURSOR_CONFIG_DIR, label: "$CURSOR_CONFIG_DIR/cli-config.json" };
  if (env.XDG_CONFIG_HOME?.trim()) return { dir: join(env.XDG_CONFIG_HOME, "cursor"), label: "$XDG_CONFIG_HOME/cursor/cli-config.json" };
  return { dir: cursorDir(home), label: "~/.cursor/cli-config.json" };
}

/** Hook events whose hook may answer "allow" for the agent: shown as such when adopted. */
export const CURSOR_DECIDING_EVENTS = new Set(["preToolUse", "subagentStart", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "beforeTabFileRead"]);
export const CURSOR_HOOK_KEYS = ["command", "timeout", "matcher", "failClosed"];

/** Programs that run whatever follows them: a Shell rule for one of these allows anything. */
const ALWAYS_WIDE = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd", "eval", "exec", "sudo", "su", "doas", "xargs"]);
/** Programs that run anything when allowed with any arguments: Cursor's `Shell(node)` is node with any. */
const WIDE_ALONE = new Set(["env", "nohup", "time", "nice", "timeout", "watch", "python", "python2", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "osascript", "npx", "bunx", "pnpx", "uvx", "uv", "docker", "npm", "pnpm", "yarn", "go"]);

/**
 * Why a Cursor permission rule would let any shell command run without asking, or "". Cursor reads
 * `Shell(git)` as git with any arguments, so a lone interpreter is as wide as `Shell(*)`.
 */
export function cursorWideRule(rule) {
  const r = String(rule).trim();
  const m = /^Shell\(([\s\S]*)\)$/.exec(r);
  if (!m) return "";
  const inner = m[1].trim();
  if (!inner || /^[*:?\s]*$/.test(inner)) return `${r} lets the agent run any command without asking`;
  if (inner.startsWith("*")) return `${r} matches any command`;
  const words = inner.replace(/(?::\*|\s\*|\*)$/, "").trim().split(/\s+/);
  const first = words[0].split(/[\\/]/).pop();
  if (ALWAYS_WIDE.has(first) || (words.length === 1 && WIDE_ALONE.has(first))) return `${r} runs anything through ${first}`;
  return "";
}

/** A Cursor permission rule as what it allows, for the plan a person approves. */
export function describeCursorRule(list, rule) {
  const r = String(rule);
  const m = /^(Shell|Read|Write|WebFetch|Mcp)\(([\s\S]*)\)$/.exec(r);
  const how = list === "allow" ? "without asking" : "refused";
  if (!m) return how;
  const [, kind, inner] = m;
  if (list === "deny") return { Shell: `never runs "${inner}"`, Read: `never reads ${inner}`, Write: `never writes ${inner}`, WebFetch: `never fetches from ${inner}`, Mcp: `never uses ${inner}` }[kind];
  return { Shell: `runs "${inner}" with any arguments, without asking`, Read: `reads ${inner} without asking`, Write: `writes ${inner} without asking`, WebFetch: `fetches from ${inner} without asking`, Mcp: `uses ${inner} without asking` }[kind];
}

/** Whether a rule names a place on this machine: a home or an absolute path cannot travel. */
function ruleNamesThisMachine(rule, where) {
  if (where.home && (lineNaming(rule, where.home) || lineNaming(rule, realForm(where.home)))) return true;
  const p = portableText(rule, where);
  return !p.ok || p.value !== rule;
}

/** Permission rules a setup may carry: none that lets any command run, names this machine, or holds a secret. */
export function scrubCursorPermissions(perms, { label, where }) {
  const value = {};
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  if (!isObj(perms)) {
    if (perms !== undefined) leave("permissions", "not permissions this version reads");
    return { value, left };
  }
  for (const key of Object.keys(perms)) {
    if (key !== "allow" && key !== "deny") {
      leave(`permissions.${key}`, "not a key this version exports");
      continue;
    }
    if (!Array.isArray(perms[key])) {
      leave(`permissions.${key}`, "not a list of rules");
      continue;
    }
    const kept = [];
    perms[key].forEach((rule, i) => {
      const at = `permissions.${key}[${i}]`;
      if (typeof rule !== "string" || !rule.trim() || rule.length > 500) return leave(at, "not a rule this version reads");
      const wide = key === "allow" ? cursorWideRule(rule) : "";
      if (wide) return leave(at, "would let any command run without asking; a setup cannot give that to someone else", wide);
      if (scanText(rule).length) return leave(at, "holds something that looks like a secret");
      if (ruleNamesThisMachine(rule, where)) return leave(at, "names a path on the exporting machine");
      if (!kept.includes(rule)) kept.push(rule);
    });
    if (kept.length) value[key] = kept;
  }
  return { value, left };
}

/** Cursor's hooks a setup may carry: commands made portable, pinned and free of secrets. */
export function scrubCursorHooks(hooks, { label, where }) {
  const value = {};
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  if (!isObj(hooks)) {
    if (hooks !== undefined) leave("hooks", "not hooks this version reads");
    return { value, left };
  }
  let rooms = false;
  for (const [event, list] of Object.entries(hooks)) {
    if (!/^[A-Za-z]{1,40}$/.test(event) || !Array.isArray(list)) {
      leave("hooks", "an event this version does not read");
      continue;
    }
    const kept = [];
    list.forEach((hook, i) => {
      const at = `hooks.${event}[${i}]`;
      if (!isObj(hook) || typeof hook.command !== "string" || !hook.command.trim()) return leave(at, "not a hook this version reads");
      if (/\bagent-hook\b/.test(hook.command) && /\biops-rooms\b|\bcli\.js\b/.test(hook.command)) {
        rooms = true;
        return undefined;
      }
      const secret = scanText(hook.command)[0];
      if (secret) return leave(at, "holds something that looks like a secret", `it looks like it holds ${secret.kind}`);
      const portable = portableText(hook.command, where);
      if (!portable.ok) return leave(at, "names a path on the exporting machine", portable.why);
      const check = checkShellLine(portable.value);
      if (!check.ok) return leave(at, "runs something a setup cannot carry", check.why);
      const out = { command: portable.value };
      if (typeof hook.timeout === "number" && hook.timeout > 0 && hook.timeout < 86_400) out.timeout = hook.timeout;
      if (typeof hook.matcher === "string" && hook.matcher.length <= 500) {
        if (!portableText(hook.matcher, {}).ok || scanText(hook.matcher).length) return leave(at, "a matcher that names a path or looks like a secret");
        out.matcher = hook.matcher;
      }
      if (typeof hook.failClosed === "boolean") out.failClosed = hook.failClosed;
      for (const k of Object.keys(hook)) if (!CURSOR_HOOK_KEYS.includes(k)) leave(`${at}.${k}`, "not a key this version exports");
      kept.push(out);
      return undefined;
    });
    if (kept.length) value[event] = kept;
  }
  if (rooms) leave("hooks: Rooms' own", "each machine installs its own");
  return { value, left };
}

const ENV_REF = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SCHEME_REF = /^(Bearer|Basic|Token) \$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/;
const upperSnake = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

/**
 * A `${…}` Cursor's CLI does not fill: anything but `${NAME}` or `${NAME:-default}`, and the editor's
 * own names, which the CLI takes for variables nobody set.
 */
export const CURSOR_UNFILLED = /\$\{(?:(?![A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})|(?:workspaceFolder|workspaceFolderBasename|userHome|pathSeparator)\})/;

/** Cursor's names for a variable and for folders, as a setup's: `${env:NAME}` → `${NAME}`, `${workspaceFolder}` → `${PROJECT}`, `${userHome}` → `${HOME}`. */
const fromCursorNames = (text) =>
  String(text).replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}").replace(/\$\{workspaceFolder\}/g, "${PROJECT}").replace(/\$\{userHome\}/g, "${HOME}");

/**
 * Cursor's MCP servers, as a setup may carry them. A local one keeps its command and arguments, made
 * portable and pinned; a remote one its address. Every `env` value and header becomes the name of
 * the variable the adopter sets; `envFile`, a file on this machine, stays out.
 */
export function scrubCursorServers(servers, { label, where }) {
  const value = {};
  const notes = [];
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  if (!isObj(servers)) return { value, notes, left };
  for (const [name, s] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      leave("mcpServers", "a server name this version does not read");
      continue;
    }
    if (!isObj(s)) {
      leave(name, "not a server this version reads");
      continue;
    }
    if (name === "iops-rooms" && Array.isArray(s.args) && s.args.some((a) => /^iops-rooms@/.test(String(a)))) {
      leave(name, "Rooms' own server; rooms mcp install adds it");
      continue;
    }
    const out = {};
    if (typeof s.command === "string" && (s.type === undefined || s.type === "stdio")) {
      if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) {
        leave(name, "a server whose args are not a list of words");
        continue;
      }
      const parts = [s.command, ...(s.args || [])].map(fromCursorNames);
      const secret = parts.map((p) => scanText(p)[0]).find(Boolean);
      if (secret) {
        leave(name, "holds something that looks like a secret", `its command looks like it holds ${secret.kind}`);
        continue;
      }
      if (parts.some((p) => CURSOR_UNFILLED.test(p))) {
        leave(name, "names a ${…} that Cursor's CLI does not fill in");
        continue;
      }
      if (!where.project && parts.some((p) => p.includes("${PROJECT}"))) {
        leave(name, "names whichever project is open; a setup for every project cannot carry that");
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
      out.command = command;
      if (s.args !== undefined) out.args = args;
      if (s.env !== undefined) {
        if (!isObj(s.env) || Object.keys(s.env).some((k) => !ENV_NAME.test(k))) {
          leave(name, "an env this version does not read");
          continue;
        }
        out.env = {};
        for (const [k, v] of Object.entries(s.env)) {
          const from = ENV_REF.exec(String(v))?.[1] || k;
          out.env[k] = { fromEnv: from };
          notes.push(`${name}: env ${k} becomes a placeholder for ${from}; its value stays here`);
        }
      }
      if (s.envFile !== undefined) leave(`${name}.envFile`, "a file on the exporting machine; not exported");
      for (const k of Object.keys(s)) if (!["type", "command", "args", "env", "envFile"].includes(k)) leave(`${name}.${k}`, "not a key this version exports");
    } else if (typeof s.url === "string") {
      const url = fromCursorNames(s.url);
      const why = urlRefusal(url) || (CURSOR_UNFILLED.test(url) || url.includes("${PROJECT}") || url.includes("${HOME}") ? "an address with a ${…} a setup does not carry" : "");
      if (why) {
        leave(name, why);
        continue;
      }
      out.url = url;
      if (s.headers !== undefined) {
        if (!isObj(s.headers) || Object.keys(s.headers).some((h) => !/^[A-Za-z0-9-]{1,100}$/.test(h))) {
          leave(name, "headers this version does not read");
          continue;
        }
        out.headers = {};
        for (const [h, v] of Object.entries(s.headers)) {
          const scheme = SCHEME_REF.exec(String(v));
          const only = ENV_REF.exec(String(v));
          const from = scheme ? scheme[2] : only ? only[1] : `${upperSnake(name)}_${upperSnake(h)}`;
          out.headers[h] = { fromEnv: from, ...(scheme ? { prefix: `${scheme[1]} ` } : {}) };
          notes.push(`${name}: header ${h} becomes a placeholder for ${from}; its value stays here`);
        }
      }
      for (const k of Object.keys(s)) if (!["type", "url", "headers"].includes(k)) leave(`${name}.${k}`, "not a key this version exports");
    } else {
      leave(name, "a kind of server this version does not export");
      continue;
    }
    value[name] = out;
  }
  return { value, notes, left };
}

const labelOf = (scope, rel) => (scope === "user" ? `~/.cursor/${rel}` : rel);

/**
 * Everything Cursor keeps for this project and for this person that a setup could carry, as items a
 * member selects from, and what was left out and why.
 */
export async function readCursor({ project = null, home = homedir(), bundledSkill = null, env = process.env } = {}) {
  const config = cursorDir(home);
  const items = [];
  const left = [];
  let count = 0;
  const places = [];
  if (project) {
    places.push({ scope: "project", root: project, base: ".cursor", files: [["rule", ".cursorrules"]], cli: { root: project, rel: ".cursor/cli.json", label: ".cursor/cli.json" } });
  }
  const cli = cursorCliDir(home, env);
  places.push({ scope: "user", root: config, base: "", files: [], cli: { root: cli.dir, rel: "cli-config.json", label: cli.label } });

  for (const place of places) {
    const { scope, root, base } = place;
    const at = (rel) => (base ? `${base}/${rel}` : rel);
    const where = scope === "project" ? { home, project } : { home, project: null };
    const linked = new Set();
    const noteLink = (rel) => {
      if (linked.has(rel)) return;
      linked.add(rel);
      left.push({ what: labelOf(scope, rel), why: "a link; Rooms does not follow links", local: scope !== "project" });
    };
    const reachable = async (rel) => {
      const link = await linkOnTheWay(root, rel);
      if (link) noteLink(link);
      return !link;
    };
    const files = [];
    for (const [kind, rel] of place.files) {
      if (!(await reachable(rel))) continue;
      if ((await lstat(join(root, rel)).catch(() => null))?.isFile()) files.push({ kind, rel });
    }
    const dirs = [["rule", at("rules"), ".mdc"], ["skill", at("skills"), null], ["agent", at("agents"), ".md"], ["command", at("commands"), ".md"], ["script", at("hooks"), null]];
    for (const [kind, dir, ext] of dirs) {
      if (scope === "user" && kind === "rule") continue;
      if (!(await reachable(dir))) continue;
      const found = [];
      const links = [];
      await walk(root, dir, ext, 0, found, links);
      for (const rel of links) noteLink(rel);
      for (const rel of found) files.push({ kind, rel });
    }
    const read = [];
    for (const f of files) {
      if (++count > MAX_FILES) {
        left.push({ what: labelOf(scope, f.rel), why: `more than ${MAX_FILES} files; this version stops there`, local: scope !== "project" });
        continue;
      }
      const acts = f.kind === "skill" && f.rel.endsWith("/SKILL.md");
      read.push(await readTextItem(root, f.rel, { tool: CURSOR, scope, kind: f.kind, label: labelOf(scope, f.rel), where, acts }));
    }
    // A skill is its folder: one refused file refuses the skill.
    const groups = new Map();
    for (const item of read) {
      if (item.kind !== "skill") continue;
      const rel = item.installTo.slice(scope.length + 1);
      const dir = rel.split("/").slice(0, base ? 3 : 2).join("/");
      groups.set(dir, [...(groups.get(dir) || []), item]);
    }
    for (const [dir, members] of groups) {
      const group = `${labelOf(scope, dir)}/`;
      // The copy `rooms mcp install` made, from this version or an earlier one: only the version it names differs.
      const versionless = (t) => String(t).replace(/\r\n/g, "\n").replace(/iops-rooms@\d+\.\d+\.\d+/g, "iops-rooms@X");
      const own = scope === "project" && dir === ".cursor/skills/rooms" && members.length === 1 && bundledSkill !== null && members[0].content !== undefined && versionless(members[0].content) === versionless(bundledSkill);
      const bad = members.find((m) => m.refused);
      for (const m of members) {
        m.group = group;
        if (own) m.own = true;
        else if (bad && !m.refused) Object.assign(m, { refused: `${group}: ${bad.refused}`, refusedWhy: bad.refusedWhy });
      }
      if (own) left.push({ what: group, why: "Rooms' own skill; rooms mcp install adds it", local: scope !== "project" });
    }
    items.push(...read.filter((i) => !i.own));

    const configItem = async (rel, take, { from = root, label = labelOf(scope, rel) } = {}) => {
      if (from === root ? !(await reachable(rel)) : await linkOnTheWay(from, rel)) {
        if (from !== root) left.push({ what: label, why: "a link; Rooms does not follow links", local: true });
        return;
      }
      const json = await readJson(join(from, rel));
      if (!json.exists) return;
      const item = { tool: CURSOR, scope, kind: "config", label, notes: [], left: [], info: "", refused: "", refusedWhy: "" };
      if (json.error) {
        items.push(refuse(item, `${label} is not valid JSON`, "not valid JSON"));
        return;
      }
      const r = take(json.data, label);
      items.push({ ...item, value: r.value, notes: r.notes || [], left: r.left, info: r.info, empty: !Object.keys(r.value).length });
    };
    await configItem(at("mcp.json"), (data, label) => {
      const r = scrubCursorServers(data.mcpServers, { label, where });
      for (const k of Object.keys(data)) if (k !== "mcpServers") r.left.push({ what: `${label} ${k}`, why: "not a key this version exports" });
      const n = Object.keys(r.value).length;
      return { value: n ? { mcpServers: r.value } : {}, notes: r.notes, left: r.left, info: n ? `${n} server${n === 1 ? "" : "s"}` : "nothing a setup carries" };
    });
    await configItem(at("hooks.json"), (data, label) => {
      const r = scrubCursorHooks(data.hooks, { label, where });
      for (const k of Object.keys(data)) if (k !== "hooks" && k !== "version") r.left.push({ what: `${label} ${k}`, why: "not a key this version exports" });
      const n = Object.values(r.value).reduce((m, l) => m + l.length, 0);
      return { value: n ? { hooks: r.value } : {}, left: r.left, info: n ? `hooks ${n}` : "nothing a setup carries" };
    });
    await configItem(place.cli.rel, (data, label) => {
      const r = scrubCursorPermissions(data.permissions, { label, where });
      for (const k of Object.keys(data)) {
        if (k === "permissions") continue;
        const why = k === "approvalMode" || k === "sandbox" ? "how the agent asks and where it runs stay each person's own" : "not a key this version exports";
        r.left.push({ what: `${label} ${k}`, why });
      }
      const parts = ["allow", "deny"].filter((k) => r.value[k]).map((k) => `${k} ${r.value[k].length}`);
      return { value: parts.length ? { permissions: r.value } : {}, left: r.left, info: parts.join(" · ") || "nothing a setup carries" };
    }, { from: place.cli.root, label: place.cli.label });

    if (scope === "project") {
      for (const [rel, why] of [["AGENTS.md", "read by Cursor too; it goes with Codex (--tool codex)"], [".agents/skills", "read by Cursor too; they go with Codex (--tool codex)"], [".cursor/environment.json", "a background agent's environment; not in this version's setups"], [".cursor/worktrees.json", "runs setup scripts when Cursor makes a worktree; not in this version's setups"]]) {
        if (await exists(join(root, rel))) left.push({ what: rel, why });
      }
    } else {
      for (const [rel, why] of [["skills-cursor", "Cursor's own skills, which come with Cursor"], ["plugins", "plugins are not in this version's setups"]]) {
        if (await exists(join(root, rel))) left.push({ what: `~/.cursor/${rel}/`, why, local: true });
      }
      if (await exists(root)) left.push({ what: "Cursor's User Rules", why: "they live inside Cursor's settings, not in a file, so they cannot be exported", local: true });
    }
  }
  return { items, left, config };
}

/** Read a Cursor JSON config as text, for adopting into: `{ exists, data }`, or why it cannot be. */
export async function readCursorJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { exists: false, data: {} };
  }
  try {
    const data = JSON.parse(text);
    return isObj(data) ? { exists: true, data } : { exists: true, error: "not a JSON object" };
  } catch {
    return { exists: true, error: "not valid JSON" };
  }
}
