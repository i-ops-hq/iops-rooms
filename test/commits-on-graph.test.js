// Commits on the branch graph.
//
// The graph drew room posts — what someone TOLD the room. It now also draws commits — what actually
// landed. Both are events on a branch at a time, so they share lanes and one axis, but they keep
// their own dot kind, and a lane made only of commits is still drawn: most projects have far more
// commits than posts, and a graph that hid them would be a picture of the room rather than of the
// project.

import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineModel, mergeHistoryIntoLanes, renderBranchGraph } from "../src/board.js";

const T = (min) => new Date(Date.parse("2026-09-07T10:00:00.000Z") + min * 60_000).toISOString();

const commit = (sha, min, over = {}) => ({
  sha: `${sha}0000000000`,
  shortSha: sha,
  at: T(min),
  t: Date.parse(T(min)),
  author: { name: "Ada", email: "ada@team.invalid" },
  subject: `did ${sha}`,
  agents: [],
  isMerge: false,
  insertions: 10,
  deletions: 2,
  files: 1,
  ...over,
});

const CLAUDE = [{ id: "claude", family: "Claude", label: "Claude Opus 5" }];
const CURSOR = [{ id: "cursor", family: "Cursor", label: "Cursor" }];

const history = (over = {}) => ({
  ok: true,
  total: 4,
  truncated: 0,
  trunk: [commit("aaa", 0, { agents: CLAUDE }), commit("bbb", 60)],
  branches: [
    { name: "feature", pr: 7, mergeSha: "mmm", mergedAt: T(50), commits: [commit("ccc", 20, { agents: CURSOR })] },
  ],
  agents: { agents: [], attributed: 0, plain: 0 },
  contributors: [],
  splitIdentities: [],
  ...over,
});

const emptyModel = () => buildTimelineModel([], { branches: ["main"], current: "main" });

test("with no history the graph is unchanged — room posts still stand alone", () => {
  const model = buildTimelineModel(
    [{ id: "1", at: T(5), type: "note", actor: "ada", branch: "main", tool: "cli", text: "hi" }],
    { branches: ["main"], current: "main" },
  );
  const same = mergeHistoryIntoLanes(model, null);
  assert.equal(same, model, "a folder that is not a checkout changes nothing");
  assert.match(renderBranchGraph(same), /bg-core/, "and the post is still drawn");
});

test("commits appear as dots even when the room has no posts at all", () => {
  const m = mergeHistoryIntoLanes(emptyModel(), history());
  const svg = renderBranchGraph(m);
  assert.match(svg, /data-kind="commit"/, "a project with history is drawable before anyone posts");
  assert.equal((svg.match(/data-kind="commit"/g) || []).length, 3, "two on trunk, one on the branch");
});

test("a merged branch becomes a lane that splits and rejoins", () => {
  const m = mergeHistoryIntoLanes(emptyModel(), history());
  const svg = renderBranchGraph(m);
  assert.match(svg, />feature</, "the branch is named from its merge commit");
  const lane = m.lanes.find((l) => l.name === "feature");
  assert.equal(lane.points.length, 1);
  assert.equal(lane.pr, 7, "and carries its PR number");
});

test("a commit is coloured by the agent that made it; a room post is not", () => {
  const model = buildTimelineModel(
    [{ id: "1", at: T(30), type: "note", actor: "ada", branch: "main", tool: "cli", text: "hi" }],
    { branches: ["main"], current: "main" },
  );
  const svg = renderBranchGraph(mergeHistoryIntoLanes(model, history()));
  assert.match(svg, /data-agent="claude"/, "the attributed commit takes the agent palette");
  assert.match(svg, /data-agent="cursor"/);
  assert.doesNotMatch(svg, /data-agent="cli"/, "a room post's tool is a different fact and must not borrow it");
});

test("a commit dot says the sha, the person, the agent and what it moved", () => {
  const svg = renderBranchGraph(mergeHistoryIntoLanes(emptyModel(), history()));
  assert.match(svg, /aaa · Ada · Claude Opus 5 · \+10 −2/);
  assert.match(svg, /bbb · Ada · no agent recorded/, "a plain commit is the person's own work, not an unknown");
});

test("a merge is drawn as a merge, not as a commit that moved nothing", () => {
  const h = history({
    trunk: [commit("mmm", 40, { isMerge: true, insertions: 0, deletions: 0 })],
    branches: [],
  });
  const svg = renderBranchGraph(mergeHistoryIntoLanes(emptyModel(), h));
  assert.match(svg, /data-kind="merge"/);
  assert.match(svg, /mmm · Ada · no agent recorded · merge/, "no misleading +0 −0 on a merge");
});

test("the axis spans commits and posts together, not just the room's own window", () => {
  // The room's only post is at minute 30. Without a shared axis the year of commits around it
  // would be squashed into whatever window the room happens to cover.
  const model = buildTimelineModel(
    [{ id: "1", at: T(30), type: "note", actor: "ada", branch: "main", tool: "cli", text: "hi" }],
    { branches: ["main"], current: "main" },
  );
  const merged = mergeHistoryIntoLanes(model, history());
  assert.equal(merged.tMin, Date.parse(T(0)), "starts at the first commit");
  assert.equal(merged.tMax, Date.parse(T(60)), "ends at the last");

  const main = merged.lanes.find((l) => l.isMain);
  const pcts = main.points.map((p) => Math.round(p.pct));
  assert.ok(pcts[0] <= 2 && pcts[pcts.length - 1] >= 98, "the ends of the span sit at the ends of the axis");
  assert.deepEqual([...pcts].sort((a, b) => a - b), pcts, "and points stay in time order");
});

test("room posts and commits on one branch share its lane", () => {
  const model = buildTimelineModel(
    [{ id: "1", at: T(30), type: "note", actor: "ada", branch: "main", tool: "cli", text: "hi" }],
    { branches: ["main"], current: "main" },
  );
  const merged = mergeHistoryIntoLanes(model, history());
  const main = merged.lanes.find((l) => l.isMain);
  const kinds = main.points.map((p) => p.type);
  assert.ok(kinds.includes("commit") && kinds.includes("note"), "one lane carries both");
  assert.equal(main.points.length, 3, "two commits and the post");
});
