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

/** A pull's result as the CLI's JSON carries it: `pullOk`, and `pullWhy` when it failed. Nothing when no pull was asked for. */
function pullFields(pulled) {
  if (!pulled || pulled.ok === undefined) return {};
  if (pulled.ok) return { pullOk: true };
  // git's first line, without the full stop it ends with: the page adds its own sentence after it.
  const why = String(pulled.why || "git pull failed").split("\n")[0].trim().replace(/\.+$/, "");
  return { pullOk: false, pullWhy: why || "git pull failed" };
}

/** Team pulse from the registered team clone (after pull), plus observe floors (packages / coverage / catalog). */
export async function buildTeamProjection(projectDir, { pull = true } = {}) {
  const linked = await teamForProject(projectDir);
  if (!linked.team) return { v: 1, kind: "dash_team", linked: false };
  // Kept, not discarded: a failed fetch must read as stale, as the CLI says it (0.12, Bugbot).
  const pulled = pull ? await pullTeamRoom(linked.team.path) : null;
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

  // Observe surfaces already available as CLI (0.12): reuse after the single pull above.
  const { readPackageRollups, buildPackageSurface } = await import("./team-packages.js");
  const { buildCoverage, readAgentRollups } = await import("./coverage.js");
  const { listSetupCatalog, resolveCommit } = await import("./setup/room.js");
  const agentRollups = await readAgentRollups(linked.team.path);
  const packageRollups = await readPackageRollups(linked.team.path);
  const packages = buildPackageSurface({ packageRollups, limit: 40 });
  const coverage = buildCoverage({ statuses, agentRollups });
  let catalog = { count: 0, setups: [] };
  try {
    const commit = await resolveCommit(linked.team.path, "HEAD");
    if (commit) catalog = await listSetupCatalog(linked.team.path, commit);
  } catch {
    catalog = { count: 0, setups: [] };
  }

  return {
    v: 1,
    kind: "dash_team",
    linked: true,
    id: linked.id,
    name: linked.team.name,
    ...pullFields(pulled),
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
    packages: {
      totals: packages.totals,
      truncated: Boolean(packages.truncated),
      packages: packages.packages.slice(0, 20),
    },
    coverage: {
      totals: coverage.totals,
      staleDays: coverage.staleDays,
      members: (coverage.members || []).slice(0, 20).map((m) => ({
        member: m.member,
        stale: m.stale,
        hooksSeen: m.hooksSeen,
        ageDays: m.ageDays,
        projects: m.projects,
      })),
    },
    catalog: {
      count: catalog.count,
      setups: (catalog.setups || []).slice(0, 20).map((s) => ({
        role: s.role,
        name: s.name,
        owner: s.owner,
        summary: s.summary,
      })),
    },
  };
}

/** Org floors from the local org clone's last rollup (optional pull). */
export async function buildOrgProjection({ org: orgFlag = null, pull = true } = {}) {
  const { id, org: entry } = await resolveOrg(orgFlag);
  if (!entry) return { v: 1, kind: "dash_org", linked: false };
  const pulled = pull ? await pullTeamRoom(entry.path) : null;
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
    ...pullFields(pulled),
    rollup,
  };
}

/** Inbox slice for the dash (same allowlist as CLI). */
/**
 * `pulled` is the team panel's pull of this same clone, when the page has just made one: the inbox
 * then reads the clone without pulling it again, and carries that result.
 */
export async function buildInboxProjection(projectDir, { pulled = null } = {}) {
  const login = (await authStatus()).github?.login || null;
  const linked = await teamForProject(projectDir);
  if (!linked.team || !login) {
    return { v: 1, kind: "dash_inbox", login, linked: Boolean(linked.team), shares: [], issues: [] };
  }
  const box = await readInbox({
    clonePath: linked.team.path,
    remotePath: githubRepoFromRemote(linked.team.remote),
    login,
    pull: !pulled,
  });
  return {
    v: 1,
    kind: "dash_inbox",
    login,
    linked: true,
    team: linked.id,
    ...pullFields(pulled || { ok: box.pullOk, why: box.pullWhy }),
    shares: box.shares,
    issues: box.issues,
  };
}
