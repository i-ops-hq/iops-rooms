import { createServer } from "node:http";
import { watch } from "node:fs";
import { realpath } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { refreshBoard, roomPaths } from "./store.js";
import { LIVE_CLIENT_SNIPPET } from "./live-client.js";

export const LIVE_HOST = "127.0.0.1";
export const LIVE_DEFAULT_PORT = 7840;


/**
 * Local-only live board. Binds 127.0.0.1 only — never LAN/internet.
 * Watches .room/, regenerates board.html, SSE-pushes open tabs to reload.
 */
/**
 * Only this machine, asked for by a name that means this machine.
 *
 * Binding to 127.0.0.1 stops another host reaching the socket. It does NOT stop a web page the user
 * is visiting: an attacker points `evil.example.com` at 127.0.0.1 (a short TTL and a second lookup —
 * DNS rebinding), the browser then treats `http://evil.example.com:7840/` as same-origin with the
 * attacker's page, and same-origin means CORS never applies. The board is the whole git history of
 * the project, so the reply is the contributor names, addresses, branches and commit subjects.
 *
 * The Host header is what distinguishes the two, and nothing was reading it. A request that did not
 * ask for localhost was not meant for this server.
 */
export function hostIsLocal(hostHeader, port) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return false; // HTTP/1.1 requires Host; a request without one is not a browser's
  // Strip the port, taking care with the bracketed IPv6 form `[::1]:7840`.
  const host = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  const named = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (!named) return false;
  const declared = raw.startsWith("[") ? raw.slice(raw.indexOf("]") + 1).replace(/^:/, "") : raw.split(":")[1];
  // A right name on the wrong port is still not this server.
  return !declared || Number(declared) === Number(port);
}

export async function startLiveBoard(projectDir, opts = {}) {
  const paths = roomPaths(projectDir);
  await refreshBoard(projectDir);

  const clients = new Set();
  let debounce = null;
  let lastBytes = -1;

  async function push() {
    try {
      const board = await refreshBoard(projectDir);
      const html = await readFile(board, "utf8");
      const payload = `data: ${JSON.stringify({ at: new Date().toISOString(), bytes: html.length })}\n\n`;
      for (const res of clients) {
        try {
          res.write(payload);
        } catch {
          clients.delete(res);
        }
      }
    } catch (err) {
      process.stderr.write(`live: refresh failed: ${err.message || err}\n`);
    }
  }

  function schedulePush() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      push();
    }, 80);
  }

  const server = createServer(async (req, res) => {
    // Before anything is read or served. A rebound name reaches this socket exactly as localhost
    // does, and only the Host header tells them apart.
    if (!hostIsLocal(req.headers.host, server.address()?.port ?? wantPort)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("this board is served to localhost only\n");
      return;
    }
    const url = new URL(req.url || "/", `http://${LIVE_HOST}`);

    if (url.pathname === "/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/board.html") {
      try {
        await refreshBoard(projectDir);
        let html = await readFile(paths.board, "utf8");
        if (!html.includes("data-rooms-live")) {
          html = html.replace("</body>", `${LIVE_CLIENT_SNIPPET}\n</body>`);
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String(err.message || err));
      }
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          host: LIVE_HOST,
          clients: clients.size,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  // `--port 0` means "pick a free one", and it never worked: the CLI hands this a STRING, so the
  // `=== 0` guard missed, and `Number("0") || 7840` fell through to the default because 0 is falsy.
  // Two boards on one machine therefore both tried 7840 and the second was refused.
  const requested = Number(opts.port);
  const wantPort =
    Number.isInteger(requested) && requested >= 0 && requested <= 65535
      ? requested
      : LIVE_DEFAULT_PORT;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(wantPort, LIVE_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : wantPort;

  // Watch the RESOLVED path. On Windows, fs.watch on a path containing an 8.3 short name
  // (C:\Users\RUNNER~1\..., or any profile whose long name got shortened) makes libuv compare the
  // OS-reported long filename against the short one it was given, fail its own assertion in
  // src\win\fs-event.c, and ABORT THE PROCESS — not throw, abort. The live board died the instant
  // anything touched .room/, taking the server with it. realpath normalises the short form away.
  //
  // A poll loop already backs this up below, so if watching is unavailable the board still updates.
  let watchRoot = paths.root;
  try {
    watchRoot = await realpath(paths.root);
  } catch {
    /* keep the unresolved path; the poll below still refreshes */
  }
  let watcher = { close() {} };
  try {
    watcher = watch(watchRoot, { persistent: true }, (_eventType, filename) => {
      if (!filename) {
        schedulePush();
        return;
      }
      const name = String(filename);
      if (name === "events.jsonl" || name === "room.json") schedulePush();
    });
  } catch (err) {
    process.stderr.write(`live: file watching unavailable (${err.message || err}); polling only\n`);
  }

  const poll = setInterval(async () => {
    try {
      const buf = await readFile(paths.events);
      if (buf.length !== lastBytes) {
        lastBytes = buf.length;
        schedulePush();
      }
    } catch {
      /* mid-write */
    }
  }, 400);

  const url = `http://${LIVE_HOST}:${port}/`;
  return {
    url,
    host: LIVE_HOST,
    port,
    async close() {
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      watcher.close();
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
