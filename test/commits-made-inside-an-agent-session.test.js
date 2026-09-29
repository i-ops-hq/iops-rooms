// Whether a commit was made inside an agent's session, from the variables the agent set for the
// commands it runs, recorded by the git hook the person installed.
//
// Checked on 2026-09-28 in a Claude Code shell: a git hook fired by a commit made inside the session
// sees CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT and AI_AGENT, and the same commit made from a person's
// own terminal sees none of them. This records where a commit was made, never who wrote it, and
// keeps it apart from the trailer counts. test/env-setup.js strips the markers from the suite's own
// environment, so every test here sets exactly the ones it means.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { agentFromEnv } from "../src/agent-markers.js";
import { quietWindow } from "../src/report.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const CLAUDE_SHELL = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", AI_AGENT: "claude-code_2-1-281_agent" };
const exists = (p) => access(p).then(() => true, () => false);

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-session-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd, argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function commit(dir, file, env = {}) {
  await writeFile(join(dir, file), `${file}\n`, "utf8");
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", `add ${file}`], { cwd: dir, env: { ...process.env, ...env } });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

async function repoWithRoom(dir) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await commit(dir, "first.txt");
  await run(dir, ["init"]);
}

const activity = async (dir) =>
  (await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("the markers an agent sets are read, and nothing else from the environment", () => {
  assert.deepEqual(agentFromEnv(CLAUDE_SHELL), { agent: "claude-code", version: "2.1.281", entry: "cli", model: null });
  assert.deepEqual(agentFromEnv({ CLAUDECODE: "1" }), { agent: "claude-code", version: null, entry: null, model: null });
  // Any agent can name itself, a custom one included, and say which model it runs.
  assert.deepEqual(agentFromEnv({ AI_AGENT: "reviewer-bot", AI_AGENT_MODEL: "claude-opus-5-5" }), {
    agent: "reviewer-bot", version: null, entry: null, model: "claude-opus-5-5",
  });
  // What it claims is kept short and plain, never markup or a command.
  assert.equal(agentFromEnv({ AI_AGENT: "<b>bot</b>; rm -rf ~" }).agent, "bbot/brm-rf");
  assert.equal(agentFromEnv({}), null);
  assert.equal(agentFromEnv({ CLAUDECODE: "0", PATH: "/usr/bin" }), null);
});

test("the same kind of commit, with and without the markers, is recorded two ways", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const inside = await commit(dir, "a.txt");
    await run(dir, ["record", "commit"], CLAUDE_SHELL);
    const outside = await commit(dir, "b.txt");
    await run(dir, ["record", "commit"]);

    const records = await activity(dir);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => [r.sha, r.madeIn, r.agentVersion, r.entry]),
      [[inside, "claude-code", "2.1.281", "cli"], [outside, null, null, null]],
    );
  });
});

test("no other variable reaches the record, however it is named", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await commit(dir, "a.txt");
    // What a Claude Code shell also carries, and what a careless reader of env would copy.
    const sentinel = "sentinel-7f3a9c-do-not-record";
    await run(dir, ["record", "commit"], { ...CLAUDE_SHELL, CLAUDE_CODE_MESSAGING_TOKEN: sentinel, GITHUB_TOKEN: sentinel });
    const raw = await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8");
    assert.equal(raw.split("\n").filter(Boolean).length, 1);
    assert.doesNotMatch(raw, /sentinel-7f3a9c/);
  });
});

test("with no room, recording creates nothing and says nothing", async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await commit(dir, "a.txt");
    const r = await run(dir, ["record", "commit"], CLAUDE_SHELL);
    assert.equal(r.code, 0);
    assert.equal(r.out + r.err, "");
    assert.equal(await exists(join(dir, ".room")), false);
  });
});

test("the git hook records each commit as it is made", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const installed = await run(dir, ["hooks", "install"]);
    assert.equal(installed.code, 0, installed.err);
    const inside = await commit(dir, "a.txt", CLAUDE_SHELL);
    const outside = await commit(dir, "b.txt");
    const records = await activity(dir);
    assert.equal(records.length, 2, "one line per commit, written by the hook");
    assert.deepEqual(records.map((r) => [r.sha, r.madeIn]), [[inside, "claude-code"], [outside, null]]);
  });
});

test("a worktree's commits reach the main checkout's room", async () => {
  await scratch(async (dir) => {
    const main = join(dir, "app");
    await exec("git", ["init", "-q", "-b", "main", main]);
    await commit(main, "first.txt");
    await run(main, ["init"]);
    const beside = join(dir, "app-feature");
    await exec("git", ["worktree", "add", "-q", beside, "-b", "feature"], { cwd: main });
    // Installed from the worktree itself, where `.git` is a file.
    const installed = await run(beside, ["hooks", "install"]);
    assert.equal(installed.code, 0, installed.err);
    const sha = await commit(beside, "f.txt", CLAUDE_SHELL);
    const records = await activity(main);
    assert.equal(records.length, 1);
    assert.equal(records[0].sha, sha);
    assert.equal(records[0].branch, "feature");
    assert.equal(await exists(join(beside, ".room")), false, "nothing in the worktree");
  });
});

test("rooms week reports what the hook observed, apart from the trailers", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir); // one commit before the hook: not observed
    await run(dir, ["hooks", "install"]);
    await commit(dir, "a.txt", CLAUDE_SHELL);
    await commit(dir, "b.txt");

    const week = await run(dir, ["week"]);
    assert.equal(week.code, 0, week.err);
    assert.match(week.out, /no agent recorded\s+3/, "the trailer rows are exactly as they were");
    const block = week.out.slice(week.out.indexOf("Observed on this machine"));
    assert.match(block, /^Observed on this machine since \d{4}-\d{2}-\d{2}, by the git hook you installed:/);
    assert.match(block, /made inside an agent session\s+1 of 2 observed \(Claude Code 1\)/);
    assert.match(block, /not observed\s+1, made before the hook or elsewhere/);
    assert.doesNotMatch(block, /%/, "counts, never a share");
    assert.doesNotMatch(block, /\bwrote\b|\bAI\b|\bhuman\b/, "where a commit was made, never who wrote it");

    const json = JSON.parse((await run(dir, ["week", "--json"])).out);
    assert.equal(json.attributed, 0);
    assert.equal(json.observed.commits, 3);
    assert.equal(json.observed.observed, 2);
    assert.equal(json.observed.madeInSession, 1);
    assert.deepEqual(json.observed.byAgent, { "claude-code": 1 });
  });
});

test("where the hook never ran, there is no observed block rather than a zero", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await commit(dir, "a.txt", CLAUDE_SHELL);
    const week = await run(dir, ["week"]);
    assert.doesNotMatch(week.out, /Observed on this machine/);
    assert.equal(JSON.parse((await run(dir, ["week", "--json"])).out).observed, null);
  });
});

test("a quiet week's age is rounded, so ten days and a minute reads as ten", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const tenDaysAndAMinute = now - (10 * 86_400_000 + 60_000);
  assert.match(quietWindow(tenDaysAndAMinute, now), /is 10 days old/);
});
