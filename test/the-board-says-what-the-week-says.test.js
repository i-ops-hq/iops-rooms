// The board, for the teammates who will never open a terminal, says what `rooms week` says: the
// same finding line, the same rows and caveats, and the same counts of what the hooks on this
// machine observed, with each agent session and the files it edited.
//
// Two surfaces that disagree would be worse than one, so each check compares the board with the
// terminal on the same repository rather than with a number written into the test.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { get } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startLiveBoard } from "../src/live.js";
import { renderObserved, sessionsFrom } from "../src/board.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const CLAUDE = "\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-board-week-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd, argv, { input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ROOMS_NO_OPEN: "1" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

async function commit(dir, file, message) {
  await mkdir(join(dir, file, ".."), { recursive: true });
  await writeFile(join(dir, file), `${file} ${Math.random()}\n`, "utf8");
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", message], { cwd: dir });
}

async function repoWithRoom(dir) {
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await commit(dir, "first.txt", "first");
  await run(dir, ["init"]);
}

const board = async (dir) => {
  const opened = await run(dir, ["open"]);
  assert.equal(opened.code, 0, opened.err);
  return readFile(join(dir, ".room", "board.html"), "utf8");
};

/** One section of the board, as the text a reader sees. */
function section(html, cls) {
  const m = html.match(new RegExp(`<section class="${cls}"[\\s\\S]*?</section>`));
  return m ? m[0] : "";
}
const text = (fragment) =>
  fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function payload(dir, event, extra = {}) {
  return JSON.stringify({ session_id: "board-session-id", cwd: dir, hook_event_name: event, ...extra });
}
const edit = (dir, file) =>
  payload(dir, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(dir, file), file_text: "body" } });

test("the board's week has the terminal's finding, rows and caveats", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await commit(dir, "a.txt", `with an agent${CLAUDE}`);
    await commit(dir, "b.txt", `and again${CLAUDE}`);
    const week = await run(dir, ["week"]);
    const json = JSON.parse((await run(dir, ["week", "--json"])).out);
    const shown = section(await board(dir), "week");
    assert.ok(shown, "the section is on the board");

    const finding = week.out.split("\n")[0];
    assert.equal(finding, "Claude co-authored 2 of the last 3 commits here.");
    assert.ok(text(shown).includes(finding), text(shown));
    const rows = [...shown.matchAll(/<li class="wk-row"[\s\S]*?<\/li>/g)].map((m) => text(m[0]));
    assert.equal(rows.length, json.rows.length);
    for (const [i, row] of json.rows.entries()) {
      assert.ok(rows[i].startsWith(`${row.label} ${row.commits} ${row.percent}%`), `${rows[i]} / ${row.label}`);
    }
    assert.ok(text(shown).includes(json.floor), "the floor travels with the percentages");
    assert.match(text(shown), /3 commits/);
  });
});

test("the board counts what the hooks observed as the terminal does, and lists the session", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await run(dir, ["hooks", "install"]);
    await run(dir, ["agent-hook", "claude-code"], { input: payload(dir, "SessionStart", { model: "claude-sonnet-5" }) });
    await run(dir, ["agent-hook", "claude-code"], { input: edit(dir, "src/a.txt") });
    await commit(dir, "src/a.txt", "the agent's edit, committed by hand");
    await commit(dir, "b.txt", "mine");

    const { observed } = JSON.parse((await run(dir, ["week", "--json"])).out);
    assert.equal(observed.observed, 2);
    assert.equal(observed.agentEdited, 1);
    assert.equal(observed.commits, 3, "the first commit was made before the hook");
    const shown = section(await board(dir), "observed");
    const tiles = [...shown.matchAll(/<div class="obs-tile">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
    assert.deepEqual(tiles, [
      `${observed.madeInSession} of ${observed.observed} commits made inside an agent session seen by the git hook`,
      `${observed.agentEdited} of ${observed.observed} commits carry files an agent edited Claude Code 1`,
      "1 commit not observed made before the hook, or elsewhere",
    ]);
    // A session's own </li> starts a line; the files inside it close theirs mid-line.
    const sessions = [...shown.matchAll(/<li class="obs-session"[\s\S]*?\n<\/li>/g)];
    assert.equal(sessions.length, 1);
    assert.match(text(sessions[0][0]), /^Claude Code claude-sonnet-5 started .+ · no end recorded 1 file edited src\/a\.txt/);
    assert.ok(text(shown).includes(observed.note), "the note travels with the counts");
    // Counts, never shares, and nothing about whose lines a commit holds.
    assert.doesNotMatch(text(shown), /%/);
    assert.doesNotMatch(text(shown), /\bwrote\b|\bwritten\b|\bAI\b|\bhuman\b/);
    assert.doesNotMatch(shown, /board-session-id/, "the session's own id is never shown");
  });
});

test("a path, model or agent holding HTML is shown as text, never run", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    // Through the hook: the path is kept as the agent gave it.
    await run(dir, ["agent-hook", "claude-code"], { input: edit(dir, 'x<img src=x onerror="alert(1)">.txt') });
    // Straight into the log, the way a teammate's commit merged by union could put it there: the
    // hook reduces a model to plain characters, and the board must not depend on that.
    const at = new Date().toISOString();
    const hostile = [
      { kind: "session", phase: "start", agent: "<b>agent</b>", session: "s2", model: "<script>alert(2)</script>", at },
      { kind: "edit", agent: "<b>agent</b>", session: "s2", path: "<svg onload=alert(3)>", at },
    ];
    await writeFile(join(dir, ".room", "agent-activity.jsonl"), hostile.map((r) => `${JSON.stringify(r)}\n`).join(""), { flag: "a" });
    const shown = section(await board(dir), "observed");
    for (const escaped of [
      "x&lt;img src=x onerror=&quot;alert(1)&quot;&gt;.txt",
      "&lt;script&gt;alert(2)&lt;/script&gt;",
      "&lt;svg onload=alert(3)&gt;",
      "&lt;b&gt;agent&lt;/b&gt;",
    ]) {
      assert.ok(shown.includes(escaped), `${escaped} is shown as text`);
    }
    assert.doesNotMatch(shown, /<img|<script|<svg|<b>/);
  });
});

test("a session is 'started' only when its start came first: a compacted one is 'first seen'", () => {
  const rec = (kind, at, extra = {}) => ({ kind, agent: "claude-code", session: "s", at, ...extra });
  const log = [
    rec("edit", "2026-09-29T06:00:00.000Z", { path: "a.txt" }),
    // Claude Code reports a start again, under the same id, when it compacts a session.
    rec("session", "2026-09-29T07:30:00.000Z", { phase: "start", model: "claude-opus-5-5" }),
    rec("edit", "2026-09-29T07:40:00.000Z", { path: "b.txt" }),
    rec("session", "2026-09-30T09:00:00.000Z", { phase: "start", model: "claude-sonnet-5" }),
    // A terminal session that restarts itself starts again under its id: the first start stands.
    rec("session", "2026-09-30T09:05:00.000Z", { phase: "start", model: "claude-sonnet-5-restarted" }),
  ].map((r, i) => (i >= 3 ? { ...r, session: "t" } : r));
  const sessions = sessionsFrom(log);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((x) => [x.model, x.files]), [["claude-sonnet-5", []], ["claude-opus-5-5", ["a.txt", "b.txt"]]]);
  assert.equal(sessions[0].start, "2026-09-30T09:00:00.000Z");
  const html = renderObserved({ observed: null, note: "", sessions, label: () => "Claude Code" });
  const whens = [...html.matchAll(/class="obs-when">([^<]*)</g)].map((m) => m[1]);
  assert.equal(whens.length, 2);
  assert.match(whens[0], /^started /);
  assert.match(whens[1], /^first seen /, "its first record is an edit, before any start");
  assert.match(html, /no edits reported/);
});

test("with nothing recorded, the board says so and how to start, rather than showing zeros", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const shown = section(await board(dir), "observed");
    assert.match(text(shown), /Nothing is recorded on this machine yet\./);
    assert.match(text(shown), /rooms hooks install --agent claude-code/);
    assert.doesNotMatch(shown, /obs-tile/);
  });
});

test("an open live board reloads when an agent reports an edit", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const live = await startLiveBoard(dir, { port: 0 });
    const pushes = [];
    const req = get(`${live.url}stream`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (chunk.includes("data:")) pushes.push(Date.now());
      });
    });
    req.on("error", () => {});
    try {
      // The server pushes once when its first poll reads the files; only a push after the edit
      // counts, or this would pass with the activity log ignored.
      await new Promise((r) => setTimeout(r, 1200));
      const editAt = Date.now();
      await run(dir, ["agent-hook", "claude-code"], { input: edit(dir, "a.txt") });
      const deadline = Date.now() + 4000;
      while (!pushes.some((t) => t > editAt) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(pushes.some((t) => t > editAt), `no refresh after the edit (pushes at ${pushes.map((t) => t - editAt).join(", ")} ms)`);
      // One change, one refresh: the poll used to refresh again for a change the watcher had caught.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(pushes.filter((t) => t > editAt).length, 1, `refreshes after one edit at ${pushes.map((t) => t - editAt).join(", ")} ms`);
    } finally {
      req.destroy();
      await live.close();
    }
  });
});

test("closing the live board waits for a refresh already running, so nothing writes after it", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const live = await startLiveBoard(dir, { port: 0 });
    const boardPath = join(dir, ".room", "board.html");
    const mtime = async () => (await stat(boardPath)).mtimeMs;
    const before = await mtime();
    await run(dir, ["agent-hook", "claude-code"], { input: edit(dir, "a.txt") });
    // Past the 80 ms debounce, so a refresh has started and is running git in the project.
    await new Promise((r) => setTimeout(r, 150));
    await live.close();
    const closed = await mtime();
    assert.ok(closed > before, "the refresh the edit started finished before close returned");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await mtime(), closed, "and nothing wrote the board after close returned");
  });
});
