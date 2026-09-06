import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, postNote } from "../src/store.js";
import { LIVE_HOST, startLiveBoard } from "../src/live.js";

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-live-"));
}

test("live board binds 127.0.0.1 and reflects a new post", async () => {
  const dir = await tmp();
  let live;
  try {
    await initRoom({ cwd: dir, name: "live-smoke" });
    live = await startLiveBoard(dir, { port: 0 });
    assert.equal(live.host, LIVE_HOST);
    assert.match(live.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const health = await fetch(live.url.replace(/\/$/, "/health"));
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.host, "127.0.0.1");

    await postNote(dir, { text: "live-card-appears" });
    // allow watch/poll debounce
    await new Promise((r) => setTimeout(r, 600));

    const page = await fetch(live.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /live-card-appears/);
    assert.match(html, /data-rooms-live/);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);
  } finally {
    if (live) await live.close();
    await rm(dir, { recursive: true, force: true });
  }
});
