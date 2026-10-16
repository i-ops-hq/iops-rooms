/**
 * Org room: a private GitHub repo that holds a CEO/lead rollup of one or more team rooms.
 * Floors and counts only — never file paths, prompts, or setup bodies (DIRECTION §4.4 / D5).
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  checkPrivate,
  gitIn,
  pullTeamRoom,
  readRegistry,
  readStatuses,
  teamIdFor,
  writeRegistry,
  validAgentRollup,
  validPackageRollup,
} from "./team.js";
import { roomsHomeDir } from "./identity.js";

export const ORG_FORMAT = "iops-rooms/org-room";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function orgRoomFiles(name) {
  return {
    "room.json": `${JSON.stringify({ format: ORG_FORMAT, name, v: 1 }, null, 2)}\n`,
    "README.md":
      `# ${name}\n\n` +
      `Org room for Rooms by I-Ops. Holds a thin rollup of linked team rooms (counts and package\n` +
      `names only). Not a dump of anyone's laptop.\n`,
    "teams.json": `${JSON.stringify({ v: 1, teams: [] }, null, 2)}\n`,
    "rollup/.gitkeep": "",
    ".gitattributes": "rollup/** text eol=lf\nteams.json text eol=lf\n",
  };
}

export async function readOrgRoom(path) {
  try {
    const room = JSON.parse(await readFile(join(path, "room.json"), "utf8"));
    if (room.format !== ORG_FORMAT) return null;
    return { name: String(room.name || basename(path)), ...(await teamIdFor(path)) };
  } catch {
    return null;
  }
}

export async function readOrgTeamsList(clonePath) {
  try {
    const data = JSON.parse(await readFile(join(clonePath, "teams.json"), "utf8"));
    const teams = Array.isArray(data.teams) ? data.teams.map(String).filter(Boolean) : [];
    return { v: 1, teams: [...new Set(teams)].slice(0, 50) };
  } catch {
    return { v: 1, teams: [] };
  }
}

export async function writeOrgTeamsList(clonePath, teams) {
  const body = { v: 1, teams: [...new Set(teams.map(String))].slice(0, 50) };
  await writeFile(join(clonePath, "teams.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

async function readTeamRollups(clonePath) {
  const agents = [];
  const packages = [];
  let skipped = 0;
  let members = [];
  try {
    members = await readdir(join(clonePath, "rollups"), { withFileTypes: true });
  } catch {
    return { agents, packages, skipped };
  }
  for (const m of members) {
    if (!m.isDirectory() || !LOGIN.test(m.name)) continue;
    for (const f of await readdir(join(clonePath, "rollups", m.name))) {
      try {
        const data = JSON.parse(await readFile(join(clonePath, "rollups", m.name, f), "utf8"));
        if (f.endsWith(".agents.json")) {
          const ok = validAgentRollup(data, m.name);
          if (ok) agents.push(ok);
          else skipped += 1;
        } else if (f.endsWith(".packages.json")) {
          const ok = validPackageRollup(data, m.name);
          if (ok) packages.push(ok);
          else skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
  }
  return { agents, packages, skipped };
}

/**
 * One team's contribution to the org view: members, activity floors, packages, stale logins.
 */
export function summarizeTeam({ id, statuses, agentRollups, packageRollups, now = Date.now() }) {
  const week = now - 7 * 86_400_000;
  const members = new Set();
  const stale = new Set();
  const seen = new Set();
  let sessions = 0;
  let filesEdited = 0;
  const agents = {};
  const packageHits = new Map();

  for (const s of statuses || []) {
    members.add(s.member);
    seen.add(s.member);
    const at = Date.parse(s.at) || 0;
    if (at < week) stale.add(s.member);
    for (const [agent, a] of Object.entries(s.agents7d || {})) {
      const e = (agents[agent] ||= { sessions: 0, filesEdited: 0 });
      e.sessions += a.sessions || 0;
      e.filesEdited += a.filesEdited || 0;
      sessions += a.sessions || 0;
      filesEdited += a.filesEdited || 0;
    }
  }
  for (const r of agentRollups || []) {
    members.add(r.member);
    for (const [agent, a] of Object.entries(r.agents || {})) {
      const e = (agents[agent] ||= { sessions: 0, filesEdited: 0 });
      // Prefer rollup if status lacked detail; avoid double-count by only adding when status had none.
      if (!(statuses || []).some((s) => s.member === r.member && s.agents7d?.[agent])) {
        e.sessions += a.sessions || 0;
        e.filesEdited += a.filesEdited || 0;
        sessions += a.sessions || 0;
        filesEdited += a.filesEdited || 0;
      }
    }
  }
  for (const r of packageRollups || []) {
    members.add(r.member);
    for (const p of r.packages || []) {
      if (!p?.name) continue;
      const key = `${p.name}@${p.version || "?"}`;
      const hit = packageHits.get(key) || { name: p.name, version: p.version || null, members: new Set() };
      hit.members.add(r.member);
      packageHits.set(key, hit);
    }
  }

  const projects = new Set((statuses || []).map((s) => s.project));
  return {
    id: String(id).slice(0, 200),
    members: members.size,
    active7d: [...members].filter((m) => !stale.has(m)).length,
    projects: projects.size,
    sessions7d: sessions,
    filesEdited7d: filesEdited,
    agents,
    packages: [...packageHits.values()]
      .map((p) => ({ name: p.name, version: p.version, members: p.members.size }))
      .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name))
      .slice(0, 100),
    stale: [...stale].sort().slice(0, 50),
  };
}

/** Org rollup from already-pulled team clones: floors only. */
export function buildOrgRollup({ teams, now = new Date() }) {
  const at = `${now.toISOString().slice(0, 16)}Z`;
  const summaries = (teams || []).map((t) => summarizeTeam({ ...t, now: now.getTime() }));
  let sessions7d = 0;
  const packageNames = new Set();
  for (const t of summaries) {
    sessions7d += t.sessions7d;
    for (const p of t.packages) packageNames.add(p.name);
  }
  return {
    v: 1,
    kind: "org_rollup",
    at,
    teams: summaries,
    totals: {
      teams: summaries.length,
      members: summaries.reduce((n, t) => n + t.members, 0),
      sessions7d,
      packages: packageNames.size,
      stale: summaries.reduce((n, t) => n + t.stale.length, 0),
    },
  };
}

export function validOrgRollup(data) {
  if (!data || data.v !== 1 || data.kind !== "org_rollup") return null;
  if (typeof data.at !== "string" || !Number.isFinite(Date.parse(data.at))) return null;
  if (!Array.isArray(data.teams) || data.teams.length > 50) return null;
  for (const t of data.teams) {
    if (!t || typeof t.id !== "string" || t.id.length > 200) return null;
    if (!Number.isInteger(t.members) || t.members < 0 || t.members > 10_000) return null;
  }
  return data;
}

export function renderOrgMarkdown(rollup) {
  const lines = [
    `# Org rollup`,
    ``,
    `_Generated ${rollup.at}. Floors only — never paths, prompts, or setup bodies._`,
    ``,
    `**Totals:** ${rollup.totals.teams} team(s) · ${rollup.totals.members} member-slots · ` +
      `${rollup.totals.sessions7d} sessions (7d) · ${rollup.totals.packages} package name(s) · ` +
      `${rollup.totals.stale} stale sync(s)`,
    ``,
  ];
  for (const t of rollup.teams) {
    lines.push(`## ${t.id}`);
    lines.push(
      `${t.members} member(s), ${t.active7d} active in 7d, ${t.projects} project(s), ` +
        `${t.sessions7d} sessions, ${t.filesEdited7d} files edited (counts)`,
    );
    if (t.stale.length) lines.push(`Stale (>7d): ${t.stale.join(", ")}`);
    const agentLine = Object.entries(t.agents)
      .map(([a, x]) => `${a} ${x.sessions}s/${x.filesEdited}f`)
      .join(" · ");
    if (agentLine) lines.push(`Agents: ${agentLine}`);
    const multi = t.packages.filter((p) => p.members > 1).slice(0, 15);
    if (multi.length) {
      lines.push(`Packages on >1 machine: ${multi.map((p) => `${p.name}@${p.version || "?"} (${p.members})`).join(", ")}`);
    }
    lines.push(``);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Pull each linked team room (from local registry), build org rollup, write rollup/org.json + ORG.md.
 */
export async function refreshOrg({ orgPath, reg = null, now = new Date() }) {
  const registry = reg || (await readRegistry());
  const list = await readOrgTeamsList(orgPath);
  const teams = [];
  const missing = [];
  for (const id of list.teams) {
    const entry = registry.teams[id];
    if (!entry?.path) {
      missing.push(id);
      continue;
    }
    const pulled = await pullTeamRoom(entry.path);
    if (!pulled.ok) {
      missing.push(`${id} (${pulled.why})`);
      continue;
    }
    const { statuses } = await readStatuses(entry.path);
    const { agents, packages } = await readTeamRollups(entry.path);
    teams.push({ id, statuses, agentRollups: agents, packageRollups: packages });
  }
  const rollup = buildOrgRollup({ teams, now });
  const content = `${JSON.stringify(rollup, null, 2)}\n`;
  const md = renderOrgMarkdown(rollup);
  await mkdir(join(orgPath, "rollup"), { recursive: true });
  await writeFile(join(orgPath, "rollup", "org.json"), content, "utf8");
  await writeFile(join(orgPath, "ORG.md"), md, "utf8");
  return { rollup, missing, files: ["rollup/org.json", "ORG.md"] };
}

/** Commit and push the org rollup files the lead already wrote with refreshOrg. */
export async function applyOrgRefresh({ orgPath, files }) {
  const paths = files || ["rollup/org.json", "ORG.md"];
  const add = await gitIn(orgPath, ["add", "--", ...paths]);
  if (!add.ok) return { ok: false, why: `git could not stage it: ${add.err}` };
  const commit = await gitIn(orgPath, ["commit", "-q", "-m", "org rollup", "--", ...paths]);
  if (!commit.ok) {
    if (/nothing to commit|no changes added/i.test(commit.err || commit.out || "")) {
      return { ok: true, unchanged: true };
    }
    return { ok: false, why: `git could not commit it: ${commit.err || commit.out}` };
  }
  let push = await gitIn(orgPath, ["push", "-q"]);
  if (!push.ok && /rejected|fetch first|non-fast-forward/i.test(push.err)) {
    const rebase = await gitIn(orgPath, ["pull", "--rebase", "--autostash", "-q"]);
    if (!rebase.ok) return { ok: false, why: `the org room moved and could not be caught up with: ${rebase.err}` };
    push = await gitIn(orgPath, ["push", "-q"]);
  }
  if (!push.ok) return { ok: false, why: `git could not push it: ${push.err}`, committed: true };
  return { ok: true };
}

/** The registered org named by `--org`, or the only one, or null. */
export async function resolveOrg(argvOrg = null) {
  const reg = await readRegistry();
  const ids = Object.keys(reg.orgs || {});
  const id = argvOrg ? String(argvOrg) : ids.length === 1 ? ids[0] : null;
  if (!id || !reg.orgs[id]) {
    return { reg, id: null, org: null, ids };
  }
  return { reg, id, org: reg.orgs[id], ids };
}

/** Register this org clone in ~/.iops-rooms/teams.json under `orgs`. */
export async function registerOrg(org) {
  const reg = await readRegistry();
  reg.orgs = reg.orgs || {};
  reg.orgs[org.id] = {
    name: org.name,
    path: org.path,
    remote: org.remote ? org.remote.label || org.remote : null,
  };
  await writeRegistry(reg);
  return reg;
}

export async function orgClonePath(id) {
  return join(roomsHomeDir(), "orgs", ...String(id).split("/"));
}

export { checkPrivate };
