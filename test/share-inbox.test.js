// Share meta + inbox (D6): metadata-only records in the team hub; Issues optional via gh (mocked).

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildShareMeta,
  githubRepoFromRemote,
  readInbox,
  readShares,
  validShareMeta,
} from "../src/share.js";
import { git, scratch, teamOfTwo } from "./team-helpers.js";

test("validShareMeta allows floors and refuses absolute paths", () => {
  const ok = buildShareMeta({
    from: "alice",
    to: ["bob"],
    type: "request",
    ref: "setup/backend/go-claude",
    note: "please",
    now: new Date("2026-10-16T12:00:00Z"),
  });
  assert.ok(ok);
  assert.equal(ok.kind, "share_meta");
  assert.equal(validShareMeta({ ...ok, ref: "/etc/passwd" }), null);
  assert.equal(validShareMeta({ ...ok, pointer: "~/.ssh/id_rsa" }), null);
  assert.equal(githubRepoFromRemote("github.com/acme/team-room"), "acme/team-room");
  assert.equal(githubRepoFromRemote("https://github.com/acme/team-room.git"), "acme/team-room");
});

test("share request commits meta only; inbox lists it for the recipient", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    const asked = await alice.rooms(
      alice.web,
      "share",
      "request",
      "--to",
      "bob",
      "--ref",
      "setup/backend/go-claude",
      "--note",
      "need your go setup",
    );
    assert.equal(asked.code, 2);
    assert.match(asked.out, /shares\/[a-f0-9]+\.json/);

    const shared = await alice.rooms(
      alice.web,
      "share",
      "request",
      "--to",
      "bob",
      "--ref",
      "setup/backend/go-claude",
      "--note",
      "need your go setup",
      "--yes",
    );
    assert.equal(shared.code, 0, shared.err);
    assert.match(shared.out, /shared shares\/[a-f0-9]+\.json/);

    const tree = await git(join(dir, "team.git"), "ls-tree", "-r", "--name-only", "main");
    assert.match(tree, /shares\/[a-f0-9]+\.json/);
    const file = tree.split("\n").find((l) => /^shares\/[a-f0-9]+\.json$/.test(l));
    const meta = JSON.parse(await git(join(dir, "team.git"), "show", `main:${file}`));
    assert.equal(meta.from, "alice");
    assert.deepEqual(meta.to, ["bob"]);
    assert.equal(meta.type, "request");
    assert.equal(meta.ref, "setup/backend/go-claude");
    assert.doesNotMatch(JSON.stringify(meta), /\/Users|BEGIN |password=/);

    const shown = await bob.rooms(bob.web, "share", "show", meta.id);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /"id": "/);

    const inbox = await bob.rooms(bob.web, "inbox");
    assert.equal(inbox.code, 0, inbox.err);
    assert.match(inbox.out, new RegExp(`share  ${meta.id}  request`));
  });
});

test("readInbox uses injected gh when ROOMS_NO_GH is unset", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await alice.rooms(alice.web, "share", "request", "--to", "bob", "--ref", "setup/x", "--yes");
    await git(bob.team, "pull", "-q");
    const { shares } = await readShares(bob.team);
    assert.equal(shares.length, 1);

    const prev = process.env.ROOMS_NO_GH;
    delete process.env.ROOMS_NO_GH;
    try {
      const box = await readInbox({
        clonePath: bob.team,
        remotePath: "acme/team",
        login: "bob",
        runGh: async () =>
          JSON.stringify([
            { number: 9, title: "[rooms] request: setup/x → @bob", url: "https://example/9", labels: [] },
            { number: 10, title: "unrelated", url: "https://example/10", labels: [] },
          ]),
      });
      assert.equal(box.issues.length, 1);
      assert.equal(box.issues[0].number, 9);
      assert.ok(box.shares.some((s) => s.to.includes("bob")));
    } finally {
      if (prev !== undefined) process.env.ROOMS_NO_GH = prev;
      else process.env.ROOMS_NO_GH = "1";
    }
  });
});
