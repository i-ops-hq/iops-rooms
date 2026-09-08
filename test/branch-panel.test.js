// The Branches panel: what is still happening, and what is finished.
//
// This panel was the hardest part of the board to read. It listed every local ref as an equal row —
// twenty-four of them on this repo, twenty of which said "0 posts · —" and "no room posts yet" —
// and it badged both `main` and `master` "default", which tells the reader the page does not know
// which one is.

import test from "node:test";
import assert from "node:assert/strict";
import { renderBranchPanel } from "../src/board.js";

const post = (branch, at) => ({
  id: `${branch}-${at}`,
  at,
  type: "note",
  actor: "ada",
  branch,
  tool: "cli",
  text: "a post",
});

const historyWith = (branches) => ({
  ok: true,
  total: 10,
  truncated: 0,
  trunk: [],
  branches,
  agents: { agents: [], attributed: 0, plain: 10 },
  contributors: [{ name: "Ada", email: "a@e.com", commits: 10, merges: 0, insertions: 0, deletions: 0, files: 0, agents: [], topAgent: null, topAgentPct: 0 }],
  splitIdentities: [],
});

/** The panel takes its git facts as an argument, so the tests hand it repos it never has to build. */
const board = ({ git, events = [], history = null }) => renderBranchPanel(git, events, history);

const git = (over = {}) => ({
  ok: true,
  current: "main",
  defaultBranch: "main",
  branches: ["main", "master", "feature", "old-thing"],
  head: "abc1234",
  remote: null,
  dirty: 0,
  upstream: "",
  ahead: null,
  behind: null,
  note: "",
  ...over,
});

test("exactly one branch is badged default, and git decides which", () => {
  // A repo part-way through a master -> main rename has both. Only one of them is the default.
  const html = board({ git: git(), history: historyWith([]) });
  assert.equal((html.match(/branch-badge">default/g) || []).length, 1);
  assert.match(html, /main <span class="branch-badge">default/);
  assert.doesNotMatch(html, /master <span class="branch-badge">default/);

  // And when git says master, the badge follows git rather than the name.
  const old = board({
    git: git({ current: "master", defaultBranch: "master" }),
    history: historyWith([]),
  });
  assert.match(old, /master <span class="branch-badge">default/);
  assert.doesNotMatch(old, /main <span class="branch-badge">default/);
});

test("finished branches collapse; anything still live keeps its own row", () => {
  const html = board({
    git: git({ branches: ["main", "feature", "a", "b", "c"] }),
    events: [post("feature", "2026-09-05T00:00:00.000Z")],
    history: historyWith([
      { name: "feature", open: true, pr: null, commits: [{}, {}] },
      { name: "a", open: false, pr: 12, commits: [{}] },
    ]),
  });

  const [liveHalf, doneHalf] = html.split("<details");
  assert.match(liveHalf, />main</, "the default is always live");
  assert.match(liveHalf, />feature</, "unmerged commits keep it in view");
  assert.doesNotMatch(liveHalf, />b</, "a finished branch is not worth a row of its own");

  assert.match(html, /3 finished branches — merged or empty/, "and the count is said out loud");
  assert.match(doneHalf, />a</, "they are still there, one disclosure away");
  assert.match(doneHalf, />b</);
  assert.match(doneHalf, />c</);
});

test("a row says which of the three kinds of empty it is", () => {
  const html = board({
    git: git({ branches: ["main", "merged-ref", "still-open"] }),
    events: [post("only-a-stamp", "2026-09-05T00:00:00.000Z")],
    history: historyWith([{ name: "still-open", open: true, pr: null, commits: [{}, {}, {}] }]),
  });
  assert.match(html, /3 commits not on main/, "unmerged work is the interesting case");
  assert.match(html, /nothing on it that main does not have/, "a ref with no unique commits");
  assert.match(html, /not a branch in this checkout/, "a name that was only ever a post stamp");
});

test("a merged branch names its PR when the merge commit recorded one", () => {
  const html = board({
    git: git({ branches: ["main", "shipped"] }),
    events: [post("shipped", "2026-09-05T00:00:00.000Z")],
    history: historyWith([{ name: "shipped", open: false, pr: 42, commits: [{}] }]),
  });
  assert.match(html, /merged in #42/);
});
