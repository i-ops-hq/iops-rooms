/**
 * A setup's manifest, `setup.json`, format 1 (docs/format/SETUP.md; docs/design/TEAM_SETUPS.md §7).
 *
 * Export builds it from what the member selected. Everything that reads one back (show, adopt, and
 * later `team check`) checks it with the rules export applied, because a setup in the team room may
 * have been edited since, by hand or in GitHub's editor. What a setup runs (`runs`) and needs
 * (`requires`) are derived from the rest and never written by hand: a reader derives both again and
 * refuses a setup whose lists differ, so the list a reviewer reads cannot leave anything out.
 */

import { createHash } from "node:crypto";
import { CHECKED_AGAINST, ENV_NAME, HOOK_KEYS, MODEL, SERVER_NAME, urlRefusal } from "./claude-code.js";
import { checkRun, checkShellLine } from "./pins.js";
import { portableText } from "./paths.js";
import { actingRefusal, injections } from "./prose.js";
import { modeRefusal, wideRule } from "./permissions.js";
import { scanText } from "./secrets.js";
import { mdText } from "../team-board.js";

export const SETUP_FORMAT = "iops-rooms/setup";
export const SETUP_FORMAT_VERSION = 1;
export const TOOL = "claude-code";
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const KINDS = new Set(["instructions", "rule", "agent", "command", "skill", "script"]);
const SCRIPT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|lua)$/i;

export const normalizeText = (text) => String(text).replace(/\r\n/g, "\n");

/** The hash a setup records for a file: of its text with CRLF line ends read as LF, so checkouts agree. */
export const sha256Text = (text) => createHash("sha256").update(normalizeText(text), "utf8").digest("hex");

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- where a setup may write -------------------------------------------------------------------

/** The only places a setup's files may go, by scope and kind; nothing else is ever written. */
const PLACES = {
  project: {
    instructions: /^(?:CLAUDE\.md|\.claude\/CLAUDE\.md)$/,
    rule: /^\.claude\/rules\/.+\.md$/,
    agent: /^\.claude\/agents\/.+\.md$/,
    command: /^\.claude\/commands\/.+\.md$/,
    skill: /^\.claude\/skills\/[^/]+\/.+$/,
    script: /^\.claude\/hooks\/.+$/,
  },
  user: {
    instructions: /^CLAUDE\.md$/,
    rule: /^rules\/.+\.md$/,
    agent: /^agents\/.+\.md$/,
    command: /^commands\/.+\.md$/,
    skill: /^skills\/[^/]+\/.+$/,
    script: /^hooks\/.+$/,
  },
};

/** A name every system can hold: no `.` or `..`, nothing Windows refuses, no control character. */
const SEGMENT = /^(?!\.{1,2}$)[^\\/:*?"<>|\x00-\x1f]{1,120}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** `project:.claude/agents/r.md` as `{ scope, rel }`, if it is a place a file of that kind may go. */
export function installPlace(installTo, kind) {
  const m = /^(project|user):(.+)$/.exec(String(installTo));
  if (!m || !PLACES[m[1]][kind]) return null;
  const [, scope, rel] = m;
  const segments = rel.split("/");
  if (rel.length > 400 || !segments.every((s) => SEGMENT.test(s) && !RESERVED.test(s) && !/[. ]$/.test(s))) return null;
  if (segments.some((s) => s.toLowerCase() === ".git")) return null;
  return PLACES[scope][kind].test(rel) ? { scope, rel } : null;
}

/** Where a file sits inside the setup's folder: derived from where it goes, so the two cannot disagree. */
export function filePathFor(installTo) {
  const [, scope, rel] = /^(project|user):(.+)$/.exec(String(installTo));
  return `files/${TOOL}/${scope}/${rel}`;
}

const acts = (f) => f.kind === "agent" || f.kind === "command" || (f.kind === "skill" && f.installTo.endsWith("/SKILL.md"));
const isScript = (f, text) => f.kind === "script" || (f.kind === "skill" && (f.executable === true || SCRIPT.test(f.installTo) || String(text).startsWith("#!")));
const scopeOf = (installTo) => String(installTo).split(":")[0];

// ---- what it runs, and what it needs ------------------------------------------------------------

/**
 * Everything the setup would run on an adopter's machine: its hooks, its MCP servers, the commands
 * its skills and commands run as they load, and the scripts it ships. In a fixed order, so the same
 * setup always derives the same list.
 */
export function deriveRuns(manifest, files) {
  const cc = manifest.tools?.[TOOL] || {};
  const runs = [];
  for (const scope of ["project", "user"]) {
    const part = cc[scope] || {};
    const hooks = part.settings?.hooks || {};
    for (const event of Object.keys(hooks).sort()) {
      for (const group of hooks[event]) {
        for (const hook of group.hooks) {
          const check = hook.args ? checkRun(hook.command, hook.args) : checkShellLine(hook.command);
          const pinned = [check.pinned].flat().filter(Boolean);
          runs.push({
            tool: TOOL, scope, surface: "hook", event,
            ...(group.matcher ? { matcher: group.matcher } : {}),
            command: [hook.command, ...(hook.args || [])].join(" "),
            ...(pinned.length ? { pinned } : {}),
          });
        }
      }
    }
    const servers = part.mcpServers || {};
    for (const name of Object.keys(servers).sort()) {
      const s = servers[name];
      if (s.url) {
        runs.push({ tool: TOOL, scope, surface: "mcp", name, url: s.url });
        continue;
      }
      const check = checkRun(s.command, s.args || []);
      runs.push({ tool: TOOL, scope, surface: "mcp", name, command: [s.command, ...(s.args || [])].join(" "), ...(check.pinned ? { pinned: [check.pinned] } : {}) });
    }
  }
  const listed = [...(cc.files || [])].sort((a, b) => (a.installTo < b.installTo ? -1 : a.installTo > b.installTo ? 1 : 0));
  for (const f of listed) {
    const text = files.get(f.path);
    if (text == null) continue;
    if (acts(f)) {
      for (const inj of injections(text)) {
        const pinned = checkShellLine(inj.command).pinned || [];
        runs.push({ tool: TOOL, scope: scopeOf(f.installTo), surface: "loads", file: f.installTo, command: inj.command, ...(pinned.length ? { pinned } : {}) });
      }
    }
    if (isScript(f, text)) runs.push({ tool: TOOL, scope: scopeOf(f.installTo), surface: "script", file: f.installTo });
  }
  return runs;
}

const PLACEHOLDER_VARS = new Set(["HOME", "PROJECT"]);

/** What an adopter must have: environment variables they set themselves, and programs on their PATH. */
export function deriveRequires(manifest, files) {
  const cc = manifest.tools?.[TOOL] || {};
  const env = new Map();
  const programs = new Map();
  const add = (map, key, what) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(what);
  };
  for (const scope of ["project", "user"]) {
    const part = cc[scope] || {};
    for (const v of Object.values(part.settings?.env || {})) add(env, v.fromEnv, "settings env");
    for (const [event, groups] of Object.entries(part.settings?.hooks || {})) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const needs = h.args ? [h.command].filter((c) => /^[A-Za-z][\w.+-]*$/.test(c)) : checkShellLine(h.command).needs || [];
          for (const p of needs) add(programs, p, `hook ${event}`);
        }
      }
    }
    for (const [name, s] of Object.entries(part.mcpServers || {})) {
      for (const v of Object.values(s.env || {})) add(env, v.fromEnv, `mcp ${name}`);
      for (const v of Object.values(s.headers || {})) add(env, v.fromEnv, `mcp ${name}`);
      for (const text of [s.command, ...(s.args || []), s.url].filter((t) => typeof t === "string")) {
        for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) if (!PLACEHOLDER_VARS.has(m[1])) add(env, m[1], `mcp ${name}`);
      }
      if (typeof s.command === "string" && /^[A-Za-z][\w.+-]*$/.test(s.command)) add(programs, s.command, `mcp ${name}`);
    }
  }
  for (const f of cc.files || []) {
    const text = files.get(f.path);
    if (text == null || !acts(f)) continue;
    const label = f.installTo.replace(/^project:/, "").replace(/^user:/, "~/.claude/");
    for (const inj of injections(text)) for (const p of checkShellLine(inj.command).needs || []) add(programs, p, label);
  }
  const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    ...sorted(env).map(([k, s]) => ({ env: k, for: [...s].sort().join(", ") })),
    ...sorted(programs).map(([k, s]) => ({ program: k, for: [...s].sort().join(", ") })),
  ];
}

// ---- building one --------------------------------------------------------------------------------

/** A declared monthly cost, `"20"`, `"$100 Claude Max 5x"`: shown as declared, never measured. */
export function parseCost(text) {
  const m = /^\s*\$?(\d{1,6}(?:\.\d{1,2})?)\s*(.*)$/.exec(String(text ?? ""));
  if (!m) throw new Error(`--cost takes US dollars a month and what they pay for, as "100 Claude Max 5x", not "${text}"`);
  const what = m[2].trim();
  if (what.length > 120) throw new Error("--cost: what it pays for is 120 characters at most");
  return { usdPerMonth: Number(m[1]), ...(what ? { what } : {}) };
}

const validCost = (c) =>
  isObj(c) &&
  Object.keys(c).every((k) => k === "usdPerMonth" || k === "what") &&
  typeof c.usdPerMonth === "number" && Number.isFinite(c.usdPerMonth) && c.usdPerMonth >= 0 && c.usdPerMonth <= 1_000_000 &&
  (c.what === undefined || (typeof c.what === "string" && c.what.length <= 120));

/**
 * The manifest and the files for the items a member selected. `notExported` is what the member
 * should know is missing: the parts of selected files left out, and selected files refused, each
 * with a reason that repeats no value from their files.
 */
export function buildManifest({ role, name, owner, summary, cost, version, items, notExported = [] }) {
  const cc = { checkedAgainst: CHECKED_AGAINST, files: [] };
  const files = new Map();
  for (const item of items.filter((i) => i.selected)) {
    if (item.kind === "settings" || item.kind === "mcp") {
      cc[item.scope] ||= {};
      cc[item.scope][item.kind === "settings" ? "settings" : "mcpServers"] = item.value;
      continue;
    }
    const path = filePathFor(item.installTo);
    files.set(path, normalizeText(item.content));
    cc.files.push({ kind: item.kind, path, installTo: item.installTo, sha256: sha256Text(item.content), ...(item.executable ? { executable: true } : {}) });
  }
  cc.files.sort((a, b) => (a.installTo < b.installTo ? -1 : a.installTo > b.installTo ? 1 : 0));
  for (const scope of ["project", "user"]) if (cc[scope]) cc[scope] = { ...(cc[scope].settings ? { settings: cc[scope].settings } : {}), ...(cc[scope].mcpServers ? { mcpServers: cc[scope].mcpServers } : {}) };
  const manifest = {
    format: SETUP_FORMAT,
    formatVersion: SETUP_FORMAT_VERSION,
    name,
    role,
    owner,
    ...(summary ? { summary } : {}),
    ...(cost ? { cost } : {}),
    exportedWith: `iops-rooms@${version}`,
    tools: { [TOOL]: cc },
  };
  manifest.runs = deriveRuns(manifest, files);
  manifest.requires = deriveRequires(manifest, files);
  manifest.notExported = notExported.map(({ what, why }) => ({ what, why }));
  return { manifest, files };
}

// ---- checking one --------------------------------------------------------------------------------

function checkStrings(strings, label, no) {
  for (const s of strings) {
    const secret = scanText(s)[0];
    if (secret) return no(`${label} looks like it holds ${secret.kind}`);
    if (!portableText(s, {}).ok) return no(`${label} names a path on someone's machine`);
  }
  return undefined;
}

function checkSettings(settings, scope, no) {
  const label = `${scope} settings`;
  if (!isObj(settings)) return no(`${label} are not an object`);
  for (const k of Object.keys(settings)) if (!["permissions", "hooks", "env", "model"].includes(k)) no(`${label} have ${k}, which a setup may not carry`);
  const p = settings.permissions;
  if (p !== undefined) {
    if (!isObj(p)) no(`${label}: permissions are not an object`);
    else {
      for (const k of Object.keys(p)) if (!["allow", "ask", "deny", "defaultMode"].includes(k)) no(`${label}: permissions.${k} is not something a setup may carry`);
      for (const list of ["allow", "ask", "deny"]) {
        if (p[list] === undefined) continue;
        if (!Array.isArray(p[list]) || p[list].length > 500 || p[list].some((r) => typeof r !== "string" || !r || r.length > 500)) {
          no(`${label}: permissions.${list} is not a list of rules`);
          continue;
        }
        for (const rule of p[list]) {
          const wide = list === "allow" ? wideRule(rule) : "";
          if (wide) no(`${label}: ${wide}, which a setup cannot give anyone`);
          if (/\(\/\/(?!dev\/|tmp\/)/.test(rule)) no(`${label}: a ${list} rule names a path on someone's machine`);
          if (scanText(rule).length) no(`${label}: a ${list} rule looks like it holds a secret`);
        }
      }
      const mode = modeRefusal(p.defaultMode);
      if (mode) no(`${label}: ${mode}`);
    }
  }
  const hooks = settings.hooks;
  if (hooks !== undefined) {
    if (!isObj(hooks)) return no(`${label}: hooks are not an object`);
    for (const [event, groups] of Object.entries(hooks)) {
      if (!/^[A-Za-z]{1,40}$/.test(event) || !Array.isArray(groups) || groups.length > 50) {
        no(`${label}: hooks.${event.slice(0, 40)} is not a list of hook groups`);
        continue;
      }
      for (const g of groups) {
        if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.length || g.hooks.length > 50 || Object.keys(g).some((k) => k !== "matcher" && k !== "hooks")) {
          no(`${label}: a ${event} hook group this version does not read`);
          continue;
        }
        if (g.matcher !== undefined && (typeof g.matcher !== "string" || g.matcher.length > 500)) no(`${label}: a ${event} matcher this version does not read`);
        for (const h of g.hooks) {
          if (!isObj(h) || h.type !== "command" || typeof h.command !== "string" || !h.command.trim() || h.command.length > 4000 || Object.keys(h).some((k) => !HOOK_KEYS.has(k))) {
            no(`${label}: a ${event} hook this version does not read; a setup carries command hooks only`);
            continue;
          }
          if (h.args !== undefined && (!Array.isArray(h.args) || h.args.some((a) => typeof a !== "string"))) {
            no(`${label}: a ${event} hook's args are not a list of words`);
            continue;
          }
          if (h.timeout !== undefined && !(typeof h.timeout === "number" && h.timeout > 0)) no(`${label}: a ${event} hook's timeout is not a number`);
          if (h.shell !== undefined && h.shell !== "bash" && h.shell !== "powershell") no(`${label}: a ${event} hook names a shell this version does not know`);
          for (const k of ["async", "once"]) if (h[k] !== undefined && typeof h[k] !== "boolean") no(`${label}: a ${event} hook's ${k} is not true or false`);
          for (const k of ["statusMessage", "if"]) if (h[k] !== undefined && typeof h[k] !== "string") no(`${label}: a ${event} hook's ${k} is not text`);
          const parts = [h.command, ...(h.args || [])];
          checkStrings([...parts, h.statusMessage, h.if].filter((s) => typeof s === "string"), `${label}: a ${event} hook`, no);
          if (scope === "user" && parts.some((s) => s.includes("${PROJECT}"))) no(`${label}: a ${event} hook for every project names one project`);
          const check = h.args ? checkRun(h.command, h.args) : checkShellLine(h.command);
          if (!check.ok) no(`${label}: a ${event} hook: ${check.why}`);
        }
      }
    }
  }
  if (settings.env !== undefined) {
    if (!isObj(settings.env)) no(`${label}: env is not an object`);
    else {
      for (const [k, v] of Object.entries(settings.env)) {
        if (!ENV_NAME.test(k) || !isObj(v) || Object.keys(v).join() !== "fromEnv" || !ENV_NAME.test(v.fromEnv || "")) {
          no(`${label}: env holds a value, where a setup may only name a variable`);
          break;
        }
      }
    }
  }
  if (settings.model !== undefined && !(typeof settings.model === "string" && MODEL.test(settings.model))) no(`${label}: model is not a model name`);
  return undefined;
}

function checkServers(servers, scope, no) {
  const label = `${scope} MCP servers`;
  if (!isObj(servers) || Object.keys(servers).length > 50) return no(`${label} are not a set of at most 50 servers`);
  for (const [name, s] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name) || !isObj(s)) {
      no(`${label}: a server this version does not read`);
      continue;
    }
    const at = `${label}: ${name}`;
    const type = s.type ?? "stdio";
    if (type === "stdio") {
      if (Object.keys(s).some((k) => !["type", "command", "args", "env"].includes(k))) no(`${at} has a key this version does not read`);
      if (typeof s.command !== "string" || !s.command.trim()) {
        no(`${at} has no command`);
        continue;
      }
      if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) {
        no(`${at}'s args are not a list of words`);
        continue;
      }
      checkStrings([s.command, ...(s.args || [])], at, no);
      if (scope === "user" && [s.command, ...(s.args || [])].some((a) => a.includes("${PROJECT}"))) no(`${at} is for every project but names one project`);
      const check = checkRun(s.command, s.args || []);
      if (!check.ok) no(`${at}: ${check.why}`);
      if (s.env !== undefined) {
        if (!isObj(s.env) || Object.entries(s.env).some(([k, v]) => !ENV_NAME.test(k) || !isObj(v) || Object.keys(v).join() !== "fromEnv" || !ENV_NAME.test(v.fromEnv || ""))) {
          no(`${at}'s env holds a value, where a setup may only name a variable`);
        }
      }
    } else if (type === "http" || type === "sse" || type === "ws") {
      if (Object.keys(s).some((k) => !["type", "url", "headers"].includes(k))) no(`${at} has a key this version does not read`);
      const why = typeof s.url === "string" ? urlRefusal(s.url) : "no address";
      if (why) no(`${at}: ${why}`);
      if (s.headers !== undefined) {
        const good = (v) => isObj(v) && ENV_NAME.test(v.fromEnv || "") && Object.keys(v).every((k) => k === "fromEnv" || k === "prefix") && (v.prefix === undefined || ["Bearer ", "Basic ", "Token "].includes(v.prefix));
        if (!isObj(s.headers) || Object.entries(s.headers).some(([h, v]) => !/^[A-Za-z0-9-]{1,100}$/.test(h) || !good(v))) {
          no(`${at}'s headers hold a value, where a setup may only name a variable`);
        }
      }
    } else {
      no(`${at} is a kind of server this version does not read`);
    }
  }
  return undefined;
}

/**
 * Everything wrong with a setup, as sentences; empty when it may be shown and adopted. `files` maps
 * each listed path to its text, read from git at the setup's commit. Every rule export applies is
 * applied again here, since the setup may have been edited in the team room since.
 */
export function checkSetup(manifest, files, { role, name } = {}) {
  const problems = [];
  const no = (s) => {
    problems.push(s);
  };
  if (!isObj(manifest) || manifest.format !== SETUP_FORMAT) return ["setup.json is not a Rooms setup"];
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) return ["setup.json has no format version this version reads"];
  if (manifest.formatVersion > SETUP_FORMAT_VERSION) {
    return [`setup.json is format version ${manifest.formatVersion}, newer than this version of Rooms reads (${SETUP_FORMAT_VERSION}); update Rooms to read it`];
  }
  if (!SLUG.test(manifest.role || "") || !SLUG.test(manifest.name || "")) no("its role or name is not a plain lowercase name");
  else if (role && name && (manifest.role !== role || manifest.name !== name)) no(`it says it is ${manifest.role}/${manifest.name}, but it is filed as ${role}/${name}`);
  if (!LOGIN.test(manifest.owner || "")) no("its owner is not a GitHub login");
  if (manifest.summary !== undefined && !(typeof manifest.summary === "string" && manifest.summary.length <= 300)) no("its summary is not text of 300 characters at most");
  if (manifest.exportedWith !== undefined && !(typeof manifest.exportedWith === "string" && manifest.exportedWith.length <= 60)) no("exportedWith is not a short name");
  if (manifest.cost !== undefined && !validCost(manifest.cost)) no("its cost is not a declared amount in US dollars a month");
  if (!isObj(manifest.tools)) return [...problems, "it holds no tools"];
  for (const tool of Object.keys(manifest.tools)) if (tool !== TOOL) no(`it has ${tool.slice(0, 40)}, which this version of Rooms cannot read; update Rooms`);
  const cc = manifest.tools[TOOL];
  if (!isObj(cc)) return [...problems, "it holds nothing for Claude Code"];
  for (const k of Object.keys(cc)) if (!["checkedAgainst", "files", "project", "user"].includes(k)) no(`it has claude-code.${k.slice(0, 40)}, which this version does not read`);

  const list = cc.files ?? [];
  if (!Array.isArray(list) || list.length > 500) no("its files are not a list of at most 500");
  const seen = new Set();
  let total = 0;
  for (const f of Array.isArray(list) ? list.slice(0, 500) : []) {
    if (!isObj(f) || !KINDS.has(f.kind) || Object.keys(f).some((k) => !["kind", "path", "installTo", "sha256", "executable"].includes(k))) {
      no("it lists a file this version does not install");
      continue;
    }
    if (!installPlace(f.installTo, f.kind)) {
      no(`it would write a ${f.kind} to ${String(f.installTo).slice(0, 120)}, which is not a place a setup may write one`);
      continue;
    }
    if (f.path !== filePathFor(f.installTo)) {
      no(`${f.installTo} is filed somewhere other than where its place says`);
      continue;
    }
    if (seen.has(f.installTo)) {
      no(`${f.installTo} is listed twice`);
      continue;
    }
    seen.add(f.installTo);
    if (f.executable !== undefined && typeof f.executable !== "boolean") no(`${f.installTo}: executable is not true or false`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || "")) {
      no(`${f.installTo} has no sha256`);
      continue;
    }
    const text = files.get(f.path);
    if (text == null) {
      no(`${f.installTo} is listed, but its file is not in the setup`);
      continue;
    }
    total += Buffer.byteLength(text);
    if (sha256Text(text) !== f.sha256) {
      no(`${f.installTo} does not match its sha256: it changed after it was exported`);
      continue;
    }
    const secret = scanText(text)[0];
    if (secret) no(`${f.installTo} line ${secret.line} looks like ${secret.kind}`);
    if (acts(f)) {
      const why = actingRefusal(text);
      if (why) no(`${f.installTo}: ${why.detail}`);
    }
  }
  if (total > 5_000_000) no("its files come to more than 5 MB");

  for (const scope of ["project", "user"]) {
    if (cc[scope] === undefined) continue;
    if (!isObj(cc[scope])) {
      no(`claude-code.${scope} is not an object`);
      continue;
    }
    for (const k of Object.keys(cc[scope])) if (k !== "settings" && k !== "mcpServers") no(`claude-code.${scope}.${k.slice(0, 40)} is not a part this version reads`);
    if (cc[scope].settings !== undefined) checkSettings(cc[scope].settings, scope, no);
    if (cc[scope].mcpServers !== undefined) checkServers(cc[scope].mcpServers, scope, no);
  }

  const notExported = manifest.notExported ?? [];
  if (!Array.isArray(notExported) || notExported.length > 300 || notExported.some((n) => !isObj(n) || typeof n.what !== "string" || typeof n.why !== "string" || n.what.length > 300 || n.why.length > 300)) {
    no("notExported is not a list of what was left out and why");
  }
  // Derived lists only mean something over a setup that passed everything above.
  if (problems.length) return problems;
  if (!sameJson(manifest.runs, deriveRuns(manifest, files))) no("its list of what it runs does not match what it holds; that list is derived, never written by hand");
  if (!sameJson(manifest.requires, deriveRequires(manifest, files))) no("its list of what it needs does not match what it holds; that list is derived, never written by hand");
  return problems;
}

// ---- its README ----------------------------------------------------------------------------------

/** The README beside setup.json, generated from it, with every value escaped for Markdown. */
export function renderReadme(manifest) {
  const cc = manifest.tools[TOOL];
  const lines = [`# ${mdText(`${manifest.role}/${manifest.name}`)}`, ""];
  if (manifest.summary) lines.push(mdText(manifest.summary), "");
  const cost = manifest.cost ? ` · costs $${manifest.cost.usdPerMonth} a month${manifest.cost.what ? `, ${mdText(manifest.cost.what)}` : ""} (declared by the owner, not measured)` : "";
  lines.push(`Owner: ${mdText(manifest.owner)} · exported with ${mdText(manifest.exportedWith)}${cost}`, "", "## What it holds", "");
  for (const f of cc.files) lines.push(`- ${mdText(f.installTo)} · ${f.kind}${f.executable ? " · runs as a program" : ""}`);
  for (const scope of ["project", "user"]) {
    if (cc[scope]?.settings) lines.push(`- ${scope} settings: ${mdText(Object.keys(cc[scope].settings).join(", "))}`);
    if (cc[scope]?.mcpServers) lines.push(`- ${scope} MCP servers: ${mdText(Object.keys(cc[scope].mcpServers).join(", "))}`);
  }
  if (!cc.files.length && !cc.project && !cc.user) lines.push("- nothing");
  lines.push("", "## What it runs, as whoever adopts it", "");
  if (!manifest.runs.length) lines.push("- nothing");
  for (const r of manifest.runs) {
    const what = r.command || r.url || "";
    const where = r.surface === "hook" ? `hook ${r.event}` : r.surface === "mcp" ? `MCP server ${r.name}` : r.surface === "loads" ? `as ${r.file} loads` : `script ${r.file}`;
    lines.push(`- ${mdText(where)}${what ? `: ${mdText(what)}` : ""}`);
  }
  lines.push("", "## What it needs", "");
  if (!manifest.requires.length) lines.push("- nothing");
  for (const q of manifest.requires) lines.push(`- ${q.env ? `the environment variable ${mdText(q.env)}, your own` : `the program ${mdText(q.program)}`} (${mdText(q.for)})`);
  if (manifest.notExported.length) {
    lines.push("", "## Left out", "");
    for (const n of manifest.notExported) lines.push(`- ${mdText(n.what)}: ${mdText(n.why)}`);
  }
  lines.push(
    "",
    "## Adopt it",
    "",
    `    rooms setup show ${manifest.role}/${manifest.name}`,
    `    rooms setup adopt ${manifest.role}/${manifest.name}`,
    "",
    "Adopting shows everything it would write and run, and asks first. `rooms setup rollback` undoes it.",
    "Generated by Rooms from setup.json; the next export replaces this file.",
    "",
  );
  return lines.join("\n");
}
