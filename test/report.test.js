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

// ---------------------------------------------------------------------------
// The three defects an outside reader found in 0.5.1, each with the number that
// was wrong. Reproduced from the filed reports before anything was changed.
// ---------------------------------------------------------------------------

test("a trailer repeated on one commit is one agent on one commit, not two", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "amended twice", `${CLAUDE}\n${CLAUDE}`);
    await commit("b.txt", "2\n", "plain");

    const r = await buildReport(dir);
    const by = Object.fromEntries(r.rows.map((row) => [row.id, row]));
    assert.equal(by.claude.commits, 1, "one commit, however many times the tool appended itself");
    assert.equal(r.rows.reduce((n, row) => n + row.commits, 0), r.seen);
  });
});

test("rows never sum past 100%, and a two-agent commit is split and said out loud", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "claude only", CLAUDE);
    await commit("b.txt", "2\n", "both", `${CLAUDE}\n${CURSOR}`);
    await commit("c.txt", "3\n", "plain");

    const r = await buildReport(dir);
    const by = Object.fromEntries(r.rows.map((row) => [row.id, row]));
    // The count is commits the agent appears on: true, and allowed to overlap.
    assert.equal(by.claude.commits, 2);
    assert.equal(by.cursor.commits, 1);
    // The percentage is that commit split between them, so the three rows are a partition.
    assert.equal(
      r.rows.reduce((n, row) => n + row.pct, 0),
      100,
      "the header, the bars and the badge all read as shares of one whole",
    );
    assert.equal(r.multi, 1);
    assert.match(formatMix(r), /records more than one agent/);

    // The badge is a stacked bar: its segments must fit inside the bar they are drawn in.
    const svg = renderBadgeSvg(r);
    const width = Number(svg.match(/<svg[^>]*width="(\d+)"/)[1]);
    const segs = [...svg.matchAll(/<rect class="seg"[^>]*x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
    const end = Math.max(...segs.map((m) => Number(m[1]) + Number(m[2])));
    assert.ok(end <= width + 0.5, `segments end at ${end}, badge is ${width} wide`);
  });
});

test("a trailer no family recognises is named, not folded into 'no agent recorded'", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "aider", "Co-authored-by: aider (gpt-4o) <aider@aider.chat>");
    await commit("b.txt", "2\n", "gemini", "Co-authored-by: Gemini CLI <gemini-cli@google.com>");
    await commit("c.txt", "3\n", "jules", "Co-authored-by: google-labs-jules[bot] <161369871+google-labs-jules[bot]@users.noreply.github.com>");
    await commit("d.txt", "4\n", "q", "Co-authored-by: Amazon Q <q@amazon.com>");
    await commit("e.txt", "5\n", "windsurf", "Co-authored-by: Windsurf <windsurf@codeium.com>");
    await commit("f.txt", "6\n", "a person", "Co-authored-by: Jane Dev <jane@example.com>");
    await commit("g.txt", "7\n", "nothing at all");

    const r = await buildReport(dir);
    const by = Object.fromEntries(r.rows.map((row) => [row.id, row]));
    for (const id of ["aider", "gemini", "jules", "amazonq", "windsurf"]) {
      assert.equal(by[id]?.commits, 1, `${id} was read as an agent`);
    }
    // A human co-author is neither an agent nor "the person's own work with nothing recorded".
    assert.equal(by.coauthor.commits, 1);
    assert.equal(by.unrecorded.commits, 1);
    assert.equal(r.rows.reduce((n, row) => n + row.pct, 0), 100);
  });
});

test("a company address is still not an agent, now that five more families exist", async () => {
  await repo(async ({ dir, commit }) => {
    // Google, Amazon and Codeium employ people. None of these is a bot.
    await commit("a.txt", "1\n", "one", "Co-authored-by: Sundar P <sundar@google.com>");
    await commit("b.txt", "2\n", "two", "Co-authored-by: Someone <someone@amazon.com>");
    await commit("c.txt", "3\n", "three", "Co-authored-by: Dev <dev@codeium.com>");

    const r = await buildReport(dir);
    const by = Object.fromEntries(r.rows.map((row) => [row.id, row]));
    assert.equal(by.coauthor.commits, 3);
    assert.equal(r.agents.agents.length, 0, "no person was relabelled as a robot");
  });
});

test("a git failure is the answer, not a confident zero", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one");

    const r = await buildReport(dir, { range: "nonexistent-base..HEAD" });
    assert.equal(r.ok, false, "an unknown ref is not an empty window");
    assert.match(r.note, /nonexistent-base/);

    const run = await runCli(dir, ["branch", "nonexistent-base"]);
    assert.equal(run.code, 1, "exit 0 here is a wrong number pasted into a PR");
    assert.match(run.stderr, /unknown revision|ambiguous argument/);
    assert.doesNotMatch(run.stdout, /0 commits/);
    // The "run it inside a repository" hint is only true when that is the problem.
    assert.doesNotMatch(run.stderr, /run them inside a repository/);
  });
});

test("a flag that takes a value refuses to be a boolean, and unknown flags are said", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one");

    // git reads --since=true as "since now" and silently drops history, so this must not run.
    const bare = await runCli(dir, ["week", "--since"]);
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /--since needs a value/);

    const beforeAnother = await runCli(dir, ["week", "--since", "--json"]);
    assert.equal(beforeAnother.code, 2, "the next long flag is not a value");

    // A value is allowed to look like a short flag: git parses -5d perfectly well.
    const negative = await runCli(dir, ["week", "--since", "-5d"]);
    assert.equal(negative.code, 0);
    assert.match(negative.stdout, /last -5d/);

    const bogus = await runCli(dir, ["week", "--bogus"]);
    assert.match(bogus.stderr, /unknown flag --bogus/);
    assert.equal(bogus.code, 0, "unknown flags warn; refusing them would break a newer flag");
  });
});

// ---------------------------------------------------------------------------
// Found by installing the published 0.5.2 and probing it as an outsider would,
// rather than by reading the diff that shipped it. Both are regressions the
// 0.5.2 fixes introduced.
// ---------------------------------------------------------------------------

test("a repository with no commits yet says so, instead of reporting a git failure", async () => {
  await repo(async ({ dir }) => {
    // Nothing committed: HEAD is an unborn branch and every git call below exits 128. Making git's
    // errors loud was right for an unknown ref and wrong here — `git init` then `rooms week` met
    // `fatal: ambiguous argument 'HEAD'`, where 0.5.1 had correctly said "0 commits".
    const r = await buildReport(dir);
    assert.equal(r.ok, true, "an empty repository is a state, not a failure");
    assert.equal(r.seen, 0);
    assert.equal(r.rows.length, 0);

    const run = await runCli(dir, ["week"]);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /0 commits/);
    assert.doesNotMatch(run.stdout + run.stderr, /fatal|ambiguous/);

    // The loud path must survive: an explicit range that does not resolve is still an error.
    const bad = await runCli(dir, ["branch", "nonexistent-base"]);
    assert.equal(bad.code, 1);
  });
});

test("--version prints the version, and it is the one in package.json", async () => {
  await repo(async ({ dir }) => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    for (const argv of [["--version"], ["version"]]) {
      const run = await runCli(dir, argv);
      assert.equal(run.code, 0, argv.join(" "));
      assert.equal(run.stdout.trim(), pkg.version);
      // It used to print the whole help text and warn that --version was unknown.
      assert.doesNotMatch(run.stderr, /unknown flag/);
    }
  });
});
