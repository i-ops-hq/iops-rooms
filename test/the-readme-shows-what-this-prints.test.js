// The README's two example blocks are copies of this tool's output, and a copy drifts.
//
// They are captured runs on purpose: a reader deciding whether to run anything should see what a
// run says rather than a description of it, and the second block exists because this repository is
// unusually well attributed and most are not. The cost is a fact with two homes. rollcall had the
// same arrangement and drifted within the hour — a label changed and the page kept the old line.
//
// **Shape, not numbers.** Both blocks are one repository at one moment; a byte comparison would
// fail on the next commit and get deleted. What must not drift is the wording, so every structural
// fragment below has to appear in a block and in a rendered report built here. Change a count and
// nothing fires. Rename the finding, drop the floor note or reword the config note, and this says
// which fragment the README is still claiming.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildReport, formatWeek } from "../src/report.js";

const exec = promisify(execFile);
const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const CLAUDE = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";

// Every one of these is a string this tool owns, and none of them contains a number.
const SHAPE = [
  "co-authored",
  "of the last",
  "commits here",
  "· last ",
  "no agent recorded",
  '"no agent recorded" is not "no agent used"',
  "Every share here is a floor.",
  "A config file says a tool was set up here, never that it was used",
];

async function rendered() {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-readme-"));
  try {
    const git = (args) => exec("git", [...IDENT, ...args], { cwd: dir });
    await git(["init", "-q", "-b", "main"]);
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(join(dir, ".cursor", "rules"), "x", "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "cursor config"]);
    for (const n of [1, 2]) {
      await writeFile(join(dir, `a${n}.txt`), `${n}\n`, "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", `change ${n}\n\n${CLAUDE}`]);
    }
    // One without a trailer, so "no agent recorded" is a row here as it is in both blocks.
    await writeFile(join(dir, "b.txt"), "b\n", "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "mine"]);
    return formatWeek(await buildReport(dir), { name: "x", window: "last 7d" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("every structural line the README claims is still a line this prints", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const blocks = [...readme.matchAll(/```\n([^`]*?· last [^`]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, `expected the two captured runs, found ${blocks.length}`);
  const both = blocks.join("\n");
  const live = await rendered();
  for (const fragment of SHAPE) {
    assert.ok(both.includes(fragment), `no README block contains: ${fragment}`);
    assert.ok(live.includes(fragment), `the output no longer contains, but the README claims: ${fragment}`);
  }
});

test("each captured block opens with its own finding, which is the point of capturing it", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const blocks = [...readme.matchAll(/```\n([^`]*?· last [^`]*?)```/g)].map((m) => m[1]);
  for (const block of blocks) {
    const first = block.split("\n")[0];
    assert.match(
      first,
      /co-authored|records an agent/,
      `a block still opens with its header rather than its finding: ${first}`,
    );
  }
});
