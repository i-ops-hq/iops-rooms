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
 * The files of commit `sha` that an agent's own hook saw it edit in this checkout since the commit
 * before it, by agent: `{ "claude-code": ["src/a.go"] }`, or null when there are none.
 *
 * Since the parent commit, because an edit before that belonged to an earlier commit or to none. An
 * edit left uncommitted across a commit that did not include it is missed, which undercounts rather
 * than overcounts, the same direction as every other count here.
 */
export async function editedByFor(cwd, sha, activity) {
  const edits = (activity || []).filter((a) => a && a.kind === "edit" && a.path && a.agent);
  if (!edits.length) return null;
  const files = await git(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha], { timeout: 4000 });
  if (!files.ok) return null;
  const changed = new Set(files.out.split("\0").filter(Boolean));
  if (!changed.size) return null;
  const parent = await git(cwd, ["log", "-1", "--format=%cI", `${sha}^`], { timeout: 4000 });
  const here = await checkoutRef(cwd);
  // git keeps commit times to the second, so an edit in the same second as the previous commit could
  // not be told apart from one after it. The hook's own record of that commit has milliseconds, and
  // whichever is later starts the window.
  const recorded = (activity || [])
    .filter((a) => a && a.kind === "commit" && (!a.checkout || a.checkout === here))
    .map((a) => Date.parse(a.at))
    .filter(Number.isFinite);
  const since = Math.max(
    parent.ok && parent.out.trim() ? Date.parse(parent.out.trim()) : 0,
    recorded.length ? Math.max(...recorded) : 0,
  );
  const byAgent = {};
  for (const e of edits) {
    if (!changed.has(e.path)) continue;
    if (e.checkout && here && e.checkout !== here) continue;
    if (!(Date.parse(e.at) > since)) continue;
    (byAgent[e.agent] ||= new Set()).add(e.path);
  }
  const out = Object.fromEntries(Object.entries(byAgent).map(([agent, paths]) => [agent, [...paths].sort().slice(0, 50)]));
  return Object.keys(out).length ? out : null;
}
