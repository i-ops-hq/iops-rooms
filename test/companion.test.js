// Companion (D8): notification planning, sleep backlog suppression, launcher mark.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPANION_MARK,
  companionShell,
  planCompanionLauncher,
  planNotifications,
  writeCompanionState,
  readCompanionState,
} from "../src/companion.js";
import { notify } from "../src/companion-notify.js";

test("planNotifications dedupes and collapses after a long pause", () => {
  const prev = {
    shareIds: ["aaa"],
    issueNumbers: [1],
    teamHead: "abc",
    lastTick: new Date(Date.now() - 60 * 60_000).toISOString(),
  };
  const inbox = {
    shares: [
      { id: "aaa", type: "request", ref: "setup/x", from: "alice" },
      { id: "bbb", type: "request", ref: "setup/y", from: "bob" },
    ],
    issues: [{ number: 2, title: "[rooms] hi" }],
  };
  const slept = planNotifications({
    prev,
    inbox,
    teamHead: "def",
    now: Date.now(),
    everyMs: 300_000,
  });
  assert.equal(slept.notes.length, 1);
  assert.match(slept.notes[0].body, /Back after a pause/);
  assert.ok(slept.next.shareIds.includes("bbb"));

  const fresh = planNotifications({
    prev: { shareIds: [], issueNumbers: [], teamHead: null, lastTick: new Date().toISOString() },
    inbox: { shares: [{ id: "ccc", type: "request", ref: "setup/z", from: "alice" }], issues: [] },
    teamHead: "x",
    now: Date.now(),
    everyMs: 300_000,
  });
  assert.equal(fresh.notes.length, 1);
  assert.match(fresh.notes[0].title, /share/i);
});

test("companion launcher content runs companion, not open", () => {
  const p = planCompanionLauncher({
    os: "linux",
    folder: "/tmp",
    name: "web",
    nodeBin: "/usr/bin/node",
    cliPath: "/opt/rooms/src/cli.js",
    projectDir: "/work/web",
  });
  assert.match(p.content, /companion/);
  assert.doesNotMatch(p.content, / cli\.js open/);
  assert.match(p.content, new RegExp(COMPANION_MARK));
  assert.match(companionShell({ nodeBin: "node", cliPath: "cli.js", projectDir: "/p" }), /companion$/);
});

test("notify falls back to stderr without throwing", async () => {
  const lines = [];
  const r = await notify({
    title: "Rooms",
    body: "hello",
    os: "linux",
    run: async () => {
      throw new Error("no notify-send");
    },
    log: { write: (s) => lines.push(s) },
  });
  assert.equal(r.ok, true);
  assert.match(lines.join(""), /Rooms: hello/);
});

test("companion state round-trips under ROOMS_HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-comp-"));
  const prev = process.env.ROOMS_HOME;
  process.env.ROOMS_HOME = home;
  try {
    await writeCompanionState({ shareIds: ["a"], issueNumbers: [3], teamHead: "h", lastTick: "2026-10-16T12:00:00.000Z" });
    const s = await readCompanionState();
    assert.deepEqual(s.shareIds, ["a"]);
    assert.equal(s.issueNumbers[0], 3);
    assert.match(await readFile(join(home, "companion.json"), "utf8"), /shareIds/);
  } finally {
    if (prev === undefined) delete process.env.ROOMS_HOME;
    else process.env.ROOMS_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
