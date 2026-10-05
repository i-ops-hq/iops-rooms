// Bare `rooms` starts where it is run: the project's name and branch, and the few commands that fit
// there, rather than all of them. A folder without git says why nothing can be read and what would
// change that; a folder of projects points into one of them; a project linked to a team room points
// to it. It writes nothing, and `rooms help` still lists every command.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { scratch as teamScratch, teamOfTwo } from "./team-helpers.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-start-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ROOMS_NO_OPEN: "1" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

async function commit(dir, file, message) {
  await mkdir(join(dir, file, ".."), { recursive: true });
  await writeFile(join(dir, file), `${file} ${Math.random()}\n`, "utf8");
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", message], { cwd: dir });
}

async function repo(dir, remote = "") {
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await commit(dir, "a.txt", "first");
  if (remote) await exec("git", ["remote", "add", "origin", remote], { cwd: dir });
}

test("in a project on its default branch: its name, its branch, and the commands that fit", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await repo(web, "https://github.com/acme/web.git");
    const before = (await readdir(web)).sort();
    const r = await run(web, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Rooms · acme\/web, on main\n\n/, "named as every clone names it");
    assert.match(r.out, /\n {2}rooms week +who built it this week, and which AI helped\n/);
    assert.match(r.out, /\n {2}rooms open +the board: commits, people, agents and branches\n/);
    assert.match(r.out, /\n {2}rooms team join +share your status with your team/);
    assert.doesNotMatch(r.out, /rooms branch/, "nothing to compare on the default branch");
    assert.match(r.out, /\nEvery command: rooms help\n$/);
    assert.ok(r.out.trim().split("\n").length <= 8, `a start, not every command:\n${r.out}`);
    assert.deepEqual((await readdir(web)).sort(), before, "it writes nothing");
  });
});

test("on another branch: how far it is from main, and that the week is read from main", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await repo(web);
    await exec("git", ["switch", "-q", "-c", "feature/x"], { cwd: web });
    await commit(web, "b.txt", "second");
    await commit(web, "c.txt", "third");
    const r = await run(web, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Rooms · web, on feature\/x \(2 commits not in main yet\)\n\n/);
    assert.match(r.out, /\n {2}rooms week +who built it this week, and which AI helped, read from main\n/);
    assert.match(r.out, /\n {2}rooms branch +what this branch adds, and which AI helped\n/);

    await exec("git", ["switch", "-q", "--detach", "HEAD~1"], { cwd: web });
    assert.match((await run(web, [])).out, /^Rooms · web, on a detached HEAD \(1 commit not in main yet\)\n/);
  });
});

test("in a folder without git: why nothing is read, and what would change that", async () => {
  await scratch(async (dir) => {
    const notes = join(dir, "notes");
    await mkdir(notes);
    await writeFile(join(notes, "todo.md"), "x\n");
    const r = await run(notes, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Rooms · notes, not a git repository\n\n/);
    assert.match(r.out, /comes from its git history, and this folder has none\.\n/);
    assert.match(r.out, /\n {2}git init +start a history here; Rooms reads it from the first commit\n/);
    assert.match(r.out, /\n {2}rooms open +a board for posts from you and your agents, without git\n/);
    assert.deepEqual(await readdir(notes), ["todo.md"], "it writes nothing");
  });
});

test("in a folder of projects: into one of them, never a history or a room here", async () => {
  await scratch(async (dir) => {
    const code = join(dir, "code");
    await repo(join(code, "web"));
    await repo(join(code, "my api"));
    const r = await run(code, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\nIt holds git repositories: my api, web\. Run rooms inside one of them:\n\n {2}cd 'my api'\n {2}rooms\n/);
    assert.doesNotMatch(r.out, /git init|rooms open/, "a folder of projects is not a project");
  });
});

test("in a project linked to a team room: the team's board and its setups", async () => {
  await teamScratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    const r = await alice.rooms(alice.web);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\n {2}rooms team board +your team's status, from \S+\n/);
    assert.match(r.out, /\n {2}rooms setup show +the AI setups your team shares\n/);
    assert.doesNotMatch(r.out, /rooms team join/, "already joined");
  });
});

test("where git cannot run, it says so, rather than calling a repository a plain folder", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await repo(web);
    const empty = join(dir, "no-tools");
    await mkdir(empty);
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli], { cwd: web, env: { ...process.env, PATH: empty, ROOMS_NO_OPEN: "1" } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /^Rooms · web\n\ngit is not on the PATH Rooms was started with/);
    assert.doesNotMatch(r.out, /not a git repository/);
  });
});

test("rooms help still lists every command", async () => {
  await scratch(async (dir) => {
    const r = await run(dir, ["help"]);
    assert.equal(r.code, 0, r.err);
    for (const line of ["rooms week", "rooms team init", "rooms setup export", "rooms hooks install", "rooms mcp install"]) {
      assert.ok(r.out.includes(line), `${line} is in rooms help`);
    }
  });
});
