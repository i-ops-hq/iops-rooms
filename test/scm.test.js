// src/scm.js shells out to `gh` and parses what comes back. It was at zero coverage — untested
// code that runs an external binary and parses its output is the combination most likely to break
// silently when that binary changes its flags or its JSON.
//
// These never require `gh` to be installed or authenticated. The GitLab path is a stub with no
// external dependency, the missing-gh path is reachable by emptying PATH, and the formatter is
// pure. What is deliberately NOT tested here is a live `gh` call: that would pass or fail on the
// machine's auth state rather than on this code, which is the opposite of a test.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { scmStatus, formatScmStatus } from "../src/scm.js";

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-scm-"));
  await new Promise((res) => spawn("git", ["init", "-q", "."], { cwd: dir }).on("close", res));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("gitlab is an honest stub, not a silent empty result", async () => {
  await withRepo(async (dir) => {
    const s = await scmStatus(dir, { provider: "gitlab" });
    assert.equal(s.ok, false, "a stub must not report ok");
    assert.equal(s.provider, "gitlab");
    assert.match(s.message, /stub/i, "the message must say it is unimplemented");
    assert.ok(s.git, "the local git snapshot is still returned");
  });
});

test("provider matching is case-insensitive", async () => {
  await withRepo(async (dir) => {
    const s = await scmStatus(dir, { provider: "GitLab" });
    assert.equal(s.provider, "gitlab");
  });
});

test("without gh on PATH it degrades cleanly and still answers from local git", async () => {
  await withRepo(async (dir) => {
    const realPath = process.env.PATH;
    const empty = await mkdtemp(join(tmpdir(), "iops-rooms-nopath-"));
    process.env.PATH = empty; // nothing executable here, so `gh --version` cannot resolve
    try {
      const s = await scmStatus(dir);
      assert.equal(s.ok, false);
      assert.equal(s.provider, "github");
      assert.match(s.message, /gh not available/i);
      assert.match(s.message, /rooms branches/, "it must name what still works");
      assert.ok("localBranches" in s, "local git must still be reported when gh is absent");
    } finally {
      process.env.PATH = realPath;
      await rm(empty, { recursive: true, force: true });
    }
  });
});

test("the formatter renders a degraded result without inventing repo lines", () => {
  const out = formatScmStatus({
    ok: false,
    provider: "github",
    message: "gh not available.",
    current: "main",
    localBranches: ["main", "feature"],
  });
  assert.match(out, /^degraded {2}github/m);
  assert.match(out, /local {4}main/);
  assert.match(out, /local branches: main, feature/);
  assert.doesNotMatch(out, /repo {5}/, "no repo line when the read did not happen");
  assert.doesNotMatch(out, /prs {6}/, "and no PR summary either");
});

test("the formatter renders repo, default branch and open PRs", () => {
  const out = formatScmStatus({
    ok: true,
    provider: "github",
    message: "Read-only via gh on this machine.",
    current: "feature",
    localBranches: ["main", "feature"],
    repo: { nameWithOwner: "i-ops-hq/iops-rooms", defaultBranchRef: { name: "master" } },
    remoteBranches: ["master", "feature"],
    openPrs: [
      { number: 7, title: "Add a thing", headRefName: "feature", author: { login: "ada" }, isDraft: false },
      { number: 8, title: "Draft idea", headRefName: "wip", author: { login: "bob" }, isDraft: true },
    ],
  });
  assert.match(out, /^ok {2}github/m);
  assert.match(out, /repo {5}i-ops-hq\/iops-rooms/);
  assert.match(out, /default {2}master/);
  assert.match(out, /remote branches \(sample\): master, feature/);
  assert.match(out, /pr #7 {2}feature {2}@ada {2}Add a thing/);
  assert.match(out, /pr #8 draft {2}wip {2}@bob {2}Draft idea/, "draft state must be visible");
});

test("an ok result with no open PRs says so rather than showing nothing", () => {
  const out = formatScmStatus({
    ok: true,
    provider: "github",
    message: "ok",
    repo: { nameWithOwner: "a/b", defaultBranchRef: { name: "main" } },
    openPrs: [],
  });
  assert.match(out, /prs {6}\(none open\)/, "an empty list and a failed read must not look alike");
});

test("a missing default branch renders a question mark rather than undefined", () => {
  const out = formatScmStatus({
    ok: true,
    provider: "github",
    message: "ok",
    repo: { nameWithOwner: "a/b" },
    openPrs: [],
  });
  assert.match(out, /default {2}\?/);
  assert.doesNotMatch(out, /undefined/);
});
