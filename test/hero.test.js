// The top of the board: five cards about the PROJECT, and a rail saying who you are and what this
// checkout is connected to.
//
// The cards used to be facts about the tool — "posters", "events", "network off", ".room on disk".
// None of those is why anyone opens a board, and two of them were about the tool's own storage.
// These tests hold the replacement to the thing that makes it worth the space: every number is
// derived from history the repo already has, and every one says what it means.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHeroFacts, renderHeroSide, shortSince, writeBoard } from "../src/board.js";
import { sanitizeRemote } from "../src/git-info.js";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const ago = (ms) => NOW - ms;
const DAY = 86_400_000;

const commit = (over = {}) => ({
  sha: "a".repeat(40),
  shortSha: "aaaaaaa",
  subject: "do a thing",
  author: { name: "Ada", email: "ada@example.com" },
  agents: [],
  insertions: 10,
  deletions: 2,
  isMerge: false,
  t: ago(DAY),
  at: new Date(ago(DAY)).toISOString(),
  ...over,
});

const claude = { id: "claude", label: "Claude Opus 5", family: "claude" };

function history(over = {}) {
  return {
    ok: true,
    total: 100,
    truncated: 0,
    trunk: [commit(), commit({ t: ago(3600_000), agents: [claude] })],
    branches: [],
    agents: { agents: [{ ...claude, commits: 35, insertions: 1, deletions: 1 }], attributed: 35, plain: 65 },
    contributors: [
      { name: "Ada", email: "ada@example.com", commits: 66, merges: 0, insertions: 1, deletions: 1, files: 1, agents: [], topAgent: null, topAgentPct: 0 },
      { name: "Ben", email: "ben@example.com", commits: 34, merges: 0, insertions: 1, deletions: 1, files: 1, agents: [], topAgent: null, topAgentPct: 0 },
    ],
    splitIdentities: [],
    ...over,
  };
}

const git = (over = {}) => ({ ok: true, current: "main", head: "abc1234", branches: ["main"], remote: null, dirty: 0, upstream: "", ahead: null, behind: null, ...over });

test("the cards are about the project, not about the tool", () => {
  const html = renderHeroFacts(history(), [], git(), NOW);
  assert.match(html, /data-source="git"/);
  assert.match(html, /<b>100<\/b><span>commits<\/span>/, "how much work is here");
  assert.match(html, /<b>2<\/b><span>people<\/span>/, "who did it");
  assert.match(html, /<b>35%<\/b><span>agent-assisted<\/span>/, "and how much an agent helped with");
  assert.match(html, /most by Ada \(66\)/, "the detail line says what the number means");

  // The facts that used to take the whole row.
  assert.doesNotMatch(html, /posters/);
  assert.doesNotMatch(html, /on disk/);
  assert.doesNotMatch(html, />network/);
});

test("the agent share is of the commits actually read, and is honest when there are none", () => {
  const none = renderHeroFacts(
    history({ agents: { agents: [], attributed: 0, plain: 100 } }),
    [],
    git(),
    NOW,
  );
  assert.match(none, /<b>none<\/b><span>agent-assisted<\/span>/);
  assert.match(none, /no Co-Authored-By trailers/, "the reason, not a bare zero");

  const half = renderHeroFacts(
    history({ agents: { agents: [{ ...claude, commits: 4 }], attributed: 4, plain: 4 } }),
    [],
    git(),
    NOW,
  );
  assert.match(half, /<b>50%<\/b>/, "4 of 8 seen, not 4 of the 100 total");
});

test("the branch card counts branches beside the trunk and says where they went", () => {
  const merged = renderHeroFacts(
    history({ branches: [{ name: "a", open: false, commits: [] }, { name: "b", open: false, commits: [] }] }),
    [],
    git(),
    NOW,
  );
  // Not "3 branches, all 2 merged in" — that was two counts of two different things side by side.
  assert.match(merged, /<b>2<\/b><span>branches<\/span>/);
  assert.match(merged, /all merged into main/);

  const open = renderHeroFacts(
    history({ branches: [{ name: "a", open: true, commits: [] }, { name: "b", open: false, commits: [] }] }),
    [],
    git(),
    NOW,
  );
  assert.match(open, /beside main, 1 still open/, "an unmerged branch is the interesting one");
});

test("with no git history the room's own numbers stand in, labelled as such", () => {
  const events = [
    { id: "1", at: new Date(ago(600_000)).toISOString(), type: "note", actor: "ada", text: "hi" },
    { id: "2", at: new Date(ago(300_000)).toISOString(), type: "note", actor: "ben", text: "yo" },
    { id: "3", at: new Date(ago(1000)).toISOString(), type: "system", actor: "ben", text: "x" },
  ];
  const html = renderHeroFacts(null, events, { ok: false }, NOW);
  assert.match(html, /data-source="room"/);
  assert.match(html, /<b>2<\/b><span>posters<\/span>/, "system events are not people");
  assert.match(html, /<b>2<\/b><span>posts<\/span>/);
  assert.match(html, /<b>5m<\/b>/, "and when the last one landed");
  assert.match(html, /git init here/, "with the way to get the project cards");
});

test("a duration is short enough to be the number on a card", () => {
  assert.equal(shortSince(30_000), "just now");
  assert.equal(shortSince(20 * 60_000), "20m");
  assert.equal(shortSince(5 * 3600_000), "5h");
  assert.equal(shortSince(3 * DAY), "3d");
  assert.equal(shortSince(21 * DAY), "3w");
  assert.equal(shortSince(200 * DAY), "7mo");
  assert.equal(shortSince(400 * DAY), "1.1y");
});

test("the rail says whether THIS device is the one that was verified", () => {
  const linked = renderHeroSide({
    git: git(),
    auth: { displayName: "ada", deviceId: "dev1", verifiedDeviceId: "dev1", github: { login: "ada" }, privateKeyPresent: true },
  });
  assert.match(linked, /data-state="ok">verified/);
  assert.match(linked, /github\.com\/ada/);

  // A restored identity.json, a copied home, a VM template: verified, but not here.
  const elsewhere = renderHeroSide({
    git: git(),
    auth: { displayName: "ada", deviceId: "dev2", verifiedDeviceId: "dev1", github: { login: "ada" }, privateKeyPresent: true },
  });
  assert.match(elsewhere, /linked on another device/);
  assert.doesNotMatch(elsewhere, /data-state="ok">verified/);

  const plain = renderHeroSide({ git: git(), auth: { displayName: "ada", deviceId: "dev1" } });
  assert.match(plain, /unverified — rooms auth github/);
  assert.match(plain, /no signing key on this device yet/);
});

test("a name from ROOMS_ACTOR is shown as the uncheckable claim it is", () => {
  const html = renderHeroSide({ git: git(), auth: { displayName: "someone", deviceId: "d", actorOverride: true } });
  assert.match(html, /ROOMS_ACTOR, so nothing can check it/);
});

test("the git card resolves to a state instead of leaving the reader guessing", () => {
  assert.match(renderHeroSide({ git: { ok: false } }), /not a git checkout/);
  assert.match(renderHeroSide({ git: git() }), /local repository/, "a repo with no remote is not 'pending'");
  assert.match(renderHeroSide({ git: git() }), /no remote configured/);
  assert.match(renderHeroSide({ git: git({ dirty: 3 }) }), /3 uncommitted changes/);
  assert.match(renderHeroSide({ git: git({ dirty: 1 }) }), /1 uncommitted change</, "one change, singular");
  assert.match(renderHeroSide({ git: git() }), /working tree clean/);
  assert.match(
    renderHeroSide({ git: git({ upstream: "origin/main", ahead: 2, behind: 1 }) }),
    /2 ahead, 1 behind origin\/main/,
  );
  assert.match(
    renderHeroSide({ git: git({ upstream: "origin/main", ahead: 0, behind: 0 }) }),
    /in step with origin\/main/,
  );
});

test("a token in the remote URL never reaches the page", () => {
  // A remote configured over HTTPS on a shared box or in CI carries the credential in the URL, and
  // a board is a file people screenshot into issues. Stripped where the URL is read, so no future
  // call site has to remember to strip it.
  const dirty = sanitizeRemote("https://x-access-token:ghp_realsecretvalue@github.com/o/r.git");
  assert.equal(dirty.label, "github.com/o/r");
  const html = renderHeroSide({ git: git({ remote: dirty }) });
  assert.doesNotMatch(html, /ghp_/);
  assert.doesNotMatch(html, /x-access-token/);

  assert.equal(sanitizeRemote("git@github.com:o/r.git").label, "github.com/o/r", "scp-style too");
  assert.equal(sanitizeRemote("ssh://git@gitlab.com:22/g/p.git").label, "gitlab.com/g/p");
  assert.equal(sanitizeRemote("/just/a/path"), null, "a local path is not a remote to show");
  assert.equal(sanitizeRemote(""), null);
});

test("writing a board never mints an identity", async () => {
  // loadIdentity() creates device.json when it is missing. Calling it from the renderer would mean
  // that opening a board — a read — is what gives this machine an identity. The caller passes what
  // it already has instead, and a render with none says so rather than going and making one.
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-hero-"));
  const project = await mkdtemp(join(tmpdir(), "iops-rooms-proj-"));
  const prev = process.env.ROOMS_HOME;
  process.env.ROOMS_HOME = home;
  try {
    const board = join(project, "board.html");
    await writeBoard(board, { id: "AAA111", createdAt: "", createdBy: "" }, [], { projectDir: project });
    assert.equal((await readdir(home)).length, 0, "no device.json, no key, nothing");
    const html = await readFile(board, "utf8");
    assert.match(html, /no identity loaded for this render/, "and the page says so plainly");
  } finally {
    if (prev === undefined) delete process.env.ROOMS_HOME;
    else process.env.ROOMS_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("markup in a branch, name or remote is escaped", () => {
  const html = renderHeroSide({
    git: git({ current: "<script>alert(1)</script>", remote: { host: "h", path: "p", label: "<img src=x onerror=1>" } }),
    auth: { displayName: "<b>ada</b>", deviceId: "d" },
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});
