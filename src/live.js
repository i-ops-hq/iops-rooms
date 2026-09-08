import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { refreshBoard, roomPaths } from "./store.js";
import { LIVE_CLIENT_SNIPPET } from "./live-client.js";

export const LIVE_HOST = "127.0.0.1";
export const LIVE_DEFAULT_PORT = 7840;


/**
 * Local-only live board. Binds 127.0.0.1 only — never LAN/internet.
 * Watches .room/, regenerates board.html, SSE-pushes open tabs to reload.
 */
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

  const watcher = watch(paths.root, { persistent: true }, (_eventType, filename) => {
    if (!filename) {
      schedulePush();
      return;
    }
    const name = String(filename);
    if (name === "events.jsonl" || name === "room.json") schedulePush();
  });

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
