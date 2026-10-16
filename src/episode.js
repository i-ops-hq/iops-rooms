/**
 * Episode stitching: join local activity into session → edits → packages → commits views.
 * A view only — not a separate database. Local machine; never invents unrecorded work.
 */

import { readActivity } from "./activity.js";
import { findRoomDir } from "./store.js";
import { projectName } from "./git-info.js";

const SESSION_HEX = /^[a-f0-9]{12}$/;

/**
 * Build episodes from an activity log.
 * @param {object[]} activity
 * @param {{ since?: number, now?: number, limit?: number }} [opts]
 */
export function buildEpisodes(activity, { since = 0, now = Date.now(), limit = 40 } = {}) {
  const byKey = new Map();

  for (const a of activity || []) {
    if (!a || !a.at) continue;
    const at = Date.parse(a.at);
    if (!Number.isFinite(at) || at < since) continue;

    if ((a.kind === "session" || a.kind === "edit") && a.agent && a.session && SESSION_HEX.test(String(a.session))) {
      const key = `${a.agent}\0${a.session}`;
      const ep =
        byKey.get(key) ||
        {
          agent: String(a.agent).slice(0, 40),
          session: String(a.session),
          model: null,
          start: null,
          end: null,
          first: a.at,
          last: a.at,
          paths: new Set(),
          packages: [],
          commits: [],
        };
      if (a.kind === "session" && a.phase === "start") {
        if (!ep.start || a.at < ep.start) ep.start = a.at;
        if (!ep.model && a.model) ep.model = String(a.model).slice(0, 60);
      }
      if (a.kind === "session" && a.phase === "end") {
        if (!ep.end || a.at > ep.end) ep.end = a.at;
      }
      if (a.kind === "edit" && a.path) ep.paths.add(String(a.path).slice(0, 200));
      if (a.at < ep.first) ep.first = a.at;
      if (a.at > ep.last) ep.last = a.at;
      byKey.set(key, ep);
      continue;
    }

    if (a.kind === "package" && typeof a.name === "string" && a.name) {
      // Attach to any open episode whose window covers this package event (overlap).
      const pkg = {
        name: String(a.name).slice(0, 80),
        version: a.version != null ? String(a.version).slice(0, 40) : null,
        action: a.action || "seen",
        at: a.at,
      };
      for (const ep of byKey.values()) {
        const start = Date.parse(ep.start || ep.first) || 0;
        const end = Date.parse(ep.end || ep.last) || now;
        if (at >= start - 60_000 && at <= end + 60_000) {
          if (ep.packages.length < 30) ep.packages.push(pkg);
        }
      }
      continue;
    }

    if (a.kind === "commit" && a.sha) {
      const commit = {
        sha: String(a.sha).slice(0, 40),
        madeIn: a.madeIn || null,
        editedBy: a.editedBy && typeof a.editedBy === "object" ? a.editedBy : null,
        at: a.at,
        branch: a.branch || null,
      };
      // Link by madeIn agent + overlapping time, or by edited files ∩ episode paths.
      for (const ep of byKey.values()) {
        const start = Date.parse(ep.start || ep.first) || 0;
        const end = Date.parse(ep.end || ep.last) || now;
        const inWindow = at >= start - 120_000 && at <= end + 300_000;
        const byAgent = commit.madeIn && commit.madeIn === ep.agent;
        const byFiles =
          commit.editedBy?.[ep.agent] &&
          Array.isArray(commit.editedBy[ep.agent]) &&
          commit.editedBy[ep.agent].some((p) => ep.paths.has(p));
        if (inWindow && (byAgent || byFiles)) {
          if (ep.commits.length < 20) ep.commits.push(commit);
        }
      }
    }
  }

  return [...byKey.values()]
    .map((ep) => ({
      v: 1,
      kind: "episode",
      agent: ep.agent,
      session: ep.session,
      model: ep.model,
      start: ep.start,
      end: ep.end,
      first: ep.first,
      last: ep.last,
      filesEdited: ep.paths.size,
      paths: [...ep.paths].sort().slice(0, 50),
      packages: dedupePackages(ep.packages).slice(0, 30),
      commits: ep.commits
        .slice()
        .sort((a, b) => (a.at || "").localeCompare(b.at || ""))
        .slice(0, 20)
        .map((c) => ({
          sha: c.sha,
          madeIn: c.madeIn,
          at: c.at,
          branch: c.branch,
          filesFromAgent: c.editedBy?.[ep.agent]?.length || 0,
        })),
      open: !ep.end,
    }))
    .sort((a, b) => (b.last || "").localeCompare(a.last || ""))
    .slice(0, limit);
}

function dedupePackages(list) {
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    const key = `${p.name}@${p.version || "?"}@${p.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Episodes for the project room covering `cwd`. */
export async function episodesFor(cwd, { sinceDays = 7, limit = 40, now = Date.now() } = {}) {
  const dir = (await findRoomDir(cwd)) || cwd;
  const activity = await readActivity(dir);
  const since = now - sinceDays * 86_400_000;
  const episodes = buildEpisodes(activity, { since, now, limit });
  return {
    v: 1,
    kind: "episodes",
    at: new Date(now).toISOString(),
    project: await projectName(cwd),
    sinceDays,
    count: episodes.length,
    episodes,
  };
}

/** Plain text for the CLI. */
export function renderEpisodesText(bundle) {
  const lines = [
    `Episodes · ${bundle.project} · last ${bundle.sinceDays}d · ${bundle.count} session(s)`,
    ``,
    `_Session → edits → packages → commits on this machine. Floors only; unrecorded work stays blank._`,
    ``,
  ];
  if (!bundle.episodes.length) {
    lines.push("Nothing recorded yet. Install hooks (`rooms hooks install --agent …`) and work in a session.");
    return `${lines.join("\n")}\n`;
  }
  for (const ep of bundle.episodes) {
    const when = ep.start || ep.first || "?";
    const end = ep.end ? ` → ${ep.end}` : " (no end recorded)";
    lines.push(`## ${ep.agent} · ${ep.session.slice(0, 8)}${ep.model ? ` · ${ep.model}` : ""}`);
    lines.push(`${when}${end}`);
    lines.push(`${ep.filesEdited} file(s) edited` + (ep.open ? " · open" : ""));
    if (ep.paths.length) lines.push(`paths: ${ep.paths.slice(0, 12).join(", ")}${ep.paths.length > 12 ? "…" : ""}`);
    if (ep.packages.length) {
      lines.push(
        `packages: ${ep.packages.map((p) => `${p.name}${p.version ? `@${p.version}` : ""}`).join(", ")}`,
      );
    }
    if (ep.commits.length) {
      lines.push(
        `commits: ${ep.commits.map((c) => `${c.sha.slice(0, 7)}${c.madeIn ? " in-session" : ""}`).join(", ")}`,
      );
    } else {
      lines.push(`commits: none linked (no commit event in this window)`);
    }
    lines.push(``);
  }
  return `${lines.join("\n")}\n`;
}
