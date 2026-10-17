/**
 * `rooms dash`: localhost observability dashboard over local activity + team/org projections.
 * Renderer only — no new capture path. Binds 127.0.0.1; Host-checked via serveLocal.
 * Page HTML is built on the server (no client fetch); SSE reloads when signatures change.
 */

import { readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_HOST, serveLocal } from "./live.js";
import { ACTIVITY_FILE } from "./activity.js";
import { roomPaths, findRoomDir } from "./store.js";
import {
  buildInboxProjection,
  buildLocalProjection,
  buildOrgProjection,
  buildTeamProjection,
} from "./dash-projection.js";
import { teamForProject } from "./team.js";

export const DASH_DEFAULT_PORT = 7841;

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(ROOT, "..", "templates", "dash.html");

const CLIENT = `
<script data-rooms-dash>
(function () {
  if (location.protocol === "file:") return;
  var es = new EventSource("/stream");
  es.onmessage = function () { location.reload(); };
})();
</script>`.trim();

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLocal(d) {
  if (!d) return "<p class=\"muted\">unavailable</p>";
  const agentLine =
    Object.entries(d.agents7d || {})
      .map(([a, x]) => `${esc(a)} ${x.sessions}s/${x.filesEdited}f`)
      .join(" · ") || "none recorded";
  const sess =
    (d.sessions || [])
      .slice(0, 12)
      .map(
        (s) =>
          `<li><strong>${esc(s.agent)}</strong> · ${s.filesEdited || 0} file(s)` +
          (s.model ? ` · ${esc(s.model)}` : "") +
          (s.paths?.length
            ? `<div class="paths">${s.paths.map(esc).join(", ")}</div>`
            : "") +
          `</li>`,
      )
      .join("") || `<li class="empty">No sessions in the last 7 days</li>`;
  const pkgs =
    (d.packages || [])
      .slice(0, 15)
      .map((p) => `<li>${esc(p.name)}${p.version ? `@${esc(p.version)}` : ""} · ${esc(p.action)}</li>`)
      .join("") || `<li class="empty">No package events yet</li>`;
  const eps =
    (d.episodes || [])
      .slice(0, 10)
      .map(
        (e) =>
          `<li><strong>${esc(e.agent)}</strong> · ${e.filesEdited} file(s) · ${e.packages} pkg · ${e.commits} commit(s)` +
          (e.open ? " · open" : "") +
          (e.paths?.length ? `<div class="paths">${e.paths.map(esc).join(", ")}</div>` : "") +
          `</li>`,
      )
      .join("") || `<li class="empty">No episodes yet</li>`;
  const week =
    d.week?.commits != null
      ? `<p>Week floor: ${esc(String(d.week.commits.total || 0))} commits · see rooms week for caveats</p>`
      : d.weekWhy
        ? `<p class="muted">Week: ${esc(d.weekWhy)}</p>`
        : "";
  return (
    `<p><strong>${esc(d.project)}</strong> · agents (7d): ${agentLine}</p>${week}` +
    `<h2>Episodes (7d)</h2><ul>${eps}</ul>` +
    `<h2>Sessions (7d)</h2><ul>${sess}</ul>` +
    `<h2>Packages (7d)</h2><ul>${pkgs}</ul>`
  );
}

function renderTeam(d) {
  if (!d?.linked) return `<p class="muted">No team room linked. rooms team join &lt;owner/repo&gt;</p>`;
  const rows =
    (d.recent || [])
      .map(
        (s) =>
          `<li><strong>${esc(s.member)}</strong> · ${esc(s.project)}` +
          (s.branch ? ` · ${esc(s.branch)}` : "") +
          ` · uncommitted ${s.uncommitted?.files ?? "?"} · pr ${esc(s.pr || "none")}</li>`,
      )
      .join("") || `<li class="empty">No statuses yet</li>`;
  const cov = d.coverage?.totals || {};
  const coverageLine =
    d.coverage
      ? `<p class="muted">Coverage: ${cov.fresh ?? 0} fresh · ${cov.stale ?? 0} stale · ` +
        `${cov.hooksSeen ?? 0} hooks-seen (floor)</p>`
      : "";
  const pkgRows =
    (d.packages?.packages || [])
      .slice(0, 12)
      .map(
        (p) =>
          `<li>${esc(p.name)}${p.version ? `@${esc(p.version)}` : ""} · ${p.members} member(s)` +
          (p.memberLogins?.length ? `: ${p.memberLogins.map((m) => `@${esc(m)}`).join(", ")}` : "") +
          `</li>`,
      )
      .join("") || `<li class="empty">No package rollups yet</li>`;
  const catRows =
    (d.catalog?.setups || [])
      .slice(0, 12)
      .map(
        (s) =>
          `<li>${esc(s.role)}/${esc(s.name)} · @${esc(s.owner || "?")}` +
          (s.summary ? ` · ${esc(s.summary)}` : "") +
          `</li>`,
      )
      .join("") || `<li class="empty">No setups in catalog yet</li>`;
  return (
    `<p><strong>${esc(d.name)}</strong> (${esc(d.id)}) · ${d.members} member(s) · ` +
    `${d.sessions7d} sessions (7d) · ${d.shares} share(s)</p>${coverageLine}` +
    `<ul>${rows}</ul>` +
    `<h2>Team packages</h2><ul>${pkgRows}</ul>` +
    `<h2>Setup catalog</h2><ul>${catRows}</ul>`
  );
}

function renderOrg(d) {
  if (!d?.linked) return `<p class="muted">No org room. rooms org join &lt;owner/repo&gt;</p>`;
  if (!d.rollup) return `<p>Org ${esc(d.id)} — no rollup yet. rooms org refresh</p>`;
  const t = d.rollup.totals || {};
  return (
    `<p><strong>${esc(d.name)}</strong> · ${t.teams || 0} team(s) · ${t.members || 0} member-slots · ` +
    `${t.sessions7d || 0} sessions · ${t.packages || 0} package name(s) · ${t.stale || 0} stale</p>`
  );
}

function renderInbox(d) {
  if (!d?.login) return `<p class="muted">Link GitHub: rooms auth github</p>`;
  const lines = [
    ...(d.shares || []).map(
      (m) => `<li>share ${esc(m.id)} · ${esc(m.type)} · ${esc(m.ref)} · @${esc(m.from)}</li>`,
    ),
    ...(d.issues || []).map((i) => `<li>issue #${esc(i.number)} · ${esc(i.title)}</li>`),
  ].join("") || `<li class="empty">nothing waiting</li>`;
  return `<p>@${esc(d.login)}${d.team ? ` · ${esc(d.team)}` : ""}</p><ul>${lines}</ul>`;
}

async function htmlPage(projectDir) {
  const [tpl, local, team, org, inbox] = await Promise.all([
    readFile(TEMPLATE, "utf8"),
    buildLocalProjection(projectDir),
    buildTeamProjection(projectDir),
    buildOrgProjection(),
    buildInboxProjection(projectDir),
  ]);
  const checked = `updated ${new Date().toLocaleTimeString()}`;
  let html = tpl
    .replace("<!--LOCAL-->", renderLocal(local))
    .replace("<!--TEAM-->", renderTeam(team))
    .replace("<!--ORG-->", renderOrg(org))
    .replace("<!--INBOX-->", renderInbox(inbox))
    .replace("loading…", checked);
  if (!html.includes("data-rooms-dash")) {
    html = html.replace(/<\/body>/i, `${CLIENT}\n</body>`);
  }
  return html;
}

function json(res, data, code = 200) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Start the dash server. Returns { url, port, close }.
 */
export async function startDash(projectDir, { port = DASH_DEFAULT_PORT } = {}) {
  const clients = new Set();
  const roomDir = (await findRoomDir(projectDir)) || projectDir;
  const paths = roomPaths(roomDir);
  const sizeOf = (file) => stat(file).then((st) => st.size, () => 0);
  const signature = async () => {
    const linked = await teamForProject(projectDir).catch(() => ({ team: null }));
    const teamHead = linked.team
      ? (await import("./team.js")).gitIn(linked.team.path, ["rev-parse", "HEAD"]).then((r) => r.out || "", () => "")
      : Promise.resolve("");
    return `${await sizeOf(paths.events)}:${await sizeOf(join(paths.root, ACTIVITY_FILE))}:${await teamHead}`;
  };
  let lastSig = await signature();
  let debounce = null;

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

  const tick = async () => {
    try {
      const sig = await signature();
      if (sig !== lastSig) {
        lastSig = sig;
        send({ at: new Date().toISOString() });
      }
    } catch {
      /* keep serving */
    }
  };

  const server = await serveLocal(async (req, res) => {
    const url = new URL(req.url || "/", `http://${LIVE_HOST}`);
    if (url.pathname === "/health") {
      return json(res, { ok: true, host: LIVE_HOST, clients: clients.size });
    }
    if (url.pathname === "/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/local.json") {
      return json(res, await buildLocalProjection(projectDir));
    }
    if (url.pathname === "/api/team.json") {
      return json(res, await buildTeamProjection(projectDir));
    }
    if (url.pathname === "/api/org.json") {
      return json(res, await buildOrgProjection());
    }
    if (url.pathname === "/api/inbox.json") {
      return json(res, await buildInboxProjection(projectDir));
    }
    if (url.pathname === "/" || url.pathname === "/dash.html") {
      const html = await htmlPage(projectDir);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  }, { port });

  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  const poll = setInterval(() => {
    if (debounce) return;
    debounce = setTimeout(async () => {
      debounce = null;
      await tick();
    }, 50);
  }, 2000);

  return {
    url: `http://${LIVE_HOST}:${actual}/`,
    port: actual,
    close: async () => {
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
