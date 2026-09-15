// Why nothing was attributed, when nothing was.
//
// `no agent recorded 100%` is the most common first run, and three different situations produce it:
// the setup is broken, the tool in use never wrote trailers, or no agent was involved. A reader
// cannot tell which, so they cannot tell whether to go looking — and in two of the three the
// honest answer is that nothing is wrong, which the output has never said.
//
// This file exists partly as a record of a mistake. The feature was first scoped around offering
// `rooms hooks install`, on the belief that it writes the trailer. It does not — it writes a board
// post — and the repository says so in two places that were not read first. No command is offered
// here, because attribution comes from the agent and this tool must not manufacture what it
// measures.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { whyNothingRecorded } from "../src/agent-config.js";
import { buildReport, formatWhyEmpty, formatWeek } from "../src/report.js";

const run = promisify(execFile);
const CLAUDE = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";

/** A repo whose commit carries `trailer`, with `files` committed alongside. */
async function repo(files, fn, { trailer = "" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-why-"));
  const git = (...a) =>
    run("git", ["-c", "user.email=ada@team.invalid", "-c", "user.name=Ada", ...a], { cwd: dir });
  await git("init", "-q", "-b", "main", ".");
  for (const path of files) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), "{}\n", "utf8");
  }
  await writeFile(join(dir, "a.txt"), "1\n", "utf8");
  await git("add", "-A");
  await git("commit", "-q", "-m", trailer ? `work\n\n${trailer}` : "work");
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The note, whitespace collapsed, because wrapping is what a reader sees. */
const note = (report) => formatWhyEmpty(report).replace(/\s+/g, " ").trim();

// ── the three cases say three different things ──────────────────────────────────────────────────

test("an agent that writes its own trailer, and none recorded, is a discrepancy", async () => {
  await repo(["CLAUDE.md"], async (dir) => {
    const text = note(await buildReport(dir));
    assert.match(text, /Claude Code writes this trailer itself/);
    assert.match(text, /turned off, or this window predates it/);
    // The line that stops this becoming an advertisement for a thing we could do and should not.
    assert.match(text, /Rooms cannot add one/);
  });
});

test("an agent that writes no trailer means an empty result is expected, not broken", async () => {
  // The most useful of the three, because it is the one that stops somebody hunting for a fault.
  await repo([".cursorrules"], async (dir) => {
    const text = note(await buildReport(dir));
    assert.match(text, /Cursor does not write a Co-Authored-By trailer/);
    assert.match(text, /expected one rather than a fault/);
    assert.match(text, /nothing to switch on/);
  });
});

test("nothing declared and nothing recorded is simply the answer", async () => {
  await repo([], async (dir) => {
    assert.match(note(await buildReport(dir)), /Nothing here declares an agent either/);
  });
});

test("an AGENTS.md alone names no vendor, so there is nothing to compare against", async () => {
  await repo(["AGENTS.md"], async (dir) => {
    const text = note(await buildReport(dir));
    assert.match(text, /names no vendor/);
    assert.doesNotMatch(text, /writes this trailer itself/, "AGENTS.md implicates no vendor");
  });
});

// ── and it is silent the moment anything is attributed ──────────────────────────────────────────

test("one attributed commit and the note disappears", async () => {
  // Not a threshold. At any attribution at all the reader has evidence the mechanism works and does
  // not need telling how it works.
  await repo(["CLAUDE.md"], async (dir) => {
    const report = await buildReport(dir);
    assert.ok(report.agents.attributed > 0, "the fixture should have attributed this commit");
    assert.equal(formatWhyEmpty(report), "");
    assert.doesNotMatch(formatWeek(report), /writes this trailer itself/);
  }, { trailer: CLAUDE });
});

test("a window with no commits at all says nothing", async () => {
  // Nothing to explain: the absence is the window, not the attribution.
  await repo(["CLAUDE.md"], async (dir) => {
    const report = await buildReport(dir, { since: "1970-01-01" });
    const empty = { ...report, seen: 0 };
    assert.equal(formatWhyEmpty(empty), "");
  });
});

test("no command is offered, and hooks install is never mentioned", async () => {
  // The feature was first scoped around `rooms hooks install` on the belief that it writes the
  // trailer. It writes a board post. A note telling somebody to run it would send them to fix an
  // attribution problem with something that does not touch attribution.
  await repo(["CLAUDE.md"], async (dir) => {
    const text = formatWeek(await buildReport(dir));
    assert.doesNotMatch(text, /hooks install/);
    assert.doesNotMatch(text, /npx |rooms [a-z]+ --/, "no command belongs in this note");
  });
});

// ── the classification itself ───────────────────────────────────────────────────────────────────

test("a family we have no position on produces no claim", async () => {
  // Silence beats a guess. An agent absent from the table is one whose behaviour we have not
  // checked, and saying either "it writes one" or "it does not" would be inventing the fact.
  assert.equal(
    whyNothingRecorded({ ok: true, agents: [{ id: "unheard-of", label: "Unheard Of", files: [] }], crossVendor: false }),
    "",
  );
});

test("a config that could not be read produces no claim", async () => {
  assert.equal(whyNothingRecorded({ ok: false, agents: [], crossVendor: false }), "");
  assert.equal(whyNothingRecorded(null), "");
});

test("an attesting agent wins over a quiet one when both are declared", async () => {
  // Claude Code writing nothing is a discrepancy worth reporting even in a repo that also has
  // Cursor set up, and it is the more actionable of the two sentences.
  const text = whyNothingRecorded({
    ok: true,
    crossVendor: false,
    agents: [
      { id: "claude", label: "Claude Code", files: ["CLAUDE.md"] },
      { id: "cursor", label: "Cursor", files: [".cursor/"] },
    ],
  });
  assert.match(text, /Claude Code writes this trailer itself/);
  assert.doesNotMatch(text, /nothing to switch on/);
});
