import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, postNote } from "../src/store.js";
import { request as httpRequest } from "node:http";
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

/**
 * One request with an arbitrary Host header.
 *
 * `fetch` cannot do this: Host is a forbidden header name, so undici drops it silently and the
 * request goes out claiming localhost — the test would pass against a server with no check at all.
 */
function requestWithHost(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: LIVE_HOST, port, path, method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A live board on a free port, torn down afterwards. Shared by the rebinding tests below. */
async function withLiveBoard(fn) {
  const dir = await tmp();
  let live;
  try {
    await initRoom({ cwd: dir, name: "rebind" });
    live = await startLiveBoard(dir, { port: 0 });
    await fn({ url: live.url, port: live.port });
  } finally {
    if (live) await live.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- DNS rebinding

test("a request that did not ask for localhost is refused", async () => {
  // Binding to 127.0.0.1 stops another HOST reaching the socket. It does not stop a PAGE the user
  // is visiting: point evil.example.com at 127.0.0.1 with a short TTL, and the browser treats
  // http://evil.example.com:7840/ as same-origin with the attacker's page — so CORS never applies
  // and the reply is readable. The board is the project's whole git history: contributor names,
  // addresses, branches, commit subjects. Only the Host header separates that from a real visit.
  await withLiveBoard(async ({ port }) => {
    for (const host of ["evil.example.com", `evil.example.com:${port}`, "attacker.test"]) {
      const res = await requestWithHost(port, "/", host);
      assert.equal(res.status, 403, `Host: ${host} must not be served`);
      assert.doesNotMatch(res.body, /<html|branch-graph|built-by/i, "and nothing of the board leaks");
    }
  });
});

test("localhost by any of its names still works", async () => {
  await withLiveBoard(async ({ port }) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "127.0.0.1"]) {
      const res = await requestWithHost(port, "/", host);
      assert.equal(res.status, 200, `Host: ${host} is this machine and must be served`);
    }
    // A right name on the wrong port is a different server, so it is not this one.
    const wrong = await requestWithHost(port, "/", `localhost:${port + 1}`);
    assert.equal(wrong.status, 403);
  });
});
