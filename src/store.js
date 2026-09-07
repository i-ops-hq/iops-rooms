import { mkdir, readFile, writeFile, appendFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { eventId, roomCode } from "./ids.js";
import { writeBoard } from "./board.js";
import { loadIdentity } from "./identity.js";
import { resolveBranch } from "./git-info.js";

export const ROOM_DIR_NAME = ".room";
const META = "room.json";
const EVENTS = "events.jsonl";
const BOARD = "board.html";

export function roomPaths(dir) {
  const root = join(dir, ROOM_DIR_NAME);
  return {
    root,
    meta: join(root, META),
    events: join(root, EVENTS),
    board: join(root, BOARD),
  };
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk cwd → parents for .room/room.json. Stop at filesystem root. */
export async function findRoomDir(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const paths = roomPaths(dir);
    if (await exists(paths.meta)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function requireRoomDir(start) {
  const dir = await findRoomDir(start);
  if (!dir) {
    throw new Error(
      "No room in this directory. Run `rooms init` (or open a project that already has .room/).",
    );
  }
  return dir;
}

const IGNORE_LINE = ".room/";

export async function ensureGitignore(projectDir, share) {
  if (share) {
    const paths = roomPaths(projectDir);
    await writeFile(
      join(paths.root, "README.md"),
      `# This room is meant to be committed.

Teammates get the same transcript and board.html.
Do not put secrets in notes or diffs.
`,
      "utf8",
    );
    return { ignored: false };
  }
  const gi = join(projectDir, ".gitignore");
  let body = "";
  try {
    body = await readFile(gi, "utf8");
  } catch {
    body = "";
  }
  if (body.split(/\r?\n/).some((line) => line.trim() === IGNORE_LINE || line.trim() === ".room")) {
    return { ignored: true, wrote: false };
  }
  const next = `${body}${body && !body.endsWith("\n") ? "\n" : ""}${IGNORE_LINE}\n`;
  await writeFile(gi, next, "utf8");
  return { ignored: true, wrote: true };
}

export async function waitForNewEvents(
  projectDir,
  { since, timeoutMs = 15_000 } = {},
) {
  const start = since ? Date.parse(since) : Date.now();
  const deadline = Date.now() + Math.min(Number(timeoutMs) || 15_000, 60_000);
  while (Date.now() < deadline) {
    const events = await readEvents(projectDir);
    const fresh = events.filter((e) => Date.parse(e.at) > start);
    if (fresh.length) return fresh;
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

export function transcriptMarkdown(meta, events) {
  const lines = [
    `# ${meta.name} (${meta.id})`,
    ``,
    `Rooms by I-Ops · local export · network ${meta.network}`,
    ``,
  ];
  for (const ev of events) {
    lines.push(`## ${ev.at} · ${ev.type} · ${ev.actor} · ${ev.deviceId || "?"} (${ev.tool})`);
    lines.push("");
    lines.push(ev.text || "");
    if (ev.path) lines.push(`\nFile: \`${ev.path}\``);
    if (ev.diff) lines.push("\n```\n" + ev.diff + "\n```");
    lines.push("");
  }
  return lines.join("\n");
}

export async function readMeta(projectDir) {
  const { meta } = roomPaths(projectDir);
  return JSON.parse(await readFile(meta, "utf8"));
}

export async function readEvents(projectDir) {
  const { events } = roomPaths(projectDir);
  if (!(await exists(events))) return [];
  const raw = await readFile(events, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function appendEvent(projectDir, event) {
  const paths = roomPaths(projectDir);
  const idn = await identity();
  const branch = event.branch || (await resolveBranch(projectDir)) || "";
  const record = {
    id: eventId(),
    at: new Date().toISOString(),
    ...event,
    deviceId: event.deviceId || idn.deviceId,
    actor: event.actor || idn.displayName,
    tool: event.tool || idn.tool,
    branch: branch || event.branch || "",
  };
  await appendFile(paths.events, `${JSON.stringify(record)}\n`, "utf8");
  const meta = await readMeta(projectDir);
  const events = await readEvents(projectDir);
  await writeBoard(paths.board, meta, events, { projectDir });
  return record;
}

export async function refreshBoard(projectDir) {
  const paths = roomPaths(projectDir);
  const meta = await readMeta(projectDir);
  const events = await readEvents(projectDir);
  await writeBoard(paths.board, meta, events, { projectDir });
  return paths.board;
}

async function identity() {
  return loadIdentity();
}

async function actor() {
  const id = await identity();
  return id.displayName;
}

async function tool() {
  const id = await identity();
  return id.tool;
}

async function deviceId() {
  const id = await identity();
  return id.deviceId;
}

export async function initRoom({
  cwd = process.cwd(),
  name,
  code,
  share = false,
  homeFallback = false,
} = {}) {
  let projectDir = resolve(cwd);
  const existing = await findRoomDir(projectDir);
  if (existing) {
    const meta = await readMeta(existing);
    if (code && String(code).toUpperCase() !== meta.id) {
      throw new Error(`this project is room ${meta.id}, not ${String(code).toUpperCase()}`);
    }
    await refreshBoard(existing);
    return { projectDir: existing, meta, created: false };
  }

  if (homeFallback) {
    projectDir = join(homedir(), ".iops-rooms", "default");
  }

  const paths = roomPaths(projectDir);
  await mkdir(paths.root, { recursive: true });
  const meta = {
    version: 1,
    product: "Rooms by I-Ops",
    id: (code || roomCode()).toUpperCase(),
    name: name || "untitled",
    createdAt: new Date().toISOString(),
    createdBy: await actor(),
    network: "off",
    share,
  };
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await writeFile(paths.events, "", "utf8");
  await appendEvent(projectDir, {
    type: "system",
    text: `Room ${meta.id} created. Files stay in ${paths.root}. Network is off. Sync is among your devices only — not I-Ops cloud.`,
  });
  await ensureGitignore(projectDir, share);
  return { projectDir, meta, created: true };
}

export async function joinRoom({ cwd = process.cwd(), code, name } = {}) {
  if (!code || !String(code).trim()) {
    throw new Error("join needs a room code (from `rooms status`)");
  }
  const id = String(code).trim().toUpperCase();
  const found = await findRoomDir(cwd);
  if (found) {
    const meta = await readMeta(found);
    if (meta.id !== id) {
      throw new Error(`this project is room ${meta.id}, not ${id}`);
    }
    await refreshBoard(found);
    return { projectDir: found, meta, created: false };
  }
  return initRoom({ cwd, name, code: id });
}

export async function postNote(projectDir, { text, type = "note", extra = {} } = {}) {
  if (!text || !String(text).trim()) {
    throw new Error("Empty message");
  }
  return appendEvent(projectDir, {
    type,
    text: String(text).trim(),
    ...extra,
  });
}

export { actor, tool, deviceId, identity, loadIdentity };

export async function exportRoomBundle(projectDir, outDir) {
  const { cp } = await import("node:fs/promises");
  const paths = roomPaths(projectDir);
  await mkdir(outDir, { recursive: true });
  await cp(paths.root, outDir, { recursive: true });
  return outDir;
}

export async function importRoomBundle(bundleDir, projectDir = process.cwd()) {
  const { cp } = await import("node:fs/promises");
  const dest = roomPaths(projectDir).root;
  if (await exists(dest)) {
    throw new Error(`.room/ already exists at ${dest}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(bundleDir, dest, { recursive: true });
  await refreshBoard(projectDir);
  return { projectDir, meta: await readMeta(projectDir) };
}
