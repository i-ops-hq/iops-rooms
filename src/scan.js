import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readEvents, readMeta, roomPaths } from "./store.js";

const SKIP = new Set([
  "node_modules",
  ".git",
  ".cursor",
  "Library",
  "Applications",
  ".Trash",
  "Caches",
]);

async function existsRoom(dir) {
  try {
    await readMeta(dir);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, depth, maxDepth, found, seen) {
  const real = resolve(dir);
  if (seen.has(real) || depth > maxDepth || found.length >= 200) return;
  seen.add(real);
  if (await existsRoom(real)) {
    found.push(real);
    return;
  }
  let entries;
  try {
    entries = await readdir(real, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || SKIP.has(ent.name) || ent.name.startsWith(".")) continue;
    await walk(join(real, ent.name), depth + 1, maxDepth, found, seen);
  }
}

export function defaultScanRoots() {
  const home = homedir();
  return [
    process.cwd(),
    join(home, "Projects"),
    join(home, "Developer"),
    join(home, "repos"),
    join(home, ".iops-rooms"),
  ];
}

export async function listRooms(roots = defaultScanRoots()) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    await walk(root, 0, 4, found, seen);
  }
  const rooms = [];
  for (const projectDir of found) {
    try {
      const meta = await readMeta(projectDir);
      const events = await readEvents(projectDir);
      const last = events[events.length - 1];
      const { board, root } = roomPaths(projectDir);
      rooms.push({
        projectDir,
        id: meta.id,
        name: meta.name,
        network: meta.network,
        events: events.length,
        lastAt: last?.at || meta.createdAt,
        lastActor: last?.actor || meta.createdBy,
        lastTool: last?.tool || "",
        board,
        boardUrl: pathToFileURL(board).href,
        roomDir: root,
      });
    } catch {
      /* skip broken rooms */
    }
  }
  rooms.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return rooms;
}
