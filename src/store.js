import { mkdir, readFile, writeFile, appendFile, access, lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { eventId, roomCode } from "./ids.js";
import { writeBoard } from "./board.js";
import {
  loadIdentity,
  stampEventIdentity,
  verifyEventIdentity,
} from "./identity.js";
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

/** Parse JSONL; soft-skip corrupt lines so one bad line cannot brick doctor/live/board. */
export function parseEventsJsonl(raw, { label = "events.jsonl" } = {}) {
  const out = [];
  const seen = new Set();
  let skipped = 0;
  let duplicates = 0;
  for (const line of String(raw || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      skipped += 1;
      continue;
    }
    // An id can legitimately arrive twice: `.room/events.jsonl` is committed with merge=union for
    // teams, and a union merge concatenates both sides rather than conflicting. mergeRoomBundle
    // already dedupes by id on the sync-merge path; every read now applies the same rule, so a
    // teammate's post cannot render twice on the board just because two people pulled it.
    if (ev && ev.id !== undefined) {
      if (seen.has(ev.id)) {
        duplicates += 1;
        continue;
      }
      seen.add(ev.id);
    }
    out.push(ev);
  }
  if (skipped > 0) {
    // Corrupt lines are not expected and are worth saying out loud. Duplicates ARE expected after
    // a union merge, so they are counted and returned rather than printed on every read.
    console.error(`[rooms] skipped ${skipped} corrupt JSONL line(s) in ${label}`);
  }
  return { events: out, skipped, duplicates };
}

/**
 * Refuse symlinks / non-regular files. Open with O_NOFOLLOW when available
 * so a TOCTOU swap to a symlink cannot redirect the read.
 */
export async function readAllowlistedRegularFile(filePath) {
  let st;
  try {
    st = await lstat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Missing required file: ${filePath}`);
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing symlink (not a regular file): ${filePath}`);
  }
  if (!st.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  const handle = await open(filePath, flags);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Copy only an allowlisted regular file (never trees, never follow symlinks). */
async function copyAllowlistedRegularFile(srcPath, destPath) {
  const body = await readAllowlistedRegularFile(srcPath);
  await writeFile(destPath, body, "utf8");
}

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

    // events.jsonl is an append-only log, so two people posting between pulls append different
    // lines at the same place and git conflicts every single time — which is the normal case for a
    // shared room, not an edge case. `merge=union` keeps both sides instead, which is exactly right
    // for an append-only log; parseEventsJsonl dedupes by id so a union can never double-render.
    await writeFile(
      join(paths.root, ".gitattributes"),
      `# An append-only log. Keep both sides of a merge instead of conflicting on every
# concurrent post; ids are unique and duplicate lines are dropped on read.
events.jsonl merge=union
`,
      "utf8",
    );

    // board.html is GENERATED from events.jsonl. Committing a 64 KB derived file guarantees a
    // second conflict on every merge and gains nothing — any read regenerates it.
    await writeFile(
      join(paths.root, ".gitignore"),
      `# Generated from events.jsonl on every read. Never commit it.
board.html
`,
      "utf8",
    );

    await writeFile(
      join(paths.root, "README.md"),
      `# This room is meant to be committed.

Commit \`room.json\`, \`events.jsonl\` and the two dotfiles beside them. **Not** \`board.html\` —
it is generated, and committing it conflicts on every merge for no benefit. Run \`rooms open\` or
\`rooms live\` to rebuild it.

\`.gitattributes\` sets \`merge=union\` on the log so concurrent posts merge instead of
conflicting. Duplicate ids are dropped when the log is read.

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
  return parseEventsJsonl(raw, { label: events }).events;
}

export async function appendEvent(projectDir, event) {
  const paths = roomPaths(projectDir);
  const idn = await identity();
  const branch = event.branch || (await resolveBranch(projectDir)) || "";
  // Reserved stamps (id, at) AFTER spread so callers cannot override them.
  let record = {
    ...event,
    deviceId: event.deviceId || idn.deviceId,
    actor: event.actor || idn.displayName,
    tool: event.tool || idn.tool,
    branch: branch || event.branch || "",
    id: eventId(),
    at: new Date().toISOString(),
  };
  // Verified GitHub/GitLab identity stamps + ed25519 sig (local only; env overrides = unverified).
  record = await stampEventIdentity(record, idn);
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


/** Treat CLI --name true/empty as omitted. */
export function normalizeRoomNameOpt(name) {
  if (name == null || name === true || name === false) return undefined;
  const s = String(name).trim();
  return s || undefined;
}

/** Prefer folder basename; fall back to git repo leaf; else untitled. Never throws. */
export async function deriveRoomName(projectDir) {
  try {
    const { basename } = await import("node:path");
    const leaf = basename(String(projectDir || "").replace(/[\\/]+$/, "") || ".");
    if (leaf && leaf !== "." && leaf !== ".." && leaf !== "/") return leaf;
  } catch { /* ignore */ }
  try {
    const { resolveGitRepoName } = await import("./git-info.js");
    const g = await resolveGitRepoName(projectDir);
    if (g) return g;
  } catch { /* ignore */ }
  return "untitled";
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
    name: (normalizeRoomNameOpt(name) || (await deriveRoomName(projectDir))),
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

export async function renameRoom(projectDir, name) {
  const paths = roomPaths(projectDir);
  const meta = await readMeta(projectDir);
  const next = String(name || "").trim();
  if (!next) throw new Error("rename needs a non-empty name");
  meta.name = next;
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await refreshBoard(projectDir);
  return meta;
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

export { actor, tool, deviceId, identity, loadIdentity, stampEventIdentity, verifyEventIdentity };

export async function exportRoomBundle(projectDir, outDir) {
  // Allowlist only: room.json + events.jsonl as regular files (never opaque tree cp).
  const paths = roomPaths(projectDir);
  await mkdir(outDir, { recursive: true });
  await copyAllowlistedRegularFile(paths.meta, join(outDir, META));
  await copyAllowlistedRegularFile(paths.events, join(outDir, EVENTS));
  return outDir;
}

export async function importRoomBundle(bundleDir, projectDir = process.cwd()) {
  const dest = roomPaths(projectDir).root;
  if (await exists(dest)) {
    throw new Error(`.room/ already exists at ${dest}. Use rooms sync-merge <dir> to union events.`);
  }
  await mkdir(dest, { recursive: true });
  // Copy ONLY allowlisted regular files — never board.html, never tree cp, never follow symlinks.
  await copyAllowlistedRegularFile(join(bundleDir, META), join(dest, META));
  await copyAllowlistedRegularFile(join(bundleDir, EVENTS), join(dest, EVENTS));
  // Always regenerate board.html locally from trusted templates + written data.
  await refreshBoard(projectDir);
  return { projectDir, meta: await readMeta(projectDir) };
}

/** Union events from a teammate bundle into this project's .room/ (by event id). Local-only. */
export async function mergeRoomBundle(bundleDir, projectDir = process.cwd()) {
  const local = roomPaths(projectDir);
  if (!(await exists(local.meta))) {
    throw new Error("No local room. Run rooms init (or import-room) first.");
  }
  const incomingMetaPath = join(bundleDir, META);
  const incomingEventsPath = join(bundleDir, EVENTS);
  // Reject missing / symlink / non-regular sources before reading.
  const metaRaw = await readAllowlistedRegularFile(incomingMetaPath);
  const eventsRaw = await readAllowlistedRegularFile(incomingEventsPath);
  const localMeta = await readMeta(projectDir);
  const incomingMeta = JSON.parse(metaRaw);
  if (incomingMeta.id && localMeta.id && incomingMeta.id !== localMeta.id) {
    throw new Error(
      `Room code mismatch: local ${localMeta.id} vs bundle ${incomingMeta.id}. Same room only.`,
    );
  }
  const existing = await readEvents(projectDir);
  const seen = new Set(existing.map((e) => e.id));
  const incoming = parseEventsJsonl(eventsRaw, { label: incomingEventsPath }).events;
  let added = 0;
  let warnBadGithub = 0;
  let warnBadGitlab = 0;
  for (const ev of incoming) {
    if (!ev?.id || seen.has(ev.id)) continue;
    // Warn-only: claimed github/gitlab without a valid ed25519 sig (do not hard-reject yet).
    const ghClaim = ev?.github?.login || ev?.githubLogin;
    const glClaim = ev?.gitlab?.username || ev?.gitlabUsername;
    if (ghClaim || glClaim) {
      const v = verifyEventIdentity(ev);
      if (!v.ok) {
        if (ghClaim) {
          warnBadGithub += 1;
          console.error(
            `[rooms] warn: event ${ev.id} claims github @${ghClaim} but sig check failed (${v.reason}) — imported anyway`,
          );
        }
        if (glClaim) {
          warnBadGitlab += 1;
          console.error(
            `[rooms] warn: event ${ev.id} claims gitlab @${glClaim} but sig check failed (${v.reason}) — imported anyway`,
          );
        }
      }
    }
    await appendFile(local.events, `${JSON.stringify(ev)}\n`, "utf8");
    seen.add(ev.id);
    added += 1;
  }
  await refreshBoard(projectDir);
  return { added, total: seen.size, meta: localMeta, warnBadGithub, warnBadGitlab };
}

