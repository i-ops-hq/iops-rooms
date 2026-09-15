// `--json`, and the thing that makes it worth having: every caveat the prose carries is a field.
//
// A consumer that gets `{"claude": 6}` and nothing else publishes "6% AI-written" as a fact, which
// is the exact misuse the text output spends four sentences refusing. A caveat that exists only in
// the terminal does not survive contact with the surface most likely to misquote it.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, reportToJson, FLOOR_NOTE } from "../src/report.js";

const run = promisify(execFile);
const CLAUDE = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";
const CLAUDE_47 = "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>";

async function repo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-json-"));
  const git = (...a) =>
    run("git", ["-c", "user.email=ada@team.invalid", "-c", "user.name=Ada", ...a], { cwd: dir });
  await git("init", "-q", "-b", "main", ".");
  const commit = async (name, body, trailer) => {
    await writeFile(join(dir, name), body, "utf8");
    await git("add", "-A");
    await git("commit", "-q", "-m", trailer ? `x\n\n${trailer}` : "x");
  };
  try {
    await fn({ dir, git, commit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("every caveat the prose carries is a field in the data", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", CLAUDE);
    await commit("b.txt", "2\n", CLAUDE_47);
    await commit("c.txt", "3\n");
    await commit("CLAUDE.md", "#\n");
    const json = reportToJson(await buildReport(dir), { name: "x", window: "all" });

    assert.equal(json.floor, FLOOR_NOTE, "the floor note itself, not a flag pointing at it");
    assert.equal(typeof json.multiAgentCommits, "number", "so a consumer knows rows can overlap");
    assert.equal(typeof json.commits.truncated, "boolean", "so it knows the window was capped");
    assert.ok(json.declared, "what the repository declares, from 0.5.5");
    assert.ok(json.declared.note.includes("never that it was used"));
    // Kept apart for the same reason the rows are: one of these buckets is mostly people.
    assert.equal(typeof json.coAuthored.byBot, "number");
    assert.equal(typeof json.coAuthored.byPersonOrUnmarked, "number");
  });
});

test("models stay under their agent instead of being flattened back into rows", async () => {
  // Flattening would put Claude Code back to appearing once per model, which 0.5.4 removed.
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", CLAUDE);
    await commit("b.txt", "2\n", CLAUDE_47);
    const json = reportToJson(await buildReport(dir), {});
    const claude = json.rows.find((r) => r.id === "claude");
    assert.equal(claude.commits, 2, "one row");
    assert.deepEqual(
      claude.models.map((m) => m.label).sort(),
      ["Claude Opus 4.7", "Claude Opus 5"],
    );
  });
});

test("why nothing was recorded is carried, and only when nothing was", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("CLAUDE.md", "#\n");
    const empty = reportToJson(await buildReport(dir), {});
    assert.match(empty.whyNothingRecorded || "", /Claude Code writes this trailer itself/);

    await commit("a.txt", "1\n", CLAUDE);
    const some = reportToJson(await buildReport(dir), {});
    assert.equal(some.whyNothingRecorded, null, "nothing to explain once something is attributed");
  });
});

test("stdout carries the object and nothing else", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", CLAUDE);
    const cli = new URL("../src/cli.js", import.meta.url).pathname;
    const { stdout } = await run(process.execPath, [cli, "week", "--since", "400d", "--json"], { cwd: dir });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.attributed, 1);
    assert.equal(stdout.trimStart()[0], "{", "no prose before the object");
  });
});

test("a refusal is JSON too, rather than prose with a success code", async () => {
  // `rooms branch` on the base branch declines. Under --json that has to parse, or a consumer gets
  // an unreadable stdout and exit 0 — the worst pair available.
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", CLAUDE);
    const cli = new URL("../src/cli.js", import.meta.url).pathname;
    const { stdout } = await run(process.execPath, [cli, "branch", "main", "--json"], { cwd: dir });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /already/);
  });
});

test("--json is listed in the help, or nobody finds it", async () => {
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const { stdout } = await run(process.execPath, [cli, "help"]);
  assert.match(stdout, /--json/);
});
