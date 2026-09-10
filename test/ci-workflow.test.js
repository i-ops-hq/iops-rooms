// The CI workflow is a file that goes stale silently.
//
// It said `push: branches: [master]`. The branch was renamed to `main` and from that day until this
// one a push ran nothing at all — no error, no warning, just a green repo with no checks on it.
// Nothing in the suite noticed, because nothing in the suite looked.
//
// Parsed with regexes rather than a YAML library on purpose: this package has zero dependencies,
// runtime or otherwise, and SECURITY.md says so.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORKFLOW = new URL("../.github/workflows/tests.yml", import.meta.url);
const yml = readFileSync(WORKFLOW, "utf8");

const matrixList = (marker) => {
  const m = yml.match(new RegExp(`${marker}\\s*'(\\[.*?\\])'`, "s"));
  assert.ok(m, `could not find the ${marker} matrix list`);
  return JSON.parse(m[1]);
};
const lean = matrixList("\\|\\|");
const full = matrixList("&&");

test("the push trigger names the branch this repo actually uses", (t) => {
  // The repo's DEFAULT branch, not the checked-out one. Comparing against HEAD failed on every
  // feature branch — which this project now always has, because the work goes through PRs. A test
  // that only passes on main is a test that fails for the reason you are working correctly.
  //
  // `origin/HEAD` is a local convenience ref that `git clone` writes and almost nothing else does.
  // actions/checkout fetches one ref and never sets it, so `symbolic-ref` exits 1 and execFileSync
  // THREW — not an assertion failure, an error out of the test body. Every push and pull_request
  // run on this repo was red for that reason from 0.5.1 onward, and the only green run in that
  // window was a manual workflow_dispatch. A red suite nobody can act on is a suite nobody reads.
  //
  // Skipped rather than passed when the ref is absent: this test cannot establish what the default
  // branch is there, and quietly returning green would be the same "answered a question it could
  // not ask" this project exists to argue against. On a developer's clone the ref is present and
  // the check runs.
  let head = "";
  try {
    head = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/^origin\//, "");
  } catch {
    t.skip("origin/HEAD is not set in this checkout, so the default branch cannot be read");
    return;
  }
  const push = yml.match(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[([^\]]+)\]/);
  assert.ok(push, "there is a push trigger");
  const branches = push[1].split(",").map((b) => b.trim());
  assert.ok(
    branches.includes(head) || head === "HEAD",
    `CI runs on ${branches.join("/")} but this checkout is on ${head} — a rename left it behind`,
  );
});

test("macOS is not on the every-push list, because it bills at ten times", () => {
  // Three macOS jobs were about three quarters of every run's bill, for the one platform that is
  // tested by hand every day. They run weekly and on demand instead.
  assert.ok(!lean.some((j) => j.os.includes("macos")), "no macOS on an ordinary push");
  assert.ok(full.some((j) => j.os.includes("macos")), "but the weekly run still covers it");
});

test("Windows stays on every run", () => {
  // Four real bugs came from it, and it is the platform nobody here is holding.
  assert.ok(lean.some((j) => j.os.includes("windows")));
});

test("the ends of the supported Node range are always exercised", () => {
  const nodes = new Set(lean.map((j) => j.node));
  assert.ok(nodes.has("20"), "20 is where the --test glob broke");
  assert.ok(nodes.has("24"), "24 is the newest supported");
});

test("no job is run twice", () => {
  for (const [label, list] of [["lean", lean], ["full", full]]) {
    const keys = list.map((j) => `${j.os}/${j.node}`);
    assert.equal(new Set(keys).size, keys.length, `${label} matrix repeats a job`);
  }
});

test("a superseded run is cancelled instead of paid for", () => {
  assert.match(yml, /concurrency:/);
  assert.match(yml, /cancel-in-progress:\s*true/);
});

test("the engines range and the tested range do not drift apart", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = pkg.engines?.node || "";
  const floor = declared.match(/(\d+)/)?.[1];
  if (!floor) return; // nothing declared, nothing to contradict
  const tested = lean.map((j) => Number(j.node)).sort((a, b) => a - b);
  assert.equal(
    tested[0],
    Number(floor),
    `package.json says node >=${floor} but the lowest tested is ${tested[0]}`,
  );
});

test("the README does not claim more testing than the matrix does", () => {
  // The trim made "all nine combinations are tested on every change" false the moment it landed.
  // A claim about how something is tested is exactly the kind that goes stale silently, because
  // the person changing the matrix is not reading the README.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const everyRun = new Set(lean.map((j) => j.os.replace("-latest", "")));

  assert.doesNotMatch(readme, /(all nine|every combination) (are|is) tested on every change/i);
  if (!everyRun.has("macos")) {
    assert.match(
      readme,
      /macOS (runs|is tested) weekly/i,
      "macOS is off the every-run matrix, so the README has to say when it does run",
    );
  }
});

test("the tests badge points at the branch CI actually runs on", () => {
  // It was pulled while the repository was private, because that badge 404s and the README is the
  // npm package page — a broken image at the top of it is the first thing a stranger sees. Now that
  // the repo is public it is back, and it has to name the branch the push trigger names: an
  // unqualified badge shows whatever ran last, including a run on a tag or a fork's PR.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const badge = readme.match(/actions\/workflows\/([\w.-]+)\/badge\.svg(\?branch=([\w.\/-]+))?/);
  assert.ok(badge, "the README shows the build state");
  assert.equal(badge[1], "tests.yml", "and it is this workflow, not another one");

  const push = yml.match(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[([^\]]+)\]/);
  const branches = push[1].split(",").map((b) => b.trim());
  assert.ok(
    branches.includes(badge[3]),
    `the badge tracks "${badge[3]}" but CI runs on ${branches.join("/")}`,
  );
});
