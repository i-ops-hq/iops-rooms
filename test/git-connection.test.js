// What the board says about this checkout: the remote, whether the tree is clean, and how far the
// branch is from its upstream.
//
// Against real repositories rather than a stubbed git. The whole value of these three facts is that
// they are true of the machine the board was written on, and a stub would only prove that the
// parsing matches the stub. Everything here builds its own repo in a temp directory.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readGitSnapshot, sanitizeRemote } from "../src/git-info.js";

const exec = promisify(execFile);
// -c on every call: a CI runner has no user.name, and configuring it globally would be this test
// changing the machine it runs on.
const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd, args) => exec("git", [...IDENT, ...args], { cwd });

async function commit(dir, name, body) {
  await writeFile(join(dir, name), body, "utf8");
  await git(dir, ["add", name]);
  await git(dir, ["commit", "-m", `add ${name}`]);
}

async function withRepos(fn) {
  const root = await mkdtemp(join(tmpdir(), "iops-rooms-git-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  try {
    await exec("git", ["init", "--bare", "-b", "main", origin]);
    await exec("git", ["clone", origin, work]);
    await fn({ root, origin, work });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a clone reports its remote, its branch and a clean tree", async () => {
  await withRepos(async ({ origin, work }) => {
    await commit(work, "a.txt", "one\n");
    await git(work, ["push", "-u", "origin", "main"]);

    const s = await readGitSnapshot(work);
    assert.equal(s.ok, true);
    assert.equal(s.current, "main");
    assert.equal(s.dirty, 0, "nothing uncommitted");
    assert.equal(s.upstream, "origin/main");
    assert.equal(s.ahead, 0);
    assert.equal(s.behind, 0);
    // A local path is not a host/owner/repo, so there is nothing honest to print for it.
    assert.equal(s.remote, null, `a filesystem remote (${origin}) is not a forge URL`);
  });
});

test("uncommitted work is counted, not summarised as a mood", async () => {
  await withRepos(async ({ work }) => {
    await commit(work, "a.txt", "one\n");
    await writeFile(join(work, "a.txt"), "changed\n", "utf8");
    await writeFile(join(work, "b.txt"), "new\n", "utf8");
    const s = await readGitSnapshot(work);
    assert.equal(s.dirty, 2, "one modified and one untracked");
  });
});

test("ahead and behind are counted against the upstream, in the right direction", async () => {
  await withRepos(async ({ origin, work, root }) => {
    await commit(work, "a.txt", "one\n");
    await git(work, ["push", "-u", "origin", "main"]);

    // A second clone pushes, so the first is genuinely behind rather than simulated as behind.
    const other = join(root, "other");
    await exec("git", ["clone", origin, other]);
    await commit(other, "b.txt", "two\n");
    await git(other, ["push"]);

    await commit(work, "c.txt", "three\n");
    await commit(work, "d.txt", "four\n");
    await git(work, ["fetch"]);

    const s = await readGitSnapshot(work);
    assert.equal(s.ahead, 2, "two local commits the upstream does not have");
    assert.equal(s.behind, 1, "and one upstream commit this clone does not");
  });
});

test("a repo with no remote says so rather than reporting an empty one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-solo-"));
  try {
    await exec("git", ["init", "-b", "main", dir]);
    await commit(dir, "a.txt", "one\n");
    const s = await readGitSnapshot(dir);
    assert.equal(s.ok, true);
    assert.equal(s.remote, null);
    assert.equal(s.upstream, "", "no upstream to be ahead or behind of");
    assert.equal(s.ahead, null, "null, not 0 — there is nothing to compare against");
    assert.equal(s.behind, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a GitHub remote is reduced to host and path, whatever form it was configured in", async () => {
  await withRepos(async ({ work }) => {
    await commit(work, "a.txt", "one\n");
    for (const [url, label] of [
      ["https://github.com/o/r.git", "github.com/o/r"],
      ["git@github.com:o/r.git", "github.com/o/r"],
      ["https://x-access-token:ghp_secret@github.com/o/r.git", "github.com/o/r"],
    ]) {
      await git(work, ["remote", "set-url", "origin", url]);
      const s = await readGitSnapshot(work);
      assert.equal(s.remote.label, label);
      assert.ok(!JSON.stringify(s).includes("ghp_"), "and no credential survives into the snapshot");
    }
  });
});

test("a URL git accepts but cannot be parsed is dropped, not half-rendered", () => {
  assert.equal(sanitizeRemote("https://"), null);
  assert.equal(sanitizeRemote("://nope"), null);
  assert.equal(sanitizeRemote("https://github.com"), null, "a host with no path names no repo");
  assert.equal(sanitizeRemote("../relative/repo"), null);
});

test("a folder that is not a checkout is reported as one, and never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-nogit-"));
  const prev = process.env.ROOMS_BRANCH;
  delete process.env.ROOMS_BRANCH;
  try {
    const s = await readGitSnapshot(dir);
    assert.equal(s.ok, false);
    assert.match(s.note, /Not a git checkout/);
  } finally {
    if (prev !== undefined) process.env.ROOMS_BRANCH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
