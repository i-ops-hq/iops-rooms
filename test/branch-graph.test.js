// The timeline: a row per branch, its name in a column of its own, and every mark on one time axis
// the reader can zoom.
//
// It replaced a single wide SVG — main as a rail, branches as arcs, a dot per commit — that could
// not be read at scale: on a repository of 8,269 commits the rail was a smear of 500 dots, twelve
// arcs crossed each other, names were cut off at the edges, and dots hung in empty space where an
// arc had already turned back to main. These tests hold the properties that fixed each of those,
// because a timeline that places a mark at the wrong time is worse than none: it is a picture that
// lies about the repo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTimelineModel, mergeHistoryIntoLanes, renderBranchGraph } from "../src/board.js";

const T0 = Date.parse("2026-09-07T10:00:00.000Z");
const DAY = 86_400_000;
const at = (min) => new Date(T0 + min * 60_000).toISOString();

const ev = (branch, actor, min, over = {}) => ({
  id: `${branch}-${min}`,
  at: at(min),
  type: "note",
  actor,
  branch,
  tool: "cli",
  text: `${actor} at ${min}`,
  ...over,
});

/** main spans the hour; one branch lives in the middle of it. */
function model() {
  const events = [
    ev("main", "ada", 0),
    ev("main", "ada", 60),
    ev("feature", "ben", 20),
    ev("feature", "ben", 40, { type: "diff", diff: "@@ -1 +1 @@" }),
  ];
  return buildTimelineModel(events, { branches: ["main", "feature"], current: "feature" });
}

/** The <details> row for `name`, so an assertion is about that row and not the whole figure. */
function rowOf(html, name) {
  const rows = html.split('<details class="ln-row"').slice(1);
  return rows.find((r) => r.includes(`title="${name}"`)) || "";
}

const commit = (sha, t, over = {}) => ({
  sha: `${sha}0000000000`,
  shortSha: sha,
  at: new Date(t).toISOString(),
  t,
  author: { name: "Ada", email: "ada@team.invalid" },
  subject: `did ${sha}`,
  agents: [],
  isMerge: false,
  insertions: 3,
  deletions: 1,
  files: 1,
  ...over,
});
const CLAUDE = [{ id: "claude", family: "Claude", label: "Claude Opus 5" }];

/** A history of `n` commits on main, `perDay` a day from T0, alternating Claude and none. */
function busy(n, perDay, over = {}) {
  const trunk = [];
  for (let i = 0; i < n; i += 1) {
    trunk.push(commit(`c${i}`, T0 + Math.floor(i / perDay) * DAY + (i % perDay) * 60_000, i % 2 ? {} : { agents: CLAUDE }));
  }
  const empty = buildTimelineModel([], { branches: ["main"], current: "main" });
  return mergeHistoryIntoLanes(empty, {
    ok: true,
    total: n,
    truncated: 0,
    trunk,
    branches: [],
    agents: { agents: [], attributed: 0, plain: 0 },
    contributors: [],
    ...over,
  });
}

// ── what is drawn, and where ────────────────────────────────────────────────────────────────────

test("a room with no posts draws nothing rather than an empty frame", () => {
  const empty = buildTimelineModel([], { branches: ["main"] });
  assert.equal(renderBranchGraph(empty), "", "no posts means there is no timeline to draw");
});

test("a row per branch, main first, then the most recently active", () => {
  // Named so that alphabetical order is the reverse of recency. With "new" and "old" the two orders
  // agreed, and a sort by name passed this test.
  const events = [ev("main", "ada", 0), ev("alpha", "ada", 5), ev("zulu", "ada", 50), ev("main", "ada", 60)];
  const html = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  const order = [...html.matchAll(/class="ln-label" title="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["main", "zulu", "alpha"]);
});

test("a branch's name is whole, in its own column, never cut to fit the drawing", () => {
  // The arcs' names were chips on the wires and were clipped at the edges of the SVG. A column
  // cannot clip a name, and the full text is there even where the stylesheet wraps it to two lines.
  const name = "feature/a-very-long-branch-name-that-used-to-be-cut-off-at-twenty-six";
  const html = renderBranchGraph(buildTimelineModel([ev("main", "ada", 0), ev(name, "ada", 10)], { branches: ["main"] }));
  assert.match(html, new RegExp(`class="ln-label" title="${name}">${name}</span>`));
  assert.doesNotMatch(html, /…/, "nothing is shortened with an ellipsis");
});

test("every mark sits on its own row, placed on one shared axis", () => {
  // Under three days the axis is the history's own extent plus a 6% margin: 10:00 to 11:00 here,
  // drawn from 09:56:24 to 11:03:36. Minute 20 is 23.6 of 67.2 minutes in.
  const html = renderBranchGraph(model());
  const feature = rowOf(html, "feature");
  assert.match(feature, /class="ln-post" data-kind="note" style="--x: 0\.35119"/, "the note at minute 20");
  assert.match(feature, /class="ln-post" data-kind="diff" style="--x: 0\.64881"/, "the diff at minute 40");
  assert.doesNotMatch(rowOf(html, "main"), /--x: 0\.35119/, "and main does not carry the branch's marks");
});

test("a branch's life is a line from its first mark to its last", () => {
  const feature = rowOf(renderBranchGraph(model()), "feature");
  assert.match(feature, /class="ln-span" style="--x: 0\.35119; --w: 0\.29762"/, "minute 20 to minute 40");
});

test("a short history is drawn to its own extent, so its commits do not pile onto one spot", () => {
  // In whole days, or whole hours, two posts twenty minutes apart could share one position.
  const html = renderBranchGraph(model());
  const xs = [...rowOf(html, "feature").matchAll(/class="ln-post"[^>]*--x: ([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.equal(new Set(xs).size, 2, "two marks, two places");
  assert.match(html, /Sep 7, 2026, 10:00 – 11:00 UTC/, "and the range line gives the data's own first and last moment");
});

test("a diff is a different mark from a note, so the kind reads without opening the row", () => {
  const feature = rowOf(renderBranchGraph(model()), "feature");
  assert.match(feature, /data-kind="diff"/);
  assert.match(feature, /data-kind="note"/);
});

// ── a busy lane ─────────────────────────────────────────────────────────────────────────────────

test("a busy lane is commits per day, stacked by the agents that made them", () => {
  // Fifty commits, ten a day: five bars rather than fifty dots.
  const html = renderBranchGraph(busy(50, 10));
  const main = rowOf(html, "main");
  assert.equal((main.match(/class="ln-bar"/g) || []).length, 5, "one bar per day");
  assert.doesNotMatch(main, /class="ln-dot"/, "and no dot per commit");
  assert.match(main, /<i data-agent="claude" style="flex: 5"><\/i><i data-agent="none" style="flex: 5"><\/i>/);
  assert.match(main, /title="Sep 7, 2026: 10 commits · Claude 5 · no agent recorded 5"/);
  assert.match(main, /data-dense="1"/, "the stylesheet draws a baseline under bars instead of a rail");
});

test("a quiet lane keeps a dot per commit", () => {
  const main = rowOf(renderBranchGraph(busy(12, 3)), "main");
  assert.equal((main.match(/class="ln-dot"/g) || []).length, 12);
  assert.doesNotMatch(main, /class="ln-bar"/);
});

test("a commit merged minutes later shows inside its merge ring, not under it", () => {
  // Drawn last, the ring covered the commit's colour whenever the two landed in one place.
  const merged = { name: "tiny-fix", pr: 9, mergedAt: new Date(T0 + 12 * DAY + 5 * 60_000).toISOString(), commits: [commit("m1", T0 + 12 * DAY, { agents: CLAUDE })] };
  const row = rowOf(renderBranchGraph(busy(12, 1, { branches: [merged] })), "tiny-fix");
  assert.ok(row.indexOf('class="ln-merge"') > -1 && row.indexOf('class="ln-dot"') > row.indexOf('class="ln-merge"'), "ring first, dot on top");
});

test("a history too short to zoom still has dates on its axis", () => {
  // Twelve days offers no 30-day window, and the weekly ticks were only ever shown inside one.
  const html = renderBranchGraph(busy(12, 1));
  assert.match(html, /<figure class="ln-figure" data-zoom="all" data-weeks="1"/);
  assert.ok((html.match(/class="ln-tick" data-g="w"/g) || []).length >= 1, "at least one weekly tick");
});

// ── opening a row ───────────────────────────────────────────────────────────────────────────────

test("every row opens into the list of what is on it, which is what a keyboard can reach", () => {
  // The lane is decoration over this list, so it is hidden from assistive technology and the list
  // is not: a picture must not be the only copy of the facts.
  const html = renderBranchGraph(model());
  const feature = rowOf(html, "feature");
  assert.match(feature, /^[^>]*>\s*<summary>/, "a details row with a summary, focusable by default");
  assert.match(feature, /class="ln-lane" aria-hidden="true"/);
  assert.equal((feature.match(/<li data-kind="post">/g) || []).length, 2, "both of the branch's posts, as text");
});

test("a long list is capped, and says how much it left out", () => {
  const main = rowOf(renderBranchGraph(busy(150, 10)), "main");
  assert.equal((main.match(/<li data-kind="commit">/g) || []).length, 100);
  assert.match(main, /and 50 older items not listed here/);
});

test("branches past the sixth are drawn and revealed, not dropped", () => {
  const events = [ev("main", "ada", 0)];
  for (let i = 0; i < 9; i += 1) events.push(ev(`br-${i}`, "ada", i + 1));
  const html = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.match(html, /<details class="ln-more"><summary>Show 3 more branches<\/summary>/);
  for (let i = 0; i < 9; i += 1) {
    assert.ok(html.includes(`title="br-${i}"`), `br-${i} is in the timeline, not omitted from it`);
  }
  const more = html.slice(html.indexOf('class="ln-more"'));
  assert.equal((more.match(/<details class="ln-row"/g) || []).length, 3, "the three oldest are behind it");
});

test("six or fewer branches need no reveal control at all", () => {
  const events = [ev("main", "ada", 0)];
  for (let i = 0; i < 6; i += 1) events.push(ev(`br-${i}`, "ada", i + 1));
  const html = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.doesNotMatch(html, /ln-more/, "nothing is hidden, so nothing offers to unhide it");
});

test("a person who posted on a branch is inside its row, as an ordinary box", async () => {
  // The avatars had a list of their own under the old graph, where the base avatar rule's
  // translate(-50%, -50%) — right for centring one on a track — pushed each half out of its row.
  const feature = rowOf(renderBranchGraph(model()), "feature");
  const [summary, body] = feature.split("</summary>");
  assert.match(summary, /class="ln-face"/, "a face in the row itself, so activity shows while it is closed");
  assert.doesNotMatch(summary, /<button/, "and nothing interactive inside the summary, which is itself the control");
  assert.match(body, /<div class="ln-people">[^]*class="tl-avatar"[^]*data-actor="ben"/, "the full avatar opens with the row");
  const css = await readFile(new URL("../templates/board.html", import.meta.url), "utf8");
  assert.match(css, /\.ln-people \.tl-avatar \{ position: relative; top: auto; left: auto; transform: none; \}/);
});

// ── the zoom, and saying what it leaves out ─────────────────────────────────────────────────────

test("a window is offered only when it zooms something, and says what it leaves out", () => {
  // 200 days of history: 30 and 90 days zoom, a year would not, and All is always there.
  const html = renderBranchGraph(busy(100, 0.5));
  const buttons = [...html.matchAll(/<button type="button" data-zoom="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ["30", "90", "all"]);
  assert.match(html, /data-zoom="30"[^>]*aria-pressed="true"/, "main is busy to the end, so it opens at 30 days");
  assert.match(html, /data-zoom="all"[^>]*data-outside-text="everything read is in this window"/);
  const outside90 = Number(html.match(/data-zoom="90"[^>]*data-outside-text="(\d+) older commits/)[1]);
  assert.ok(outside90 > 0 && outside90 < 100, "the 90-day window names how many are older than it");
  assert.match(html, /<figure class="ln-figure" data-zoom="30"[^>]*style="--z0: 0\.[0-9]+; --z1: 1"/);
});

test("it opens at the smallest window that still shows every row on screen", () => {
  // A branch last touched 58 days before the end: thirty days would show its row empty but for a
  // count, so the view opens at ninety.
  const slow = { name: "slow", pr: null, mergedAt: "", open: true, commits: [commit("s1", T0 + 140 * DAY)] };
  const html = renderBranchGraph(busy(100, 0.5, { branches: [slow] }));
  assert.match(html, /data-zoom="90"[^>]*aria-pressed="true"/);
  assert.match(html, /<figure class="ln-figure" data-zoom="90"/);
});

test("a range that crosses a year gives both years", () => {
  // "Mar 16 – Sep 18, 2026" over a span that began in 2023 read as six months.
  const html = renderBranchGraph(busy(100, 0.5));
  assert.match(html, /data-zoom="all"[^>]*data-range="Sep 7, 2026 – Mar 24, 2027"/);
  assert.match(html, /data-zoom="30"[^>]*data-range="Feb 23 – Mar 24, 2027"/, "and one inside a year gives it once");
});

test("a lane says how many of its marks are earlier than the window", () => {
  const html = renderBranchGraph(busy(100, 0.5));
  assert.match(rowOf(html, "main"), /data-before-30="\d+" data-before-90="\d+"/);
});

test("a short history offers no zoom, because none would zoom anything", () => {
  assert.doesNotMatch(renderBranchGraph(model()), /class="ln-zoom"/);
});

test("the cap on how much history was read is said once, for the whole figure", () => {
  const html = renderBranchGraph(busy(40, 10, { total: 8269, truncated: 8229 }));
  assert.match(html, /Reading the newest 40 of 8269 commits\./);
});

test("the drawn branches say how many branch refs the checkout has", () => {
  const html = renderBranchGraph(busy(12, 3, { branchRefs: 1527 }));
  assert.match(html, /This checkout has 1527 branch refs/);
});

// ── the stylesheet and the script have to agree with the markup ─────────────────────────────────

test("the stylesheet places every mark with one calc against the window", async () => {
  // Two files have to agree for the zoom to work. Nothing else notices when they stop agreeing.
  const css = await readFile(new URL("../templates/board.html", import.meta.url), "utf8");
  assert.match(css, /\.ln-lane > \* \{ position: absolute; left: calc\(\(var\(--x\) - var\(--z0\)\) \/ \(var\(--z1\) - var\(--z0\)\) \* 100%\); \}/);
  for (const id of ["30", "90", "365"]) {
    assert.match(css, new RegExp(`\\.ln-figure\\[data-zoom="${id}"\\] \\.ln-lane\\[data-before-${id}\\]::before`));
  }
});

test("the script reads exactly the attributes the renderer writes", async () => {
  const tpl = await readFile(new URL("../templates/board.html", import.meta.url), "utf8");
  const html = renderBranchGraph(busy(100, 0.5));
  for (const attr of ["data-z0", "data-zoom", "data-range", "data-outside-text"]) {
    assert.ok(tpl.includes(`getAttribute("${attr}")`), `the script reads ${attr}`);
    assert.ok(html.includes(`${attr}="`), `and the renderer writes it`);
  }
  assert.match(tpl, /fig\.style\.setProperty\("--z0"/);
});

test("markup in a branch name, actor or post text is escaped, not rendered", () => {
  const events = [
    ev("main", "ada", 0),
    ev('<img src=x onerror=alert(1)>', '<script>alert("who")</script>', 10, {
      text: '</title><script>alert("text")</script>',
    }),
  ];
  const html = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.doesNotMatch(html, /<script>/, "no injected script tag");
  assert.doesNotMatch(html, /<img src=x onerror=/, "no injected handler");
  assert.match(html, /&lt;script&gt;/, "shown as text instead");
});
