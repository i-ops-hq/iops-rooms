import { readFile, writeFile } from "node:fs/promises";
import { LIVE_CLIENT_SNIPPET } from "./live-client.js";
import { readGitSnapshot } from "./git-info.js";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eventVerifiedBadge } from "./identity.js";

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
    const prev = actors.get(name) || {
      deviceIds: new Set(),
      tools: new Set(),
      verified: false,
      unverified: false,
      githubLogin: null,
    };
    if (ev.deviceId) prev.deviceIds.add(ev.deviceId);
    if (ev.tool) prev.tools.add(ev.tool);
    const badge = eventVerifiedBadge(ev);
    if (badge.kind === "verified") {
      prev.verified = true;
      prev.unverified = false;
      prev.githubLogin = badge.login || prev.githubLogin;
    } else if (badge.kind === "unverified" && !prev.verified) {
      prev.unverified = true;
      if (badge.login) prev.githubLogin = badge.login;
    }
    actors.set(name, prev);
    if (ev.tool) tools.add(ev.tool);
  }
  return { actors, tools };
}

function renderVerifyBadge(ev) {
  const badge = eventVerifiedBadge(ev);
  if (badge.kind === "verified") {
    const dual = badge.provider === "both";
    const host = dual ? "GitHub + GitLab" : badge.provider === "gitlab" ? "GitLab" : "GitHub";
    const tip = badge.login
      ? `Signed locally as @${badge.login} (${host}) — not a live check.`
      : `Signed locally (${host}) — not a live check.`;
    const label = dual ? "verified · gh+gl" : badge.provider === "gitlab" ? "verified · gitlab" : badge.provider === "github" ? "verified · github" : "verified";
    return `<span class="verify-badge" data-verify="verified" title="${escapeHtml(tip)}">${label}</span>`;
  }
  if (badge.kind === "unverified") {
    const tip = badge.login
      ? `claims @${badge.login} without a valid signature`
      : "env override / missing local signature";
    return `<span class="verify-badge" data-verify="unverified" title="${escapeHtml(tip)}">unverified</span>`;
  }
  // kind === "none" — quiet unsigned solo; no chip
  return "";
}

function renderPosterVerifyChip(info) {
  if (info?.verified) {
    return `<span class="verify-badge" data-verify="verified">verified</span>`;
  }
  if (info?.unverified || info?.githubLogin) {
    return `<span class="verify-badge" data-verify="unverified">unverified</span>`;
  }
  return "";
}

function posterVerifyKind(info) {
  if (info?.verified) return "verified";
  if (info?.unverified || info?.githubLogin) return "unverified";
  return "none";
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
          ? `<pre class="diff">${escapeHtml(ev.diff)}${
              ev.truncated ? "\n\n[cut at 100 KB — this is the start of the file, not all of it]" : ""
            }</pre>`
          : "";
      const deviceBit = device
        ? `<span class="device" title="device ${escapeHtml(ev.deviceId || "")}">${device}</span>`
        : "";
      const branchBit = branch
        ? `<span class="branch" title="git branch">${branch}</span>`
        : "";
      const verifyBit = renderVerifyBadge(ev);
      const hue = branch ? branchHue(ev.branch) : 210;
      const mainAttr = isMainBranch(ev.branch) ? ' data-main="1"' : "";
      const verifyAttr = eventVerifiedBadge(ev).kind;
      return `<article class="event" data-type="${kind}" data-tone="${kind}" data-branch="${branch}" data-verify="${verifyAttr}"${mainAttr} style="--branch-hue: ${hue}">
  <header>
    <span class="dot"></span>
    <span class="actor">${actor}</span>
    ${verifyBit}
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


function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) {
    const s = parts[0];
    return (s.slice(0, 2) || "?").toUpperCase();
  }
  return ((parts[0][0] || "") + (parts[parts.length - 1][0] || "")).toUpperCase() || "?";
}

/** Light normalize of event.tool — Rooms stamps only, not IDE telemetry. */
export function normalizeTool(tool) {
  const raw = String(tool || "").trim().toLowerCase();
  if (!raw) return "cli";
  if (/(cursor|composer)/.test(raw)) return "cursor";
  if (/claude/.test(raw)) return "claude";
  if (/codex|openai/.test(raw)) return "codex";
  if (raw.includes("mcp")) return "mcp";
  if (/git[-_]?hook|hook/.test(raw)) return "git-hook";
  if (/cli|terminal|shell/.test(raw)) return "cli";
  return "unknown";
}

/** Canonical agent/tool ids shown on the board. */
export const TOOL_IDS = ["cursor", "claude", "codex", "mcp", "cli", "git-hook", "unknown"];

export function toolLabel(tool) {
  switch (normalizeTool(tool)) {
    case "cursor":
      return "Cursor";
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "mcp":
      return "MCP";
    case "cli":
      return "CLI";
    case "git-hook":
      return "git-hook";
    default:
      return "unknown";
  }
}

/** Compact self-contained SVG icons (no CDN). currentColor fill/stroke. */
export function toolIconSvg(tool) {
  const id = normalizeTool(tool);
  const common = 'viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"';
  switch (id) {
    case "cursor":
      return `<svg ${common}><path fill="currentColor" d="M3.2 2.1 12.6 7.4c.5.3.3 1.1-.3 1.2L8.4 9.3l1.7 4.2c.2.5-.4.9-.8.6L3 8.4c-.5-.4-.3-1.2.2-1.3l.2-.05Z"/></svg>`;
    case "claude":
      return `<svg ${common}><path fill="currentColor" d="M8 1.5 9.7 5.8 14.5 6.2 10.8 9.2 12.1 14 8 11.5 3.9 14 5.2 9.2 1.5 6.2 6.3 5.8Z"/></svg>`;
    case "codex":
      return `<svg ${common}><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>`;
    case "mcp":
      return `<svg ${common}><circle cx="4" cy="8" r="2" fill="currentColor"/><circle cx="12" cy="4.5" r="2" fill="currentColor"/><circle cx="12" cy="11.5" r="2" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M5.7 7.2 10.2 5.2M5.7 8.8 10.2 10.8"/></svg>`;
    case "cli":
      return `<svg ${common}><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3.5 4.5 7 8l-3.5 3.5M8.5 12.5h4"/></svg>`;
    case "git-hook":
      return `<svg ${common}><circle cx="5" cy="4" r="1.7" fill="currentColor"/><circle cx="11" cy="8" r="1.7" fill="currentColor"/><circle cx="5" cy="12" r="1.7" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M5 5.7v4.6M5 8h4.2"/></svg>`;
    default:
      return `<svg ${common}><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><text x="8" y="11" text-anchor="middle" font-size="8" font-family="system-ui,sans-serif" fill="currentColor">?</text></svg>`;
  }
}

/** Default presence window: 10 minutes. Override with ROOMS_ACTIVE_MS (ms). */
export const DEFAULT_ACTIVE_MS = 10 * 60 * 1000;

/** Resolve active window from env; invalid/missing → default. */
export function resolveActiveMs(env = process.env) {
  const raw = env?.ROOMS_ACTIVE_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_ACTIVE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ACTIVE_MS;
  return n;
}

/**
 * Humanize a non-negative elapsed duration for tip copy.
 * e.g. "just now", "2m ago", "3h ago", "2d ago"
 */
export function humanizeRelative(msAgo) {
  let ms = Number(msAgo);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec <= 5 ? "just now" : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatPresenceLabel(state, relative) {
  if (relative === "just now") return `${state} · just now`;
  return `${state} · last ${relative}`;
}

/**
 * Active if last non-system event timestamp is within windowMs of now.
 * Honest: only .room event stamps — not IDE scrape / invented presence.
 */
export function presenceFromLastAt(lastAt, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const windowMs = opts.windowMs != null ? Number(opts.windowMs) : resolveActiveMs();
  const t = parseAt(lastAt);
  if (t == null) {
    return {
      state: "idle",
      lastAt: "",
      relative: "",
      label: "idle · never",
      active: false,
    };
  }
  const ago = Math.max(0, now - t);
  const active = ago <= windowMs;
  const state = active ? "active" : "idle";
  const relative = humanizeRelative(ago);
  return {
    state,
    lastAt: lastAt || "",
    relative,
    label: formatPresenceLabel(state, relative),
    active,
  };
}

/** Latest non-system event `at` per normalized tool. */
export function lastAtByTool(events) {
  const map = new Map();
  for (const ev of events || []) {
    if (!ev || ev.type === "system") continue;
    const id = normalizeTool(ev.tool);
    const at = ev.at || "";
    const prev = map.get(id) || "";
    if (!prev || (at && at > prev)) map.set(id, at);
  }
  return map;
}

/** Latest non-system event `at` per actor. */
export function lastAtByActor(events) {
  const map = new Map();
  for (const ev of events || []) {
    if (!ev || ev.type === "system") continue;
    const name = ev.actor || "unknown";
    const at = ev.at || "";
    const prev = map.get(name) || "";
    if (!prev || (at && at > prev)) map.set(name, at);
  }
  return map;
}

function renderToolChip(tool, presence) {
  const id = normalizeTool(tool);
  const label = toolLabel(id);
  const state = presence?.state === "active" ? "active" : "idle";
  const tip = presence?.label ? `${label} · ${presence.label}` : label;
  return `<span class="agent-chip" data-tool="${escapeHtml(id)}" data-presence="${state}" title="${escapeHtml(tip)}">${toolIconSvg(id)}<span class="agent-presence" aria-hidden="true"></span><span class="agent-chip-label">${escapeHtml(label)}</span></span>`;
}

function renderAgentsStrip(events, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const windowMs = opts.windowMs != null ? Number(opts.windowMs) : resolveActiveMs();
  const lastByTool = lastAtByTool(events);
  const tools = new Set(lastByTool.keys());
  const list = [...tools].sort((a, b) => {
    const ia = TOOL_IDS.indexOf(a);
    const ib = TOOL_IDS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  if (!list.length) return "";
  return `<div class="agents-strip" aria-label="agents seen in room"><span class="agents-strip-label">Agents</span>${list
    .map((t) => renderToolChip(t, presenceFromLastAt(lastByTool.get(t), { now, windowMs })))
    .join("")}</div>`;
}

function actorHue(name) {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function parseAt(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : null;
}

/**
 * Build branch lanes + per-(actor,branch) presence from Rooms events + local git.
 * Positions are honest: only .room event stamps, not IDE session data.
 */
/** Branch graph geometry. Kept as constants so the SVG and the CSS agree on one set of numbers. */
const GRAPH = { w: 1000, pad: 26, top: 30, gap: 34, maxLanes: 8, r: 3.4, glow: 8 };

/** x for a 0-100 time position, inset so a dot at either end is not clipped. */
function graphX(pct) {
  return GRAPH.pad + (Math.max(0, Math.min(100, pct)) / 100) * (GRAPH.w - GRAPH.pad * 2);
}

/**
 * A branch leaves main, runs its own line, and rejoins. Orthogonal with rounded corners rather
 * than a free bezier — the same reasoning as the runtime architecture diagram: free curves between
 * many nodes read as spaghetti, right angles with a radius read as a circuit.
 */
function branchPath(x1, x2, yMain, yLane) {
  const r = Math.min(12, Math.max(4, (x2 - x1) / 4));
  const dy = yLane > yMain ? 1 : -1;
  const a = x1 + r;
  const b = x2 - r;
  if (b <= a) {
    // Too short to route: a single spur down and back, so a one-post branch still reads as one.
    const mid = (x1 + x2) / 2;
    return `M${x1} ${yMain} Q${mid} ${yMain} ${mid} ${yLane} Q${mid} ${yMain} ${x2} ${yMain}`;
  }
  return (
    `M${x1} ${yMain}` +
    ` Q${a} ${yMain} ${a} ${yMain + r * dy}` +
    ` L${a} ${yLane - r * dy}` +
    ` Q${a} ${yLane} ${a + r} ${yLane}` +
    ` L${b - r} ${yLane}` +
    ` Q${b} ${yLane} ${b} ${yLane - r * dy}` +
    ` L${b} ${yMain + r * dy}` +
    ` Q${b} ${yMain} ${x2} ${yMain}`
  );
}

/** One commit: a soft halo plus a solid core. Two circles rather than an SVG blur filter — same
 *  look, no filter cost, and it still reads when the page is printed. */
function graphDot(x, y, pt, hue) {
  const kind = pt.isDiff ? "diff" : pt.type === "approved" ? "approved" : pt.type === "review_requested" ? "review" : "note";
  const when = formatWhen(pt.at);
  const tip = `${pt.actor}${pt.tool ? ` · ${pt.tool}` : ""} · ${kind}${when ? ` · ${when}` : ""}${pt.text ? `\n${pt.text}` : ""}`;
  return (
    `<g class="bg-dot" data-kind="${escapeHtml(kind)}" style="--h: ${hue}">` +
    `<title>${escapeHtml(tip)}</title>` +
    `<circle class="bg-halo" cx="${x.toFixed(1)}" cy="${y}" r="${GRAPH.glow}"></circle>` +
    `<circle class="bg-core" cx="${x.toFixed(1)}" cy="${y}" r="${GRAPH.r}"></circle>` +
    `</g>`
  );
}

/**
 * The branch graph: main as a rail across the whole span, every other branch splitting off at its
 * first post and rejoining at its last, a glowing dot per post, and a light travelling each wire.
 *
 * Positions come from the same 0-100 time axis the lane avatars use, so a dot and its avatar sit
 * at the same x. Nothing here is invented: a branch with no posts has no line to draw.
 */
export function renderBranchGraph(model) {
  const withPosts = (model.lanes || []).filter((l) => (l.points || []).length > 0);
  if (!withPosts.length) return "";

  const main = withPosts.find((l) => l.isMain) || null;
  const others = withPosts.filter((l) => l !== main);
  const shown = others.slice(0, GRAPH.maxLanes);
  const dropped = others.length - shown.length;

  const yMain = GRAPH.top;
  const height = GRAPH.top + (shown.length + 1) * GRAPH.gap;

  const mainRail =
    `<g class="bg-branch" data-main="1" style="--h: ${main ? main.hue : 150}">` +
    `<path class="bg-track" d="M${GRAPH.pad} ${yMain} L${GRAPH.w - GRAPH.pad} ${yMain}"></path>` +
    `<path class="bg-pulse" d="M${GRAPH.pad} ${yMain} L${GRAPH.w - GRAPH.pad} ${yMain}"></path>` +
    `</g>`;

  const branches = shown
    .map((lane, i) => {
      const yLane = yMain + (i + 1) * GRAPH.gap;
      const x1 = graphX(lane.firstPct);
      const x2 = graphX(lane.lastPct);
      const d = branchPath(x1, x2, yMain, yLane);
      const cur = lane.isCurrent ? ' data-current="1"' : "";
      return (
        `<g class="bg-branch"${cur} style="--h: ${lane.hue}; --delay: ${(i * 0.5).toFixed(2)}s">` +
        `<title>${escapeHtml(lane.name)} · ${lane.eventCount} post${lane.eventCount === 1 ? "" : "s"}</title>` +
        `<path class="bg-track" d="${d}"></path>` +
        `<path class="bg-pulse" d="${d}"></path>` +
        `<text class="bg-label" x="${GRAPH.pad}" y="${yLane - 8}">${escapeHtml(shortBranch(lane.name, 26))}</text>` +
        lane.points.map((pt) => graphDot(graphX(pt.pct), yLane, pt, lane.hue)).join("") +
        `</g>`
      );
    })
    .join("");

  const mainDots = main
    ? `<g class="bg-branch" data-main="1" style="--h: ${main.hue}">` +
      `<text class="bg-label bg-label-main" x="${GRAPH.pad}" y="${yMain - 12}">${escapeHtml(shortBranch(main.name, 26))}</text>` +
      main.points.map((pt) => graphDot(graphX(pt.pct), yMain, pt, main.hue)).join("") +
      `</g>`
    : "";

  // A dropped branch is a branch the reader cannot see. Say so rather than quietly drawing eight.
  const more = dropped > 0
    ? `<p class="bg-more">${dropped} more branch${dropped === 1 ? "" : "es"} not drawn — the list below has all of them.</p>`
    : "";

  return `<figure class="branch-graph">
  <svg viewBox="0 0 ${GRAPH.w} ${height}" preserveAspectRatio="xMidYMid meet" role="img"
       aria-label="Branch graph: ${withPosts.length} branch${withPosts.length === 1 ? "" : "es"} over time, one dot per post">
    ${mainRail}
    ${branches}
    ${mainDots}
  </svg>
  ${more}
</figure>`;
}

export function buildTimelineModel(events, git = {}, opts = {}) {
  const nonSystem = (events || []).filter((e) => e && e.type !== "system");
  const byBranch = new Map();
  let tMin = Infinity;
  let tMax = -Infinity;

  for (const ev of nonSystem) {
    const b = ev.branch || "(unknown)";
    const t = parseAt(ev.at);
    if (t != null) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    let lane = byBranch.get(b);
    if (!lane) {
      lane = {
        name: b,
        actors: new Map(),
        eventCount: 0,
        lastAt: "",
        tools: new Set(),
        points: [],
      };
      byBranch.set(b, lane);
    }
    lane.eventCount += 1;
    lane.points.push({
      t,
      at: ev.at || "",
      actor: ev.actor || "unknown",
      tool: ev.tool ? normalizeTool(ev.tool) : "",
      type: ev.type || "note",
      isDiff: ev.type === "diff" || (ev.diff != null && ev.diff !== ""),
      text: String(ev.text || "").slice(0, 120),
    });
    if (ev.tool) lane.tools.add(normalizeTool(ev.tool));
    if (!lane.lastAt || (ev.at && ev.at > lane.lastAt)) lane.lastAt = ev.at || "";

    const actorName = ev.actor || "unknown";
    let person = lane.actors.get(actorName);
    if (!person) {
      person = {
        actor: actorName,
        tools: new Set(),
        lastAt: "",
        lastType: "",
        lastText: "",
        lastDiff: false,
        devices: new Set(),
        eventCount: 0,
        postCount: 0,
        diffCount: 0,
        verified: false,
        unverified: false,
        githubLogin: null,
      };
      lane.actors.set(actorName, person);
    }
    person.eventCount += 1;
    if (ev.type === "diff" || (ev.diff != null && ev.diff !== "")) person.diffCount += 1;
    else person.postCount += 1;
    if (ev.tool) person.tools.add(normalizeTool(ev.tool));
    if (ev.deviceId) person.devices.add(ev.deviceId);
    {
      const badge = eventVerifiedBadge(ev);
      if (badge.kind === "verified") {
        person.verified = true;
        person.unverified = false;
        person.githubLogin = badge.login || person.githubLogin;
      } else if (badge.kind === "unverified" && !person.verified) {
        person.unverified = true;
        if (badge.login) person.githubLogin = badge.login;
      }
    }
    if (!person.lastAt || (ev.at && ev.at > person.lastAt)) {
      person.lastAt = ev.at || "";
      person.lastType = ev.type || "note";
      person.lastText = String(ev.text || "").slice(0, 160);
      person.lastDiff = Boolean(ev.diff);
    }
  }

  const local = git.branches || [];
  const named = [...new Set([...local, ...byBranch.keys()])].filter(
    (n) => n !== "(unknown)",
  );
  named.sort((a, b) => {
    const am = isMainBranch(a) ? 0 : 1;
    const bm = isMainBranch(b) ? 0 : 1;
    if (am !== bm) return am - bm;
    const la = byBranch.get(a)?.lastAt || "";
    const lb = byBranch.get(b)?.lastAt || "";
    if (la !== lb) return lb > la ? 1 : lb < la ? -1 : 0;
    return a.localeCompare(b);
  });

  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    const now = Date.now();
    tMin = now - 3_600_000;
    tMax = now;
  }
  if (tMax <= tMin) tMax = tMin + 60_000;

  const lanes = named.map((name) => {
    const info =
      byBranch.get(name) ||
      { name, actors: new Map(), eventCount: 0, lastAt: "", tools: new Set() };
    const people = [...info.actors.values()].map((p) => {
      const t = parseAt(p.lastAt);
      const pct =
        t == null ? 50 : Math.max(2, Math.min(98, ((t - tMin) / (tMax - tMin)) * 100));
      const now = opts.now != null ? Number(opts.now) : Date.now();
      const windowMs = opts.windowMs != null ? Number(opts.windowMs) : resolveActiveMs();
      const presence = presenceFromLastAt(p.lastAt, { now, windowMs });
      return {
        actor: p.actor,
        initials: initials(p.actor),
        tools: [...p.tools].sort(),
        lastAt: p.lastAt,
        lastType: p.lastType,
        lastText: p.lastText,
        lastDiff: p.lastDiff,
        devices: [...p.devices],
        eventCount: p.eventCount,
        postCount: p.postCount || 0,
        diffCount: p.diffCount || 0,
        verified: Boolean(p.verified),
        unverified: Boolean(p.unverified),
        githubLogin: p.githubLogin || null,
        pct,
        hue: actorHue(p.actor),
        presence,
      };
    });
    people.sort((a, b) => (a.lastAt || "").localeCompare(b.lastAt || ""));

    const span = tMax - tMin;
    const points = (info.points || [])
      .map((pt) => ({
        ...pt,
        // Same 0-100 axis the avatars sit on, so a dot and its avatar line up.
        pct: pt.t == null || !(span > 0) ? 50 : Math.max(1, Math.min(99, ((pt.t - tMin) / span) * 100)),
      }))
      .sort((a, b) => a.pct - b.pct);

    return {
      name,
      isMain: isMainBranch(name),
      isCurrent: name === git.current,
      eventCount: info.eventCount,
      tools: [...info.tools].sort(),
      people,
      points,
      firstPct: points.length ? points[0].pct : null,
      lastPct: points.length ? points[points.length - 1].pct : null,
      hue: branchHue(name),
    };
  });

  const unknown = byBranch.get("(unknown)");
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const windowMs = opts.windowMs != null ? Number(opts.windowMs) : resolveActiveMs();
  const toolLast = lastAtByTool(nonSystem);
  const toolPresence = {};
  for (const [tool, at] of toolLast) {
    toolPresence[tool] = presenceFromLastAt(at, { now, windowMs });
  }
  return {
    lanes,
    unknownCount: unknown?.eventCount || 0,
    tMin,
    tMax,
    head: git.head || "",
    current: git.current || "",
    hasPeople: lanes.some((l) => l.people.length > 0),
    toolPresence,
    now,
    windowMs,
  };
}

function renderTimeline(events, git, opts = {}) {
  const model = buildTimelineModel(events, git, opts);
  if (!model.lanes.length && !model.unknownCount) {
    return `<section class="timeline" data-timeline="1" aria-label="branch timeline">
  <div class="timeline-head">
    <h2 class="timeline-heading">Timeline</h2>
    <p class="timeline-note">No branch stamps yet. Posts with a git branch (or ROOMS_BRANCH) will appear as lanes here. Derived from room events — not IDE telemetry.</p>
  </div>
</section>`;
  }

  const headBit =
    model.head && model.current
      ? `Current checkout <strong>${escapeHtml(shortBranch(model.current, 28))}</strong> @ <span class="device">${escapeHtml(model.head)}</span> (local git only).`
      : "Commit SHAs appear only for the current local checkout when git is available.";

  const lanesHtml = model.lanes
    .map((lane) => {
      const mainAttr = lane.isMain ? ' data-main="1"' : "";
      const curAttr = lane.isCurrent ? ' data-current="1"' : "";
      const avatars = lane.people
        .map((p) => {
          const tools = p.tools.length ? p.tools.join(",") : "cli";
          const lastPost = p.lastText
            ? `${p.lastType}: ${p.lastText}`
            : "no post text";
          // No title= on the button — native browser tip would stack with .tl-tooltip.
          const aria = `${p.actor} on ${lane.name}`;
          const verify = posterVerifyKind(p);
          // Tip icons are rendered client-side from data-tools; keep avatar chrome light.
          // No title= on .tl-verify — custom .tl-tooltip owns hover; native title stacks.
          const presenceState = p.presence?.state === "active" ? "active" : "idle";
          const presenceLabel = p.presence?.label || "idle · never";
          const toolPresenceBits = p.tools
            .map((tid) => {
              const pr = model.toolPresence?.[tid];
              const st = pr?.state === "active" ? "active" : "idle";
              const lb = pr?.label || "idle · never";
              return `${tid}=${st}:${lb}`;
            })
            .join("|");
          return `<button type="button" class="tl-avatar" style="left:${p.pct.toFixed(2)}%; --actor-hue: ${p.hue}" data-actor="${escapeHtml(p.actor)}" data-branch="${escapeHtml(lane.name)}" data-tools="${escapeHtml(tools)}" data-tool-presence="${escapeHtml(toolPresenceBits)}" data-presence="${presenceState}" data-presence-label="${escapeHtml(presenceLabel)}" data-posts="${p.postCount}" data-diffs="${p.diffCount}" data-last-at="${escapeHtml(p.lastAt || "")}" data-last-post="${escapeHtml(lastPost)}" data-commit="${escapeHtml(lane.isCurrent && model.head ? model.head : "")}" data-verify="${verify}" aria-label="${escapeHtml(aria)}"><span class="tl-avatar-initials" aria-hidden="true">${escapeHtml(p.initials)}</span><span class="tl-presence" data-presence="${presenceState}" aria-hidden="true"></span>${p.verified ? '<span class="tl-verify" data-verify="verified">✓</span>' : ""}</button>`;
        })
        .join("\n        ");
      const empty =
        !lane.people.length
          ? `<span class="tl-lane-empty">no posters yet</span>`
          : "";
      return `<div class="tl-lane"${mainAttr}${curAttr} style="--branch-hue: ${lane.hue}" data-branch="${escapeHtml(lane.name)}">
  <div class="tl-lane-label" title="${escapeHtml(lane.name)}">
    <span class="branch-swatch" aria-hidden="true"></span>
    <span class="tl-lane-name">${escapeHtml(shortBranch(lane.name, 22))}${lane.isMain ? ' <span class="branch-badge">default</span>' : ""}</span>
    <span class="tl-lane-meta">${lane.eventCount} post${lane.eventCount === 1 ? "" : "s"}</span>
  </div>
  <div class="tl-lane-track" role="group" aria-label="${escapeHtml(lane.name)} lane">
    <div class="tl-rail" aria-hidden="true"></div>
    ${avatars}
    ${empty}
  </div>
</div>`;
    })
    .join("\n");

  const unk =
    model.unknownCount > 0
      ? `<p class="timeline-unknown">${model.unknownCount} older post${model.unknownCount === 1 ? "" : "s"} without a branch stamp are omitted from lanes.</p>`
      : "";

  const t0 = escapeHtml(formatWhen(new Date(model.tMin).toISOString()));
  const t1 = escapeHtml(formatWhen(new Date(model.tMax).toISOString()));

  return `<section class="timeline" data-timeline="1" aria-label="branch timeline">
  <div class="timeline-head">
    <h2 class="timeline-heading">Timeline</h2>
    <p class="timeline-note">Branches flow left→right in time. Initials float on the lane of their last room post. Hover for agent icons (Cursor / Claude Code / Codex / MCP / CLI / git-hook) with green/gray active·idle dots (from .room posts within the active window), post·diff counts on that branch, last activity, and local HEAD when known. ${headBit}</p>
  </div>
  <div class="timeline-scroll">
    <div class="timeline-canvas">
      <div class="tl-axis" aria-hidden="true">
        <span>${t0}</span>
        <span class="tl-axis-mid">time →</span>
        <span>${t1}</span>
      </div>
${renderBranchGraph(model)}
      <div class="tl-lanes">
${lanesHtml}
      </div>
    </div>
  </div>
  ${unk}
  <div class="tl-tooltip" id="tl-tooltip" role="tooltip" hidden></div>
</section>`;
}

export async function writeBoard(boardPath, meta, events, opts = {}) {
  let template = await readFile(TEMPLATE, "utf8");
  const projectDir = opts.projectDir || process.cwd();
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const windowMs = opts.windowMs != null ? Number(opts.windowMs) : resolveActiveMs();
  const presenceOpts = { now, windowMs };
  const git = await readGitSnapshot(projectDir);
  const { actors } = posterStats(events);
  // Non-system actors only — empty/system-only rooms show 0, not a fake "1 poster"
  const distinctPosters = actors.size;
  const postersLabel = String(distinctPosters);
  const postersBlurb =
    distinctPosters === 0
      ? "No posts yet — join from another tool or machine with the room code."
      : distinctPosters === 1
        ? "1 poster on this board."
        : `${distinctPosters} posters on this board.`;

  const posterNames = [...actors.keys()];
  const agentsStrip = renderAgentsStrip(events, presenceOpts);
  let posterStrip = "";
  if (distinctPosters >= 2) {
    posterStrip = `<div class="tools-strip" aria-label="posters">${posterNames
      .map((n) => {
        const info = actors.get(n);
        const v = renderPosterVerifyChip(info);
        const chip = v ? `${escapeHtml(n)} ${v}` : escapeHtml(n);
        return `<span class="tool-chip">${chip}</span>`;
      })
      .join('<span class="dot-sep">·</span>')}</div>`;
  } else if (distinctPosters === 1) {
    const n = posterNames[0];
    const info = actors.get(n);
    const v = renderPosterVerifyChip(info);
    const chip = v ? `${escapeHtml(n)} ${v}` : escapeHtml(n);
    posterStrip = `<div class="tools-strip" aria-label="posters"><span class="tool-chip">${chip}</span></div>`;
  }
  const strip = `${agentsStrip}${posterStrip}`;

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
    "{{TIMELINE}}": renderTimeline(events, git, presenceOpts),
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
