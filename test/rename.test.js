import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, renameRoom, roomPaths } from "../src/store.js";

test("renameRoom updates display name and board hero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-rename-"));
  try {
    const { meta } = await initRoom({ cwd: dir, name: "dogfood", code: "YMMBFL" });
    assert.equal(meta.name, "dogfood");
    const next = await renameRoom(dir, "Rooms");
    assert.equal(next.name, "Rooms");
    assert.equal(next.id, "YMMBFL");
    const html = await readFile(roomPaths(dir).board, "utf8");
    assert.match(html, /Rooms · Rooms/);
    assert.match(html, /<title>Rooms · Rooms<\/title>/);
    assert.doesNotMatch(html, />dogfood</);
    assert.doesNotMatch(html, /Rooms · dogfood/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
