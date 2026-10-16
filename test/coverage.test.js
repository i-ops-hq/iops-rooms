import test from "node:test";
import assert from "node:assert/strict";
import { buildCoverage, renderCoverageText } from "../src/coverage.js";
import { authorLoginMismatch } from "../src/identity-warn.js";
import { scratch, teamOfTwo } from "./team-helpers.js";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");

test("buildCoverage marks stale and hooks-seen floors", () => {
  const cov = buildCoverage({
    now: NOW,
    staleDays: 7,
    statuses: [
      {
        member: "alice",
        project: "web",
        at: "2026-10-15T10:00Z",
        agents7d: { claude: { sessions: 2, filesEdited: 3 } },
      },
      {
        member: "bob",
        project: "web",
        at: "2026-09-01T10:00Z",
        agents7d: {},
      },
    ],
  });
  assert.equal(cov.totals.members, 2);
  assert.equal(cov.totals.fresh, 1);
  assert.equal(cov.totals.stale, 1);
  assert.equal(cov.totals.hooksSeen, 1);
  assert.equal(cov.members.find((m) => m.member === "bob").stale, true);
  assert.equal(cov.members.find((m) => m.member === "alice").hooksSeen, true);
  const text = renderCoverageText(cov, { teamId: "acme/team" });
  assert.match(text, /hooks-seen/);
  assert.match(text, /Floor from shared status/);
});

test("authorLoginMismatch warns when git author looks unlike login", async () => {
  const ok = await authorLoginMismatch("/tmp", "alice", {
    runGit: async (_cwd, key) => (key === "user.email" ? "alice@users.noreply.github.com" : "Alice"),
  });
  assert.equal(ok.ok, true);

  const bad = await authorLoginMismatch("/tmp", "alice", {
    runGit: async (_cwd, key) => (key === "user.email" ? "bob@example.com" : "Bob Builder"),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /@alice/);
  assert.match(bad.detail, /bob@example.com/);
});

test("rooms team coverage reads shared statuses", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await alice.rooms(alice.web, "team", "sync", "--yes");
    await bob.rooms(bob.web, "team", "sync", "--yes");
    const cov = await alice.rooms(alice.web, "team", "coverage");
    assert.equal(cov.code, 0, cov.err);
    assert.match(cov.out, /Coverage ·/);
    assert.match(cov.out, /@alice/);
    assert.match(cov.out, /@bob/);
  });
});
