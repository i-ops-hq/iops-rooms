// Org rollup (D5): a second private room that holds floors from linked team rooms — counts and
// package names only, never paths, prompts, or setup bodies.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildOrgRollup,
  orgRoomFiles,
  renderOrgMarkdown,
  summarizeTeam,
  validOrgRollup,
} from "../src/org.js";
import { exec, git, scratch, teamOfTwo } from "./team-helpers.js";

test("summarizeTeam and buildOrgRollup keep floors only", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const full = buildOrgRollup({
    teams: [
      {
        id: "acme/team",
        statuses: [
          {
            member: "alice",
            project: "web",
            at: "2026-10-15T10:00Z",
            agents7d: { claude: { sessions: 2, filesEdited: 4 } },
          },
          {
            member: "bob",
            project: "web",
            at: "2026-09-01T10:00Z",
            agents7d: {},
          },
        ],
        agentRollups: [],
        packageRollups: [
          { member: "alice", packages: [{ name: "lodash", version: "4.17.21" }] },
          { member: "bob", packages: [{ name: "lodash", version: "4.17.21" }] },
        ],
      },
    ],
    now,
  });
  assert.ok(validOrgRollup(full));
  assert.equal(full.totals.teams, 1);
  assert.equal(full.totals.sessions7d, 2);
  assert.equal(full.teams[0].stale[0], "bob");
  assert.equal(full.teams[0].packages[0].members, 2);
  const md = renderOrgMarkdown(full);
  assert.match(md, /Org rollup/);
  assert.doesNotMatch(md, /\/Users|secret-plan|CLAUDE\.md/);
  const one = summarizeTeam({
    id: "acme/team",
    now: now.getTime(),
    statuses: full.teams[0] && [
      {
        member: "alice",
        project: "web",
        at: "2026-10-15T10:00Z",
        agents7d: { claude: { sessions: 2, filesEdited: 4 } },
      },
    ],
  });
  assert.equal(one.sessions7d, 2);
});

test("org init, link, refresh push floors only", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await alice.rooms(alice.web, "team", "sync", "--yes");
    await bob.rooms(bob.web, "team", "sync", "--yes");

    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "org.git")]);
    const orgClone = join(dir, "alice", "org");
    await exec("git", ["clone", "-q", join(dir, "org.git"), orgClone]);
    await git(orgClone, "config", "user.name", "alice");
    await git(orgClone, "config", "user.email", "alice@example.com");

    const refused = await alice.rooms(orgClone, "org", "init", "--yes");
    assert.notEqual(refused.code, 0);
    const made = await alice.rooms(orgClone, "org", "init", "--name", "acme-org", "--yes", "--confirm-private");
    assert.equal(made.code, 0, made.err);
    assert.equal(await git(orgClone, "log", "--format=%s"), "Org room: acme-org");
    assert.deepEqual(Object.keys(orgRoomFiles("x")).sort(), [
      ".gitattributes",
      "README.md",
      "rollup/.gitkeep",
      "room.json",
      "teams.json",
    ]);

    const reg = JSON.parse(await readFile(join(alice.home, "teams.json"), "utf8"));
    const linkedTeamId = Object.keys(reg.teams)[0];
    assert.ok(linkedTeamId);
    assert.ok(reg.orgs && Object.keys(reg.orgs).length >= 1);

    await git(orgClone, "push", "-q", "-u", "origin", "main");
    const linked = await alice.rooms(orgClone, "org", "link", linkedTeamId, "--yes");
    assert.equal(linked.code, 0, linked.err);

    const refreshed = await alice.rooms(orgClone, "org", "refresh", "--yes", "--confirm-private");
    assert.equal(refreshed.code, 0, refreshed.err);
    const orgJson = JSON.parse(await git(join(dir, "org.git"), "show", "main:rollup/org.json"));
    assert.ok(validOrgRollup(orgJson));
    assert.equal(orgJson.teams[0].id, linkedTeamId);
    const everything = await git(join(dir, "org.git"), "log", "-p", "--all");
    assert.doesNotMatch(everything, /secret-plan|launch date|\/Users\/|CLAUDE\.md/);

    const shown = await alice.rooms(orgClone, "org", "show");
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Org rollup/);
  });
});

test("validOrgRollup refuses junk", () => {
  assert.equal(validOrgRollup({ v: 1, kind: "org_rollup", at: "nope", teams: [] }), null);
  assert.equal(
    validOrgRollup({ v: 1, kind: "org_rollup", at: "2026-10-16T12:00Z", teams: [{ id: "x", members: -1 }] }),
    null,
  );
});
