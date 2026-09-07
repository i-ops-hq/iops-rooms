import { readFile, writeFile } from "node:fs/promises";
import { LIVE_CLIENT_SNIPPET } from "./live-client.js";
import { readGitSnapshot } from "./git-info.js";
import { basename, dirname, join, resolve } from "node:path";
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


/** meta.name if set and not a useless default; else folder basename. */
export function boardProjectName(meta, projectDir) {
  const name = String(meta?.name || "").trim();
  const useless = !name || /^(untitled|room)$/i.test(name);
  if (!useless) return name;
  const base = basename(resolve(projectDir || "."));
  return base || "project";
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

function shortBranch(name, max = 18) {
  if (!name) return "—";
  const s = String(name);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

function branchHue(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function isMainBranch(name) {
  return /^(main|master)$/i.test(String(name || ""));
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

function renderEmptyBanner() {
  return `<aside class="empty-banner" role="status">
  <h2 class="empty-title">Nothing posted yet</h2>
  <p class="empty-lead">This room is set up, but nothing meaningful is on the board yet. Try one of these:</p>
  <ul class="empty-actions">
    <li><code>rooms post "…"</code> — post a CLI note</li>
    <li>MCP <code>post_note</code> — agents post while working (enable in mcp.json)</li>
    <li><code>rooms hooks install</code> — opt-in local git auto-post (not IDE telemetry)</li>
  </ul>
</aside>`;
}

function renderEvents(events) {
  const nonSystem = events.filter((e) => e.type !== "system");
  if (nonSystem.length === 0) {
    return renderEmptyBanner();
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
      const hue = branch ? branchHue(ev.branch) : 210;
      const mainAttr = isMainBranch(ev.branch) ? ' data-main="1"' : "";
      return `<article class="event" data-type="${kind}" data-tone="${kind}" data-branch="${branch}"${mainAttr} style="--branch-hue: ${hue}">
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
    const prev =
      byBranch.get(b) ||
      { count: 0, actors: new Set(), devices: new Set(), lastAt: "", lastActor: "" };
    prev.count += 1;
    if (ev.actor) prev.actors.add(ev.actor);
    if (ev.deviceId) prev.devices.add(ev.deviceId);
    if (!prev.lastAt || (ev.at && ev.at > prev.lastAt)) {
      prev.lastAt = ev.at || "";
      prev.lastActor = ev.actor || "";
    }
    byBranch.set(b, prev);
  }
  const local = git.branches || [];
  const unknown = byBranch.get("(unknown)");
  const named = [...new Set([...local, ...byBranch.keys()])].filter((n) => n !== "(unknown)");
  if (!named.length && !unknown && !git.current) {
    return `<section class="branch-panel" aria-label="branches">
  <h2 class="branch-heading">Branches</h2>
  <p class="branch-note">${escapeHtml(git.note || "No local git branches yet.")}</p>
</section>`;
  }
  const rows = named
    .map((name) => {
      const info =
        byBranch.get(name) ||
        { count: 0, actors: new Set(), devices: new Set(), lastAt: "", lastActor: "" };
      const actors = [...info.actors].join(", ") || "—";
      const devices = [...info.devices].map((d) => shortDevice(d)).filter(Boolean).join(", ");
      const who = devices ? `${actors} · devices ${devices}` : actors;
      const current = name === git.current ? ' data-current="1"' : "";
      const mainAttr = isMainBranch(name) ? ' data-main="1"' : "";
      const hue = branchHue(name);
      const last = info.lastAt
        ? `${escapeHtml(info.lastActor || "?")} · ${escapeHtml(formatWhen(info.lastAt))}`
        : "no room posts yet";
      return `<div class="branch-row"${current}${mainAttr} style="--branch-hue: ${hue}">
  <span class="branch-swatch" aria-hidden="true"></span>
  <span class="branch-name" title="${escapeHtml(name)}">${escapeHtml(shortBranch(name, 28))}${isMainBranch(name) ? ' <span class="branch-badge">default</span>' : ""}</span>
  <span class="branch-meta">${info.count} post${info.count === 1 ? "" : "s"} · ${escapeHtml(who)}</span>
  <span class="branch-last">${last}</span>
</div>`;
    })
    .join("\n");
  const hist = unknown
    ? `<details class="branch-history"><summary>Pre-stamp history (${unknown.count} post${unknown.count === 1 ? "" : "s"} without a branch field)</summary>
  <p class="branch-note">Older events from before branch awareness. Actors: ${escapeHtml([...unknown.actors].join(", ") || "—")}${unknown.devices.size ? ` · devices ${escapeHtml([...unknown.devices].map((d) => shortDevice(d)).join(", "))}` : ""}.</p>
</details>`
    : "";
  const cur = git.current
    ? `<p class="branch-current">Current checkout: <strong title="${escapeHtml(git.current)}">${escapeHtml(shortBranch(git.current, 40))}</strong>${git.head ? ` <span class="device">@ ${escapeHtml(git.head)}</span>` : ""}</p>`
    : "";
  return `<section class="branch-panel" aria-label="branches">
  <h2 class="branch-heading">Branches</h2>
  ${cur}
  <p class="branch-note">${escapeHtml(git.note || "Local git + room posts. Remotes/PRs come later. Actors are people/tools; devices are machines.")}</p>
  <p class="branch-legend"><span class="branch-swatch branch-swatch-main" aria-hidden="true"></span> green rail = main / master</p>
  <div class="branch-list">${rows}</div>
  ${hist}
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

  const branchLabel = shortBranch(git.current || "—", 18);
  const projectName = boardProjectName(meta, projectDir);
  const boardTitle = `Rooms · ${projectName}`;
  const replacements = {
    "{{TITLE}}": escapeHtml(boardTitle),
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
