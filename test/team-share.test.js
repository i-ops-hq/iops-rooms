// The team path: `rooms init --share` plus a shared git remote.
//
// Found by simulating three machines — three HOMEs, three device ids, one bare repo, all running
// the packed package. The documented team workflow conflicted on EVERY concurrent post:
//
//   ben  push: REJECTED — CONFLICT (content): Merge conflict in .room/events.jsonl
//   cara push: REJECTED — CONFLICT (content): Merge conflict in .room/events.jsonl
//   ada   3 events  actors: ada        ben  7 events  actors: ada,ben
//
// Nobody could see everybody, and two of three were stuck mid-merge. Two people posting between
// pulls is not an edge case for a shared room — it is the normal case.
//
// Two causes. events.jsonl is append-only, so both sides add different lines at the same place and
// git cannot know appends commute. And board.html is a 64 KB GENERATED file that was being
// committed, guaranteeing a second conflict for no benefit.

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  initRoom,
  postNote,
  parseEventsJsonl,
  readEvents,
  refreshBoard,
  roomPaths,
} from "../src/store.js";

async function project(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-team-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("init --share writes the merge driver that stops every concurrent post conflicting", async () => {
  await project(async (dir) => {
    await initRoom({ cwd: dir, name: "team", share: true });
    const attrs = await readFile(join(dir, ".room", ".gitattributes"), "utf8");
    assert.match(attrs, /^events\.jsonl merge=union$/m, "an append-only log must merge as a union");
  });
});

test("init --share keeps the generated board out of git", async () => {
  await project(async (dir) => {
    await initRoom({ cwd: dir, name: "team", share: true });
    const ignore = await readFile(join(dir, ".room", ".gitignore"), "utf8");
    assert.match(ignore, /^board\.html$/m, "board.html is derived; committing it conflicts for nothing");

    const readme = await readFile(join(dir, ".room", "README.md"), "utf8");
    assert.match(readme, /generated/i, "the README must say why board.html is excluded");
    assert.doesNotMatch(
      readme,
      /Teammates get the same transcript and board\.html/,
      "the old README told teammates to commit the very file that conflicts",
    );
  });
});

test("a default init still gitignores the room — sharing stays opt-in", async () => {
  await project(async (dir) => {
    await initRoom({ cwd: dir, name: "solo" });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(gi, /^\.room\/$/m);
    await assert.rejects(
      () => readFile(join(dir, ".room", ".gitattributes"), "utf8"),
      "a private room needs no merge driver",
    );
  });
});

test("a union merge cannot double-render: duplicate ids are dropped on read", () => {
  const line = (id, actor) =>
    JSON.stringify({ id, at: "2026-09-07T00:00:00.000Z", type: "note", actor, text: `by ${actor}` });

  // What a union merge produces when both sides already had Ada's event and each added its own.
  const merged = [line("a1", "ada"), line("b1", "ben"), line("a1", "ada"), line("c1", "cara")].join("\n");
  const { events, duplicates } = parseEventsJsonl(merged);

  assert.equal(events.length, 3, "three distinct events");
  assert.equal(duplicates, 1, "the repeat is counted, not silently absorbed");
  assert.deepEqual(events.map((e) => e.actor), ["ada", "ben", "cara"], "order is preserved");
});

test("a corrupt line and a duplicate are counted separately", () => {
  const good = JSON.stringify({ id: "x1", type: "note", actor: "ada", text: "hi" });
  const { events, skipped, duplicates } = parseEventsJsonl([good, "<<<<<<< HEAD", good].join("\n"));
  assert.equal(events.length, 1);
  assert.equal(skipped, 1, "a conflict marker is corrupt, not a duplicate");
  assert.equal(duplicates, 1, "and the repeat is a duplicate, not corruption");
});

test("the board renders a union-merged log once per event, not twice", async () => {
  await project(async (dir) => {
    await initRoom({ cwd: dir, name: "team", share: true });
    await postNote(dir, { text: "unique marker alpha" });

    // Simulate what git leaves behind after a union merge: the same line present twice.
    const { events } = roomPaths(dir);
    const raw = await readFile(events, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    await writeFile(events, `${[...lines, lines[lines.length - 1]].join("\n")}\n`, "utf8");

    // refreshBoard is the path `rooms open` and `rooms live` take, so this is end to end.
    const boardPath = await refreshBoard(dir);
    const board = await readFile(boardPath, "utf8");
    const hits = board.split("unique marker alpha").length - 1;
    assert.equal(hits, 1, "a duplicated line must not appear twice on the board");

    const back = await readEvents(dir);
    const ids = back.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "readEvents returns no duplicate ids");
  });
});
