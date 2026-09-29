/**
 * What hooks observed about agents on this machine: one JSON line per event in
 * `.room/agent-activity.jsonl`.
 *
 * Kept beside the room's posts rather than among them, so a line per commit (and, later, per edit)
 * never floods the board's list of posts. Append-only, and merged with union when a room is shared,
 * the same rule as `events.jsonl`. Every field is chosen by the code that writes it; nothing from a
 * hook's payload or the environment is copied in whole.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findRoomDir, roomPaths } from "./store.js";

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
