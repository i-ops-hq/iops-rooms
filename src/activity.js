/**
 * What hooks observed about agents on this machine: one JSON line per event in
 * `.room/agent-activity.jsonl`.
 *
 * Kept beside the room's posts rather than among them, so a line per commit (and, later, per edit)
 * never floods the board's list of posts. Append-only, and merged with union when a room is shared,
 * the same rule as `events.jsonl`. Every field is chosen by the code that writes it; nothing from a
 * hook's payload or the environment is copied in whole.
 */

import { appendFile, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { findRoomDir, roomPaths } from "./store.js";
import { repositoryTop } from "./git-info.js";
import { git } from "./git-history.js";

export const ACTIVITY_FILE = "agent-activity.jsonl";

export function activityPath(projectDir) {
  return join(roomPaths(projectDir).root, ACTIVITY_FILE);
}

/** Append one record. `v` and `at` are stamped after the caller's fields, so they cannot be set by it. */
export async function appendActivity(projectDir, record) {
  const line = JSON.stringify({ ...record, v: 1, at: new Date().toISOString() });
  await appendFile(activityPath(projectDir), `${line}\n`, "utf8");
}

/** Every record, oldest first. A corrupt line is skipped, as in the post log. */
export async function readActivity(projectDir) {
  let raw;
  try {
    raw = await readFile(activityPath(projectDir), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      /* one bad line must not hide the rest */
    }
  }
  return out;
}

/** The activity of the room that `cwd` belongs to, or [] where there is no room. */
export async function activityFor(cwd) {
  const dir = await findRoomDir(cwd);
  return dir ? readActivity(dir) : [];
}

/**
 * Which checkout `cwd` is, as a short hash of its real top-level path, or null outside one.
 *
 * Every worktree of a repository shares one room, and two agents in two worktrees edit the same
 * paths on different branches. Without this, an edit made in one worktree would be credited to a
 * commit in another that touched the same file. The path itself is not kept: it names the person's
 * folders.
 */
export async function checkoutRef(cwd) {
  const top = await repositoryTop(cwd);
  if (!top) return null;
  let real = top;
  try {
    real = await realpath(top);
  } catch {
    /* the spelling git gave */
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

/**
 * The files of commit `sha` that an agent's own hook saw it edit in this checkout since each file
 * was last committed, by agent: `{ "claude-code": ["src/a.go"] }`, or null when there are none.
 *
 * Per file, not per commit. The window used to open at the commit before this one, so work split
 * into two commits lost every edit made before the first: the second commit carried files the agent
 * had written, one second after a commit that did not include them, and recorded nothing. An edit
 * before a file's own last commit belonged to that commit or to none. A file this commit deletes is
 * not carried by it.
 */
export async function editedByFor(cwd, sha, activity) {
  const here = await checkoutRef(cwd);
  const edits = (activity || []).filter(
    (a) => a && a.kind === "edit" && a.path && a.agent && !(a.checkout && here && a.checkout !== here),
  );
  if (!edits.length) return null;
  const listed = await git(
    cwd,
    ["diff-tree", "--root", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", sha],
    { timeout: 4000 },
  );
  if (!listed.ok) return null;
  const fields = listed.out.split("\0");
  const status = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] && fields[i + 1]) status.set(fields[i + 1], fields[i]);
  const editedHere = new Set(edits.map((e) => e.path));
  const files = [...status].filter(([path, s]) => s !== "D" && editedHere.has(path)).map(([path]) => path).slice(0, 200);
  if (!files.length) return null;
  // git keeps commit times to the second, so an edit in the same second as a file's last commit
  // could not be told apart from one after it. The hook's own record of that commit has
  // milliseconds, and whichever is later opens the window.
  const recordedAt = new Map(
    (activity || [])
      .filter((a) => a && a.kind === "commit" && a.sha && (!a.checkout || a.checkout === here))
      .map((a) => [a.sha, Date.parse(a.at)]),
  );
  const parentAt = async () => {
    const parent = await git(cwd, ["log", "-1", "--format=%H %cI", `${sha}^`], { timeout: 4000 });
    return windowStart(parent, recordedAt);
  };
  const since = new Map();
  // Eight at a time: this runs inside the git hook, after every commit, and a large commit of files
  // an agent touched must not start a process per file all at once.
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files.slice(i, i + 8).map(async (path) => {
        // Added here: nothing before this commit held the file, so every edit to it counts.
        if (status.get(path) === "A") return since.set(path, 0);
        const last = await git(cwd, ["log", "-1", "--format=%H %cI", `${sha}^`, "--", path], { timeout: 4000 });
        // Where git cannot say, the commit before this one: narrower, so it can only undercount.
        since.set(path, last.ok && last.out.trim() ? windowStart(last, recordedAt) : await parentAt());
      }),
    );
  }
  const byAgent = {};
  for (const e of edits) {
    if (!since.has(e.path)) continue;
    if (!(Date.parse(e.at) > since.get(e.path))) continue;
    (byAgent[e.agent] ||= new Set()).add(e.path);
  }
  const out = Object.fromEntries(Object.entries(byAgent).map(([agent, paths]) => [agent, [...paths].sort().slice(0, 50)]));
  return Object.keys(out).length ? out : null;
}

/** When a commit printed as `%H %cI` was made, to the millisecond where the hook recorded it. */
function windowStart(result, recordedAt) {
  const [commit, iso] = result.ok ? result.out.trim().split(" ") : [];
  return Math.max(iso ? Date.parse(iso) || 0 : 0, recordedAt.get(commit) || 0);
}
