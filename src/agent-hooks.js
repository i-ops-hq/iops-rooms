/**
 * What an agent's own hooks tell Rooms: which sessions ran here, and which files they edited.
 *
 * The trailer is written only on commits an agent makes itself, so an agent that edits and leaves
 * the committing to a person leaves no trace in git. Its hooks do. Claude Code, Codex and Cursor
 * each run a command on session start/end and after edits, with a JSON payload on stdin; this turns
 * that payload into one small record in `.room/agent-activity.jsonl`, and the git hook later joins
 * the edits to the commit that carried them. A custom agent can call `rooms record` with the same
 * allowlisted shape.
 *
 * **The payload also carries what must never be kept.** Claude's `Write` passes the whole file;
 * Codex's `apply_patch` sends the patch in `tool_input.command`; Cursor's `afterFileEdit` sends
 * `edits` with old/new strings; every tool may include output, prompts and `transcript_path`. An
 * adapter picks a fixed set of fields and nothing else. A test fails if any other string reaches
 * the log.
 *
 * **It must never talk to the agent or get in its way.** Hooks print nothing and exit 0 whatever
 * happens, and record nothing where there is no room.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendActivity, checkoutRef } from "./activity.js";
import { agentFromEnv } from "./agent-markers.js";
import { findRoomDir } from "./store.js";
import { repositoryTop } from "./git-info.js";

/** Payloads above this are not parsed. A `Write` of a large file arrives whole on stdin. */
const MAX_PAYLOAD = 8 * 1024 * 1024;

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CODEX_EDIT_TOOLS = new Set(["apply_patch", "Edit", "Write"]);

/** Enough of a session id to group events, and useless for finding its transcript. */
export function sessionRef(id) {
  const s = String(id || "");
  return s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : null;
}

function short(value, max = 60) {
  const s = String(value || "").trim().replace(/[^A-Za-z0-9._:/@+-]/g, "").slice(0, max);
  return s || null;
}

/**
 * Paths named in a Codex `apply_patch` command, and nothing else of the patch.
 * Lines look like `*** Update File: src/a.js` (also Add / Delete). Checked against Codex hooks docs
 * 2026-10-16; the rest of `tool_input.command` is code and must never reach the log.
 */
export function pathsFromApplyPatch(command) {
  if (typeof command !== "string" || !command) return [];
  const out = [];
  for (const line of command.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(\S.*?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Claude Code's payload, reduced to what Rooms keeps, or null for events it does not record.
 * Field names from the hooks reference (re-read 2026-09-29); the file path is made relative later.
 */
export function fromClaudeCode(payload, env = {}) {
  if (!payload || typeof payload !== "object") return null;
  const marker = agentFromEnv(env);
  const base = { agent: "claude-code", session: sessionRef(payload.session_id), source: "hook" };
  switch (payload.hook_event_name) {
    case "SessionStart":
      return {
        ...base,
        kind: "session",
        phase: "start",
        model: short(payload.model),
        version: marker?.agent === "claude-code" ? marker.version : null,
        entry: marker?.agent === "claude-code" ? marker.entry : null,
      };
    case "SessionEnd":
      return { ...base, kind: "session", phase: "end" };
    case "PostToolUse": {
      const tool = String(payload.tool_name || "");
      if (!CLAUDE_EDIT_TOOLS.has(tool)) return null;
      const file = payload.tool_input?.file_path || payload.tool_input?.notebook_path;
      if (!file || typeof file !== "string") return null;
      return { ...base, kind: "edit", via: tool, file };
    }
    default:
      return null;
  }
}

/**
 * Codex CLI hooks (SessionStart / SessionEnd / PostToolUse). File edits arrive as `apply_patch`
 * with the patch in `tool_input.command` — only path lines are kept. Docs: developers.openai.com/codex/hooks
 * (read 2026-10-16).
 */
export function fromCodex(payload, env = {}) {
  if (!payload || typeof payload !== "object") return null;
  const marker = agentFromEnv(env);
  const base = {
    agent: "codex",
    session: sessionRef(payload.session_id),
    source: "hook",
  };
  switch (payload.hook_event_name) {
    case "SessionStart":
      return {
        ...base,
        kind: "session",
        phase: "start",
        model: short(payload.model),
        version: marker?.agent === "codex" ? marker.version : null,
        entry: null,
      };
    case "SessionEnd":
      return { ...base, kind: "session", phase: "end" };
    case "PostToolUse": {
      const tool = String(payload.tool_name || "");
      if (!CODEX_EDIT_TOOLS.has(tool)) return null;
      if (tool === "apply_patch" || (payload.tool_input && typeof payload.tool_input.command === "string")) {
        const paths = pathsFromApplyPatch(payload.tool_input?.command);
        if (!paths.length) return null;
        // One PostToolUse can touch several files; runAgentHook expands `files` into one edit each.
        return { ...base, kind: "edit", via: "apply_patch", files: paths };
      }
      const file = payload.tool_input?.file_path;
      if (!file || typeof file !== "string") return null;
      return { ...base, kind: "edit", via: tool, file };
    }
    default:
      return null;
  }
}

/**
 * Cursor Agent hooks (sessionStart / sessionEnd / afterFileEdit). `edits` holds old/new strings and
 * must never be kept. Docs: cursor.com/docs/hooks (read 2026-10-16). Tab-only events are ignored.
 */
export function fromCursor(payload, env = {}) {
  if (!payload || typeof payload !== "object") return null;
  const marker = agentFromEnv(env);
  const sid = payload.session_id || payload.conversation_id;
  const event = String(payload.hook_event_name || "");
  const base = { agent: "cursor", session: sessionRef(sid), source: "hook" };
  switch (event) {
    case "sessionStart":
      return {
        ...base,
        kind: "session",
        phase: "start",
        model: short(payload.model),
        version: marker?.agent === "cursor" ? marker.version : short(env.CURSOR_VERSION || payload.cursor_version),
        entry: payload.is_background_agent ? "background" : short(payload.composer_mode) || "agent",
      };
    case "sessionEnd":
      return { ...base, kind: "session", phase: "end" };
    case "afterFileEdit": {
      const file = payload.file_path;
      if (!file || typeof file !== "string") return null;
      return { ...base, kind: "edit", via: "afterFileEdit", file };
    }
    default:
      return null;
  }
}

/**
 * Custom / any agent: allowlisted JSON only (`kind`, `phase`/`path`/`via`, optional `session`/`model`).
 * Used by `rooms record session-start|edit|session-end` and `agent-hook custom`.
 */
export function fromCustom(payload, env = {}) {
  if (!payload || typeof payload !== "object") return null;
  const marker = agentFromEnv(env);
  const agent = short(payload.agent) || marker?.agent;
  if (!agent) return null;
  const base = {
    agent: agent.toLowerCase(),
    session: sessionRef(payload.session || payload.session_id),
    source: payload.source === "hook" ? "hook" : "record",
    version: marker?.version ?? short(payload.version),
    entry: marker?.entry ?? short(payload.entry),
  };
  const kind = String(payload.kind || "");
  if (kind === "session" || payload.phase === "start" || payload.phase === "end") {
    const phase = payload.phase === "end" ? "end" : "start";
    return {
      agent: base.agent,
      session: base.session,
      source: base.source,
      kind: "session",
      phase,
      model: short(payload.model) || marker?.model,
      version: phase === "start" ? base.version : null,
      entry: phase === "start" ? base.entry : null,
    };
  }
  if (kind === "edit" || payload.path || payload.file) {
    const file = payload.path || payload.file;
    if (!file || typeof file !== "string") return null;
    return {
      agent: base.agent,
      session: base.session,
      source: base.source,
      kind: "edit",
      via: short(payload.via) || "record",
      file,
    };
  }
  return null;
}

export const ADAPTERS = {
  "claude-code": fromClaudeCode,
  codex: fromCodex,
  cursor: fromCursor,
  custom: fromCustom,
};

export const HOOK_AGENTS = ["claude-code", "codex", "cursor"];

async function readPayload(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_PAYLOAD) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * `file` relative to `top` with forward slashes, the way git names files, or null outside it.
 *
 * The same directory can be spelled two ways (macOS's /var and /private/var, a symlinked home), and
 * an agent reports whichever it was started in. When the spellings disagree, both are resolved and
 * compared again, so a file inside the project is not dropped for how its path was written.
 */
async function insideOf(top, file) {
  const within = (a, b) => {
    const rel = relative(a, b);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : null;
  };
  const direct = within(top, file);
  if (direct) return direct;
  const { realpath } = await import("node:fs/promises");
  try {
    return within(await realpath(top), await realpath(file));
  } catch {
    return null;
  }
}

async function finalizeEdit(dir, where, record, file) {
  const top = (await repositoryTop(where)) || dir;
  const abs = isAbsolute(file) ? file : resolve(where, file);
  const rel = await insideOf(top, abs);
  if (!rel) return null;
  const out = { ...record, path: rel, checkout: await checkoutRef(where) };
  delete out.file;
  delete out.files;
  await appendActivity(dir, out);
  return out;
}

/**
 * Run one hook event for `agent`: read the payload, keep the allowlisted fields, append a record.
 * Throws nothing a caller has to handle, prints nothing, and writes nothing without a room.
 * Codex `apply_patch` may yield several paths; each becomes its own edit line.
 */
export async function runAgentHook(agent, { stdin = process.stdin, env = process.env, cwd = process.cwd() } = {}) {
  const adapt = ADAPTERS[agent];
  if (!adapt) return null;
  const payload = await readPayload(stdin);
  const record = adapt(payload, env);
  if (!record) return null;
  const where =
    typeof payload?.cwd === "string" && payload.cwd
      ? payload.cwd
      : typeof payload?.workspace_roots?.[0] === "string"
        ? payload.workspace_roots[0]
        : cwd;
  const dir = await findRoomDir(where);
  if (!dir) return null;
  if (record.kind === "edit") {
    const files = Array.isArray(record.files) ? record.files : record.file ? [record.file] : [];
    const written = [];
    for (const file of files) {
      const one = await finalizeEdit(dir, where, record, file);
      if (one) written.push(one);
    }
    return written.length === 1 ? written[0] : written.length ? written : null;
  }
  // Session records must not carry version/entry keys when end (adapter already nulls them).
  const clean = { ...record };
  if (clean.phase === "end") {
    delete clean.version;
    delete clean.entry;
    delete clean.model;
  }
  await appendActivity(dir, clean);
  return clean;
}

/** Append a custom allowlisted record (from `rooms record`), same quiet rules as hooks. */
export async function recordCustom(payload, { env = process.env, cwd = process.cwd() } = {}) {
  const record = fromCustom(payload, env);
  if (!record) return null;
  const where = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : cwd;
  const dir = await findRoomDir(where);
  if (!dir) return null;
  if (record.kind === "edit") {
    return finalizeEdit(dir, where, record, record.file);
  }
  const clean = { ...record };
  if (clean.phase === "end") {
    delete clean.version;
    delete clean.entry;
    delete clean.model;
  }
  await appendActivity(dir, clean);
  return clean;
}

// ------------------------------------------------------------------ installing the hooks

const EVENTS = [
  ["SessionStart", null],
  ["PostToolUse", "Edit|Write|MultiEdit|NotebookEdit"],
  ["SessionEnd", null],
];

/** The command an agent runs. Double quotes, which bash, zsh, PowerShell and cmd all accept. */
export function agentHookCommand(agent, { nodeBin = process.execPath, cliPath } = {}) {
  return `"${nodeBin}" "${cliPath}" agent-hook ${agent}`;
}

export function claudeHookCommand({ nodeBin = process.execPath, cliPath }) {
  return agentHookCommand("claude-code", { nodeBin, cliPath });
}

export function codexHookCommand(opts) {
  return agentHookCommand("codex", opts);
}

export function cursorHookCommand(opts) {
  return agentHookCommand("cursor", opts);
}

const isOursFor = (agent) => (hook) =>
  typeof hook?.command === "string" && new RegExp(`\\bagent-hook ${agent}\\b`).test(hook.command);

const isOurs = isOursFor("claude-code");

/** Whether a Claude Code hook entry is one Rooms installed. A setup leaves these out: each machine installs its own. */
export const isRoomsHook = isOurs;

export function isRoomsAgentHook(agent, hook) {
  return isOursFor(agent)(hook);
}

// Asked of the hooks themselves. Comparing the file with itself minus our entries also counted the
// tidying `withoutClaudeHooks` does, so an empty "hooks": {} read as Rooms hooks present; searching
// the text for the command also matched a permission rule that names it.
function holdsOurs(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return Object.values(hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs)),
  );
}

/**
 * Settings with the Rooms hooks added, replacing any earlier Rooms entry and leaving every other hook
 * exactly where it was. Pure, so the preview is the same object that gets written.
 */
export function withClaudeHooks(settings, command) {
  const next = structuredClone(settings && typeof settings === "object" ? settings : {});
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  for (const [event, matcher] of EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    kept.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
    next.hooks[event] = kept;
  }
  return next;
}

/** Settings with every Rooms hook taken out, and any group or event left empty by that removed. */
export function withoutClaudeHooks(settings) {
  const next = structuredClone(settings && typeof settings === "object" ? settings : {});
  if (!next.hooks || typeof next.hooks !== "object") return next;
  for (const event of Object.keys(next.hooks)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

async function readSettings(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { exists: false, raw: "", settings: {} };
  }
  try {
    return { exists: true, raw, settings: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix it first; nothing was changed.`);
  }
}

/** Where the hooks go: the project's personal settings, or the user's for every project. */
export async function claudeSettingsPath({ cwd = process.cwd(), user = false, home } = {}) {
  if (user) return join(home || (await import("node:os")).homedir(), ".claude", "settings.json");
  const top = await repositoryTop(cwd);
  if (!top) throw new Error("Not a git repository. Run this inside the project, or pass --user.");
  return join(top, ".claude", "settings.local.json");
}

/**
 * The change `install` would make, without making it: the file, what it holds now, and what it
 * would hold. The caller shows this and asks before anything is written.
 */
export async function planClaudeHooks({ cwd = process.cwd(), user = false, home, nodeBin, cliPath }) {
  const path = await claudeSettingsPath({ cwd, user, home });
  const { exists, raw, settings } = await readSettings(path);
  const after = withClaudeHooks(settings, claudeHookCommand({ nodeBin, cliPath }));
  // The backup is the file as it was before Rooms first touched it. Installing again used to replace
  // it with the already-installed file, and uninstalling then restored the Rooms hooks it was meant
  // to remove. So an existing backup is kept, and a file that already holds Rooms hooks is never one.
  // Decided here, once, because the preview and the write both read it: the preview used to promise
  // a copy on every install into an existing file, including the ones where none was made.
  const hasOurs = exists && holdsOurs(settings);
  const copy = (await readFile(`${path}.rooms-backup`, "utf8").then(() => true, () => false))
    ? "kept"
    : exists && !hasOurs
      ? "write"
      : "none";
  return { path, exists, hasOurs, copy, before: raw, after: `${JSON.stringify(after, null, 2)}\n` };
}

/** Write the planned change, keep what was there, and keep the personal file out of git. */
export async function applyClaudeHooks(plan, { cwd = process.cwd(), user = false } = {}) {
  await mkdir(dirname(plan.path), { recursive: true });
  const backup = `${plan.path}.rooms-backup`;
  // Checked again: a copy that appeared while the person read the preview is still never replaced.
  if (plan.copy === "write" && !(await readFile(backup, "utf8").then(() => true, () => false))) {
    await writeFile(backup, plan.before, "utf8");
  }
  await writeFile(plan.path, plan.after, "utf8");
  if (!user) await excludeFromGit(cwd, plan.path);
}

/** Take the Rooms hooks out again. A file Rooms created, and that holds nothing else, is removed. */
export async function removeClaudeHooks({ cwd = process.cwd(), user = false, home } = {}) {
  const path = await claudeSettingsPath({ cwd, user, home });
  const { exists, settings } = await readSettings(path);
  if (!exists) return { path, removed: false };
  if (!holdsOurs(settings)) return { path, removed: false };
  const after = withoutClaudeHooks(settings);
  let backup = null;
  try {
    backup = await readFile(`${path}.rooms-backup`, "utf8");
  } catch {
    backup = null;
  }
  // Restoring the backup byte for byte is right only if nothing else changed since the install;
  // otherwise the Rooms entries are taken out and everything the person added since is kept.
  let deleted = false;
  if (backup !== null && JSON.stringify(withoutClaudeHooks(JSON.parse(backup))) === JSON.stringify(after)) {
    await writeFile(path, backup, "utf8");
  } else if (!Object.keys(after).length) {
    await unlink(path);
    deleted = true;
  } else {
    await writeFile(path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  }
  await unlink(`${path}.rooms-backup`).catch(() => {});
  // The exclude line kept a file out of git that is now gone, so it goes too. Where the file stays,
  // holding the person's own settings, the line stays and keeps doing its job.
  if (deleted && !user) await includeInGitAgain(cwd, path);
  return { path, removed: true };
}

// ------------------------------------------------------------------ Codex (hooks.json, Claude-shaped)

const CODEX_EVENTS = [
  ["SessionStart", null],
  ["PostToolUse", "apply_patch|Edit|Write"],
  ["SessionEnd", null],
];

function holdsOursCodex(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const ours = isOursFor("codex");
  return Object.values(hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(ours)),
  );
}

export function withCodexHooks(settings, command) {
  const next = structuredClone(settings && typeof settings === "object" ? settings : {});
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  const ours = isOursFor("codex");
  for (const [event, matcher] of CODEX_EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length);
    kept.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
    next.hooks[event] = kept;
  }
  return next;
}

export function withoutCodexHooks(settings) {
  const next = structuredClone(settings && typeof settings === "object" ? settings : {});
  if (!next.hooks || typeof next.hooks !== "object") return next;
  const ours = isOursFor("codex");
  for (const event of Object.keys(next.hooks)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export async function codexHooksPath({ cwd = process.cwd(), user = false, home } = {}) {
  if (user) return join(home || (await import("node:os")).homedir(), ".codex", "hooks.json");
  const top = await repositoryTop(cwd);
  if (!top) throw new Error("Not a git repository. Run this inside the project, or pass --user.");
  return join(top, ".codex", "hooks.json");
}

export async function planCodexHooks({ cwd = process.cwd(), user = false, home, nodeBin, cliPath }) {
  const path = await codexHooksPath({ cwd, user, home });
  const { exists, raw, settings } = await readSettings(path);
  const after = withCodexHooks(settings, codexHookCommand({ nodeBin, cliPath }));
  const hasOurs = exists && holdsOursCodex(settings);
  const copy = (await readFile(`${path}.rooms-backup`, "utf8").then(() => true, () => false))
    ? "kept"
    : exists && !hasOurs
      ? "write"
      : "none";
  return { path, exists, hasOurs, copy, before: raw, after: `${JSON.stringify(after, null, 2)}\n` };
}

export async function applyCodexHooks(plan, { cwd = process.cwd(), user = false } = {}) {
  await mkdir(dirname(plan.path), { recursive: true });
  const backup = `${plan.path}.rooms-backup`;
  if (plan.copy === "write" && !(await readFile(backup, "utf8").then(() => true, () => false))) {
    await writeFile(backup, plan.before, "utf8");
  }
  await writeFile(plan.path, plan.after, "utf8");
  if (!user) await excludeFromGit(cwd, plan.path);
}

export async function removeCodexHooks({ cwd = process.cwd(), user = false, home } = {}) {
  const path = await codexHooksPath({ cwd, user, home });
  const { exists, settings } = await readSettings(path);
  if (!exists) return { path, removed: false };
  if (!holdsOursCodex(settings)) return { path, removed: false };
  const after = withoutCodexHooks(settings);
  let backup = null;
  try {
    backup = await readFile(`${path}.rooms-backup`, "utf8");
  } catch {
    backup = null;
  }
  let deleted = false;
  if (backup !== null && JSON.stringify(withoutCodexHooks(JSON.parse(backup))) === JSON.stringify(after)) {
    await writeFile(path, backup, "utf8");
  } else if (!Object.keys(after).length) {
    await unlink(path);
    deleted = true;
  } else {
    await writeFile(path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  }
  await unlink(`${path}.rooms-backup`).catch(() => {});
  if (deleted && !user) await includeInGitAgain(cwd, path);
  return { path, removed: true };
}

// ------------------------------------------------------------------ Cursor (hooks.json, flat version:1)

const CURSOR_EVENTS = ["sessionStart", "afterFileEdit", "sessionEnd"];

function holdsOursCursor(doc) {
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const ours = isOursFor("cursor");
  return Object.values(hooks).some((list) => Array.isArray(list) && list.some(ours));
}

export function withCursorHooks(doc, command) {
  const next = structuredClone(doc && typeof doc === "object" ? doc : {});
  if (next.version == null) next.version = 1;
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  const ours = isOursFor("cursor");
  for (const event of CURSOR_EVENTS) {
    const list = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = list.filter((h) => !ours(h));
    kept.push({ command });
    next.hooks[event] = kept;
  }
  return next;
}

export function withoutCursorHooks(doc) {
  const next = structuredClone(doc && typeof doc === "object" ? doc : {});
  if (!next.hooks || typeof next.hooks !== "object") return next;
  const ours = isOursFor("cursor");
  for (const event of Object.keys(next.hooks)) {
    const list = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = list.filter((h) => !ours(h));
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export async function cursorHooksPath({ cwd = process.cwd(), user = false, home } = {}) {
  if (user) return join(home || (await import("node:os")).homedir(), ".cursor", "hooks.json");
  const top = await repositoryTop(cwd);
  if (!top) throw new Error("Not a git repository. Run this inside the project, or pass --user.");
  return join(top, ".cursor", "hooks.json");
}

export async function planCursorHooks({ cwd = process.cwd(), user = false, home, nodeBin, cliPath }) {
  const path = await cursorHooksPath({ cwd, user, home });
  const { exists, raw, settings } = await readSettings(path);
  const after = withCursorHooks(settings, cursorHookCommand({ nodeBin, cliPath }));
  const hasOurs = exists && holdsOursCursor(settings);
  const copy = (await readFile(`${path}.rooms-backup`, "utf8").then(() => true, () => false))
    ? "kept"
    : exists && !hasOurs
      ? "write"
      : "none";
  return { path, exists, hasOurs, copy, before: raw, after: `${JSON.stringify(after, null, 2)}\n` };
}

export async function applyCursorHooks(plan, { cwd = process.cwd(), user = false } = {}) {
  await mkdir(dirname(plan.path), { recursive: true });
  const backup = `${plan.path}.rooms-backup`;
  if (plan.copy === "write" && !(await readFile(backup, "utf8").then(() => true, () => false))) {
    await writeFile(backup, plan.before, "utf8");
  }
  await writeFile(plan.path, plan.after, "utf8");
  if (!user) await excludeFromGit(cwd, plan.path);
}

export async function removeCursorHooks({ cwd = process.cwd(), user = false, home } = {}) {
  const path = await cursorHooksPath({ cwd, user, home });
  const { exists, settings } = await readSettings(path);
  if (!exists) return { path, removed: false };
  if (!holdsOursCursor(settings)) return { path, removed: false };
  const after = withoutCursorHooks(settings);
  let backup = null;
  try {
    backup = await readFile(`${path}.rooms-backup`, "utf8");
  } catch {
    backup = null;
  }
  let deleted = false;
  if (backup !== null && JSON.stringify(withoutCursorHooks(JSON.parse(backup))) === JSON.stringify(after)) {
    await writeFile(path, backup, "utf8");
  } else if (!after.hooks && Object.keys(after).every((k) => k === "version" || after[k] == null)) {
    // Only version (or empty) left — remove the file Rooms owned.
    if (!Object.keys(after).filter((k) => k !== "version").length) {
      await unlink(path);
      deleted = true;
    } else {
      await writeFile(path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    }
  } else {
    await writeFile(path, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  }
  await unlink(`${path}.rooms-backup`).catch(() => {});
  if (deleted && !user) await includeInGitAgain(cwd, path);
  return { path, removed: true };
}

/** Which hook agents look installed on this machine (config dirs present). */
export async function discoverHookAgents({ cwd = process.cwd(), home } = {}) {
  const { access } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const h = home || homedir();
  const top = await repositoryTop(cwd);
  const found = [];
  const check = async (agent, paths) => {
    for (const p of paths) {
      try {
        await access(p);
        found.push(agent);
        return;
      } catch {
        /* try next */
      }
    }
  };
  await check("claude-code", [
    ...(top ? [join(top, ".claude")] : []),
    join(h, ".claude"),
  ]);
  await check("codex", [...(top ? [join(top, ".codex")] : []), join(h, ".codex")]);
  await check("cursor", [...(top ? [join(top, ".cursor")] : []), join(h, ".cursor")]);
  return found;
}

async function excludeFile(cwd) {
  const { git } = await import("./git-history.js");
  const top = await repositoryTop(cwd);
  if (!top) return null;
  const res = await git(top, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { timeout: 4000 });
  return res.ok ? { top, file: res.out.trim() } : null;
}

async function includeInGitAgain(cwd, path) {
  const where = await excludeFile(cwd);
  if (!where) return;
  const line = relative(where.top, path).split(sep).join("/");
  const current = await readFile(where.file, "utf8").catch(() => null);
  if (current === null) return;
  const lines = current.split("\n");
  if (!lines.includes(line)) return;
  await writeFile(where.file, lines.filter((l) => l !== line).join("\n"), "utf8");
}

/** Add the personal settings file to .git/info/exclude, which is local and never committed. */
async function excludeFromGit(cwd, path) {
  const { git } = await import("./git-history.js");
  const where = await excludeFile(cwd);
  if (!where) return;
  const ignored = await git(where.top, ["check-ignore", "-q", path], { timeout: 4000 });
  if (ignored.ok) return;
  const line = relative(where.top, path).split(sep).join("/");
  await mkdir(dirname(where.file), { recursive: true });
  const current = await readFile(where.file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).includes(line)) return;
  await appendFile(where.file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
}
