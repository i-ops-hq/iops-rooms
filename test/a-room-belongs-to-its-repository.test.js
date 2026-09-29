// A room belongs to the repository it is in, and every worktree of that repository shares it.
//
// `rooms open` in the folder holding someone's projects made a room there. Because finding a room
// walked up to the filesystem root, every repository under that folder then found it and opened its
// board, which can read none of them: "no git" from inside a repository with a full history, however
// many times the person moved to the right folder and tried again. Checked against the published
// 0.5.9 before this was written.
//
// Worktrees were the other side of the same search. One beside the main checkout found no room, and
// one nested inside it found the room only because the folders happened to line up.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findRoomDir, initRoom } from "../src/store.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];

const exists = (p) => access(p).then(() => true, () => false);
const same = async (a, b) => (await realpath(a)) === (await realpath(b));

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-home-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function repoAt(dir) {
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "main.go"), "package main\n", "utf8");
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", "real history"], { cwd: dir });
  return dir;
}

function run(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ROOMS_TOOL: "test" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("a room in the folder above a repository is not that repository's room", async () => {
  await scratch(async (dir) => {
    const api = await repoAt(join(dir, "work", "api"));
    // What an earlier version left behind after `rooms open` in the folder holding the projects.
    await initRoom({ cwd: join(dir, "work") });
    assert.ok(await exists(join(dir, "work", ".room", "room.json")), "the setup made the stray room");

    assert.equal(await findRoomDir(api), null, "the search stops at the top of the repository");
    const opened = await run(api, ["open"]);
    assert.equal(opened.code, 0, opened.err);
    assert.ok(await exists(join(api, ".room", "room.json")), "the repository gets a room of its own");
    const board = await readFile(join(api, ".room", "board.html"), "utf8");
    assert.match(board, /local repository/, "and its board reads the repository");
    assert.doesNotMatch(board, /not a git checkout/);
  });
});

test("rooms open in the folder that holds repositories names them and creates nothing", async () => {
  await scratch(async (dir) => {
    const work = join(dir, "work");
    await repoAt(join(work, "api"));
    await repoAt(join(work, "clients", "web"));
    const opened = await run(work, ["open"]);
    assert.equal(opened.code, 1);
    assert.match(opened.err, /not a git repository\. It holds 2: api, clients\/web\./);
    assert.match(opened.err, /Nothing was created here/);
    assert.equal(await exists(join(work, ".room")), false, "no room");
    assert.equal(await exists(join(work, ".gitignore")), false, "and no .gitignore");
  });
});

test("a room already made in that folder still opens, and says why its board is empty", async () => {
  await scratch(async (dir) => {
    const work = join(dir, "work");
    await repoAt(join(work, "api"));
    await initRoom({ cwd: work });
    const opened = await run(work, ["open"]);
    assert.equal(opened.code, 0, opened.err);
    assert.match(opened.err, /It holds 1: api\.\s+Run rooms open inside one of them to see its history/);
  });
});

test("a plain folder with no repositories still gets a room, and says it holds posts only", async () => {
  await scratch(async (dir) => {
    const notes = join(dir, "notes");
    await mkdir(notes);
    const opened = await run(notes, ["open"]);
    assert.equal(opened.code, 0, opened.err);
    assert.match(opened.out, /not a git repository, so its board will hold room posts only/);
    assert.ok(await exists(join(notes, ".room", "room.json")));
  });
});

test("every worktree of a repository finds the main checkout's room", async () => {
  await scratch(async (dir) => {
    const main = await repoAt(join(dir, "app"));
    const beside = join(dir, "app-feature");
    const nested = join(main, ".claude", "worktrees", "agent-1");
    await exec("git", ["worktree", "add", "-q", beside, "-b", "feature"], { cwd: main });
    await exec("git", ["worktree", "add", "-q", nested, "-b", "agent-1"], { cwd: main });

    // With no room anywhere, one made from a worktree beside the main checkout lands in the main one.
    const made = await initRoom({ cwd: beside });
    assert.ok(await same(made.projectDir, main), `made at ${made.projectDir}, not the main checkout`);
    assert.equal(await exists(join(beside, ".room")), false, "nothing in the worktree");

    for (const [where, from] of [["the main checkout", main], ["a worktree beside it", beside], ["a worktree nested in it", nested]]) {
      const found = await findRoomDir(from);
      assert.ok(found, `${where} found no room`);
      assert.ok(await same(found, main), `${where} found ${found}`);
    }
  });
});
