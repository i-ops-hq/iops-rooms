// "Right now": this checkout as it stands, on the board's Git card and at the end of `rooms week`.
// What is not committed, as counts; where the branch is against its upstream; and its pull request,
// asked of GitHub through the person's own `gh`.
//
// The pull request line has one way to be right and several ways to not know. "No pull request
// yet" is said only when GitHub says there is none: no `gh`, `gh` signed out, or no answer in time
// are each "unknown", with the reason, because a team reading "no pull request yet" acts on it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readGitSnapshot } from "../src/git-info.js";
import { branchPullRequest, pullRequestWords } from "../src/scm.js";
import { renderHeroSide } from "../src/board.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-now-"));
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
    child.stdin.end("");
  });
}

const g = (dir, ...args) => exec("git", [...IDENT, ...args], { cwd: dir });

/** git's own count of what is not committed, file by file, to check the snapshot's sums against. */
async function numstat(dir) {
  const { stdout } = await exec("git", ["diff", "--numstat", "HEAD"], { cwd: dir });
  let added = 0;
  let removed = 0;
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    added += Number(a);
    removed += Number(r);
  }
  return { files: stdout.split("\n").filter(Boolean).length, added, removed };
}

test("the uncommitted counts are git's own: tracked files and their lines, and new files apart", async () => {
  await scratch(async (dir) => {
    await g(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(dir, "b.txt"), "b\n", "utf8");
    await g(dir, "add", "-A");
    await g(dir, "commit", "-q", "-m", "first");
    assert.deepEqual((await readGitSnapshot(dir)).uncommitted, { files: 0, added: 0, removed: 0, untracked: 0 });

    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\nfour\nfive\n", "utf8");
    await writeFile(join(dir, "b.txt"), "b\nstaged\n", "utf8");
    await g(dir, "add", "b.txt");
    await writeFile(join(dir, "new.txt"), "not added yet\n", "utf8");
    const { uncommitted } = await readGitSnapshot(dir);
    const own = await numstat(dir);
    assert.equal(own.files, 2);
    assert.deepEqual(uncommitted, { ...own, untracked: 1 }, "staged and unstaged together, as git diff HEAD counts them");
  });
});

test("before the first commit the lines are not known, and are not reported as none", async () => {
  await scratch(async (dir) => {
    await g(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await g(dir, "add", "a.txt");
    assert.deepEqual((await readGitSnapshot(dir)).uncommitted, { files: 1, added: null, removed: null, untracked: 0 });
  });
});

test("the board's Git card and rooms week say the same three lines about this checkout", async () => {
  await scratch(async (root) => {
    const origin = join(root, "origin.git");
    const dir = join(root, "work");
    await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
    await exec("git", ["clone", "-q", origin, dir]);
    // Read as a GitHub repository, pushed to a folder: the whole chain runs, and nothing leaves.
    await g(dir, "remote", "set-url", "origin", "https://github.com/o/r.git");
    await g(dir, "remote", "set-url", "--push", "origin", origin);
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    await g(dir, "add", "-A");
    await g(dir, "commit", "-q", "-m", "first");
    await g(dir, "push", "-q", "-u", "origin", "main");
    await g(dir, "switch", "-q", "-c", "feat");
    await g(dir, "push", "-q", "-u", "origin", "feat");
    for (const n of [1, 2]) {
      await writeFile(join(dir, `c${n}.txt`), `${n}\n`, "utf8");
      await g(dir, "add", "-A");
      await g(dir, "commit", "-q", "-m", `local ${n}`);
    }
    await writeFile(join(dir, "a.txt"), "a\nmore\n", "utf8");
    await writeFile(join(dir, "fresh.txt"), "fresh\n", "utf8");
    await run(dir, ["init"]);

    const week = await run(dir, ["week"]);
    assert.equal(week.code, 0, week.err);
    const block = week.out.slice(week.out.indexOf("\nRight now"));
    const lines = block.split("\n").slice(2).filter(Boolean).map((l) => l.trim());
    assert.deepEqual(lines, [
      // fresh.txt, and the .gitignore `rooms init` wrote; .room/ itself is ignored.
      "uncommitted: +1 −0 in 1 file, and 2 new files",
      "2 ahead origin/feat",
      "pull request unknown: ROOMS_NO_GH is set",
    ]);
    assert.match(block, /^\nRight now, in this checkout \(feat\):\n/);

    await run(dir, ["open"]);
    const card = (await readFile(join(dir, ".room", "board.html"), "utf8")).match(/<span class="side-title">Git<\/span>[\s\S]*?<\/div>/)[0];
    const flags = [...card.matchAll(/<span class="side-flag"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(flags, lines, "the same words on both surfaces");

    // Pushed without an upstream still counts as on the remote; a branch only here does not.
    await g(dir, "switch", "-q", "-c", "no-upstream");
    await g(dir, "push", "-q", "origin", "no-upstream");
    assert.equal((await readGitSnapshot(dir)).published, true);
    await g(dir, "switch", "-q", "-c", "only-here");
    assert.equal((await readGitSnapshot(dir)).published, false);
    const local = await run(dir, ["week"]);
    assert.match(local.out, /\n {2}not pushed yet, so no pull request\n$/);
    await g(dir, "switch", "-q", "feat");

    const { now } = JSON.parse((await run(dir, ["week", "--json"])).out);
    assert.deepEqual(now, {
      branch: "feat",
      uncommitted: { files: 1, added: 1, removed: 0, untracked: 2 },
      upstream: "origin/feat",
      ahead: 2,
      behind: 0,
      pr: { state: "unknown", why: "ROOMS_NO_GH is set" },
    });
  });
});

test("the pull request reader tells 'none' from every way of not knowing", async () => {
  const git = (branch = "feat") => ({ ok: true, current: branch, defaultBranch: "main", remote: { label: "github.com/o/r" }, published: true });
  let dirs = 0;
  // A fresh project path each time, so the minute-long memory of one case never answers another.
  const ask = async (answer, opts = {}) => {
    const calls = [];
    const runGh = async (cwd, cmd, args) => {
      calls.push([cmd, ...args]);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const pr = await branchPullRequest(`/p/${++dirs}`, opts.git || git(), { env: opts.env || {}, runGh, now: 1000 });
    return { pr, calls };
  };
  const fail = (fields) => Object.assign(new Error("gh failed"), fields);

  const open = await ask(JSON.stringify({ number: 7, state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/7" }));
  assert.deepEqual(open.pr, { state: "open", number: 7, url: "https://github.com/o/r/pull/7" });
  assert.deepEqual(open.calls, [["gh", "pr", "view", "feat", "--json", "number,state,isDraft,url"]], "the branch is named, and nothing else is asked");
  assert.equal((await ask(JSON.stringify({ number: 8, state: "OPEN", isDraft: true }))).pr.state, "draft");
  assert.equal((await ask(JSON.stringify({ number: 9, state: "MERGED" }))).pr.state, "merged");
  assert.equal((await ask(JSON.stringify({ number: 10, state: "CLOSED" }))).pr.state, "closed");

  assert.deepEqual((await ask(fail({ stderr: 'no pull requests found for branch "feat"' }))).pr, { state: "none" });
  const cases = [
    [fail({ code: "ENOENT" }), "gh is not installed"],
    [fail({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }), "gh is not signed in"],
    [fail({ killed: true, signal: "SIGTERM" }), "GitHub did not answer in time"],
    [fail({ stderr: "none of the git remotes configured for this repository point to a known GitHub host" }), "the remote is not on GitHub"],
    [fail({ stderr: "HTTP 502: something else" }), "gh could not say"],
    ["{}", "gh answered in a shape this version does not read"],
  ];
  for (const [answer, why] of cases) assert.deepEqual((await ask(answer)).pr, { state: "unknown", why }, why);

  const off = await ask("{}", { env: { ROOMS_NO_GH: "1" } });
  assert.deepEqual([off.pr, off.calls.length], [{ state: "unknown", why: "ROOMS_NO_GH is set" }, 0]);
  const onMain = await ask("{}", { git: git("main") });
  assert.deepEqual([onMain.pr, onMain.calls.length], [{ state: "default-branch" }, 0]);
  const noRemote = await ask("{}", { git: { ...git(), remote: null } });
  assert.deepEqual([noRemote.pr.state, noRemote.calls.length], ["unknown", 0]);
  // A branch the remote does not have: known without asking, and its name is never sent.
  const local = await ask("{}", { git: { ...git("fix-the-ceo-bug"), published: false } });
  assert.deepEqual([local.pr, local.calls.length], [{ state: "unpushed" }, 0]);
  const localOffline = await ask("{}", { git: { ...git("x"), published: false }, env: { ROOMS_NO_GH: "1" } });
  assert.deepEqual(localOffline.pr, { state: "unpushed" }, "what is known locally is said even with the question off");

  assert.equal(pullRequestWords({ state: "none" }), "no pull request yet");
  assert.equal(pullRequestWords({ state: "unpushed" }), "not pushed yet, so no pull request");
  assert.equal(pullRequestWords({ state: "open", number: 7 }), "pull request #7, open");
  assert.equal(pullRequestWords({ state: "draft", number: 8 }), "pull request #8, a draft");
  assert.equal(pullRequestWords({ state: "closed", number: 10 }), "pull request #10, closed without merging");
  assert.equal(pullRequestWords({ state: "unknown", why: "gh is not installed" }), "pull request unknown: gh is not installed");
  assert.equal(pullRequestWords({ state: "default-branch" }), "", "on the default branch nothing is said");
});

test("a live board asks GitHub at most once a minute per branch", async () => {
  let calls = 0;
  const runGh = async () => {
    calls += 1;
    return JSON.stringify({ number: 3, state: "OPEN", isDraft: false });
  };
  const git = { ok: true, current: "feat", defaultBranch: "main", remote: { label: "github.com/o/r" }, published: true };
  const at = (now) => branchPullRequest("/cached/project", git, { env: {}, runGh, now });
  await at(1_000);
  await at(30_000);
  assert.equal(calls, 1, "the second, 29 s later, is answered from memory");
  await at(62_000);
  assert.equal(calls, 2, "and after a minute GitHub is asked again");
});

test("the card marks a pull request by what it asks of the reader: none yet warns, not pushed is neutral", () => {
  const git = { ok: true, current: "feat", head: "abc1234", remote: { label: "github.com/o/r" }, dirty: 0 };
  const mark = (pr) => {
    const html = renderHeroSide({ git, pr, prWords: pullRequestWords(pr) });
    return html.match(new RegExp(`data-state="([a-z]+)">${pullRequestWords(pr)}<`))?.[1];
  };
  assert.equal(mark({ state: "none" }), "warn");
  assert.equal(mark({ state: "unpushed" }), "none", "the same fact as 'tracks nothing yet', and no better");
  assert.equal(mark({ state: "open", number: 4 }), "ok");
  assert.equal(mark({ state: "closed", number: 5 }), "warn");
  assert.equal(mark({ state: "unknown", why: "gh is not installed" }), "none");
});
