// The first line says what was found, not that the tool ran.
//
// `rooms week` had the answer and made the reader infer it: a header, a bar, and two caveat
// paragraphs, with the finding sitting inside the bar. On the repository this was written in, that
// finding is "Claude co-authored 24 of the last 24 commits here" — a sentence about the reader's
// own repository, which is the one they repeat to somebody else.
//
// The caveats do not move. A floor stated after the number is honesty; stated instead of the number
// it is a tool that will not say what it found, which is the criticism in the ledger's row 13.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildReport, formatWeek } from "../src/report.js";

const exec = promisify(execFile);
const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd, args) => exec("git", [...IDENT, ...args], { cwd });
const CLAUDE = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";
const CURSOR = "Co-Authored-By: Cursor Agent <cursoragent@cursor.com>";

async function repo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-finding-"));
  try {
    await git(dir, ["init", "-q", "-b", "main"]);
    const commit = async (file, subject, trailer = "") => {
      await writeFile(join(dir, file), `${subject}\n`, "utf8");
      await git(dir, ["add", file]);
      await git(dir, ["commit", "-m", trailer ? `${subject}\n\n${trailer}` : subject]);
    };
    await fn({ dir, commit, git: (args) => git(dir, args) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const first = (text) => text.split("\n")[0];

test("one agent on every commit is said outright, before the dashboard", async () => {
  await repo(async ({ dir, commit }) => {
    for (const n of [1, 2, 3]) await commit(`a${n}.txt`, `change ${n}`, CLAUDE);
    const text = formatWeek(await buildReport(dir), { name: "x" });
    assert.equal(first(text), "Claude co-authored 3 of the last 3 commits here.");
  });
});

test("a share that is not all of them says so, in the same shape", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "with claude", CLAUDE);
    await commit("b.txt", "mine");
    await commit("c.txt", "mine too");
    const text = formatWeek(await buildReport(dir), { name: "x" });
    assert.equal(first(text), "Claude co-authored 1 of the last 3 commits here.");
  });
});

test("a second agent is named rather than folded into the first", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "claude one", CLAUDE);
    await commit("b.txt", "claude two", CLAUDE);
    await commit("c.txt", "cursor one", CURSOR);
    const text = formatWeek(await buildReport(dir), { name: "x" });
    assert.match(first(text), /^Claude co-authored 2 of the last 3 commits here, and Cursor 1\.$/);
  });
});

test("nothing recorded is the finding for most repositories, so it is said too", async () => {
  // Cursor and Copilot write no trailer, so this is the majority of first runs. The old behaviour
  // put the dashboard back and said nothing, at exactly the moment a reader decides whether the
  // tool told them anything.
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "mine");
    await commit("b.txt", "mine too");
    const text = formatWeek(await buildReport(dir), { name: "x", window: "last 7d" });
    assert.equal(first(text), "None of the last 2 commits here records an agent.");
  });
});

test("a configured agent that recorded nothing is named, because that is the gap", async () => {
  await repo(async ({ dir, commit, git: run }) => {
    // Committed, because that is what rooms reads: a config file in the working tree is not
    // evidence the repository declares anything.
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(join(dir, ".cursor", "rules"), "x", "utf8");
    await run(["add", "-A"]);
    await run(["commit", "-m", "cursor config"]);
    await commit("a.txt", "mine");
    await commit("b.txt", "mine too");
    const text = formatWeek(await buildReport(dir), { name: "x" });
    assert.equal(
      first(text),
      "None of the last 3 commits here records an agent, and Cursor is configured in this repository.",
    );
    // It says what was read, never who wrote the code: no trailer is not no agent, which is what
    // the note underneath has always said and what this must not contradict in one line.
    assert.doesNotMatch(first(text), /wrote|AI|human/i);
  });
});

test("an empty window still has no sentence, because there is nothing to have found", async () => {
  await repo(async ({ dir }) => {
    const text = formatWeek(await buildReport(dir), { name: "x", window: "last 7d" });
    assert.equal(first(text), "x · last 7d", "the header is still the header");
  });
});

test("the caveats keep their place, after the number rather than instead of it", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "with claude", CLAUDE);
    const text = formatWeek(await buildReport(dir), { name: "x" });
    assert.match(text, /not "no agent used"/, "the floor note survives");
    assert.match(text, /floor/);
    const saidAt = text.indexOf("co-authored");
    assert.ok(saidAt >= 0 && saidAt < text.indexOf("floor"), "the finding comes first, the floor after");
  });
});

test("one commit reads as English, not as arithmetic", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "the only one", CLAUDE);
    const text = formatWeek(await buildReport(dir), { name: "x" });
    assert.equal(first(text), "Claude co-authored the last commit here.");
  });
});
