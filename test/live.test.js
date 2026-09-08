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

test("--port 0 binds a free port, not the default", async () => {
  // The CLI passes port as a STRING. `opts.port === 0` therefore missed, and
  // `Number("0") || 7840` fell through to the default because 0 is falsy — so `--port 0` bound
  // 7840, two boards on one machine collided, and the second was refused. Found by Windows CI.
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-port-"));
  try {
    await initRoom({ cwd: dir, name: "port" });
    const a = await startLiveBoard(dir, { port: "0" });
    try {
      assert.notEqual(a.port, 7840, "a string zero must still mean 'pick a free one'");
      assert.ok(a.port > 0, "and it must be a real port");
      assert.equal(a.host, "127.0.0.1");
    } finally {
      await a.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
