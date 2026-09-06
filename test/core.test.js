import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, joinRoom, postNote, readEvents, roomPaths } from "../src/store.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-"));
}

test("init writes local room, gitignore, and offline board", async () => {
  const dir = await tmp();
  try {
    const { meta, created } = await initRoom({ cwd: dir, name: "homework" });
    assert.equal(created, true);
    assert.equal(meta.network, "off");
    assert.match(meta.id, /^[A-Z2-9]{6}$/);
    const paths = roomPaths(dir);
    const html = await readFile(paths.board, "utf8");
    assert.doesNotMatch(html, /https?:\/\//);
    assert.match(html, /I-Ops · Rooms/);
    assert.match(html, /homework/);
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(gi, /^\.room\/$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("share mode does not gitignore and writes a room README", async () => {
  const dir = await tmp();
  try {
    await initRoom({ cwd: dir, name: "team", share: true });
    await assert.rejects(() => readFile(join(dir, ".gitignore")));
    const readme = await readFile(join(dir, ".room", "README.md"), "utf8");
    assert.match(readme, /committed/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("join matches code; rejects a different code", async () => {
  const dir = await tmp();
  try {
    const { meta } = await initRoom({ cwd: dir, name: "a" });
    const again = await joinRoom({ cwd: dir, code: meta.id });
    assert.equal(again.created, false);
    await assert.rejects(() => joinRoom({ cwd: dir, code: "XXXXXX" }), /not XXXXXX/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("post, review, approve, diff, export", async () => {
  const dir = await tmp();
  try {
    await initRoom({ cwd: dir, name: "flow" });
    await postNote(dir, { text: "hello" });
    await postNote(dir, { type: "diff", text: "patch", extra: { path: "a.js", diff: "-a\n+b" } });
    await postNote(dir, { type: "review_requested", text: "look" });
    await postNote(dir, { type: "approved", text: "ok" });
    const events = await readEvents(dir);
    assert.equal(events.map((e) => e.type).join(","), "system,note,diff,review_requested,approved");
    const html = await readFile(roomPaths(dir).board, "utf8");
    assert.match(html, /data-tone="approved"/);
    assert.doesNotMatch(html, /fonts\.googleapis/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("index finds rooms in sibling project folders", async () => {
  const parent = await tmp();
  try {
    const a = join(parent, "alpha");
    const b = join(parent, "beta");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await initRoom({ cwd: a, name: "alpha" });
    await initRoom({ cwd: b, name: "beta" });
    const { listRooms } = await import("../src/scan.js");
    const rooms = await listRooms([parent]);
    assert.equal(rooms.length, 2);
    assert.deepEqual(rooms.map((r) => r.name).sort(), ["alpha", "beta"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("cli whoami and status in a room", async () => {
  const dir = await tmp();
  try {
    await initRoom({ cwd: dir, name: "cli" });
    const out = await runCli(dir, ["status"]);
    assert.match(out, /network {2}off/);
    assert.match(out, /cli/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source does not open the network", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(root, "src"));
  for (const f of files) {
    const src = await readFile(join(root, "src", f), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.doesNotMatch(src, /from ["']node:https/);
    // live.js may use node:http bound to 127.0.0.1 only — never other src files
    if (f === "live.js") {
      assert.match(src, /127\.0\.0\.1/);
      assert.doesNotMatch(src, /0\.0\.0\.0/);
      continue;
    }
    assert.doesNotMatch(src, /from ["']node:http/);
    assert.doesNotMatch(src, /from ["']node:net/);
  }
});

function runCli(cwd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_ACTOR: "test" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || out || `exit ${code}`));
    });
  });
}

test("two devices stamp distinct deviceId and both appear on the board", async () => {
  const dir = await tmp();
  const homeA = await tmp();
  const homeB = await tmp();
  try {
    await initRoom({ cwd: dir, name: "pair" });
    const outA = await runCliEnv(dir, ["post", "hello from A"], {
      HOME: homeA,
      ROOMS_ACTOR: "Ada",
      ROOMS_TOOL: "cli",
      ROOMS_DEVICE_ID: "devaaaa1",
    });
    const outB = await runCliEnv(dir, ["post", "hello from B"], {
      HOME: homeB,
      ROOMS_ACTOR: "Ben",
      ROOMS_TOOL: "mcp",
      ROOMS_DEVICE_ID: "devbbbb2",
    });
    assert.match(outA, /^[a-f0-9]+/);
    assert.match(outB, /^[a-f0-9]+/);
    const events = await readEvents(dir);
    const notes = events.filter((e) => e.type === "note");
    assert.equal(notes.length, 2);
    assert.equal(notes[0].actor, "Ada");
    assert.equal(notes[0].deviceId, "devaaaa1");
    assert.equal(notes[1].actor, "Ben");
    assert.equal(notes[1].deviceId, "devbbbb2");
    const html = await readFile(roomPaths(dir).board, "utf8");
    assert.match(html, /Ada/);
    assert.match(html, /Ben/);
    assert.match(html, /2 posters/);
    assert.match(html, /cli/);
    assert.match(html, /mcp/);
    assert.match(html, /does not phone home/i);
    assert.match(html, /Two people/);
    assert.match(html, /files stay in this folder/);
    assert.doesNotMatch(html, /Vinci|assurance|Control Room|harness|governed/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
  }
});

test("whoami prints deviceId", async () => {
  const dir = await tmp();
  const home = await tmp();
  try {
    await initRoom({ cwd: dir, name: "id" });
    const out = await runCliEnv(dir, ["whoami"], {
      HOME: home,
      ROOMS_ACTOR: "Casey",
      ROOMS_DEVICE_ID: "devcasey",
      ROOMS_TOOL: "cli",
    });
    assert.match(out, /actor\s+Casey/);
    assert.match(out, /deviceId\s+devcasey/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

function runCliEnv(cwd, argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || out || `exit ${code}`));
    });
  });
}
