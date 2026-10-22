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

// A GitHub token's shape, made up here so no real-looking secret sits in the source.
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;

test("free text that looks like a secret is withheld from the catalog, by field, and never printed", () => {
  const meta = catalogMetaFromManifest("backend", "go-claude", {
    owner: "alice",
    summary: `use ${TOKEN} to start`,
    cost: { usdPerMonth: 20, what: `seat ${TOKEN}` },
    exportedWith: TOKEN,
    tools: { "claude-code": { checkedAgainst: TOKEN, files: [] } },
  });
  assert.equal(meta.summary, null);
  assert.equal(meta.cost.what, null);
  assert.equal(meta.cost.usdPerMonth, 20, "the number stays");
  assert.equal(meta.exportedWith, null);
  assert.equal(meta.tools["claude-code"].checkedAgainst, null);
  assert.deepEqual(meta.withheld.map((w) => w.field).sort(), ["cost.what", "exportedWith", "summary", "tools.claude-code.checkedAgainst"]);
  assert.ok(meta.withheld.every((w) => w.why === "it looks like a GitHub token"));
  assert.doesNotMatch(JSON.stringify(meta), /ghp_/);

  const clean = catalogMetaFromManifest("backend", "go-claude", { owner: "alice", summary: "Claude for Go", tools: {} });
  assert.equal(clean.withheld, undefined, "nothing withheld, nothing said");
});

test("a hand-edited summary holding a token: withheld in the catalog and listing, refused by show, refused at export", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    const setupDir = join(alice.team, "setups", "backend", "leaky");
    await mkdir(join(setupDir, "files", "claude-code", "project"), { recursive: true });
    await writeFile(join(setupDir, "files", "claude-code", "project", "CLAUDE.md"), "# Go\n", "utf8");
    await writeFile(
      join(setupDir, "setup.json"),
      `${JSON.stringify({ format: "iops-rooms/setup", formatVersion: 1, role: "backend", name: "leaky", owner: "alice", summary: `token ${TOKEN}`, tools: { "claude-code": { files: [] } }, runs: [], requires: [] }, null, 2)}\n`,
      "utf8",
    );
    await git(alice.team, "add", "setups");
    await git(alice.team, "commit", "-q", "-m", "a setup edited by hand");
    await git(alice.team, "push", "-q", "origin", "main");

    const text = await bob.rooms(bob.web, "setup", "catalog");
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /- backend\/leaky · @alice\n {2}tools: claude-code\n {2}withheld: summary \(it looks like a GitHub token\)/);
    const json = await bob.rooms(bob.web, "setup", "catalog", "--json");
    assert.deepEqual(JSON.parse(json.out).setups[0].withheld, [{ field: "summary", why: "it looks like a GitHub token" }]);
    const listed = await bob.rooms(bob.web, "setup", "show");
    assert.match(listed.out, /backend\/leaky +alice {2}\(summary withheld: it looks like a secret\)/);
    for (const r of [text, json, listed]) assert.doesNotMatch(r.out + r.err, /ghp_/);

    const shown = await bob.rooms(bob.web, "setup", "show", "backend/leaky");
    assert.notEqual(shown.code, 0);
    assert.match(shown.out + shown.err, /its summary looks like it holds a GitHub token/);
    assert.doesNotMatch(shown.out + shown.err, /ghp_/);

    await writeFile(join(alice.web, "CLAUDE.md"), "# Web\n", "utf8");
    const exported = await alice.rooms(alice.web, "setup", "export", "--role", "web", "--name", "x", "--tool", "claude-code", "--summary", `see ${TOKEN}`, "--yes");
    assert.notEqual(exported.code, 0, "the export stops");
    assert.match(exported.err, /its summary looks like it holds a GitHub token/);
    assert.doesNotMatch(exported.out + exported.err, /ghp_/);
    assert.equal(await git(alice.team, "branch", "--list", "setup/web/x"), "", "and no branch is made");
  });
});
