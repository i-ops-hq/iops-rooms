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
    else gitLanes.set(b.name, { name: b.name, isMain: false, pr: b.pr, open: Boolean(b.open), mergedAt: b.mergedAt || "", points: pts });
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
      open: Boolean(lane.open),
      mergedAt: lane.mergedAt || "",
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

  return {
    ...model,
    lanes,
    tMin,
    tMax,
    fromHistory: true,
    historyTotal: history.total,
    historyTruncated: Boolean(history.truncated),
    historyBranchRefs: Number(history.branchRefs) || 0,
  };
}

/**
 * The timeline, drawn as rows: one per branch, its name in a column of its own, and every mark
 * placed on one time axis the reader can zoom.
 *
 * It replaced one wide SVG — main as a rail, branches as arcs above and below it, a dot per commit —
 * that stopped being readable at scale. On OpenHands, 8,269 commits, the rail carried 500 dots
 * thirteen pixels apart, twelve arcs crossed each other and main, the names were chips floating on
 * the wires and were cut off at the edges, and a commit was drawn at its branch's height even where
 * the arc had already turned back to main, so dots hung in empty space. Each change answers one:
 *
 * - **A row per branch, the name in its own column.** Nothing crosses anything, and a name is never
 *   clipped by the edge of the drawing or lost when the lane scrolls.
 * - **A busy lane is commits per day, stacked by agent,** not a dot per commit. Five hundred dots
 *   are a smear; sixty bars are a history, and the stack says which agent did the work.
 * - **Time, with a zoom, rather than commit order.** The old axis gave every commit one step, so a
 *   quiet month and a busy hour were the same width and "when" could not be read down the page. Its
 *   objection to time was that a forty-minute branch becomes a sliver on a two-year axis. The zoom
 *   answers that, and so does a history shorter than three days being drawn in hours.
 * - **Every row opens into the list of what is on it.** That list is also the version a keyboard or
 *   a screen reader can use: the picture decorates the facts, it is not the only copy of them.
 */
const LANES = { shown: 6, listCap: 100, dense: 40, barPx: 22 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The windows on offer. One longer than the history is not offered, because it would zoom nothing. */
const ZOOMS = [
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
  { id: "all", label: "All", days: 0 },
];

/** For a tooltip that says "Claude 9" rather than "claude 9". An unknown id is shown as itself. */
const FAMILY_NAMES = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  copilot: "Copilot",
  devin: "Devin",
  gemini: "Gemini",
  jules: "Jules",
  aider: "aider",
  amazonq: "Amazon Q",
  windsurf: "Windsurf",
};
const familyName = (id) => (id ? FAMILY_NAMES[id] || id : "no agent recorded");

const isCommit = (pt) => pt.type === "commit" || pt.type === "merge";
const fixed = (n) => Number(n.toFixed(5));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function postKind(pt) {
  if (pt.isDiff) return "diff";
  if (pt.type === "approved") return "approved";
  if (pt.type === "review_requested") return "review";
  return "note";
}

/** Dates in UTC, because days are bucketed in UTC. A label that disagreed with its own bar by a
 *  timezone would file a Monday's commits under Sunday. */
function fmtDay(t, { year = false } = {}) {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

function fmtHour(t) {
  return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}

/** What a mark says on hover: the sha, the person, the agent and what it moved — as it did before. */
function pointTip(pt) {
  const when = formatWhen(pt.at);
  if (isCommit(pt)) {
    return (
      `${pt.sha ? `${pt.sha} · ` : ""}${pt.actor}` +
      ` · ${pt.agent || "no agent recorded"}` +
      `${pt.type === "merge" ? " · merge" : ` · +${pt.ins || 0} −${pt.del || 0}`}` +
      `${when ? ` · ${when}` : ""}${pt.text ? `\n${pt.text}` : ""}`
    );
  }
  return (
    `${pt.actor}${pt.tool ? ` · ${pt.tool}` : ""} · ${postKind(pt)}` +
    `${when ? ` · ${when}` : ""}${pt.text ? `\n${pt.text}` : ""}`
  );
}

/**
 * One axis over every lane. Whole UTC days from the oldest mark to the end of the newest day, so a
 * day's bar has a width — except when the whole history is under three days. Days would pile every
 * commit onto one spot there, and so would whole hours: a first afternoon's commits all land in the
 * same one. A short history is drawn to its own extent instead, with a margin so no mark sits on the
 * edge, and busy stretches of it are bucketed by the hour.
 */
function laneAxis(lanes) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const lane of lanes) {
    for (const pt of lane.points) {
      if (pt.t == null) continue;
      if (pt.t < lo) lo = pt.t;
      if (pt.t > hi) hi = pt.t;
    }
    const merged = Date.parse(lane.mergedAt || "");
    if (Number.isFinite(merged) && merged > hi) hi = merged;
  }
  if (!Number.isFinite(lo)) return null;
  const short = hi - lo < 3 * DAY;
  const unit = short ? HOUR : DAY;
  const pad = Math.max(60_000, (hi - lo) * 0.06);
  const T0 = short ? lo - pad : Math.floor(lo / unit) * unit;
  const T1 = short ? hi + pad : (Math.floor(hi / unit) + 1) * unit;
  const span = T1 - T0;
  return { T0, T1, lo, hi, span, unit, x: (t) => fixed((t - T0) / span), w: (ms) => fixed(ms / span) };
}

function rangeText(axis, from) {
  if (axis.unit === HOUR) {
    // The data's own first and last moment, not the margin drawn around them.
    const sameDay = fmtDay(axis.lo) === fmtDay(axis.hi);
    if (sameDay && fmtHour(axis.lo) === fmtHour(axis.hi)) return `${fmtDay(axis.lo, { year: true })}, ${fmtHour(axis.lo)} UTC`;
    return `${fmtDay(axis.lo, { year: true })}, ${fmtHour(axis.lo)} – ${sameDay ? "" : `${fmtDay(axis.hi)}, `}${fmtHour(axis.hi)} UTC`;
  }
  // The start carries its year whenever it differs from the end's. "Mar 16 – Sep 18, 2026" over a
  // span that began in 2023 read as six months when it was three and a half years.
  const end = axis.T1 - DAY;
  const sameYear = new Date(from).getUTCFullYear() === new Date(end).getUTCFullYear();
  return `${fmtDay(from, { year: !sameYear })} – ${fmtDay(end, { year: true })}`;
}

/** Each window the reader can pick, with how many commits it leaves out, so the count is honest
 *  whichever is on screen. */
function laneZooms(axis, lanes) {
  const times = [];
  for (const lane of lanes) for (const pt of lane.points) if (pt.t != null && isCommit(pt)) times.push(pt.t);
  const days = axis.span / DAY;
  return ZOOMS.filter((z) => !z.days || z.days < days).map((z) => {
    const from = z.days ? axis.T1 - z.days * DAY : axis.T0;
    return {
      ...z,
      from,
      z0: z.days ? axis.x(from) : 0,
      outside: times.filter((t) => t < from).length,
      range: rangeText(axis, from),
    };
  });
}

/** Month ticks across the whole span, and weekly ones where the 30-day window can show them. */
function laneTicks(axis, zooms) {
  if (axis.unit === HOUR) return "";
  const ticks = [];
  const start = new Date(axis.T0);
  let m = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (start.getUTCDate() === 1 ? 0 : 1), 1);
  let first = true;
  while (m < axis.T1) {
    const d = new Date(m);
    const month = d.getUTCMonth();
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      ...(first || month === 0 ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
    ticks.push(
      `<span class="ln-tick" data-g="m"${month % 3 === 0 ? ' data-q="1"' : ""}${month === 0 ? ' data-y="1"' : ""} style="--x: ${axis.x(m)}">${escapeHtml(label)}</span>`,
    );
    first = false;
    m = Date.UTC(d.getUTCFullYear(), month + 1, 1);
  }
  // Weeks where the 30-day window can show them, or across the whole span when it is too short to
  // offer that window: twelve days of history otherwise had no dates on its axis at all.
  const short = zooms.find((z) => z.id === "30") || (axis.span <= 45 * DAY ? { from: axis.T0 } : null);
  if (short) {
    let w = Math.floor(short.from / DAY) * DAY;
    while (new Date(w).getUTCDay() !== 1) w += DAY;
    for (; w < axis.T1; w += 7 * DAY) {
      ticks.push(`<span class="ln-tick" data-g="w" style="--x: ${axis.x(w)}">${escapeHtml(fmtDay(w))}</span>`);
    }
  }
  return ticks.join("");
}

/** A busy lane: one bar per day (or hour), its height the commit count and its colours the agents. */
function laneBars(commits, axis) {
  const buckets = new Map();
  for (const c of commits) {
    const at = Math.floor(c.t / axis.unit) * axis.unit;
    const b = buckets.get(at) || { n: 0, by: new Map() };
    b.n += 1;
    const id = c.tool || "none";
    b.by.set(id, (b.by.get(id) || 0) + 1);
    buckets.set(at, b);
  }
  const most = Math.max(1, ...[...buckets.values()].map((b) => b.n));
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, b]) => {
      const h = Math.max(3, Math.round((b.n / most) * LANES.barPx));
      const parts = [...b.by.entries()].sort((a, b2) => b2[1] - a[1]);
      const when = axis.unit === HOUR ? `${fmtDay(at)} ${fmtHour(at)} UTC` : fmtDay(at, { year: true });
      const tip = `${when}: ${plural(b.n, "commit")} · ${parts.map(([id, n]) => `${familyName(id === "none" ? "" : id)} ${n}`).join(" · ")}`;
      const segs = parts.map(([id, n]) => `<i data-agent="${escapeHtml(id)}" style="flex: ${n}"></i>`).join("");
      return `<span class="ln-bar" style="--x: ${axis.x(at)}; --w: ${axis.w(axis.unit)}; --bh: ${h}px" title="${escapeHtml(tip)}">${segs}</span>`;
    })
    .join("");
}

/** The marks on one lane: bars when it is busy, otherwise its life as a line with a dot per commit. */
function laneMarks(lane, axis) {
  const commits = lane.points.filter((pt) => isCommit(pt) && pt.t != null);
  const posts = lane.points.filter((pt) => !isCommit(pt) && pt.t != null);
  const merged = Date.parse(lane.mergedAt || "");
  const out = [];
  const dense = commits.length > LANES.dense;
  // A rail under dots; a busy lane's bars stand on a baseline the stylesheet draws instead.
  if (lane.isMain && !dense) out.push(`<span class="ln-rail"></span>`);
  // The merge ring goes down first: a one-commit branch merged minutes later puts both in one place,
  // and drawn last the ring covered the commit's colour.
  if (!lane.isMain && Number.isFinite(merged)) {
    out.push(
      `<span class="ln-merge" style="--x: ${axis.x(merged)}" title="${escapeHtml(`merged${lane.pr ? ` in #${lane.pr}` : ""} · ${formatWhen(lane.mergedAt)}`)}"></span>`,
    );
  }
  if (dense) {
    out.push(laneBars(commits, axis));
  } else {
    if (!lane.isMain && commits.length + posts.length > 0) {
      const ts = [...commits, ...posts].map((pt) => pt.t);
      const a = Math.min(...ts);
      const b = Math.max(...ts, Number.isFinite(merged) ? merged : -Infinity);
      out.push(`<span class="ln-span" style="--x: ${axis.x(a)}; --w: ${axis.w(b - a)}"></span>`);
    }
    for (const c of commits) {
      out.push(
        `<span class="ln-dot" data-kind="${c.type}" data-agent="${escapeHtml(c.tool || "none")}"` +
          ` style="--x: ${axis.x(c.t)}" title="${escapeHtml(pointTip(c))}"></span>`,
      );
    }
  }
  for (const p of posts) {
    out.push(`<span class="ln-post" data-kind="${postKind(p)}" style="--x: ${axis.x(p.t)}" title="${escapeHtml(pointTip(p))}"></span>`);
  }
  return out.join("");
}

/**
 * The avatar a person posts under, with the tooltip data the board's script reads. Shared by the
 * row that opens under a branch; the class and data attributes are the ones that script expects.
 */
function laneAvatar(p, lane, model) {
  const tools = p.tools.length ? p.tools.join(",") : "cli";
  const lastPost = p.lastText ? `${p.lastType}: ${p.lastText}` : "no post text";
  const presenceState = p.presence?.state === "active" ? "active" : "idle";
  const presenceLabel = p.presence?.label || "idle · never";
  const toolPresenceBits = p.tools
    .map((tid) => {
      const pr = model.toolPresence?.[tid];
      return `${tid}=${pr?.state === "active" ? "active" : "idle"}:${pr?.label || "idle · never"}`;
    })
    .join("|");
  // No title= on the button — a native browser tip would stack with .tl-tooltip.
  return (
    `<button type="button" class="tl-avatar" style="--actor-hue: ${p.hue}" data-actor="${escapeHtml(p.actor)}"` +
    ` data-branch="${escapeHtml(lane.name)}" data-tools="${escapeHtml(tools)}" data-tool-presence="${escapeHtml(toolPresenceBits)}"` +
    ` data-presence="${presenceState}" data-presence-label="${escapeHtml(presenceLabel)}" data-posts="${p.postCount}"` +
    ` data-diffs="${p.diffCount}" data-last-at="${escapeHtml(p.lastAt || "")}" data-last-post="${escapeHtml(lastPost)}"` +
    ` data-commit="${escapeHtml(lane.isCurrent && model.head ? model.head : "")}" data-verify="${posterVerifyKind(p)}"` +
    ` aria-label="${escapeHtml(`${p.actor} on ${lane.name}`)}">` +
    `<span class="tl-avatar-initials" aria-hidden="true">${escapeHtml(p.initials)}</span>` +
    `<span class="tl-presence" data-presence="${presenceState}" aria-hidden="true"></span>` +
    `${p.verified ? '<span class="tl-verify" data-verify="verified">✓</span>' : ""}</button>`
  );
}

/** One line of a row's list: the date and what happened first, then who, which agent, and the sha. */
function laneListItem(pt) {
  const day = pt.t == null ? "—" : fmtDay(pt.t);
  if (isCommit(pt)) {
    return (
      `<li data-kind="${pt.type}"><time datetime="${escapeHtml(pt.at || "")}">${escapeHtml(day)}</time>` +
      `<span class="ln-subj">${escapeHtml(pt.text || "")}</span>` +
      `<span class="ln-who">${escapeHtml(pt.actor || "")}</span>` +
      `<span class="ln-mini" data-agent="${escapeHtml(pt.tool || "none")}">${escapeHtml(pt.agent || "no agent recorded")}</span>` +
      `<span class="ln-delta">${pt.type === "merge" ? "merge" : `+${pt.ins || 0} −${pt.del || 0}`}</span>` +
      `<code>${escapeHtml(pt.sha || "")}</code></li>`
    );
  }
  return (
    `<li data-kind="post"><time datetime="${escapeHtml(pt.at || "")}">${escapeHtml(day)}</time>` +
    `<span class="ln-subj">${escapeHtml(pt.text || "")}</span>` +
    `<span class="ln-who">${escapeHtml(pt.actor || "")}</span><span class="ln-kind">${postKind(pt)}</span></li>`
  );
}

function laneRow(lane, axis, zooms, model, ctx) {
  const commits = lane.points.filter(isCommit);
  const posts = lane.points.filter((pt) => !isCommit(pt));
  const times = lane.points.map((pt) => pt.t).filter((t) => t != null);
  const last = times.length ? Math.max(...times) : null;

  const byAgent = new Map();
  for (const c of commits) if (c.tool) byAgent.set(c.tool, (byAgent.get(c.tool) || 0) + 1);
  const agents = [...byAgent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id, n]) => `<span class="ln-mini" data-agent="${escapeHtml(id)}">${escapeHtml(familyName(id))} ${n}</span>`)
    .join("");

  const counts = [commits.length ? plural(commits.length, "commit") : "", posts.length ? plural(posts.length, "post") : ""]
    .filter(Boolean)
    .join(" · ");
  // A branch whose tip is in main says so. The cap on how much history was read is said once, for
  // the whole figure, because it cuts every lane and not only main.
  const state = lane.isMain
    ? ""
    : lane.mergedAt
      ? `merged${lane.pr ? ` #${lane.pr}` : ""}`
      : lane.open
        ? "open"
        : "";
  const ago = last == null ? "" : shortSince(Math.max(0, ctx.now - last));
  const when = ago ? (ago === "just now" ? ago : `${ago} ago`) : "";

  // Items earlier than the window on screen are clipped from the lane, so the lane says how many.
  const before = zooms
    .filter((z) => z.id !== "all")
    .map((z) => [z.id, lane.points.filter((pt) => pt.t != null && pt.t < z.from).length])
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ` data-before-${id}="${n}"`)
    .join("");

  const faces = lane.people.length
    ? `<span class="ln-faces" aria-hidden="true">${lane.people
        .slice(0, 4)
        .map((p) => `<span class="ln-face" style="--actor-hue: ${p.hue}">${escapeHtml(p.initials)}</span>`)
        .join("")}</span>`
    : "";

  const listed = [...lane.points]
    .sort((a, b) => (b.t ?? -Infinity) - (a.t ?? -Infinity))
    .slice(0, LANES.listCap);
  const unlisted = lane.points.length - listed.length;
  const people = lane.people.length
    ? `<div class="ln-people"><span class="ln-people-label">Posting here</span>${lane.people.map((p) => laneAvatar(p, lane, model)).join("")}</div>`
    : "";

  const badges =
    (lane.isMain ? ' <span class="branch-badge">default</span>' : "") +
    (lane.isCurrent && !lane.isMain ? ' <span class="branch-badge">checked out</span>' : "");

  return `<details class="ln-row"${lane.isMain ? ' data-main="1"' : ""}${lane.isCurrent ? ' data-current="1"' : ""} style="--branch-hue: ${lane.hue}">
  <summary>
    <span class="ln-name"><span class="branch-swatch" aria-hidden="true"></span><span class="ln-label" title="${escapeHtml(lane.name)}">${escapeHtml(lane.name)}</span>${badges}</span>
    <span class="ln-lane" aria-hidden="true"${before}${commits.filter((pt) => pt.t != null).length > LANES.dense ? ' data-dense="1"' : ""}>${laneMarks(lane, axis)}</span>
    <span class="ln-meta"><span class="ln-counts">${escapeHtml(counts)}${state ? ` · ${escapeHtml(state)}` : ""}</span>${agents}${when ? `<span class="ln-when">${escapeHtml(when)}</span>` : ""}${faces}</span>
  </summary>
  <div class="ln-body">
    ${people}
    <ol class="ln-list">${listed.map(laneListItem).join("")}${unlisted > 0 ? `<li class="ln-unlisted">and ${plural(unlisted, "older item")} not listed here</li>` : ""}</ol>
  </div>
</details>`;
}

function laneLegend(lanes) {
  const seen = new Set();
  let posts = false;
  let merges = false;
  for (const lane of lanes) {
    if (lane.mergedAt && !lane.isMain) merges = true;
    for (const pt of lane.points) {
      if (isCommit(pt)) seen.add(pt.tool || "none");
      else posts = true;
    }
  }
  const order = [...seen].sort((a, b) => (a === "none") - (b === "none") || familyName(a).localeCompare(familyName(b)));
  const keys = order.map(
    (id) => `<li><span class="ln-key" data-agent="${escapeHtml(id)}"></span>${escapeHtml(familyName(id === "none" ? "" : id))}</li>`,
  );
  if (posts) keys.push(`<li><span class="ln-key" data-shape="post"></span>room post</li>`);
  if (merges) keys.push(`<li><span class="ln-key" data-shape="merge"></span>merged</li>`);
  return `<ul class="ln-legend" aria-label="Colours">${keys.join("")}</ul>`;
}

export function renderBranchGraph(model, { now = Date.now() } = {}) {
  const lanes = (model.lanes || []).filter((l) => (l.points || []).length > 0);
  if (!lanes.length) return "";
  const axis = laneAxis(lanes);
  if (!axis) return "";

  const zooms = laneZooms(axis, lanes);
  const lastOf = (lane) => Math.max(...lane.points.map((pt) => pt.t ?? -Infinity));
  const main = lanes.find((l) => l.isMain);
  const others = lanes.filter((l) => l !== main).sort((a, b) => lastOf(b) - lastOf(a) || a.name.localeCompare(b.name));
  const ordered = main ? [main, ...others] : others;
  // It opens at the smallest window in which every row on screen still shows its latest activity:
  // thirty days on a busy repository, where anything wider bunches this week's branches against the
  // right edge, and wider on a quiet one, where thirty days would show rows of nothing but "‹ 12".
  const onScreen = ordered.slice(0, LANES.shown + (main ? 1 : 0));
  const start = zooms.find((z) => onScreen.every((lane) => lastOf(lane) >= z.from)) || zooms[zooms.length - 1];

  const ctx = { now };
  const read = lanes.reduce((n, l) => n + l.points.filter(isCommit).length, 0);
  const capNote = model.historyTruncated
    ? `<p class="ln-note">Reading the newest ${read} of ${model.historyTotal} commits. Older ones are not drawn here or counted anywhere on this board.</p>`
    : "";
  const rows = ordered.map((lane) => laneRow(lane, axis, zooms, model, ctx));
  const visible = rows.slice(0, LANES.shown + (main ? 1 : 0));
  const rest = rows.slice(visible.length);

  const refs = Number(model.historyBranchRefs) || 0;
  const unseen = refs - 1 - others.length;
  const refNote =
    unseen > 0
      ? `<p class="ln-note">The ${others.length} most recently merged or active branches are drawn. This checkout has ${refs} branch refs; <code>git branch -a</code> lists them all.</p>`
      : "";

  const outsideText = (z) => (z.outside ? `${plural(z.outside, "older commit")} outside this window` : "everything read is in this window");
  const zoomControl =
    zooms.length > 1
      ? `<div class="ln-zoom" role="group" aria-label="Time window">${zooms
          .map(
            (z) =>
              `<button type="button" data-zoom="${z.id}" data-z0="${z.z0}" data-range="${escapeHtml(z.range)}" data-outside-text="${escapeHtml(outsideText(z))}" aria-pressed="${z === start}">${z.label}</button>`,
          )
          .join("")}</div>`
      : "";

  // How dense the month labels can be over the whole span: every month, every quarter, or years.
  const long = axis.span > 730 * DAY ? 2 : axis.span > 400 * DAY ? 1 : 0;
  const weeks = axis.unit === DAY && !zooms.some((z) => z.id === "30") && axis.span <= 45 * DAY;
  return `<figure class="ln-figure" data-zoom="${start.id}"${long ? ` data-long="${long}"` : ""}${weeks ? ' data-weeks="1"' : ""} style="--z0: ${start.z0}; --z1: 1">
  <div class="ln-controls">
    <p class="ln-range"><b data-ln-range>${escapeHtml(start.range)}</b> · <span data-ln-outside>${escapeHtml(outsideText(start))}</span></p>
    ${zoomControl}
  </div>
  ${laneLegend(lanes)}
  <div class="ln-axis" aria-hidden="true"><span></span><span class="ln-ticks">${laneTicks(axis, zooms)}</span><span></span></div>
  <div class="ln-rows">
${visible.join("\n")}
  </div>
  ${rest.length ? `<details class="ln-more"><summary>Show ${plural(rest.length, "more branch", "more branches")}</summary><div class="ln-rows">\n${rest.join("\n")}\n</div></details>` : ""}
  ${capNote}
  ${refNote}
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
  const coauthoredByBot = Number(history.agents.coauthoredByBot) || 0;
  const coauthoredByPerson = Number(history.agents.coauthoredByPerson) || 0;
  const totalShown = history.trunk.length + history.branches.reduce((n, b) => n + b.commits.length, 0);

  const agentChips = agents
    .map(
      (a) =>
        `<span class="bb-agent" data-family="${escapeHtml(a.id)}"><span class="bb-swatch" aria-hidden="true"></span>${escapeHtml(a.label)} <b>${a.commits}</b><span class="bb-lines">+${shortNum(a.insertions)} −${shortNum(a.deletions)}</span></span>`,
    )
    .join("");
  // A trailer no family recognises is its own chip. Folding it into "no agent recorded" would
  // say the commit was the person's own while the commit itself names a co-author.
  //
  // Two chips, and neither of them says "agent": as one chip reading "co-author, not a known
  // agent" it sat at 47% on astral-sh/uv with maintainers and release bots inside it, next to the
  // agent chips, and read as agent work. `[bot]` is GitHub's own marker on App accounts, so the
  // split is evidence rather than a guess about anybody's name.
  const coauthorChip = [
    coauthoredByBot
      ? `<span class="bb-agent" data-family="coauthor-bot"><span class="bb-swatch" aria-hidden="true"></span>co-author that says it is a bot <b>${coauthoredByBot}</b></span>`
      : "",
    coauthoredByPerson
      ? `<span class="bb-agent" data-family="coauthor"><span class="bb-swatch" aria-hidden="true"></span>co-author, no bot marker <b>${coauthoredByPerson}</b></span>`
      : "",
  ].join("");
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
  <p class="bb-note">From ${history.truncated ? `the newest <strong>${totalShown}</strong> of ${history.total} commits` : `<strong>${history.total}</strong> commit${history.total === 1 ? "" : "s"}`} of git history — attribution comes from <code>Co-Authored-By</code> trailers the agents write themselves. Nothing is read from Cursor's or Claude's private state.</p>
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
    return `<section class="timeline" id="timeline" data-timeline="1" aria-label="branch timeline">
  <div class="timeline-head">
    <h2 class="timeline-heading">Timeline</h2>
    <p class="timeline-note">No branch stamps yet. Posts with a git branch (or ROOMS_BRANCH) will appear as lanes here. Derived from room events — not IDE telemetry.</p>
  </div>
</section>`;
  }

  const headBit =
    model.head && model.current
      ? ` Checked out: <strong>${escapeHtml(shortBranch(model.current, 28))}</strong> @ <span class="device">${escapeHtml(model.head)}</span>.`
      : "";

  const unk =
    model.unknownCount > 0
      ? `<p class="timeline-unknown">${model.unknownCount} older post${model.unknownCount === 1 ? "" : "s"} without a branch stamp are omitted from lanes.</p>`
      : "";

  // One sentence, where there used to be seven lines of instructions. What the picture means belongs
  // in the picture: the legend names the colours, the range line names the window, and every mark
  // says what it is on hover. People who posted on a branch are inside its row.
  return `<section class="timeline" id="timeline" data-timeline="1" aria-label="branch timeline">
  <div class="timeline-head">
    <h2 class="timeline-heading">Timeline</h2>
    <p class="timeline-note">A row per branch, most recent first. Dots are commits, coloured by the agent that co-authored them; a busy row shows commits per day instead. Open a row to list what is on it.${headBit}</p>
  </div>
${renderBranchGraph(model, { now: opts.now != null ? Number(opts.now) : Date.now() })}
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
