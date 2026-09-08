// `rooms week` / `branch` / `file` / `badge` — attribution as a number in a terminal.
//
// The board is the poster; these are the habit. Two properties matter more than the formatting:
// they read git and need no room, and "no agent recorded" is a row like any other rather than a
// leftover slice. The second one is the honesty of the whole tool — a plain commit is not evidence
// that no agent was used, and a surface that buries that is a vendor dashboard with a different logo.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  compact,
  formatBranch,
  formatFile,
  formatMix,
  formatWeek,
  renderBadgeSvg,
  wrap,
  FLOOR_NOTE,
} from "../src/report.js";

const exec = promisify(execFile);
// fileURLToPath, not .pathname: on Windows the latter is `/C:/…`, which nothing can spawn from.
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");
const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd, args) => exec("git", [...IDENT, ...args], { cwd });

const CLAUDE = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";
const CURSOR = "Co-Authored-By: Cursor Agent <cursoragent@cursor.com>";

async function repo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-report-"));
  try {
    await git(dir, ["init", "-q", "-b", "main"]);
    const commit = async (file, body, subject, trailer = "") => {
      await writeFile(join(dir, file), body, "utf8");
      await git(dir, ["add", file]);
      await git(dir, ["commit", "-m", trailer ? `${subject}\n\n${trailer}` : subject]);
    };
    await fn({ dir, commit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("every share is of the commits this window read, and unrecorded is one of the rows", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "with claude", CLAUDE);
    await commit("b.txt", "2\n", "with cursor", CURSOR);
    await commit("c.txt", "3\n", "just me");
    await commit("d.txt", "4\n", "me again");

    const r = await buildReport(dir);
    assert.equal(r.seen, 4);
    const by = Object.fromEntries(r.rows.map((row) => [row.id, row]));
    assert.equal(by.claude.pct, 25);
    assert.equal(by.cursor.pct, 25);
    // Not a remainder computed by the caller — a row, with a label, at the same weight.
    assert.equal(by.unrecorded.commits, 2);
    assert.equal(by.unrecorded.pct, 50);
    assert.equal(by.unrecorded.label, "no agent recorded");
    assert.equal(r.rows.reduce((n, row) => n + row.commits, 0), 4, "the rows account for every commit");
  });
});

test("a window filters the denominator too, not just the sample", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("keep.txt", "1\n", "in src", CLAUDE);
    await commit("lock.json", "{}\n", "lockfile churn");
    await commit("lock.json", "{ }\n", "more lockfile churn");

    // "1 of 3" and "1 of 1" are different claims. Counting all of HEAD and then reporting a
    // filtered sample makes the percentage a ratio of two different populations.
    const all = await buildReport(dir);
    assert.equal(all.total, 3);

    const noLock = await buildReport(dir, { exclude: ["lock.json"] });
    assert.equal(noLock.total, 1, "the total is counted under the same filter");
    assert.equal(noLock.seen, 1);
    assert.equal(noLock.rows.find((row) => row.id === "claude").pct, 100);

    const onlyLock = await buildReport(dir, { paths: ["lock.json"] });
    assert.equal(onlyLock.seen, 2);
    assert.equal(onlyLock.rows.find((row) => row.id === "unrecorded").pct, 100);
  });
});

test("--since takes a shorthand and a real git date", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "today", CLAUDE);
    const recent = await buildReport(dir, { since: "7d" });
    assert.equal(recent.seen, 1);
    const ancient = await buildReport(dir, { since: "1y" });
    assert.equal(ancient.seen, 1, "a year covers today too");
    const none = await buildReport(dir, { since: "2050-01-01" });
    assert.equal(none.seen, 0, "a raw date is passed through to git");
  });
});

test("a branch range reports only what is on the branch", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "on main");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await commit("b.txt", "2\n", "on the branch", CLAUDE);
    await commit("c.txt", "3\n", "also on the branch", CLAUDE);

    const r = await buildReport(dir, { range: "main..HEAD" });
    assert.equal(r.seen, 2, "the main commit is not on this branch");
    assert.equal(r.rows.find((row) => row.id === "claude").pct, 100);
  });
});

test("the floor note travels with every surface that prints a percentage", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    const r = await buildReport(dir);
    for (const [name, text] of [
      ["week", formatWeek(r, { name: "x" })],
      ["branch", formatBranch(r, { branch: "f", base: "main" })],
      ["file", formatFile(r, { path: "a.txt" })],
    ]) {
      assert.match(text, /not "no agent used"/, `${name} says what a plain commit does not mean`);
      assert.match(text, /floor/, `${name} says the share is a floor`);
    }
    // Wrapped, so the note is readable in a terminal rather than one long line.
    assert.ok(
      wrap(FLOOR_NOTE).split("\n").every((l) => l.length <= 76),
      "the note is wrapped to a terminal width",
    );
  });
});

test("the mix gives unrecorded the same bar as everything else", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two");
    const text = formatMix(await buildReport(dir));
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    // Same column layout on both rows: an unrecorded slice rendered smaller or without a bar would
    // be the tool putting a thumb on its own scale.
    const bars = lines.map((l) => (l.match(/[█░]+/) || [""])[0].length);
    assert.equal(bars[0], bars[1]);
    assert.ok(bars[0] > 0);
  });
});

test("the badge is a stacked bar, so unrecorded cannot be cropped out of it", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two");
    await commit("c.txt", "3\n", "three");
    const svg = renderBadgeSvg(await buildReport(dir));
    assert.match(svg, /^<svg xmlns=/);
    assert.match(svg, /unrecorded 67%/, "the number nobody wants on their README is on it");
    assert.match(svg, /Claude Opus 5 33%/);
    // A single "33% AI" number is the claim this tool cannot support; the unrecorded segment has
    // to be in the same picture at the same size as the ones it is compared against.
    assert.equal((svg.match(/<rect class="seg"/g) || []).length, 2, "one segment per row");
    assert.match(svg, /data-agent="unrecorded"/, "and it is named, not anonymous filler");
    assert.match(svg, /trailers only/, "and the caveat is in the title text");
  });
});

test("a badge escapes what it renders, because a branch or model name is free text", () => {
  const svg = renderBadgeSvg(
    { ok: true, rows: [{ id: "claude", label: '<script>alert("x")</script>', commits: 1, pct: 100 }] },
    { label: "<img src=x>" },
  );
  assert.doesNotMatch(svg, /<script>/);
  assert.doesNotMatch(svg, /<img src=x>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("compact keeps a terminal column narrow", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(999), "999");
  assert.equal(compact(1500), "1.5k");
  assert.equal(compact(15000), "15k");
  assert.equal(compact(2_400_000), "2.4M");
});

test("all four run on a repo that has never heard of this tool", async () => {
  // The whole point of the git layer: point it at a repo and it answers. Requiring `rooms init`
  // first would put a write in front of a read, and nobody runs a second command to see a number.
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two");

    for (const args of [["week"], ["file", "a.txt"], ["badge"]]) {
      const r = await runCli(dir, args);
      assert.equal(r.code, 0, `rooms ${args.join(" ")} failed: ${r.stderr}`);
      assert.ok(r.stdout.length > 0, `rooms ${args.join(" ")} printed nothing`);
    }
    assert.deepEqual(await readdir(dir).then((f) => f.filter((n) => n === ".room")), [], "no room was created");
  });
});

test("outside a repo they say so and exit non-zero, rather than printing zeroes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-nogit-"));
  try {
    const r = await runCli(dir, ["week"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a git checkout/);
    assert.match(r.stderr, /inside a repository/, "and what to do about it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("badge --out writes the file and hands back the markdown line", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    const r = await runCli(dir, ["badge", "--out", "agents.svg"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /!\[agents\]\(agents\.svg\)/, "a badge is for pasting");
    const svg = await readFile(join(dir, "agents.svg"), "utf8");
    assert.match(svg, /^<svg/);
  });
});
