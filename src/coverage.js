/**
 * Team coverage floor (observe layer): who synced recently, who showed any agent sessions
 * (hooks-seen floor), who is stale. Never claims "hooks installed" — only what status/rollups show.
 */

import { pullTeamRoom, readStatuses, teamForProject } from "./team.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validAgentRollup } from "./team.js";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

async function readAgentRollups(clonePath) {
  const out = [];
  let members = [];
  try {
    members = await readdir(join(clonePath, "rollups"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const m of members) {
    if (!m.isDirectory() || !LOGIN.test(m.name)) continue;
    for (const f of await readdir(join(clonePath, "rollups", m.name))) {
      if (!f.endsWith(".agents.json")) continue;
      try {
        const ok = validAgentRollup(JSON.parse(await readFile(join(clonePath, "rollups", m.name, f), "utf8")), m.name);
        if (ok) out.push(ok);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/**
 * @param {{ statuses: object[], agentRollups?: object[], now?: number, staleDays?: number }} opts
 */
export function buildCoverage({ statuses = [], agentRollups = [], now = Date.now(), staleDays = 7 } = {}) {
  const staleMs = staleDays * 86_400_000;
  const byMember = new Map();

  for (const s of statuses) {
    if (!s?.member) continue;
    const row = byMember.get(s.member) || {
      member: s.member,
      projects: new Set(),
      lastAt: null,
      sessions7d: 0,
      filesEdited7d: 0,
      agents: new Set(),
    };
    row.projects.add(s.project);
    if (!row.lastAt || (s.at && s.at > row.lastAt)) row.lastAt = s.at;
    for (const [agent, a] of Object.entries(s.agents7d || {})) {
      row.agents.add(agent);
      row.sessions7d += a.sessions || 0;
      row.filesEdited7d += a.filesEdited || 0;
    }
    byMember.set(s.member, row);
  }

  for (const r of agentRollups) {
    if (!r?.member) continue;
    const row = byMember.get(r.member) || {
      member: r.member,
      projects: new Set(),
      lastAt: null,
      sessions7d: 0,
      filesEdited7d: 0,
      agents: new Set(),
    };
    if (!row.lastAt || (r.at && r.at > row.lastAt)) row.lastAt = r.at;
    for (const [agent, a] of Object.entries(r.agents || {})) {
      if (row.agents.has(agent)) continue; // status already counted
      row.agents.add(agent);
      row.sessions7d += a.sessions || 0;
      row.filesEdited7d += a.filesEdited || 0;
    }
    byMember.set(r.member, row);
  }

  const members = [...byMember.values()]
    .map((m) => {
      const at = Date.parse(m.lastAt) || 0;
      const ageDays = at ? Math.floor((now - at) / 86_400_000) : null;
      return {
        member: m.member,
        projects: m.projects.size,
        lastAt: m.lastAt,
        ageDays,
        stale: at ? now - at > staleMs : true,
        hooksSeen: m.sessions7d > 0 || m.filesEdited7d > 0 || m.agents.size > 0,
        sessions7d: m.sessions7d,
        filesEdited7d: m.filesEdited7d,
        agents: [...m.agents].sort(),
      };
    })
    .sort((a, b) => a.member.localeCompare(b.member));

  return {
    v: 1,
    kind: "team_coverage",
    at: new Date(now).toISOString(),
    staleDays,
    totals: {
      members: members.length,
      fresh: members.filter((m) => !m.stale).length,
      stale: members.filter((m) => m.stale).length,
      hooksSeen: members.filter((m) => m.hooksSeen).length,
      hooksUnseen: members.filter((m) => !m.hooksSeen).length,
    },
    members,
  };
}

export function renderCoverageText(cov, { teamId = "" } = {}) {
  const lines = [
    `Coverage · ${teamId || "team"} · stale >${cov.staleDays}d`,
    ``,
    `_Floor from shared status/rollups only. "hooks seen" means agent sessions or edits appeared in` +
      ` the sync — not that hooks are installed everywhere. Unrecorded work stays blank._`,
    ``,
    `**${cov.totals.members}** member(s) · **${cov.totals.fresh}** fresh · **${cov.totals.stale}** stale · ` +
      `**${cov.totals.hooksSeen}** hooks-seen · **${cov.totals.hooksUnseen}** no agent activity in sync`,
    ``,
  ];
  if (!cov.members.length) {
    lines.push("Nobody has shared a status yet. From a project: rooms team sync.");
    return `${lines.join("\n")}\n`;
  }
  for (const m of cov.members) {
    const age = m.ageDays == null ? "never" : m.ageDays === 0 ? "today" : `${m.ageDays}d ago`;
    const flags = [
      m.stale ? "stale" : "fresh",
      m.hooksSeen ? `hooks-seen (${m.sessions7d}s/${m.filesEdited7d}f)` : "no agent activity in sync",
    ].join(" · ");
    lines.push(`- @${m.member} · ${m.projects} project(s) · last ${age} · ${flags}`);
    if (m.agents.length) lines.push(`  agents: ${m.agents.join(", ")}`);
  }
  lines.push(``);
  return `${lines.join("\n")}\n`;
}

/** Coverage for the team room linked to cwd (or --team). */
export async function coverageForProject(projectDir, { team: teamFlag = null, staleDays = 7, pull = true } = {}) {
  const linked = await teamForProject(projectDir);
  const { readRegistry } = await import("./team.js");
  const reg = await readRegistry();
  const id = teamFlag || linked.id || (Object.keys(reg.teams).length === 1 ? Object.keys(reg.teams)[0] : null);
  if (!id || !reg.teams[id]) {
    return { ok: false, why: "No team room. rooms team join <owner/repo>" };
  }
  const room = reg.teams[id];
  if (pull) await pullTeamRoom(room.path);
  const { statuses, skipped } = await readStatuses(room.path);
  const agentRollups = await readAgentRollups(room.path);
  const coverage = buildCoverage({ statuses, agentRollups, staleDays });
  return { ok: true, id, name: room.name, coverage, skipped };
}
