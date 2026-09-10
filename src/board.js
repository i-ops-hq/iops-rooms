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

/**
 * Is this THE default branch?
 *
 * `git` carries the answer — `defaultBranch` comes from `origin/HEAD` and falls back to whichever
 * of main/master/trunk/develop the repo actually has. Matching `/^(main|master)$/` instead put a
 * "default" badge on both of them in a repo part-way through a rename, and a page that names two
 * defaults has told the reader it does not know which.
 *
 * The name test is only the fallback for callers with no snapshot to hand.
 */
function isMainBranch(name, git) {
  const n = String(name || "");
  if (git && git.defaultBranch) return n === git.defaultBranch;
  return /^(main|master)$/i.test(n);
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

function renderEvents(events, git) {
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
      const mainAttr = isMainBranch(ev.branch, git) ? ' data-main="1"' : "";
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

export function renderBranchPanel(git, events, history) {
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
  // What git knows about each branch, so a row can say whether anything is still on it rather than
  // only whether anyone posted about it. Most branches in a long-lived repo are merged and finished.
  const fromGit = new Map();
  for (const b of history?.branches || []) fromGit.set(b.name, b);

  const row = (name) => {
    const info =
      byBranch.get(name) ||
      { count: 0, actors: new Set(), devices: new Set(), lastAt: "", lastActor: "" };
    const g = fromGit.get(name);
    const actors = [...info.actors].join(", ") || "—";
    const devices = [...info.devices].map((d) => shortDevice(d)).filter(Boolean).join(", ");
    const who = devices ? `${actors} · devices ${devices}` : actors;
    const current = name === git.current ? ' data-current="1"' : "";
    const isDefault = isMainBranch(name, git);
    const mainAttr = isDefault ? ' data-main="1"' : "";
    const hue = branchHue(name);
    // Three different things were all being called "0 posts": a branch that merged, a ref that
    // still exists with nothing unique on it, and a name that was only ever a post stamp.
    const trunkLabel = escapeHtml(shortBranch(git.defaultBranch || "the default branch", 18));
    const state = g
      ? g.open
        ? `${g.commits.length} commit${g.commits.length === 1 ? "" : "s"} not on ${trunkLabel}`
        : `merged${g.pr ? ` in #${g.pr}` : ""}`
      : isDefault
        ? "the default branch"
        : (git.branches || []).includes(name)
          ? `nothing on it that ${trunkLabel} does not have`
          : "not a branch in this checkout";
    const posts = info.count
      ? `${info.count} post${info.count === 1 ? "" : "s"} · ${escapeHtml(who)}`
      : "no room posts";
    const last = info.lastAt
      ? `${escapeHtml(info.lastActor || "?")} · ${escapeHtml(formatWhen(info.lastAt))}`
      : "";
    return `<div class="branch-row"${current}${mainAttr} style="--branch-hue: ${hue}">
  <span class="branch-swatch" aria-hidden="true"></span>
  <span class="branch-name" title="${escapeHtml(name)}">${escapeHtml(shortBranch(name, 28))}${isDefault ? ' <span class="branch-badge">default</span>' : ""}${name === git.current && !isDefault ? ' <span class="branch-badge">checked out</span>' : ""}</span>
  <span class="branch-meta">${state} · ${posts}</span>
  <span class="branch-last">${last}</span>
</div>`;
  };

  // A branch is worth a row of its own if something is still happening on it: the default, the one
  // you have checked out, anything with commits the default does not have, or anything anyone posted
  // about. Everything else is finished work, and twenty finished rows above the graph is why the
  // page was hard to read — they are one line and a disclosure instead.
  const isLive = (name) =>
    isMainBranch(name, git) ||
    name === git.current ||
    (byBranch.get(name)?.count || 0) > 0 ||
    Boolean(fromGit.get(name)?.open);
  const live = named.filter(isLive);
  const done = named.filter((n) => !isLive(n));
  const rows = live.map(row).join("\n");
  const doneBlock = done.length
    ? `<details class="branch-history"><summary>${done.length} finished branch${done.length === 1 ? "" : "es"} — merged or empty, with no room posts</summary>
  <div class="branch-list">${done.map(row).join("\n")}</div>
</details>`
    : "";
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
  <p class="branch-legend"><span class="branch-swatch branch-swatch-main" aria-hidden="true"></span> green rail = the default branch</p>
  <div class="branch-list">${rows}</div>
  ${doneBlock}
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
/**
 * Geometry for the branch graph.
 *
 * `edge` is the room kept beyond the outermost lane, so a branch name has somewhere to sit.
 * `shown` is how many branches are visible before the reader opens the rest — six, because main
 * plus three lanes either side is what stays readable at a glance and still fits a screenshot.
 */
const GRAPH = { w: 1000, maxW: 7200, perCommit: 13, pad: 26, edge: 30, gap: 34, shown: 6, r: 3.4, glow: 8 };

/**
 * Branches alternate below main, above main, further below, further above.
 *
 * Stacking every branch downward made main the ceiling of the picture and pushed the oldest branch
 * furthest from it. Alternating puts main in the middle where a trunk belongs, keeps the busiest
 * branches nearest it, and halves how far the graph runs before it needs scrolling.
 */
function laneOffset(i) {
  const step = Math.floor(i / 2) + 1;
  return i % 2 === 0 ? step : -step;
}

/**
 * A branch leaves main, runs its own line, and rejoins.
 *
 * Curves rather than right angles, which is a reversal of the runtime-diagram treatment and for a
 * reason: that diagram's boxes are far apart and its connectors are wide, so square corners read as
 * a circuit. A branch here can be two commits inside three hundred — narrow and, if it sits on an
 * outer lane, tall. A square staple at that aspect ratio is a spike; the same shape as a curve is
 * a legible arc off the trunk.
 */
function branchPath(x1, x2, yMain, yLane) {
  const span = Math.max(0, x2 - x1);
  const third = span / 3;
  const k = Math.min(52, Math.max(7, third));
  const xa = x1 + third;
  const xb = x2 - third;
  return (
    `M${x1} ${yMain}` +
    ` C${(x1 + k).toFixed(1)} ${yMain} ${(xa - k).toFixed(1)} ${yLane} ${xa.toFixed(1)} ${yLane}` +
    ` L${xb.toFixed(1)} ${yLane}` +
    ` C${(xb + k).toFixed(1)} ${yLane} ${(x2 - k).toFixed(1)} ${yMain} ${x2} ${yMain}`
  );
}

/**
 * A branch name, in a chip on its own wire.
 *
 * Drawn as a rect plus text rather than plain text: with lanes above and below main, a name will
 * sooner or later land on top of another branch's line, and bare 11px type over a wire is unreadable.
 * The chip is the card colour, so it knocks the wire out behind the name.
 */
function graphLabel(x, y, text, anchor = "start", extra = "") {
  const w = Math.max(20, text.length * 6.2 + 10);
  const rx = anchor === "end" ? x - w : x;
  return (
    `<rect class="bg-tag" x="${rx.toFixed(1)}" y="${(y - 9.5).toFixed(1)}" width="${w.toFixed(1)}" height="13" rx="3"></rect>` +
    `<text class="bg-label${extra ? ` ${extra}` : ""}" x="${(rx + 5).toFixed(1)}" y="${y}">${escapeHtml(text)}</text>`
  );
}

/** One commit: a soft halo plus a solid core. Two circles rather than an SVG blur filter — same
 *  look, no filter cost, and it still reads when the page is printed. */
function graphDot(x, y, pt, hue) {
  const kind =
    pt.type === "commit" || pt.type === "merge"
      ? pt.type
      : pt.isDiff
        ? "diff"
        : pt.type === "approved"
          ? "approved"
          : pt.type === "review_requested"
            ? "review"
            : "note";
  const when = formatWhen(pt.at);
  // A commit says who made it, which agent helped, and what it moved. "no agent recorded" is the
  // honest label for a plain commit — it is the person's own work, not an unknown.
  const tip =
    kind === "commit" || kind === "merge"
      ? `${pt.sha ? `${pt.sha} · ` : ""}${pt.actor}` +
        ` · ${pt.agent || "no agent recorded"}` +
        `${kind === "merge" ? " · merge" : ` · +${pt.ins || 0} −${pt.del || 0}`}` +
        `${when ? ` · ${when}` : ""}${pt.text ? `\n${pt.text}` : ""}`
      : `${pt.actor}${pt.tool ? ` · ${pt.tool}` : ""} · ${kind}${when ? ` · ${when}` : ""}${pt.text ? `\n${pt.text}` : ""}`;
  return (
    // data-agent colours a COMMIT by the agent that made it. A room post's tool (cli, mcp) is a
    // different fact and must not borrow the agent palette.
    `<g class="bg-dot" data-kind="${escapeHtml(kind)}"${
      (kind === "commit" || kind === "merge") && pt.tool ? ` data-agent="${escapeHtml(pt.tool)}"` : ""
    } style="--h: ${hue}">` +
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
/**
 * Fold git history into the graph's lane shape, so commits and room posts sit on one picture.
 *
 * Room posts say what someone TOLD the room; commits say what actually landed. Both are events on
 * a branch at a time, so they share lanes and a time axis — but they keep their own dot kind, and a
 * lane made only of commits is still drawn, because most projects have far more commits than posts.
 *
 * The axis spans BOTH sources. Using the room's own tMin would squash a year of commits into
 * whatever window the room happens to cover.
 */
export function mergeHistoryIntoLanes(model, history) {
  if (!history || !history.ok) return model;

  const commitPoint = (c) => ({
    t: c.t,
    at: c.at,
    actor: c.author.name,
    tool: c.agents[0]?.id || "",
    type: c.isMerge ? "merge" : "commit",
    isDiff: false,
    agent: c.agents[0]?.label || "",
    sha: c.shortSha,
    text: c.subject,
    ins: c.insertions,
    del: c.deletions,
  });

  const gitLanes = new Map();
  const trunkName = model.current && history.branches.every((b) => b.name !== model.current)
    ? model.current
    : "main";
  gitLanes.set(trunkName, { name: trunkName, isMain: true, points: history.trunk.map(commitPoint) });
  for (const b of history.branches) {
    const existing = gitLanes.get(b.name);
    const pts = b.commits.map(commitPoint);
    if (existing) existing.points.push(...pts);
    else gitLanes.set(b.name, { name: b.name, isMain: false, pr: b.pr, points: pts });
  }

  // One axis over everything, so a commit from March and a post from today are placed honestly.
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const lane of gitLanes.values()) {
    for (const pt of lane.points) {
      if (pt.t == null) continue;
      if (pt.t < tMin) tMin = pt.t;
      if (pt.t > tMax) tMax = pt.t;
    }
  }
  for (const lane of model.lanes || []) {
    for (const pt of lane.points || []) {
      if (pt.t == null) continue;
      if (pt.t < tMin) tMin = pt.t;
      if (pt.t > tMax) tMax = pt.t;
    }
  }
  if (!(tMax > tMin)) {
    tMin = Number.isFinite(model.tMin) ? model.tMin : tMin;
    tMax = Number.isFinite(model.tMax) ? model.tMax : tMax;
  }
  const span = tMax - tMin;
  const place = (pt) => ({
    ...pt,
    pct: pt.t == null || !(span > 0) ? 50 : Math.max(1, Math.min(99, ((pt.t - tMin) / span) * 100)),
  });

  const merged = new Map();
  for (const lane of gitLanes.values()) {
    merged.set(lane.name, {
      name: lane.name,
      isMain: lane.isMain,
      isCurrent: lane.name === model.current,
      pr: lane.pr || null,
      eventCount: lane.points.length,
      tools: [],
      people: [],
      points: lane.points.map(place),
      hue: branchHue(lane.name),
    });
  }
  for (const lane of model.lanes || []) {
    const into = merged.get(lane.name);
    const pts = (lane.points || []).map(place);
    if (into) {
      into.points = [...into.points, ...pts].sort((a, b) => a.pct - b.pct);
      into.eventCount += pts.length;
      into.people = lane.people;
    } else {
      merged.set(lane.name, { ...lane, points: pts, people: lane.people });
    }
  }

  const lanes = [...merged.values()].map((l) => ({
    ...l,
    points: l.points.sort((a, b) => a.pct - b.pct),
    firstPct: l.points.length ? l.points[0].pct : null,
    lastPct: l.points.length ? l.points[l.points.length - 1].pct : null,
  }));

  return { ...model, lanes, tMin, tMax, fromHistory: true, historyTotal: history.total };
}

/**
 * Where each event sits on the horizontal axis.
 *
 * By ORDER, not by elapsed time. A branch that lived forty minutes inside a repo spanning two
 * months is 0.1% of a time axis — drawn to scale it is a vertical spike, not a branch, and
 * seventeen of them are a comb. Ordering gives every commit the same width, which is what
 * `git log --graph` does and what makes a branch look like a branch.
 *
 * The cost is that a quiet month and a busy hour take the same space. The axis says so, and the
 * real timestamp is still on every dot's tooltip and at both ends of the axis.
 */
function rankAxis(lanes) {
  const times = new Set();
  for (const lane of lanes) {
    for (const pt of lane.points || []) if (pt.t != null) times.add(pt.t);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const rank = new Map(sorted.map((t, i) => [t, i]));
  const steps = Math.max(1, sorted.length - 1);
  const w = Math.max(
    GRAPH.w,
    Math.min(GRAPH.maxW, sorted.length * GRAPH.perCommit + GRAPH.pad * 2),
  );
  const span = w - GRAPH.pad * 2;
  return {
    w,
    count: sorted.length,
    // A point with no timestamp cannot be ordered, so it sits in the middle rather than at an end.
    of: (pt) => (pt.t == null ? GRAPH.pad + span / 2 : GRAPH.pad + (rank.get(pt.t) / steps) * span),
    // A branch leaves main one commit before its first and rejoins one after its last — which is
    // where it actually forked and merged, and guarantees even a one-commit branch has a body.
    at: (i) => GRAPH.pad + (Math.max(0, Math.min(steps, i)) / steps) * span,
    rankOf: (pt) => (pt.t == null ? steps / 2 : rank.get(pt.t)),
  };
}

export function renderBranchGraph(model) {
  const withPosts = (model.lanes || []).filter((l) => (l.points || []).length > 0);
  if (!withPosts.length) return "";

  const main = withPosts.find((l) => l.isMain) || null;
  const others = withPosts.filter((l) => l !== main);
  const axis = rankAxis(withPosts);

  // Every branch is drawn. The ones past `shown` sit outside the collapsed crop rather than being
  // left out of the picture — a branch the reader cannot reach is a branch they do not know about.
  const reach = Math.ceil(others.length / 2);
  const half = reach * GRAPH.gap + GRAPH.edge;
  const yMain = half;
  const fullH = half * 2;
  const openH = (Math.min(reach, GRAPH.shown / 2) * GRAPH.gap + GRAPH.edge) * 2;
  const hidden = Math.max(0, others.length - GRAPH.shown);

  const mainRail =
    `<g class="bg-branch" data-main="1" style="--h: ${main ? main.hue : 150}">` +
    `<path class="bg-track" d="M${GRAPH.pad} ${yMain} L${axis.w - GRAPH.pad} ${yMain}"></path>` +
    `<path class="bg-pulse" d="M${GRAPH.pad} ${yMain} L${axis.w - GRAPH.pad} ${yMain}"></path>` +
    `</g>`;

  const branches = others
    .map((lane, i) => {
      const dir = laneOffset(i);
      const yLane = yMain + dir * GRAPH.gap;
      const ranks = lane.points.map((pt) => axis.rankOf(pt));
      const x1 = axis.at(Math.min(...ranks) - 1);
      const x2 = axis.at(Math.max(...ranks) + 1);
      const d = branchPath(x1, x2, yMain, yLane);
      const cur = lane.isCurrent ? ' data-current="1"' : "";
      // The name goes on the branch's own wire, on the far side from main, so it never sits in the
      // gap between two lines and belongs to neither.
      const name = shortBranch(lane.name, 26);
      const nearRight = x1 > axis.w - 240;
      const label = graphLabel(
        nearRight ? x2 - 2 : x1 + 2,
        dir > 0 ? yLane + 16 : yLane - 8,
        name,
        nearRight ? "end" : "start",
      );
      return (
        `<g class="bg-branch"${cur} data-lane="${i}"${i >= GRAPH.shown ? ' data-extra="1"' : ""}` +
        ` style="--h: ${lane.hue}; --delay: ${((i % 6) * 0.5).toFixed(2)}s">` +
        `<title>${escapeHtml(lane.name)} · ${lane.eventCount} post${lane.eventCount === 1 ? "" : "s"}</title>` +
        `<path class="bg-track" d="${d}"></path>` +
        `<path class="bg-pulse" d="${d}"></path>` +
        label +
        lane.points.map((pt) => graphDot(axis.of(pt), yLane, pt, lane.hue)).join("") +
        `</g>`
      );
    })
    .join("");

  const mainDots = main
    ? `<g class="bg-branch" data-main="1" style="--h: ${main.hue}">` +
      graphLabel(axis.w - GRAPH.pad, yMain - 11, shortBranch(main.name, 26), "end", "bg-label-main") +
      main.points.map((pt) => graphDot(axis.of(pt), yMain, pt, main.hue)).join("") +
      `</g>`
    : "";

  // Collapsed, the SVG is cropped to `openH` around main — which is why main sits at the centre of
  // the viewBox and lanes fan out from it. The checkbox swaps the height to the full drawing, so
  // the reveal is CSS only and the board keeps working as a file with no server behind it.
  const toggle =
    hidden > 0
      ? `<label class="bg-expand" for="bg-toggle">` +
        `<span class="bg-expand-open">+ ${hidden} more branch${hidden === 1 ? "" : "es"}</span>` +
        `<span class="bg-expand-close">− show the ${GRAPH.shown} closest to main</span>` +
        `</label>`
      : "";

  const svg = `<svg viewBox="0 0 ${axis.w} ${fullH}" preserveAspectRatio="xMidYMid slice" role="img"
       style="--vb-w: ${axis.w}px; --vb-open: ${openH}px; --vb-full: ${fullH}px"
       aria-label="Branch graph: ${withPosts.length} branch${withPosts.length === 1 ? "" : "es"} in commit order, one dot per commit or post">
    ${mainRail}
    ${branches}
    ${mainDots}
  </svg>`;

  // Input first so `~` can reach both the svg it resizes and the label it relabels; the label sits
  // after the svg so the control reads under the picture it opens.
  // The slider is the answer to "the graph is wider than the window and nothing says so". A native
  // scrollbar on macOS is an overlay: invisible until you already knew to scroll, which is exactly
  // the wrong way round. The range input is always visible, is a control people recognise, and
  // works from the keyboard. It hides itself when the graph fits.
  const slider = `<input type="range" class="bg-slider" min="0" max="1000" value="1000" step="1"
       aria-label="Scroll the branch graph through history" hidden>`;

  return `<figure class="branch-graph" data-graph-width="${axis.w}">
  <input type="checkbox" class="bg-toggle" id="bg-toggle" hidden>
  <div class="bg-scroll">
    ${svg}
  </div>
  ${slider}
  ${toggle}
</figure>`;
}

/** Compact +/- pair. Line counts get large fast, and a wall of digits stops being readable. */
function shortNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

/**
 * Who built this project, read from git history rather than from room posts.
 *
 * The agent split comes from `Co-Authored-By` trailers, which Claude Code and Cursor already write
 * — so a repo has this history before it ever hears of Rooms. A commit with no trailer is shown as
 * the person's own, not as an unknown.
 */
export function renderBuiltBy(history) {
  if (!history || !history.ok || !history.contributors?.length) return "";
  const { agents } = history.agents;
  const plain = Number(history.agents.plain) || 0;
  const coauthored = Number(history.agents.coauthored) || 0;
  const totalShown = history.trunk.length + history.branches.reduce((n, b) => n + b.commits.length, 0);

  const agentChips = agents
    .map(
      (a) =>
        `<span class="bb-agent" data-family="${escapeHtml(a.id)}"><span class="bb-swatch" aria-hidden="true"></span>${escapeHtml(a.label)} <b>${a.commits}</b><span class="bb-lines">+${shortNum(a.insertions)} −${shortNum(a.deletions)}</span></span>`,
    )
    .join("");
  // A trailer no family recognises is its own chip. Folding it into "no agent recorded" would
  // say the commit was the person's own while the commit itself names a co-author.
  const coauthorChip = coauthored
    ? `<span class="bb-agent" data-family="coauthor"><span class="bb-swatch" aria-hidden="true"></span>co-author, not a known agent <b>${coauthored}</b></span>`
    : "";
  const plainChip = plain
    ? `<span class="bb-agent" data-family="human"><span class="bb-swatch" aria-hidden="true"></span>no agent recorded <b>${plain}</b></span>`
    : "";

  const people = history.contributors
    .map((p) => {
      const agentBits = p.agents.length
        ? p.agents
            .map((a) => `<span class="bb-mini" data-family="${escapeHtml(a.id)}">${escapeHtml(a.label)} ${a.commits}</span>`)
            .join("")
        : `<span class="bb-mini" data-family="human">no agent recorded</span>`;
      const top = p.topAgent
        ? `${escapeHtml(p.topAgent.label)} on ${p.topAgentPct}% of their attributed commits`
        : "no agent recorded on any commit";
      return `<li class="bb-person">
  <div class="bb-who">
    <span class="bb-name">${escapeHtml(p.name)}</span>
    <span class="bb-email">${escapeHtml(p.email)}</span>
  </div>
  <div class="bb-stats">
    <span><b>${p.commits - p.merges}</b> commits</span>
    ${p.merges ? `<span title="git records no line changes for a merge">${p.merges} merge${p.merges === 1 ? "" : "s"}</span>` : ""}
    <span class="bb-ins">+${shortNum(p.insertions)}</span>
    <span class="bb-del">−${shortNum(p.deletions)}</span>
    <span>${p.files} file touches</span>
  </div>
  <div class="bb-agents" title="${escapeHtml(top)}">${agentBits}</div>
</li>`;
    })
    .join("");

  // Two addresses under one name are usually one person and sometimes are not. Flagged, never
  // merged on a guess — .mailmap is git's own answer and the reader is the one who should write it.
  const split = (history.splitIdentities || [])
    .map(
      (s) =>
        `<p class="bb-warn"><strong>${escapeHtml(s.name)}</strong> commits under ${s.emails.length} addresses — ${s.emails.map((e) => `<code>${escapeHtml(e)}</code>`).join(" and ")}. They are listed separately. A <code>.mailmap</code> merges them; guessing could merge two different people.</p>`,
    )
    .join("");

  const truncated = history.truncated
    ? `<p class="bb-note">Reading the newest ${totalShown} of ${history.total} commits. The rest are not counted in these figures.</p>`
    : "";

  return `<section class="built-by" aria-label="who built this project">
  <h2 class="bb-heading">Built by</h2>
  <p class="bb-note">From <strong>${history.total}</strong> commit${history.total === 1 ? "" : "s"} of git history — attribution comes from <code>Co-Authored-By</code> trailers the agents write themselves. Nothing is read from Cursor's or Claude's private state.</p>
  <div class="bb-agent-row">${agentChips}${coauthorChip}${plainChip}</div>
  <ul class="bb-people">${people}</ul>
  ${split}
  ${truncated}
</section>`;
}

/** "3d", "5w", "just now" — a duration short enough to be the value on a card. */
export function shortSince(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = ms / 60_000;
  if (min < 2) return "just now";
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h`;
  const day = hr / 24;
  if (day < 14) return `${Math.round(day)}d`;
  if (day < 60) return `${Math.round(day / 7)}w`;
  if (day < 365) return `${Math.round(day / 30)}mo`;
  return `${(day / 365).toFixed(day < 730 ? 1 : 0)}y`;
}

/** Cut to a word boundary and mark it, so a clipped sentence does not look like the whole one. */
function clip(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function factCard({ value, label, detail }) {
  return (
    `<div class="fact">` +
    `<b>${escapeHtml(String(value))}</b>` +
    `<span>${escapeHtml(label)}</span>` +
    (detail ? `<em>${escapeHtml(detail)}</em>` : "") +
    `</div>`
  );
}

/**
 * The five numbers worth putting at the top of a project's board.
 *
 * The cards used to be facts about the TOOL: how many "posters", whether the network was off, that
 * state lives in `.room`. None of that is why someone opens a board. They want to know about the
 * PROJECT — how much work is in it, who did it, how much of it an agent helped with, how many
 * lines of work are open, and whether any of it is recent. Every one of those comes from git
 * history the repo already has, so the cards are full on a board's first run.
 *
 * Without git there is nothing to say about a project, so the room's own numbers stand in, labelled
 * for what they are rather than dressed up as project figures.
 */
export function renderHeroFacts(history, events, git, now = Date.now()) {
  const nonSystem = (events || []).filter((e) => e && e.type !== "system");
  const lastPost = nonSystem.reduce((max, e) => (e.at > max ? e.at : max), "");

  if (!history || !history.ok || !history.contributors?.length) {
    const posters = new Set(nonSystem.map((e) => e.actor || "unknown")).size;
    const t = parseAt(lastPost);
    return (
      `<div class="facts" data-source="room">` +
      factCard({ value: posters, label: "posters", detail: "people and agents in this room" }) +
      factCard({ value: nonSystem.length, label: "posts", detail: "notes and diffs on the board" }) +
      factCard({
        value: t == null ? "—" : shortSince(now - t),
        label: "since the last post",
        detail: t == null ? "nothing posted yet" : formatWhen(lastPost),
      }) +
      factCard({
        value: git?.ok ? shortBranch(git.current || "—", 16) : "no git",
        label: git?.ok ? "branch" : "history",
        detail: git?.ok
          ? "the checkout this board was written from"
          : "run git init here and the board fills in",
      }) +
      `</div>`
    );
  }

  const commits = [...history.trunk, ...history.branches.flatMap((b) => b.commits)];
  const times = commits.map((c) => c.t).filter((t) => t != null);
  const newest = times.length ? Math.max(...times) : null;
  const oldest = times.length ? Math.min(...times) : null;
  const lastCommit = commits.find((c) => c.t === newest);

  const { agents } = history.agents;
  // Every commit lands in exactly one of the three, so this is the commit count and the
  // denominator stays whole. It was attributed + plain, which stopped covering all of them the
  // day co-authored-but-not-an-agent became its own bucket.
  //
  // Each term is coerced because one missing field must not turn the denominator into NaN: that
  // renders as "none agent-assisted", which is a false claim about the repo rather than a gap in
  // the page. Zero is the honest reading of an absent count.
  const attributed = Number(history.agents.attributed) || 0;
  const coauthored = Number(history.agents.coauthored) || 0;
  const plain = Number(history.agents.plain) || 0;
  const seen = attributed + coauthored + plain;
  const pct = seen > 0 ? Math.round((attributed / seen) * 100) : 0;

  const open = history.branches.filter((b) => b.open).length;
  const merged = history.branches.length - open;

  const top = history.contributors[0];
  const trunkName = shortBranch(git?.current || "main", 18);
  const postT = parseAt(lastPost);
  // The freshest thing that happened, from either source — a room post counts as activity.
  const freshest = Math.max(newest ?? -Infinity, postT ?? -Infinity);

  return (
    `<div class="facts" data-source="git">` +
    factCard({
      value: history.total,
      label: history.total === 1 ? "commit" : "commits",
      detail:
        oldest != null && newest != null && newest > oldest
          ? `first one ${shortSince(now - oldest)} ago`
          : "in this checkout",
    }) +
    factCard({
      value: history.contributors.length,
      label: history.contributors.length === 1 ? "person" : "people",
      detail: top ? `most by ${clip(top.name, 22)} (${top.commits})` : "",
    }) +
    factCard({
      value: pct ? `${pct}%` : "none",
      label: "agent-assisted",
      // The number this tool exists to produce. It is a floor, not a measurement: an agent that
      // writes no trailer leaves no trace, so the true share can only be higher.
      detail: agents.length
        ? `${agents.slice(0, 2).map((a) => a.label).join(" · ")}${agents.length > 2 ? ` +${agents.length - 2}` : ""}`
        : "no Co-Authored-By trailers in this history",
    }) +
    factCard({
      value: history.branches.length,
      label: history.branches.length === 1 ? "branch" : "branches",
      // Beside the trunk, not including it — "13 branches, all 12 merged in" was two counts of two
      // different things sitting next to each other.
      detail: open
        ? `beside ${trunkName}, ${open} still open`
        : merged
          ? `all merged into ${trunkName}`
          : "everything landed on one line",
    }) +
    factCard({
      value: Number.isFinite(freshest) ? shortSince(now - freshest) : "—",
      label: "since the last change",
      // The name, not the subject: the subject is on the dot in the graph, and at this width it
      // wraps to four lines and stretches every card in the row to match.
      detail: lastCommit ? `${clip(lastCommit.author.name, 24)} on ${trunkName}` : "",
    }) +
    `</div>`
  );
}

/** ✓ / ! / — as one small marked span, so the three states read without reading the words. */
function sideFlag(state, text) {
  return `<span class="side-flag" data-state="${escapeHtml(state)}">${escapeHtml(text)}</span>`;
}

/**
 * Who you are and what this checkout is connected to.
 *
 * Both were missing from the board, and their absence read as a pending state: the page talked
 * about verified identity and about branches without ever saying whether THIS machine had either.
 * Neither panel goes looking for anything — `auth` is passed in by the caller that already loaded
 * it, so opening a board cannot mint an identity as a side effect, and the git side is the snapshot
 * already read for the branch panel.
 */
export function renderHeroSide({ git, auth, meta } = {}) {
  const name = auth?.displayName || meta?.createdBy || "you";
  const login = auth?.github?.login || auth?.gitlab?.username || "";
  const host = auth?.github?.login ? "github.com" : auth?.gitlab?.username ? "gitlab.com" : "";

  const you =
    `<div class="side-card">` +
    `<span class="side-title">You</span>` +
    `<div class="side-who">` +
    `<span class="side-avatar" style="--actor-hue: ${actorHue(name)}" aria-hidden="true">${escapeHtml(initials(name))}</span>` +
    `<div class="side-who-text"><b>${escapeHtml(name)}</b>` +
    (login
      ? `<span class="side-sub">${escapeHtml(`${host}/${login}`)}</span>`
      : `<span class="side-sub">not linked to an account</span>`) +
    `</div></div>` +
    (auth
      ? (login
          ? auth.verifiedDeviceId && auth.deviceId && auth.verifiedDeviceId !== auth.deviceId
            ? sideFlag("warn", "linked on another device — re-run rooms auth github here")
            : sideFlag("ok", "verified — your posts carry it")
          : sideFlag("warn", "unverified — rooms auth github")) +
        (auth.actorOverride ? sideFlag("warn", "name set by ROOMS_ACTOR, so nothing can check it") : "") +
        sideFlag(
          auth.privateKeyPresent ? "ok" : "warn",
          auth.privateKeyPresent
            ? `signing as device ${String(auth.deviceId || "").slice(0, 8)}`
            : "no signing key on this device yet",
        )
      : sideFlag("none", "no identity loaded for this render")) +
    `</div>`;

  let gitCard;
  if (!git || !git.ok) {
    gitCard =
      `<div class="side-card">` +
      `<span class="side-title">Git</span>` +
      `<p class="side-repo">not a git checkout</p>` +
      sideFlag("none", "git init here and the history fills this board") +
      `</div>`;
  } else {
    const ab = [];
    if (git.ahead) ab.push(`${git.ahead} ahead`);
    if (git.behind) ab.push(`${git.behind} behind`);
    gitCard =
      `<div class="side-card">` +
      `<span class="side-title">Git</span>` +
      `<p class="side-repo">${escapeHtml(git.remote ? git.remote.label : "local repository")}</p>` +
      `<p class="side-branch"><b>${escapeHtml(shortBranch(git.current || "detached", 24))}</b>` +
      (git.head ? ` <code>${escapeHtml(git.head)}</code>` : "") +
      `</p>` +
      sideFlag(
        git.dirty ? "warn" : "ok",
        git.dirty ? `${git.dirty} uncommitted change${git.dirty === 1 ? "" : "s"}` : "working tree clean",
      ) +
      (git.upstream
        ? sideFlag(ab.length ? "warn" : "ok", ab.length ? `${ab.join(", ")} ${git.upstream}` : `in step with ${git.upstream}`)
        : sideFlag("none", git.remote ? "this branch tracks nothing yet" : "no remote configured")) +
      `</div>`;
  }

  return `<aside class="hero-side" aria-label="you and this checkout">${you}${gitCard}</aside>`;
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
    const am = isMainBranch(a, git) ? 0 : 1;
    const bm = isMainBranch(b, git) ? 0 : 1;
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
      isMain: isMainBranch(name, git),
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
  const model = mergeHistoryIntoLanes(buildTimelineModel(events, git, opts), opts.history);
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

  // Only branches somebody actually posted on. A lane per branch with "no posters yet" written
  // across it was a row of furniture for every branch in the repo — and it sat under a graph on a
  // commit-order axis while positioning its avatars by time, so the two never lined up and looked
  // like they were meant to. The graph is the picture; this says who is where.
  const withPeople = model.lanes.filter((l) => l.people.length > 0);
  const lanesHtml = withPeople
    .map((lane) => {
      const mainAttr = lane.isMain ? ' data-main="1"' : "";
      const curAttr = lane.isCurrent ? ' data-current="1"' : "";
      const avatars = lane.people
        .map((p) => {
          const tools = p.tools.length ? p.tools.join(",") : "cli";
          const lastPost = p.lastText ? `${p.lastType}: ${p.lastText}` : "no post text";
          // No title= on the button — a native browser tip would stack with .tl-tooltip.
          const aria = `${p.actor} on ${lane.name}`;
          const verify = posterVerifyKind(p);
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
          return `<button type="button" class="tl-avatar" style="--actor-hue: ${p.hue}" data-actor="${escapeHtml(p.actor)}" data-branch="${escapeHtml(lane.name)}" data-tools="${escapeHtml(tools)}" data-tool-presence="${escapeHtml(toolPresenceBits)}" data-presence="${presenceState}" data-presence-label="${escapeHtml(presenceLabel)}" data-posts="${p.postCount}" data-diffs="${p.diffCount}" data-last-at="${escapeHtml(p.lastAt || "")}" data-last-post="${escapeHtml(lastPost)}" data-commit="${escapeHtml(lane.isCurrent && model.head ? model.head : "")}" data-verify="${verify}" aria-label="${escapeHtml(aria)}"><span class="tl-avatar-initials" aria-hidden="true">${escapeHtml(p.initials)}</span><span class="tl-presence" data-presence="${presenceState}" aria-hidden="true"></span>${p.verified ? '<span class="tl-verify" data-verify="verified">✓</span>' : ""}</button>`;
        })
        .join("");
      return `<div class="tl-who"${mainAttr}${curAttr} style="--branch-hue: ${lane.hue}" data-branch="${escapeHtml(lane.name)}">
  <span class="branch-swatch" aria-hidden="true"></span>
  <span class="tl-who-name" title="${escapeHtml(lane.name)}">${escapeHtml(shortBranch(lane.name, 24))}${lane.isMain ? ' <span class="branch-badge">default</span>' : ""}</span>
  <span class="tl-who-meta">${lane.eventCount} post${lane.eventCount === 1 ? "" : "s"}</span>
  <span class="tl-who-avatars">${avatars}</span>
</div>`;
    })
    .join("\n");

  const quiet = model.lanes.length - withPeople.length;
  const quietLine = quiet > 0
    ? `<p class="tl-quiet">${quiet} other branch${quiet === 1 ? " is" : "es are"} on the graph with no room posts — their commits are still drawn.</p>`
    : "";

  const unk =
    model.unknownCount > 0
      ? `<p class="timeline-unknown">${model.unknownCount} older post${model.unknownCount === 1 ? "" : "s"} without a branch stamp are omitted from lanes.</p>`
      : "";

  const t0 = escapeHtml(formatWhen(new Date(model.tMin).toISOString()));
  const t1 = escapeHtml(formatWhen(new Date(model.tMax).toISOString()));

  return `<section class="timeline" data-timeline="1" aria-label="branch timeline">
  <div class="timeline-head">
    <h2 class="timeline-heading">Timeline</h2>
    <p class="timeline-note">Branches flow left→right in commit order — every commit takes the same step, so a quiet month and a busy hour are the same width and a short-lived branch is still readable. Real timestamps are on every dot and at both ends of the axis. Drag the bar under the graph to move through history. Hover for agent icons (Cursor / Claude Code / Codex / MCP / CLI / git-hook) with green/gray active·idle dots (from .room posts within the active window), post·diff counts on that branch, last activity, and local HEAD when known. ${headBit}</p>
  </div>
  <div class="tl-axis">
    <span class="tl-axis-mid">oldest <b>${t0}</b> → newest <b>${t1}</b> · one step per commit</span>
  </div>
${renderBranchGraph(model)}
  <div class="tl-who-list">
${lanesHtml}
  </div>
  ${quietLine}
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

  // The room's own state, on one line under the lead. It was five of the top cards, which pushed
  // every fact about the project below the fold; it is worth a sentence, not a quarter of the page.
  const roomLine = `${postersBlurb} Network ${networkLabel} — ${networkDetail}.`;
  const projectName = boardProjectName(meta, projectDir);
  const boardTitle = `Rooms · ${projectName}`;
  const replacements = {
    "{{TITLE}}": escapeHtml(boardTitle),
    "{{FACTS}}": renderHeroFacts(opts.history, events, git, now),
    "{{HERO_SIDE}}": renderHeroSide({ git, auth: opts.auth || null, meta }),
    "{{ROOM_LINE}}": escapeHtml(roomLine),
    "{{CODE}}": escapeHtml(meta.id || ""),
    "{{CREATED}}": escapeHtml(meta.createdAt || ""),
    "{{BY}}": escapeHtml(meta.createdBy || ""),
    "{{BRANCH_PANEL}}": renderBranchPanel(git, events, opts.history),
    "{{TIMELINE}}": renderTimeline(events, git, { ...presenceOpts, history: opts.history }),
    "{{BUILT_BY}}": renderBuiltBy(opts.history),
    "{{TOOLS_STRIP}}": strip,
    "{{EVENTS}}": renderEvents(events, git),
  };
  for (const [token, value] of Object.entries(replacements)) {
    template = template.replaceAll(token, value);
  }
  if (!template.includes("data-rooms-live")) {
    template = template.replace("</body>", `${LIVE_CLIENT_SNIPPET}\n</body>`);
  }
  await writeFile(boardPath, template, "utf8");
}
