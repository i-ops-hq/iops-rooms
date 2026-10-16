/**
 * Read-only JSON projections for `rooms dash`: local activity + week floor, team/org when linked.
 * Never invents work; never includes secret values. Paths stay local-only (this machine's API).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { sessionsFrom } from "./board.js";
import { agentsLast7Days, pullTeamRoom, readStatuses, teamForProject } from "./team.js";
import { resolveOrg, validOrgRollup } from "./org.js";
import { githubRepoFromRemote, readInbox, readShares } from "./share.js";
import { buildReport, reportToJson } from "./report.js";
import { buildEpisodes } from "./episode.js";
import { projectName } from "./git-info.js";
import { readMeta, findRoomDir } from "./store.js";
import { authStatus } from "./identity.js";

function packageHits(activity, since) {
  const by = new Map();
  for (const a of activity || []) {
    if (!a || a.kind !== "package" || !(Date.parse(a.at) >= since)) continue;
    if (typeof a.name !== "string" || !a.name) continue;
    const key = `${a.name}@${a.version || "?"}`;
    const hit = by.get(key) || { name: a.name, version: a.version || null, action: a.action || "seen", lastAt: a.at };
    if (a.at > hit.lastAt) {
      hit.lastAt = a.at;
      hit.action = a.action || hit.action;
      hit.version = a.version || hit.version;
    }
    by.set(key, hit);
  }
  return [...by.values()].sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || "")).slice(0, 50);
}

/** Local observability slice for the dashboard. */
export async function buildLocalProjection(projectDir, { now = Date.now() } = {}) {
  const week = now - 7 * 86_400_000;
  const roomDir = (await findRoomDir(projectDir)) || projectDir;
  const activity = await readActivity(roomDir);
  const sessions = sessionsFrom(activity, { since: week }).slice(0, 40).map((s) => ({
    agent: s.agent,
    model: s.model,
    start: s.start,
    end: s.end,
    last: s.last,
    filesEdited: s.files.length,
    // paths stay on this machine's localhost dash only
    paths: s.files.slice(0, 40),
  }));
  const agents7d = agentsLast7Days(activity, now);
  const packages = packageHits(activity, week);
  const episodes = buildEpisodes(activity, { since: week, now, limit: 20 }).map((ep) => ({
    agent: ep.agent,
    session: ep.session,
    model: ep.model,
    start: ep.start,
    end: ep.end,
    filesEdited: ep.filesEdited,
    packages: ep.packages.length,
    commits: ep.commits.length,
    open: ep.open,
    // paths stay on this machine's localhost dash only
    paths: ep.paths.slice(0, 20),
  }));
  let weekJson = null;
  let weekWhy = null;
  try {
    const report = await buildReport(projectDir, { since: "7d" });
    weekJson = reportToJson(report, { name: await projectName(projectDir), window: "7d" });
  } catch (e) {
    weekWhy = String(e.message || e);
  }
  let meta = null;
  try {
    meta = await readMeta(roomDir);
  } catch {
    meta = null;
  }
  return {
    v: 1,
    kind: "dash_local",
    at: new Date(now).toISOString(),
    project: await projectName(projectDir),
    room: meta ? { name: meta.name || null, code: meta.code || null } : null,
    agents7d,
    sessions,
    packages,
    episodes,
    week: weekJson,
    weekWhy,
  };
}

/** Team pulse from the registered team clone (after pull). */
export async function buildTeamProjection(projectDir, { pull = true } = {}) {
  const linked = await teamForProject(projectDir);
  if (!linked.team) return { v: 1, kind: "dash_team", linked: false };
  if (pull) await pullTeamRoom(linked.team.path);
  const { statuses, skipped } = await readStatuses(linked.team.path);
  const { shares } = await readShares(linked.team.path);
  const members = new Set(statuses.map((s) => s.member));
  let sessions7d = 0;
  let filesEdited7d = 0;
  for (const s of statuses) {
    for (const a of Object.values(s.agents7d || {})) {
      sessions7d += a.sessions || 0;
      filesEdited7d += a.filesEdited || 0;
    }
  }
  return {
    v: 1,
    kind: "dash_team",
    linked: true,
    id: linked.id,
    name: linked.team.name,
    members: members.size,
    statuses: statuses.length,
    skipped,
    sessions7d,
    filesEdited7d,
    shares: shares.length,
    recent: statuses.slice(0, 30).map((s) => ({
      member: s.member,
      project: s.project,
      at: s.at,
      branch: s.branch ?? null,
      uncommitted: s.uncommitted,
      pr: s.pr?.state || null,
      agents7d: s.agents7d || {},
    })),
  };
}

/** Org floors from the local org clone's last rollup (optional pull). */
export async function buildOrgProjection({ org: orgFlag = null, pull = true } = {}) {
  const { id, org: entry } = await resolveOrg(orgFlag);
  if (!entry) return { v: 1, kind: "dash_org", linked: false };
  if (pull) {
    const { pullTeamRoom } = await import("./team.js");
    await pullTeamRoom(entry.path);
  }
  let rollup = null;
  try {
    rollup = validOrgRollup(JSON.parse(await readFile(join(entry.path, "rollup", "org.json"), "utf8")));
  } catch {
    rollup = null;
  }
  return {
    v: 1,
    kind: "dash_org",
    linked: true,
    id,
    name: entry.name,
    rollup,
  };
}

/** Inbox slice for the dash (same allowlist as CLI). */
export async function buildInboxProjection(projectDir) {
  const login = (await authStatus()).github?.login || null;
  const linked = await teamForProject(projectDir);
  if (!linked.team || !login) {
    return { v: 1, kind: "dash_inbox", login, linked: Boolean(linked.team), shares: [], issues: [] };
  }
  const box = await readInbox({
    clonePath: linked.team.path,
    remotePath: githubRepoFromRemote(linked.team.remote),
    login,
  });
  return {
    v: 1,
    kind: "dash_inbox",
    login,
    linked: true,
    team: linked.id,
    pullOk: box.pullOk,
    shares: box.shares,
    issues: box.issues,
  };
}
