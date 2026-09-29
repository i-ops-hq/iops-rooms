/**
 * What an agent's own hooks tell Rooms: which sessions ran here, and which files they edited.
 *
 * The trailer is written only on commits an agent makes itself, so an agent that edits and leaves
 * the committing to a person leaves no trace in git. Its hooks do. Claude Code runs a command on
 * session start and end and after every tool call, with a JSON payload on stdin; this turns that
 * payload into one small record in `.room/agent-activity.jsonl`, and the git hook later joins the
 * edits to the commit that carried them.
 *
 * **The payload also carries what must never be kept.** `Write` passes the whole file as
 * `tool_input.file_text`, every tool's result arrives as `tool_output`, `Stop` carries the last
 * assistant message, and every event names `transcript_path`. An adapter picks a fixed set of fields
 * and nothing else: the event, the session id (hashed), the tool's name and the edited file's path,
 * made relative to the project. A test fails if any other string reaches the log.
 *
 * **It must never talk to the agent or get in its way.** Claude Code adds a `SessionStart` hook's
 * stdout to the model's context, and a `PostToolUse` hook exiting 2 shows its stderr to Claude. So
 * the hook prints nothing, exits 0 whatever happens, and records nothing where there is no room.
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

const ADAPTERS = { "claude-code": fromClaudeCode };

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

/**
 * Run one hook event for `agent`: read the payload, keep the allowlisted fields, append a record.
 * Throws nothing a caller has to handle, prints nothing, and writes nothing without a room.
 */
export async function runAgentHook(agent, { stdin = process.stdin, env = process.env, cwd = process.cwd() } = {}) {
  const adapt = ADAPTERS[agent];
  if (!adapt) return null;
  const payload = await readPayload(stdin);
  const record = adapt(payload, env);
  if (!record) return null;
  const where = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : cwd;
  const dir = await findRoomDir(where);
  if (!dir) return null;
  if (record.kind === "edit") {
    // Relative to this checkout's top, with forward slashes, the way git names files; a file
    // outside the checkout is not the project's, so it is not recorded at all.
    const top = (await repositoryTop(where)) || dir;
    const abs = isAbsolute(record.file) ? record.file : resolve(where, record.file);
    delete record.file;
    const rel = await insideOf(top, abs);
    if (!rel) return null;
    record.path = rel;
    record.checkout = await checkoutRef(where);
  }
  await appendActivity(dir, record);
  return record;
}

// ------------------------------------------------------------------ installing the hooks

const EVENTS = [
  ["SessionStart", null],
  ["PostToolUse", "Edit|Write|MultiEdit|NotebookEdit"],
  ["SessionEnd", null],
];

/** The command Claude Code runs. Double quotes, which bash, zsh, PowerShell and cmd all accept. */
export function claudeHookCommand({ nodeBin = process.execPath, cliPath }) {
  return `"${nodeBin}" "${cliPath}" agent-hook claude-code`;
}

const isOurs = (hook) => typeof hook?.command === "string" && /\bagent-hook claude-code\b/.test(hook.command);

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
  return { path, exists, before: raw, after: `${JSON.stringify(after, null, 2)}\n` };
}

/** Write the planned change, keep what was there, and keep the personal file out of git. */
export async function applyClaudeHooks(plan, { cwd = process.cwd(), user = false } = {}) {
  await mkdir(dirname(plan.path), { recursive: true });
  // The backup is the file as it was before Rooms first touched it. Installing again used to replace
  // it with the already-installed file, and uninstalling then restored the Rooms hooks it was meant
  // to remove. So an existing backup is kept, and a file that already holds Rooms hooks is never one.
  const backup = `${plan.path}.rooms-backup`;
  const hasOurs = plan.exists && plan.before.includes("agent-hook claude-code");
  if (plan.exists && !hasOurs && !(await readFile(backup, "utf8").then(() => true, () => false))) {
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
  const after = withoutClaudeHooks(settings);
  if (JSON.stringify(after) === JSON.stringify(settings)) return { path, removed: false };
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
