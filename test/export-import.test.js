import { mkdtemp, rm, access, writeFile, symlink, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  initRoom,
  postNote,
  importRoomBundle,
  mergeRoomBundle,
  appendEvent,
  readEvents,
  roomPaths,
} from "../src/store.js";
import { boardProjectName } from "../src/board.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

function run(cwd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out || `exit ${code}`)),
    );
  });
}

test("cli export-room and import-room work", async () => {
  const a = await mkdtemp(join(tmpdir(), "rooms-exp-a-"));
  const b = await mkdtemp(join(tmpdir(), "rooms-exp-b-"));
  const bundle = join(a, "bundle");
  try {
    await initRoom({ cwd: a, name: "exp", code: "EXPORT" });
    await postNote(a, { text: "bundle me" });
    const out = await run(a, ["export-room", bundle]);
    assert.match(out, /exported/);
    await access(join(bundle, "room.json"));
    const imp = await run(b, ["import-room", bundle]);
    assert.match(imp, /imported/);
    await access(join(b, ".room", "board.html"));
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("import refuses symlink board.html escape (never tree-copies board)", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "rooms-mal-board-"));
  const project = await mkdtemp(join(tmpdir(), "rooms-imp-board-"));
  const outside = join(project, "OUTSIDE_SHOULD_NOT_EXIST.txt");
  try {
    await writeFile(
      join(bundle, "room.json"),
      JSON.stringify({
        version: 1,
        product: "Rooms by I-Ops",
        id: "MALBRD",
        name: "mal-board",
        createdAt: new Date().toISOString(),
        createdBy: "test",
        network: "off",
        share: false,
      }) + "\n",
      "utf8",
    );
    await writeFile(join(bundle, "events.jsonl"), "", "utf8");
    // Malicious: board.html as symlink pointing outside the eventual .room/
    await symlink(outside, join(bundle, "board.html"));
    // Also plant a decoy payload that would be written if someone followed/copied the link target tree-style
    await writeFile(join(bundle, "pwn.txt"), "pwned\n", "utf8");

    await importRoomBundle(bundle, project);

    // Destination board must be a regenerated regular file, not a symlink
    const boardPath = roomPaths(project).board;
    const st = await lstat(boardPath);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    const html = await readFile(boardPath, "utf8");
    assert.match(html, /Rooms · mal-board/);
    // Outside path must NOT have been created/written via symlink escape
    let outsideExists = true;
    try {
      await access(outside);
    } catch {
      outsideExists = false;
    }
    assert.equal(outsideExists, false);
    // Extraneous bundle files must not land in .room/
    let pwnInRoom = true;
    try {
      await access(join(project, ".room", "pwn.txt"));
    } catch {
      pwnInRoom = false;
    }
    assert.equal(pwnInRoom, false);
  } finally {
    await rm(bundle, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("import/merge refuse symlink events.jsonl (no /etc/passwd-style read)", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "rooms-mal-ev-"));
  const project = await mkdtemp(join(tmpdir(), "rooms-imp-ev-"));
  try {
    await writeFile(
      join(bundle, "room.json"),
      JSON.stringify({
        version: 1,
        product: "Rooms by I-Ops",
        id: "MALEV",
        name: "mal-ev",
        createdAt: new Date().toISOString(),
        createdBy: "test",
        network: "off",
        share: false,
      }) + "\n",
      "utf8",
    );
    await symlink("/etc/passwd", join(bundle, "events.jsonl"));

    await assert.rejects(
      () => importRoomBundle(bundle, project),
      /symlink|regular file/i,
    );

    // Local room for merge path
    await initRoom({ cwd: project, name: "local", code: "MALEV" });
    await assert.rejects(
      () => mergeRoomBundle(bundle, project),
      /symlink|regular file/i,
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("readEvents soft-skips bad JSONL lines and keeps good events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-bad-jsonl-"));
  try {
    await initRoom({ cwd: dir, name: "jsonl" });
    const paths = roomPaths(dir);
    await writeFile(
      paths.events,
      [
        JSON.stringify({
          id: "aaaaaaaaaaaaaaaa",
          at: "2026-01-01T00:00:00.000Z",
          type: "note",
          text: "keep-me",
          actor: "A",
          tool: "cli",
          deviceId: "d1",
        }),
        "{not-json",
        JSON.stringify({
          id: "bbbbbbbbbbbbbbbb",
          at: "2026-01-01T00:00:01.000Z",
          type: "note",
          text: "also-keep",
          actor: "A",
          tool: "cli",
          deviceId: "d1",
        }),
        "",
      ].join("\n") + "\n",
      "utf8",
    );
    const events = await readEvents(dir);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.text),
      ["keep-me", "also-keep"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendEvent ignores attacker-supplied id/at in payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-append-stamp-"));
  try {
    await initRoom({ cwd: dir, name: "stamp" });
    const before = Date.now();
    const record = await appendEvent(dir, {
      type: "note",
      text: "hi",
      id: "attacker-id-should-not-win",
      at: "1999-01-01T00:00:00.000Z",
    });
    assert.notEqual(record.id, "attacker-id-should-not-win");
    assert.notEqual(record.at, "1999-01-01T00:00:00.000Z");
    assert.ok(Date.parse(record.at) >= before - 1000);
    assert.match(record.id, /^[a-f0-9]+$/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty board shows Nothing posted yet banner; title uses Rooms · name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-empty-banner-"));
  try {
    const { meta } = await initRoom({ cwd: dir, name: "Homework", code: "EMPTY1" });
    const html = await readFile(roomPaths(dir).board, "utf8");
    assert.match(html, /Nothing posted yet/);
    assert.match(html, /rooms post/);
    assert.match(html, /post_note/);
    assert.match(html, /hooks install/);
    assert.match(html, /not IDE telemetry/);
    assert.match(html, /<title>Rooms · Homework<\/title>/);
    assert.match(html, /<h1 class="h-display">Rooms · Homework<\/h1>/);
    assert.match(html, /<b>0<\/b><span>posters<\/span>/);
    assert.match(html, /No posts yet —/);
    assert.doesNotMatch(html, /1 poster —/);
    assert.equal(boardProjectName({ name: "untitled" }, dir), basename(dir));
    assert.equal(boardProjectName(meta, dir), "Homework");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
