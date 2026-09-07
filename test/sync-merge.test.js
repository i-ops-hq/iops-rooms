import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  initRoom,
  postNote,
  readEvents,
  exportRoomBundle,
  mergeRoomBundle,
  roomPaths,
} from "../src/store.js";
import { readFile } from "node:fs/promises";

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-sync-"));
}

test("sync-merge unions events by id across devices", async () => {
  const a = await tmp();
  const b = await tmp();
  const bundle = await tmp();
  try {
    process.env.ROOMS_BRANCH = "main";
    const { meta } = await initRoom({ cwd: a, name: "sync-a", code: "SYNCXY" });
    await postNote(a, { text: "from device A" });
    await exportRoomBundle(a, bundle);

    await initRoom({ cwd: b, name: "sync-b", code: "SYNCXY" });
    await postNote(b, { text: "from device B" });
    const result = await mergeRoomBundle(bundle, b);
    assert.ok(result.added >= 1);
    const events = await readEvents(b);
    const texts = events.filter((e) => e.type === "note").map((e) => e.text);
    assert.ok(texts.includes("from device A"));
    assert.ok(texts.includes("from device B"));
    const html = await readFile(roomPaths(b).board, "utf8");
    assert.match(html, /from device A/);
    assert.match(html, /from device B/);
  } finally {
    delete process.env.ROOMS_BRANCH;
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
    await rm(bundle, { recursive: true, force: true });
  }
});

test("board collapses unknown branch into pre-stamp history", async () => {
  const dir = await tmp();
  try {
    delete process.env.ROOMS_BRANCH;
    await initRoom({ cwd: dir, name: "hist" });
    // force an event without branch by writing raw then refresh
    const { appendFile } = await import("node:fs/promises");
    const paths = roomPaths(dir);
    await appendFile(
      paths.events,
      JSON.stringify({
        id: "deadbeefdeadbeef",
        at: new Date().toISOString(),
        type: "note",
        text: "legacy no branch",
        actor: "Old",
        tool: "cli",
        deviceId: "dev1",
      }) + "\n",
      "utf8",
    );
    process.env.ROOMS_BRANCH = "feature/x";
    await postNote(dir, { text: "stamped" });
    const { refreshBoard } = await import("../src/store.js");
    await refreshBoard(dir);
    const html = await readFile(paths.board, "utf8");
    assert.match(html, /Pre-stamp history/);
    assert.match(html, /feature\/x|feature\/x…|feature/);
    assert.doesNotMatch(html, /class="branch-name">\(unknown\)/);
  } finally {
    delete process.env.ROOMS_BRANCH;
    await rm(dir, { recursive: true, force: true });
  }
});
