// Episode stitching: session → edits → packages → commits from the local activity log.

import test from "node:test";
import assert from "node:assert/strict";
import { buildEpisodes, renderEpisodesText } from "../src/episode.js";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");

test("buildEpisodes joins session, edits, packages, and commits in the window", () => {
  const activity = [
    {
      kind: "session",
      agent: "claude",
      session: "aaaaaaaaaaaa",
      phase: "start",
      model: "sonnet",
      at: "2026-10-16T11:00:00.000Z",
    },
    {
      kind: "edit",
      agent: "claude",
      session: "aaaaaaaaaaaa",
      path: "src/a.js",
      at: "2026-10-16T11:05:00.000Z",
    },
    {
      kind: "edit",
      agent: "claude",
      session: "aaaaaaaaaaaa",
      path: "src/b.js",
      at: "2026-10-16T11:06:00.000Z",
    },
    {
      kind: "package",
      name: "lodash",
      version: "4.17.21",
      action: "seen",
      at: "2026-10-16T11:07:00.000Z",
    },
    {
      kind: "commit",
      sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      madeIn: "claude",
      editedBy: { claude: ["src/a.js"] },
      at: "2026-10-16T11:10:00.000Z",
      branch: "main",
    },
    {
      kind: "session",
      agent: "claude",
      session: "aaaaaaaaaaaa",
      phase: "end",
      at: "2026-10-16T11:15:00.000Z",
    },
  ];
  const eps = buildEpisodes(activity, { since: NOW - 7 * 86_400_000, now: NOW });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].agent, "claude");
  assert.equal(eps[0].filesEdited, 2);
  assert.deepEqual(eps[0].paths, ["src/a.js", "src/b.js"]);
  assert.equal(eps[0].packages[0].name, "lodash");
  assert.equal(eps[0].commits.length, 1);
  assert.equal(eps[0].commits[0].sha.slice(0, 7), "deadbee");
  assert.equal(eps[0].open, false);
  assert.doesNotMatch(JSON.stringify(eps), /prompt|BEGIN |\/Users\//);
});

test("episodes without an end stay open; unlinked commits stay out", () => {
  const activity = [
    {
      kind: "session",
      agent: "codex",
      session: "bbbbbbbbbbbb",
      phase: "start",
      at: "2026-10-16T11:00:00.000Z",
    },
    {
      kind: "edit",
      agent: "codex",
      session: "bbbbbbbbbbbb",
      path: "x.ts",
      at: "2026-10-16T11:01:00.000Z",
    },
    {
      kind: "commit",
      sha: "ffffffffffffffffffffffffffffffffffffffff",
      madeIn: null,
      editedBy: { other: ["y.ts"] },
      at: "2026-10-16T11:02:00.000Z",
    },
  ];
  const eps = buildEpisodes(activity, { since: 0, now: NOW });
  assert.equal(eps[0].open, true);
  assert.equal(eps[0].commits.length, 0);
});

test("renderEpisodesText names the floor ethic", () => {
  const text = renderEpisodesText({
    project: "acme/web",
    sinceDays: 7,
    count: 0,
    episodes: [],
  });
  assert.match(text, /Episodes · acme\/web/);
  assert.match(text, /Nothing recorded yet/);
});
