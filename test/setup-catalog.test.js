// Setup catalog (observe): metadata from setup.json only — never file bodies or install targets.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogMetaFromManifest, listSetupCatalog } from "../src/setup/room.js";
import { git, scratch, teamOfTwo } from "./team-helpers.js";

test("catalogMetaFromManifest keeps only allowlisted fields", () => {
  const meta = catalogMetaFromManifest("backend", "go-claude", {
    owner: "alice",
    summary: "Claude for Go",
    cost: { usdPerMonth: 20, what: "Claude Pro" },
    exportedWith: "iops-rooms@0.12.0",
    tools: {
      "claude-code": { checkedAgainst: "2.0.1", files: [{ path: "CLAUDE.md" }, { path: "x.md" }] },
    },
    runs: [{ command: "rm -rf /" }],
    secret: "must-not-appear",
  });
  assert.equal(meta.kind, "setup_catalog_entry");
  assert.equal(meta.role, "backend");
  assert.equal(meta.name, "go-claude");
  assert.equal(meta.owner, "alice");
  assert.equal(meta.tools["claude-code"].files, 2);
  assert.equal(meta.runs, undefined);
  assert.equal(meta.secret, undefined);
  const json = JSON.stringify(meta);
  assert.doesNotMatch(json, /rm -rf|must-not-appear|CLAUDE\.md/);
});

test("rooms setup catalog lists metadata without bodies", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    const setupDir = join(alice.team, "setups", "backend", "go-claude");
    await mkdir(setupDir, { recursive: true });
    await writeFile(
      join(setupDir, "setup.json"),
      `${JSON.stringify(
        {
          format: "rooms-setup",
          formatVersion: 1,
          role: "backend",
          name: "go-claude",
          owner: "alice",
          summary: "Claude Code for Go",
          cost: { usdPerMonth: 20, what: "Claude Pro" },
          exportedWith: "iops-rooms@0.12.0",
          tools: {
            "claude-code": {
              checkedAgainst: "2.0.1",
              files: [{ path: "files/claude-code/project/CLAUDE.md", kind: "doc" }],
            },
          },
          runs: [],
          requires: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await mkdir(join(setupDir, "files", "claude-code", "project"), { recursive: true });
    await writeFile(
      join(setupDir, "files", "claude-code", "project", "CLAUDE.md"),
      "# SECRET BODY that catalog must never print\n",
      "utf8",
    );
    await git(alice.team, "add", "setups");
    await git(alice.team, "commit", "-q", "-m", "setup for catalog test");
    await git(alice.team, "push", "-q", "origin", "main");
    await git(bob.team, "pull", "-q");

    const catalog = await listSetupCatalog(alice.team, "HEAD");
    assert.equal(catalog.count, 1);
    assert.equal(catalog.setups[0].name, "go-claude");
    assert.doesNotMatch(JSON.stringify(catalog), /SECRET BODY/);

    const listed = await bob.rooms(bob.web, "setup", "catalog", "--json");
    assert.equal(listed.code, 0, listed.err);
    const data = JSON.parse(listed.out);
    assert.equal(data.kind, "setup_catalog");
    assert.equal(data.count, 1);
    assert.equal(data.setups[0].owner, "alice");
    assert.equal(data.pullOk, true);
    assert.doesNotMatch(listed.out, /SECRET BODY|# SECRET/);

    const text = await bob.rooms(bob.web, "setup", "catalog");
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /backend\/go-claude/);
    assert.match(text.out, /Metadata from setup\.json only/);
    assert.doesNotMatch(text.out, /SECRET BODY/);
  });
});
