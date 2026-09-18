// Reading who built a project out of git, with no MCP, no network and no vendor's private state.
//
// The signal is the `Co-Authored-By` trailer that Claude Code and Cursor already write, so a repo
// built with either has this history before it has ever heard of Rooms. A commit with no trailer is
// the person's own, not an unknown.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import {
  attributeAgent,
  marksItselfABot,
  readCommits,
  readHistoryGraph,
  rollUpAgents,
  rollUpContributors,
} from "../src/git-history.js";
import { renderBuiltBy } from "../src/board.js";

const run = promisify(execFile);

async function repo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-hist-"));
  const git = (...a) =>
    run("git", ["-c", "user.email=ada@team.invalid", "-c", "user.name=Ada", ...a], { cwd: dir });
  await git("init", "-q", "-b", "main", ".");
  const commit = async (file, body, msg, trailer) => {
    await writeFile(join(dir, file), body, "utf8");
    await git("add", file);
    await git("commit", "-q", "-m", trailer ? `${msg}\n\n${trailer}` : msg);
  };
  try {
    await fn({ dir, git, commit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLAUDE = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";
const CURSOR = "Co-Authored-By: Cursor <cursoragent@cursor.com>";
// Assembled rather than written whole, so the `${...}` survives being read by anything that
// interpolates — which is the same accident that put it in the commit in the first place.
const LEAKED_TEMPLATE =
  "Co-Authored-By: Claude Code (" + "$" + "{CLAUDE_PROJECT_DIR}) <noreply@anthropic.com>";

// ------------------------------------------------------------------ attribution

test("an agent trailer is recognised by domain, and keeps the model name it stated", () => {
  const a = attributeAgent("Claude Opus 5 <noreply@anthropic.com>");
  assert.equal(a.id, "claude");
  assert.equal(a.label, "Claude Opus 5", "Opus 5 and Fable must not both flatten to 'Claude'");

  const f = attributeAgent("Claude Fable 5.1 <noreply@anthropic.com>");
  assert.equal(f.id, "claude");
  assert.equal(f.label, "Claude Fable 5.1");

  assert.equal(attributeAgent("Cursor <cursoragent@cursor.com>").id, "cursor");
});

test("a human co-author is not mistaken for an unknown robot", () => {
  assert.equal(attributeAgent("Ben Smith <ben@example.com>"), null);
  assert.equal(attributeAgent(""), null);
});

test("a person at an AI company's domain is a person", () => {
  // This matched on DOMAIN, and github.com is not only where Copilot lives — it is the domain of
  // users.noreply.github.com, the address GitHub hands every human with an account. On a normal
  // GitHub repo every human co-author was counted as Copilot, and the board's headline
  // "agent-assisted" figure was inflated by exactly those people.
  for (const trailer of [
    "Ada Lovelace <12345+ada@users.noreply.github.com>",
    "Ben <ben@users.noreply.github.com>",
    "octocat <octocat@github.com>",
  ]) {
    assert.equal(attributeAgent(trailer), null, `${trailer} is a person`);
  }

  // The same trap was set for the other four families: those domains have employees.
  assert.equal(attributeAgent("Jane Doe <jane@anthropic.com>"), null);
  assert.equal(attributeAgent("Sam <sam@openai.com>"), null);
  assert.equal(attributeAgent("Pat <pat@cursor.com>"), null);
});

test("the agents themselves still land, by the name they write", () => {
  // GitHub's own Copilot co-author trailer, which is where the domain rule came from.
  const c = attributeAgent("Copilot <198982749+Copilot@users.noreply.github.com>");
  assert.equal(c.id, "copilot");

  // A mailbox no person can hold still counts, so an agent that renames itself is not lost.
  assert.equal(attributeAgent("Opus <noreply@anthropic.com>").id, "claude");
  assert.equal(attributeAgent("Agent <cursoragent@cursor.com>").id, "cursor");
});

// ------------------------------------------------------------------ reading history

test("every commit is read, attributed or not, with its line counts", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "one\ntwo\n", "by a person");
    await commit("b.txt", "x\n", "with claude", CLAUDE);
    await commit("c.txt", "y\n", "with cursor", CURSOR);

    const r = await readCommits(dir);
    assert.equal(r.ok, true);
    assert.equal(r.total, 3);
    assert.equal(r.commits.length, 3);
    assert.equal(r.truncated, 0);

    const claude = r.commits.find((c) => c.subject === "with claude");
    assert.equal(claude.agents[0].label, "Claude Opus 5");
    assert.equal(claude.insertions, 1);

    const human = r.commits.find((c) => c.subject === "by a person");
    assert.deepEqual(human.agents, [], "no trailer means the person's own commit");
    assert.equal(human.insertions, 2);
  });
});

test("a cap on how much history is read is reported, not applied in silence", async () => {
  await repo(async ({ dir, commit }) => {
    for (let i = 0; i < 5; i += 1) await commit(`f${i}.txt`, `${i}\n`, `c${i}`);
    const r = await readCommits(dir, { limit: 2 });
    assert.equal(r.commits.length, 2);
    assert.equal(r.total, 5);
    assert.equal(r.truncated, 3, "a board that draws 2 of 5 and says nothing changes the answer");
  });
});

test("a folder that is not a checkout is not an error, it just has no history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-nogit-"));
  try {
    const r = await readCommits(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.commits, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ merges

test("a merge contributes no lines, and is counted as a merge rather than as empty work", async () => {
  await repo(async ({ dir, git, commit }) => {
    await commit("base.txt", "base\n", "base");
    await git("checkout", "-q", "-b", "feature");
    await commit("feat.txt", "feature work\n", "did the feature", CLAUDE);
    await git("checkout", "-q", "main");
    await git("merge", "-q", "--no-ff", "feature", "-m", "Merge branch 'feature'");

    const r = await readCommits(dir);
    const merge = r.commits.find((c) => c.isMerge);
    assert.ok(merge, "the merge is present");
    assert.equal(merge.insertions, 0, "git reports no numstat for a merge");

    const [p] = rollUpContributors(r.commits);
    assert.equal(p.merges, 1, "counted as a merge");
    assert.ok(p.commits > p.merges, "and not confused with authored commits");
  });
});

test("a merged branch is reconstructed from its merge commit, even after the branch is gone", async () => {
  await repo(async ({ dir, git, commit }) => {
    await commit("base.txt", "base\n", "base");
    await git("checkout", "-q", "-b", "feature");
    await commit("f1.txt", "a\n", "feature one", CLAUDE);
    await commit("f2.txt", "b\n", "feature two", CLAUDE);
    await git("checkout", "-q", "main");
    await git("merge", "-q", "--no-ff", "feature", "-m", "Merge branch 'feature'");
    await git("branch", "-q", "-D", "feature"); // the branch no longer exists

    const g = await readHistoryGraph(dir);
    assert.equal(g.ok, true);
    assert.equal(g.branches.length, 1, "the merge still tells us the branch existed");
    assert.equal(g.branches[0].name, "feature", "and what it was called");
    assert.equal(g.branches[0].commits.length, 2, "and what it brought in");
    assert.ok(
      !g.trunk.some((c) => c.subject === "feature one"),
      "a branch commit is on its branch, not replayed on the trunk as well",
    );
  });
});

test("a linear history has no branches, and that is not a failure", async () => {
  // A repo whose rule is to work on main is exactly this: every commit on one rail, no merges.
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two");
    const g = await readHistoryGraph(dir);
    assert.equal(g.branches.length, 0);
    assert.equal(g.trunk.length, 2, "everything is on the rail");
  });
});

// ------------------------------------------------------------------ rollups

test("agent totals separate attributed work from work with no agent recorded", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two", CURSOR);
    await commit("c.txt", "3\n", "three");
    const { agents, attributed, plain } = rollUpAgents((await readCommits(dir)).commits);
    assert.equal(attributed, 2);
    assert.equal(plain, 1, "a plain commit is not evidence that no agent was used, only unrecorded");
    // The row is the AGENT. The trailer said "Claude Opus 5" and Claude Code is what wrote it —
    // keying rows on the trailer text split one agent into a row per model, and anthropic-sdk-python
    // showed Claude Code five times with nobody able to see how much it had done.
    assert.deepEqual(agents.map((a) => a.label).sort(), ["Claude", "Cursor"]);
    assert.deepEqual(
      agents.find((a) => a.label === "Claude").variants,
      [{ label: "Claude Opus 5", commits: 1 }],
      "the model is kept underneath, because it is a detail of the agent and not a second agent",
    );
  });
});

const CLAUDE_47 = "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>";

test("two models of one agent are one row, and one commit", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two", CLAUDE_47);
    // Both trailers on a single commit: still one commit, and still one agent on it.
    await commit("c.txt", "3\n", "three", `${CLAUDE}\n${CLAUDE_47}`);
    const { agents, attributed, multi } = rollUpAgents((await readCommits(dir)).commits);
    assert.equal(agents.length, 1, "one agent");
    assert.equal(agents[0].commits, 3, "on three commits, not four");
    assert.equal(attributed, 3);
    assert.equal(multi, 0, "two models of one agent is not two agents, so nothing is split");
    // Counts, not just labels. Each model is on two of the three commits — its own and the shared
    // one — and asserting only the names would miss a variant tally that double-counted.
    assert.deepEqual(
      [...agents[0].variants].sort((a, b) => a.label.localeCompare(b.label)),
      [{ label: "Claude Opus 4.7", commits: 2 }, { label: "Claude Opus 5", commits: 2 }],
    );
  });
});

test("a co-author that marks itself a bot is counted apart from one that does not", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", "Co-Authored-By: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>");
    await commit("b.txt", "2\n", "two", "Co-Authored-By: Zanie Blue <contact@zanie.dev>");
    await commit("c.txt", "3\n", "three", "Co-Authored-By: Charlie Marsh <charlie@astral.sh>");
    const { coauthoredByBot, coauthoredByPerson, coauthored } = rollUpAgents(
      (await readCommits(dir)).commits,
    );
    // On astral-sh/uv these three sat in ONE row labelled "co-author, not a known agent" at 47%,
    // beside the agent rows. The bucket was maintainers and release bots and it read as agent work.
    assert.equal(coauthoredByBot, 1);
    assert.equal(coauthoredByPerson, 2);
    assert.equal(coauthored, 3, "the total is still there for anything that wants the sum");
  });
});

test("a commit with a person and a bot on it goes with the people", async () => {
  await repo(async ({ dir, commit }) => {
    await commit(
      "a.txt", "1\n", "one",
      "Co-Authored-By: github-actions[bot] <github-actions[bot]@users.noreply.github.com>\n" +
        "Co-Authored-By: Ada Lovelace <ada@team.invalid>",
    );
    const { coauthoredByBot, coauthoredByPerson } = rollUpAgents((await readCommits(dir)).commits);
    // One bucket per commit, so it has to pick. The human is the more informative half.
    assert.equal(coauthoredByPerson, 1);
    assert.equal(coauthoredByBot, 0);
  });
});

test("marksItselfABot reads GitHub's marker and does not guess from a name", async () => {
  assert.equal(marksItselfABot({ label: "dependabot[bot]", email: "x@y" }), true);
  assert.equal(marksItselfABot({ label: "x", email: "1+renovate[bot]@users.noreply.github.com" }), true);
  // Would be automation on a suffix rule, and is not marked. Understating automation is the safe
  // direction; the alternative also reads a person named Abbot as a robot.
  assert.equal(marksItselfABot({ label: "zaniebot", email: "z@example.com" }), false);
  assert.equal(marksItselfABot({ label: "Talbot Reid", email: "t@example.com" }), false);
});

test("an unexpanded shell variable is not shown as the agent's name", async () => {
  await repo(async ({ dir, commit }) => {
    // Real, from anthropic-sdk-python: a hook wrote the template instead of the value, and rooms
    // printed `Claude Code (${CLAUDE_PROJECT_DIR})` as an agent.
    await commit("a.txt", "1\n", "one", LEAKED_TEMPLATE);
    const { agents } = rollUpAgents((await readCommits(dir)).commits);
    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0].variants, [{ label: "Claude Code", commits: 1 }]);
  });
});

test("an agent share is of that person's ATTRIBUTED commits, not of all of them", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two", CLAUDE);
    await commit("c.txt", "3\n", "three");
    const [p] = rollUpContributors((await readCommits(dir)).commits);
    assert.equal(p.attributed, 2);
    assert.equal(p.plain, 1);
    assert.equal(p.topAgentPct, 100, "2 of 2 attributed, not 2 of 3 commits");
  });
});

// ------------------------------------------------------------------ the panel

test("the panel names the agents, the people and where the attribution came from", async () => {
  await repo(async ({ dir, commit }) => {
    await commit("a.txt", "1\n", "one", CLAUDE);
    await commit("b.txt", "2\n", "two");
    const html = renderBuiltBy(await readHistoryGraph(dir));
    assert.match(html, /Claude Opus 5/);
    assert.match(html, /no agent recorded/, "unattributed work is named, not hidden");
    assert.match(html, /Co-Authored-By/, "the panel says where it got this");
    assert.match(html, /private state/, "and that it read nothing it should not have");
    assert.match(html, /Ada/);
  });
});

test("the panel's first sentence counts what it read, not the whole repository", async () => {
  // It said "From 8269 commits" over figures computed from the newest 500, and put the correction in
  // a note at the bottom. The count a reader takes away is the one in the first sentence.
  await repo(async ({ dir, commit }) => {
    for (let i = 0; i < 5; i += 1) await commit(`f${i}.txt`, `${i}\n`, `c${i}`);
    const capped = renderBuiltBy(await readHistoryGraph(dir, { limit: 3 }));
    assert.match(capped, /From the newest <strong>3<\/strong> of 5 commits of git history/);
    const whole = renderBuiltBy(await readHistoryGraph(dir));
    assert.match(whole, /From <strong>5<\/strong> commits of git history/);
  });
});

test("one name under two addresses is flagged, never merged on a guess", async () => {
  await repo(async ({ dir, git, commit }) => {
    await commit("a.txt", "1\n", "one");
    await writeFile(join(dir, "b.txt"), "2\n", "utf8");
    await git("add", "b.txt");
    await run("git", ["-c", "user.email=ada@other.invalid", "-c", "user.name=Ada", "commit", "-q", "-m", "two"], { cwd: dir });

    const g = await readHistoryGraph(dir);
    assert.equal(g.splitIdentities.length, 1, "the same name under two addresses is worth saying");
    assert.equal(g.contributors.length, 2, "but they stay separate — merging could merge two people");
    assert.match(renderBuiltBy(g), /mailmap/, "and the panel names git's own fix");
  });
});

test("a room with git but no commits renders no panel rather than an empty one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-empty-"));
  try {
    await run("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    assert.equal(renderBuiltBy(await readHistoryGraph(dir)), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git strips angle brackets from an author name before we ever see it", async () => {
  // Worth pinning as a fact rather than defending against: `Name <email>` is git's own format, so
  // it removes < and > from a name at commit time. The vector for this panel is elsewhere.
  await repo(async ({ dir, git }) => {
    await writeFile(join(dir, "a.txt"), "1\n", "utf8");
    await git("add", "a.txt");
    await run(
      "git",
      ["-c", "user.email=x@x.invalid", "-c", "user.name=<script>alert(1)</script>", "commit", "-q", "-m", "safe"],
      { cwd: dir },
    );
    const g = await readHistoryGraph(dir);
    assert.equal(g.contributors[0].name, "scriptalert(1)/script", "git sanitised it, not us");
    assert.doesNotMatch(renderBuiltBy(g), /<script>/);
  });
});

test("markup in an agent trailer is escaped — a trailer is free text and reaches the panel", async () => {
  await repo(async ({ dir, commit }) => {
    await commit(
      "a.txt",
      "1\n",
      "one",
      'Co-Authored-By: <img src=x onerror=alert(1)> Claude <noreply@anthropic.com>',
    );
    const g = await readHistoryGraph(dir);
    const html = renderBuiltBy(g);
    assert.ok(g.agents.agents.length, "it is still recognised as an agent by its domain");
    assert.doesNotMatch(html, /<img src=x onerror=/, "no injected handler");
    assert.match(html, /&lt;img src=x/, "shown as text instead");
  });
});

test("a branch that was never merged still appears — on a repo that never merges it is all there is", async () => {
  // Reading only merge commits missed the branches that matter most. A project working on main has
  // zero merges and can still have a dozen live branches; a board saying "no branches" while
  // `git branch -r` lists eleven of them is simply wrong.
  await repo(async ({ dir, git, commit }) => {
    await commit("base.txt", "base\n", "base");
    await git("checkout", "-q", "-b", "release/v2");
    await commit("rel.txt", "release work\n", "prepare the release", CLAUDE);
    await git("checkout", "-q", "main");

    const g = await readHistoryGraph(dir);
    const rel = g.branches.find((b) => b.name === "release/v2");
    assert.ok(rel, `unmerged branch missing — saw ${JSON.stringify(g.branches.map((b) => b.name))}`);
    assert.equal(rel.open, true, "and it is marked as still open");
    assert.equal(rel.commits.length, 1);
    assert.equal(g.branches.filter((b) => b.name === "main").length, 0, "the trunk is not its own branch");
  });
});

test("a branch tracked both locally and on a remote is drawn once", async () => {
  await repo(async ({ dir, git, commit }) => {
    await commit("base.txt", "base\n", "base");
    await git("checkout", "-q", "-b", "feature");
    await commit("f.txt", "x\n", "work");
    await git("checkout", "-q", "main");
    // Stand in for `origin/feature` without needing a real remote.
    await git("update-ref", "refs/remotes/origin/feature", "refs/heads/feature");

    const g = await readHistoryGraph(dir);
    assert.equal(
      g.branches.filter((b) => b.name === "feature").length,
      1,
      "main and origin/main are one branch, and so are feature and origin/feature",
    );
  });
});
