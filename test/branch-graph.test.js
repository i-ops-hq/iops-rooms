// The branch graph: main as a rail, every other branch splitting off at its first post and
// rejoining at its last, one glowing dot per post, and a light travelling each wire.
//
// The wire-and-travelling-light treatment is taken from the I-Ops runtime architecture diagram:
// a dim static track, plus the SAME path drawn again with a short dash and an animated dash
// offset. These tests hold the geometry, because a graph that draws a branch rejoining at the
// wrong time is worse than no graph — it is a picture that lies about the repo.

import test from "node:test";
import assert from "node:assert/strict";
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

test("main is a rail across the whole span", () => {
  const svg = renderBranchGraph(model());
  assert.match(svg, /class="bg-track" d="M26 30 L974 30"/, "the rail runs the full inset width");
});

test("a branch leaves main at its first post and returns to main at its last", () => {
  const m = model();
  const svg = renderBranchGraph(m);
  const d = pathOf(svg, "feature");
  assert.ok(d, "the feature branch has a track");

  const [, sx, sy] = d.match(/^M([\d.]+) (\d+)/).map(Number);
  const end = d.match(/([\d.]+) (\d+)$/).map(Number);

  assert.equal(sy, 30, "it starts on the main rail");
  assert.equal(end[2], 30, "and it rejoins the main rail");
  assert.ok(sx < end[1], "the rejoin is later in time than the split");

  // The feature ran from minute 20 to 40 of a 60-minute span, so it must sit inside main's ends.
  assert.ok(sx > 26 && end[1] < 974, "a branch cannot start before or end after the rail");
  assert.ok(d.includes(" 64"), "and it dips to its own lane in between");
});

test("one dot per post, on the lane that posted it", () => {
  const svg = renderBranchGraph(model());
  const cores = svg.match(/class="bg-core"/g) || [];
  assert.equal(cores.length, 4, "four posts, four dots");

  const onMain = svg.match(/class="bg-core" cx="[\d.]+" cy="30"/g) || [];
  const onFeature = svg.match(/class="bg-core" cx="[\d.]+" cy="64"/g) || [];
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

test("branches beyond the drawn limit are counted out loud, not dropped in silence", () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    events.push(ev(`br-${i}`, "ada", i));
  }
  events.push(ev("main", "ada", 20));
  const svg = renderBranchGraph(buildTimelineModel(events, { branches: ["main"] }));
  assert.match(svg, /4 more branches not drawn/, "a cap the reader cannot see is an unrecorded cap");
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
