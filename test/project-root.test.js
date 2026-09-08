// A repository is one project, whichever directory inside it you happen to be standing in.
//
// `rooms open` in `src/api/` used to make `src/api/.room/` and call the project "api". Two people
// in the same repo working from different subdirectories got two different rooms; the `.gitignore`
// and the union merge driver landed in a subdirectory where git would not apply them to the events
// log; and every board and report was titled after a folder rather than the project.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../src/git-info.js";
import { findRoomDir } from "../src/store.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];

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

async function project(fn) {
  const base = await mkdtemp(join(tmpdir(), "iops-rooms-root-"));
  // macOS hands out /var/… which is a symlink to /private/var; git reports the resolved path.
  const dir = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: base })
    .then((r) => r.stdout.trim())
    .catch(() => base);
  void dir;
  try {
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: base });
    await mkdir(join(base, "src", "api"), { recursive: true });
    await writeFile(join(base, "src", "api", "thing.js"), "export const a = 1;\n", "utf8");
    await exec("git", [...IDENT, "add", "-A"], { cwd: base });
    await exec("git", [...IDENT, "commit", "-m", "first\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>"], { cwd: base });
    const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: base })).stdout.trim();
    await fn({ base, top, deep: join(base, "src", "api") });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("the project root is the repository, from any depth inside it", async () => {
  await project(async ({ base, top, deep }) => {
    const { realpath } = await import("node:fs/promises");
    assert.equal(await realpath(await resolveProjectRoot(deep)), await realpath(top));
    assert.equal(await realpath(await resolveProjectRoot(top)), await realpath(top));
  });
});

test("the answer is spelled the way the caller spelled it", async () => {
  // git reports the toplevel with symlinks resolved. On macOS a temp dir is /var/… while git says
  // /private/var/…, and a workspace under a symlinked home has the same problem for real: telling
  // someone their project lives at a path they have never typed is a small, constant confusion.
  await project(async ({ base, deep }) => {
    assert.equal(await resolveProjectRoot(base), base);
    assert.equal(await resolveProjectRoot(deep), base, "from a subdirectory too");
  });
});

test("a folder with no repo is its own project, rather than an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-norepo-"));
  try {
    // Not every project is a checkout, and a room in a plain folder is a supported thing.
    assert.equal(await resolveProjectRoot(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a room made from a subdirectory lands at the repository root", async () => {
  await project(async ({ base, deep }) => {
    const r = await run(deep, ["open"]);
    assert.equal(r.code, 0, r.err);
    // Not src/api/.room — that is a second room in the same repo, and the merge driver it writes
    // would sit in a directory git never consults for the events log at the root.
    assert.equal(await findRoomDir(deep), base);
    assert.equal(await findRoomDir(base), base);
    assert.match(r.out, /created room \w+ for/);

    // And a second run from a different subdirectory joins it rather than making another.
    const again = await run(base, ["open"]);
    assert.equal(again.code, 0, again.err);
    assert.doesNotMatch(again.out, /created room/, "one repository, one room");
  });
});

test("a report from a subdirectory is about the project, not the folder", async () => {
  await project(async ({ base, deep }) => {
    const here = await run(deep, ["week"]);
    assert.equal(here.code, 0, here.err);
    // `git log` already read the whole history from a subdirectory. What was wrong was the title:
    // "api · last 7d" for a repository called something else.
    assert.match(here.out, new RegExp(`^${join(base).split("/").pop()} · last`), here.out);
    assert.doesNotMatch(here.out.split("\n")[0], /^api /);
  });
});

test("a path you type is the file you meant, not the same name at the root", async () => {
  await project(async ({ deep }) => {
    const r = await run(deep, ["file", "thing.js"]);
    assert.equal(r.code, 0, r.err);
    // Typed in src/api/, so it means src/api/thing.js — rebased onto the root rather than
    // reinterpreted there, where it does not exist.
    assert.match(r.out, /^src\/api\/thing\.js/);
    assert.match(r.out, /1 commit/);
  });
});
