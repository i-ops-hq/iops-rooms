// The branch graph: main as a rail, every other branch splitting off at its first post and
// rejoining at its last, one glowing dot per post, and a light travelling each wire.
//
// The wire-and-travelling-light treatment is taken from the I-Ops runtime architecture diagram:
// a dim static track, plus the SAME path drawn again with a short dash and an animated dash
// offset. These tests hold the geometry, because a graph that draws a branch rejoining at the
// wrong time is worse than no graph — it is a picture that lies about the repo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTimelineModel, renderBranchGraph } from "../src/board.js";

const T0 = Date.parse("2026-09-07T10:00:00.000Z");
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

/** main spans the whole hour; one branch lives in the middle of it. */
function model() {
  const events = [
    ev("main", "ada", 0),
    ev("main", "ada", 60),
    ev("feature", "ben", 20),
    ev("feature", "ben", 40, { type: "diff", diff: "@@ -1 +1 @@" }),
  ];
  return buildTimelineModel(events, { branches: ["main", "feature"], current: "feature" });
}

const pathOf = (svg, label) => {
  const g = svg.split("<g ").find((chunk) => chunk.includes(`>${label}</text>`));
  return g ? (g.match(/class="bg-track" d="([^"]+)"/) || [])[1] : undefined;
};

test("a room with no posts draws nothing rather than an empty frame", () => {
  const empty = buildTimelineModel([], { branches: ["main"] });
  assert.equal(renderBranchGraph(empty), "", "no posts means there is no graph to draw");
});

test("main is a rail across the whole span, in the middle of the picture", () => {
  const svg = renderBranchGraph(model());
  // One other branch, so it reaches one lane out and main sits one lane plus the edge from the top.
  assert.match(svg, /class="bg-track" d="M26 64 L974 64"/, "the rail runs the full inset width");
  assert.match(svg, /viewBox="0 0 1000 128"/, "and the drawing is symmetric about it");
});

test("a branch leaves main at its first post and returns to main at its last", () => {
  const m = model();
  const svg = renderBranchGraph(m);
  const d = pathOf(svg, "feature");
  assert.ok(d, "the feature branch has a track");

  const [, sx, sy] = d.match(/^M([\d.]+) (\d+)/).map(Number);
  const end = d.match(/([\d.]+) (\d+)$/).map(Number);

  assert.equal(sy, 64, "it starts on the main rail");
  assert.equal(end[2], 64, "and it rejoins the main rail");
  assert.ok(sx < end[1], "the rejoin is later in time than the split");

  // A branch leaves main one event before its own first and rejoins one after its own last —
  // which is where it actually forked and merged. Here that is main's first and main's last.
  assert.ok(sx >= 26 && end[1] <= 974, "a branch cannot start before or end after the rail");
  assert.ok(d.includes(" 98"), "and it dips to its own lane in between");

  // Its own dots stay strictly inside that, because the fork and the merge are not its commits.
  const dots = [...svg.matchAll(/class="bg-core" cx="([\d.]+)" cy="98"/g)].map((m) => Number(m[1]));
  assert.equal(dots.length, 2);
  assert.ok(Math.min(...dots) > sx && Math.max(...dots) < end[1], "the wire outlives its commits");
});

test("the axis is commit order, so a forty-minute branch is not a vertical spike", () => {
  // Two events a minute apart, inside a span of a year. On a time axis the branch would be
  // 0.0002% of the width; on an order axis it is a readable share of it.
  const events = [
    ev("main", "ada", 0),
    ev("feature", "ben", 200_000),
    ev("feature", "ben", 200_001),
    ev("main", "ada", 525_600),
  ];
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main", "feature"] }));
  const d = pathOf(svg, "feature");
  const x1 = Number(d.match(/^M([\d.]+) /)[1]);
  const x2 = Number(d.match(/([\d.]+) \d+$/)[1]);
  assert.ok(x2 - x1 > 300, `a branch of two of four events takes its share of the width (${x2 - x1})`);
});

test("a long history gets a wider drawing rather than a more crowded one", () => {
  const events = [];
  for (let i = 0; i < 300; i += 1) events.push(ev("main", "ada", i));
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  const w = Number(svg.match(/viewBox="0 0 (\d+) /)[1]);
  assert.equal(w, 300 * 13 + 52, "13px a commit, so 300 commits scroll instead of overlapping");
  assert.match(svg, /--vb-w: 3952px/, "and the element is that wide, inside its own scroller");
});

test("branches alternate below main, above main, and outward from there", () => {
  const events = [ev("main", "ada", 0), ev("main", "ada", 60)];
  for (let i = 0; i < 4; i += 1) events.push(ev(`br-${i}`, "ada", 10 + i * 8));
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));

  // Four branches reach two lanes either side: main sits at 2*34 + 30.
  assert.match(svg, /class="bg-track" d="M26 98 L974 98"/, "main is centred");
  const lanes = [...svg.matchAll(/class="bg-core" cx="[\d.]+" cy="(\d+)"/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y !== 98);
  const distinct = [...new Set(lanes)].sort((a, b) => a - b);
  assert.deepEqual(distinct, [30, 64, 132, 166], "two lanes above main and two below, evenly spaced");
});

test("one dot per post, on the lane that posted it", () => {
  const svg = renderBranchGraph(model());
  const cores = svg.match(/class="bg-core"/g) || [];
  assert.equal(cores.length, 4, "four posts, four dots");

  const onMain = svg.match(/class="bg-core" cx="[\d.]+" cy="64"/g) || [];
  const onFeature = svg.match(/class="bg-core" cx="[\d.]+" cy="98"/g) || [];
  assert.equal(onMain.length, 2, "two on the rail");
  assert.equal(onFeature.length, 2, "two on the branch");
});

test("a diff is a different dot from a note, so the kind reads without a legend", () => {
  const svg = renderBranchGraph(model());
  assert.match(svg, /data-kind="diff"/, "the diff post is marked");
  assert.match(svg, /data-kind="note"/, "and a plain note is not");
});

test("every wire gets a travelling light, and each starts at a different moment", () => {
  const svg = renderBranchGraph(model());
  assert.equal((svg.match(/class="bg-pulse"/g) || []).length, 2, "main and the branch each carry one");
  assert.match(svg, /--delay: 0\.00s/, "the branch pulses are staggered rather than in lockstep");
});

test("a branch name is chipped over its wire so it reads where lines cross", () => {
  const svg = renderBranchGraph(model());
  assert.match(svg, /<rect class="bg-tag"[^>]*><\/rect><text class="bg-label"[^>]*>feature<\/text>/);
});

test("branches past the sixth are drawn and revealed, not dropped", () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    events.push(ev(`br-${i}`, "ada", i));
  }
  events.push(ev("main", "ada", 20));
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));

  assert.match(svg, /\+ 6 more branches/, "the reader is told how many are out of view");
  for (let i = 0; i < 12; i += 1) {
    assert.ok(svg.includes(`>br-${i}</text>`), `br-${i} is in the drawing, not omitted from it`);
  }
  // Marked so the stylesheet can hide them: cropping alone leaves their risers crossing the
  // visible band, a line to nowhere from a branch whose name is off screen.
  assert.equal((svg.match(/data-extra="1"/g) || []).length, 6, "the six out of view are marked");
  assert.match(svg, /data-lane="5"[^>]*style=/, "and the sixth is not");

  // Collapsed shows six lanes around main; the checkbox swaps to the drawing's own full height.
  assert.match(svg, /--vb-open: 264/, "six lanes plus the edge, above and below");
  assert.match(svg, /--vb-full: 468/, "and every lane when opened");
  assert.match(svg, /viewBox="0 0 1000 468"/, "the viewBox always holds all of them");
});

test("six or fewer branches need no reveal control at all", () => {
  const events = [ev("main", "ada", 0)];
  for (let i = 0; i < 6; i += 1) events.push(ev(`br-${i}`, "ada", i + 1));
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.doesNotMatch(svg, /bg-expand/, "nothing is hidden, so nothing offers to unhide it");
  assert.match(svg, /--vb-open: 264/);
  assert.match(svg, /--vb-full: 264/, "collapsed and open are the same picture");
});

test("a graph wider than its window ships a control that says so", async () => {
  const events = [];
  for (let i = 0; i < 200; i += 1) events.push(ev("main", "ada", i));
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.match(svg, /class="bg-slider"/, "a range input, not only a scrollbar");
  assert.match(svg, /aria-label="Scroll the branch graph through history"/);
  assert.match(svg, /data-graph-width="2652"/, "and the drawing is genuinely wider than any window");

  // Hidden in the markup: the script un-hides it only after measuring a real overflow, so a graph
  // that fits never ships a slider that cannot move.
  assert.match(svg, /class="bg-slider"[^>]*hidden/);
});

test("the script and the stylesheet agree about the slider and the scrollbar", async () => {
  const tpl = await readFile(new URL("../templates/board.html", import.meta.url), "utf8");

  // `flex-direction: row-reverse` is the usual CSS-only right-anchor. It reported scrollLeft 0 with
  // the OLDEST commits in view, so the position is set in script where it can be measured.
  assert.doesNotMatch(tpl, /\.bg-scroll\s*\{[^}]*row-reverse/s, "the hack that did not work");
  assert.match(tpl, /scroll\.scrollLeft = span\(\)/, "opens at the newest end");

  // scrollbar-width and ::-webkit-scrollbar are mutually exclusive in Chrome: the standard property
  // makes it ignore the pseudo-elements, and on macOS `thin` is an overlay that occupies no space.
  assert.match(tpl, /@supports not selector\(::-webkit-scrollbar\)[^}]*\{[^}]*scrollbar-width/s);

  // The native bar is only hidden once a slider is really on screen.
  assert.match(tpl, /\.branch-graph\[data-slider="on"\] \.bg-scroll::-webkit-scrollbar \{ height: 0; \}/);
  assert.match(tpl, /fig\.setAttribute\("data-slider", "on"\)/);
  assert.match(tpl, /fig\.removeAttribute\("data-slider"\)/);
});

test("the stylesheet actually hides what the markup marks as out of view", async () => {
  // Two files have to agree for the collapse to work. Nothing else notices when they stop agreeing.
  const css = await readFile(new URL("../templates/board.html", import.meta.url), "utf8");
  assert.match(css, /\.bg-branch\[data-extra="1"\]\s*\{\s*display: none;/);
  assert.match(css, /\.bg-toggle:checked ~ \.bg-scroll \.bg-branch\[data-extra="1"\]/);
  assert.match(css, /\.bg-toggle:checked ~ \.bg-scroll svg \{ height: var\(--vb-full/);
});

test("markup in a branch name, actor or post text is escaped, not rendered", () => {
  const events = [
    ev("main", "ada", 0),
    ev('<img src=x onerror=alert(1)>', '<script>alert("who")</script>', 10, {
      text: '</title><script>alert("text")</script>',
    }),
  ];
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.doesNotMatch(svg, /<script>/, "no injected script tag");
  assert.doesNotMatch(svg, /<img src=x onerror=/, "no injected handler");
  assert.match(svg, /&lt;script&gt;/, "shown as text instead");
});
