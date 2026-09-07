import { readFile, writeFile } from "node:fs/promises";
import { LIVE_CLIENT_SNIPPET } from "./live-client.js";
import { readGitSnapshot } from "./git-info.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "templates", "board.html");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shortDevice(id) {
  if (!id) return "";
  const s = String(id);
  // Keep readable ids (tom-smoke). Only trim long hex blobs.
  if (/^[a-f0-9]+$/i.test(s) && s.length > 12) return s.slice(0, 12);
  if (s.length > 24) return s.slice(0, 24);
  return s;
}

function posterStats(events) {
  const actors = new Map();
  const tools = new Set();
  for (const ev of events) {
    if (ev.type === "system") continue;
    const name = ev.actor || "unknown";
    const prev = actors.get(name) || { deviceIds: new Set(), tools: new Set() };
    if (ev.deviceId) prev.deviceIds.add(ev.deviceId);
    if (ev.tool) prev.tools.add(ev.tool);
    actors.set(name, prev);
    if (ev.tool) tools.add(ev.tool);
  }
  return { actors, tools };
}

function renderEvents(events) {
  if (!events.length) {
    return `<p class="empty">No events yet. Post from the CLI or your agent.</p>`;
  }
  return events
    .map((ev) => {
      const kind = escapeHtml(ev.type || "note");
      const actor = escapeHtml(ev.actor || "unknown");
      const tool = escapeHtml(ev.tool || "");
      const device = escapeHtml(shortDevice(ev.deviceId));
      const branch = escapeHtml(ev.branch || "");
      const when = escapeHtml(formatWhen(ev.at));
      const text = escapeHtml(ev.text || "");
      const extra =
        ev.path != null
          ? `<p class="meta-line">path: ${escapeHtml(ev.path)}</p>`
          : "";
      const diff =
        ev.diff != null && ev.diff !== ""
          ? `<pre class="diff">${escapeHtml(ev.diff)}</pre>`
          : "";
      const deviceBit = device
        ? `<span class="device" title="device ${escapeHtml(ev.deviceId || "")}">${device}</span>`
        : "";
      const branchBit = branch
        ? `<span class="branch" title="git branch">${branch}</span>`
        : "";
      return `<article class="event" data-type="${kind}" data-tone="${kind}" data-branch="${branch}">
  <header>
    <span class="dot"></span>
    <span class="actor">${actor}</span>
    <span class="tool">${tool}</span>
    ${deviceBit}
    ${branchBit}
    <span class="kind">${kind}</span>
    <time datetime="${escapeHtml(ev.at || "")}">${when}</time>
  </header>
  <p class="body">${text}</p>
  ${extra}
  ${diff}
</article>`;
    })
    .join("\n");
}

function renderBranchPanel(git, events) {
  const byBranch = new Map();
  for (const ev of events) {
    if (ev.type === "system") continue;
    const b = ev.branch || "(unknown)";
    const prev = byBranch.get(b) || { count: 0, actors: new Set(), lastAt: "", lastActor: "" };
    prev.count += 1;
    if (ev.actor) prev.actors.add(ev.actor);
    if (!prev.lastAt || (ev.at && ev.at > prev.lastAt)) {
      prev.lastAt = ev.at || "";
      prev.lastActor = ev.actor || "";
    }
    byBranch.set(b, prev);
  }
  const local = git.branches || [];
  const names = [...new Set([...local, ...byBranch.keys()])].filter((n) => n !== "(unknown)" || byBranch.has(n));
  if (!names.length && !git.current) {
    return `<section class="branch-panel" aria-label="branches">
  <h2 class="branch-heading">Branches</h2>
  <p class="branch-note">${escapeHtml(git.note || "No local git branches yet.")}</p>
</section>`;
  }
  const rows = names
    .map((name) => {
      const info = byBranch.get(name) || { count: 0, actors: new Set(), lastAt: "", lastActor: "" };
      const actors = [...info.actors].join(", ") || "—";
      const current = name === git.current ? ' data-current="1"' : "";
      const last = info.lastAt
        ? `${escapeHtml(info.lastActor || "?")} · ${escapeHtml(formatWhen(info.lastAt))}`
        : "no room posts yet";
      return `<div class="branch-row"${current}>
  <span class="branch-name">${escapeHtml(name)}</span>
  <span class="branch-meta">${info.count} post${info.count === 1 ? "" : "s"} · ${escapeHtml(actors)}</span>
  <span class="branch-last">${last}</span>
</div>`;
    })
    .join("\n");
  const cur = git.current
    ? `<p class="branch-current">Current checkout: <strong>${escapeHtml(git.current)}</strong>${git.head ? ` <span class="device">@ ${escapeHtml(git.head)}</span>` : ""}</p>`
    : "";
  return `<section class="branch-panel" aria-label="branches">
  <h2 class="branch-heading">Branches</h2>
  ${cur}
  <p class="branch-note">${escapeHtml(git.note || "Local git + room posts. Remotes/PRs come later.")}</p>
  <div class="branch-list">${rows}</div>
</section>`;
}

export async function writeBoard(boardPath, meta, events, opts = {}) {
  let template = await readFile(TEMPLATE, "utf8");
  const projectDir = opts.projectDir || process.cwd();
  const git = await readGitSnapshot(projectDir);
  const { actors, tools } = posterStats(events);
  // Count distinct non-system actors; if only system events, still 1 creator
  const distinctPosters = actors.size;
  const postersLabel = String(Math.max(distinctPosters, meta.createdBy ? 1 : 0));
  const postersBlurb =
    distinctPosters <= 1
      ? "1 poster — join from another tool or machine with the room code."
      : `${distinctPosters} posters on this board.`;

  const toolList = [...tools];
  const posterNames = [...actors.keys()];
  let strip = "";
  if (toolList.length >= 2) {
    strip = `<div class="tools-strip" aria-label="tools that posted">${toolList
      .map((t) => `<span class="tool-chip">${escapeHtml(t)}</span>`)
      .join('<span class="dot-sep">·</span>')}</div>`;
  } else if (distinctPosters >= 2) {
    strip = `<div class="tools-strip" aria-label="posters">${posterNames
      .map((n) => `<span class="tool-chip">${escapeHtml(n)}</span>`)
      .join('<span class="dot-sep">·</span>')}</div>`;
  }

  const network = meta.network || "off";
  const networkLabel = network === "off" ? "off" : network;
  const networkDetail =
    network === "off"
      ? "files stay in this folder"
      : "syncs only among your team’s devices — not I-Ops cloud";

  const branchLabel = git.current || "—";
  const replacements = {
    "{{TITLE}}": escapeHtml(meta.name || "room"),
    "{{CODE}}": escapeHtml(meta.id || ""),
    "{{CREATED}}": escapeHtml(meta.createdAt || ""),
    "{{BY}}": escapeHtml(meta.createdBy || ""),
    "{{COUNT}}": String(events.length),
    "{{NETWORK}}": escapeHtml(networkLabel),
    "{{NETWORK_DETAIL}}": escapeHtml(networkDetail),
    "{{POSTERS}}": escapeHtml(postersLabel),
    "{{POSTERS_BLURB}}": escapeHtml(postersBlurb),
    "{{BRANCH}}": escapeHtml(branchLabel),
    "{{BRANCH_PANEL}}": renderBranchPanel(git, events),
    "{{TOOLS_STRIP}}": strip,
    "{{EVENTS}}": renderEvents(events),
  };
  for (const [token, value] of Object.entries(replacements)) {
    template = template.replaceAll(token, value);
  }
  if (!template.includes("data-rooms-live")) {
    template = template.replace("</body>", `${LIVE_CLIENT_SNIPPET}\n</body>`);
  }
  await writeFile(boardPath, template, "utf8");
}
