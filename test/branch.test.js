import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, postNote, readEvents, roomPaths } from "../src/store.js";

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-branch-"));
}

function run(cwd, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || String(code)))));
  });
}

test("posts stamp branch from ROOMS_BRANCH and board shows it", async () => {
  const dir = await tmp();
  const prev = process.env.ROOMS_BRANCH;
  try {
    process.env.ROOMS_BRANCH = "feature/slice-2";
    await initRoom({ cwd: dir, name: "branch-room" });
    await postNote(dir, { text: "on feature branch" });
    const events = await readEvents(dir);
    const note = events.find((e) => e.type === "note");
    assert.equal(note.branch, "feature/slice-2");
    const html = await import("node:fs/promises").then((fs) =>
      fs.readFile(roomPaths(dir).board, "utf8"),
    );
    assert.match(html, /feature\/slice-2/);
    assert.match(html, /branch-panel|Branches/);
  } finally {
    if (prev === undefined) delete process.env.ROOMS_BRANCH;
    else process.env.ROOMS_BRANCH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("git checkout branch is stamped when ROOMS_BRANCH unset", async () => {
  const dir = await tmp();
  const prev = process.env.ROOMS_BRANCH;
  try {
    delete process.env.ROOMS_BRANCH;
    await run(dir, "git", ["init"]);
    await run(dir, "git", ["config", "user.email", "rooms@test.local"]);
    await run(dir, "git", ["config", "user.name", "Rooms Test"]);
    await writeFile(join(dir, "README"), "x\n", "utf8");
    await run(dir, "git", ["add", "README"]);
    await run(dir, "git", ["commit", "-m", "init"]);
    await run(dir, "git", ["checkout", "-b", "dogfood-branch"]);
    await initRoom({ cwd: dir, name: "git-branch-room" });
    await postNote(dir, { text: "from git branch" });
    const events = await readEvents(dir);
    const note = events.find((e) => e.type === "note");
    assert.equal(note.branch, "dogfood-branch");
  } finally {
    if (prev === undefined) delete process.env.ROOMS_BRANCH;
    else process.env.ROOMS_BRANCH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
