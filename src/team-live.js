/**
 * `rooms team live`: the team board, kept current while it is open (docs/design/TEAM_LIVE.md, T4).
 *
 * Every interval it fetches the team room with git, which asks nothing of GitHub's API, and rebuilds
 * the page when something arrived. If this member has already said yes to sharing with this team
 * (the first `rooms team sync` asks), it also shares their status for this project whenever it
 * changed. It runs only while it is open; there is no background service to install or forget.
 * The page says when it last looked, since "live" is only ever "as of then".
 *
 * Served on 127.0.0.1 only, and only to a request that asked for this machine by name: the page is
 * every member's branches and pull requests, and DNS rebinding would otherwise hand it to any web
 * page the person visits (src/live.js).
 */

import { LIVE_HOST, serveLocal } from "./live.js";
import { applySync, buildStatus, gitIn, planSync, pullTeamRoom, readStatuses } from "./team.js";
import { renderTeamBoard } from "./team-board.js";

/** The page's own client: reload when the board changed, otherwise only update when it last looked. */
const CLIENT = `
<script data-rooms-team-live>
(function () {
  if (location.protocol === "file:") return;
  var es = new EventSource("/stream");
  es.onmessage = function (e) {
    var d = {};
    try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.reload) { location.reload(); return; }
    var el = document.querySelector("[data-checked]");
    if (el && d.checked) el.textContent = d.checked;
  };
  es.onerror = function () {
    var el = document.querySelector("[data-checked]");
    if (el && es.readyState === 2) el.textContent = "not live: this page's server has stopped";
  };
})();
</script>`.trim();

function clock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Start the team's live board. `share` is whether this member's status may be pushed, which the
 * caller decides from their earlier yes; `projectDir` and `login` are needed only for that.
 */
export async function startTeamLive({ id, room, projectDir = null, login = null, share = false, withBranch = true, everyMs = 300_000, port = 0, now = () => new Date(), mayShare = async () => ({ ok: true }) }) {
  const clients = new Set();
  let html = "";
  let lastHead = null;
  let lastLine = "";
  let lastShared = "";
  let inflight = Promise.resolve();
  let closed = false;
  let checking = false;

  const send = (data) => {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  };

  async function check() {
    // A check queued but not started when the board closes is skipped; one already running finishes.
    if (closed) return;
    checking = true;
    try {
      await checkOnce();
    } finally {
      checking = false;
    }
  }

  async function checkOnce() {
    const pulled = await pullTeamRoom(room.path);
    if (share && projectDir && login) {
      try {
        const plan = await planSync({ clonePath: room.path, status: await buildStatus({ projectDir, login, withBranch }) });
        // Asked before each push, not once at the start: a team room made public while the board
        // is open would otherwise publish every status pushed after that.
        const allowed = plan.changed ? await mayShare() : { ok: true };
        if (plan.changed && !allowed.ok) {
          lastShared = `your status was not shared: ${allowed.why}`;
        } else if (plan.changed) {
          const done = await applySync({ clonePath: room.path, plan });
          lastShared = done.ok ? `your status shared at ${clock(now())}` : `your status was not shared: ${done.why}`;
        }
      } catch (err) {
        lastShared = `your status was not shared: ${err.message || err}`;
      }
    }
    const head = (await gitIn(room.path, ["rev-parse", "HEAD"])).out;
    const minutes = Math.round(everyMs / 60_000);
    const every = everyMs >= 60_000 ? `every ${minutes} minute${minutes === 1 ? "" : "s"}` : `every ${Math.round(everyMs / 1000)} seconds`;
    lastLine =
      `checked ${clock(now())}, ${every}` +
      (pulled.ok ? "" : ", but the team room could not be fetched") +
      (share ? (lastShared ? `; ${lastShared}` : "; your status is shared when it changes") : "; your status is not shared from here");
    if (head !== lastHead || !html) {
      lastHead = head;
      const { statuses, skipped } = await readStatuses(room.path);
      html = (await renderTeamBoard({ name: room.name, id, statuses, skipped, pulled: pulled.ok, checked: lastLine })).replace(
        "</body>",
        `${CLIENT}\n</body>`,
      );
      send({ reload: true });
    } else {
      send({ checked: lastLine });
    }
  }

  const tick = () => {
    inflight = inflight.then(check).catch(() => {});
    return inflight;
  };
  await tick();
  const timer = setInterval(tick, everyMs);

  const server = await serveLocal(
    (req, res) => {
      const path = new URL(req.url || "/", `http://${LIVE_HOST}`).pathname;
      if (path === "/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (path === "/" || path === "/board.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }
      if (path === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, checked: lastLine, clients: clients.size }));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    },
    { port },
  );
  const bound = server.address().port;
  return {
    url: `http://${LIVE_HOST}:${bound}/`,
    port: bound,
    checkNow: tick,
    checking: () => checking,
    async close() {
      closed = true;
      clearInterval(timer);
      // Waited for, so no fetch, commit or push is still running in the team room after this.
      await inflight;
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
