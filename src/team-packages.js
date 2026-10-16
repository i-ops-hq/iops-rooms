/**
 * Cross-member package surface from team hub package_rollups (observe layer).
 * Names/versions/member counts only — never lockfile bodies or install scripts.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pullTeamRoom, readRegistry, teamForProject, validPackageRollup } from "./team.js";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export async function readPackageRollups(clonePath) {
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
      if (!f.endsWith(".packages.json")) continue;
      try {
        const ok = validPackageRollup(
          JSON.parse(await readFile(join(clonePath, "rollups", m.name, f), "utf8")),
          m.name,
        );
        if (ok) out.push(ok);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/**
 * Join package rollups into a surface: which named packages appear on how many members.
 * @param {{ packageRollups: object[], multiOnly?: boolean, limit?: number }} opts
 */
export function buildPackageSurface({ packageRollups = [], multiOnly = false, limit = 100 } = {}) {
  const by = new Map();
  for (const r of packageRollups) {
    if (!r?.member || !Array.isArray(r.packages)) continue;
    for (const p of r.packages) {
      if (!p?.name) continue;
      const key = `${p.name}@${p.version || "?"}`;
      const hit =
        by.get(key) ||
        {
          name: p.name,
          version: p.version || null,
          manager: p.manager || null,
          members: new Set(),
          projects: new Set(),
          lastAt: r.at || null,
        };
      hit.members.add(r.member);
      if (r.project) hit.projects.add(r.project);
      if (r.at && (!hit.lastAt || r.at > hit.lastAt)) hit.lastAt = r.at;
      if (p.manager && !hit.manager) hit.manager = p.manager;
      by.set(key, hit);
    }
  }
  let rows = [...by.values()]
    .map((h) => ({
      name: h.name,
      version: h.version,
      manager: h.manager,
      members: h.members.size,
      memberLogins: [...h.members].sort(),
      projects: h.projects.size,
      lastAt: h.lastAt,
    }))
    .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  if (multiOnly) rows = rows.filter((r) => r.members > 1);
  return {
    v: 1,
    kind: "team_packages",
    at: new Date().toISOString(),
    totals: {
      packages: rows.length,
      multiMember: rows.filter((r) => r.members > 1).length,
      members: new Set(packageRollups.map((r) => r.member)).size,
    },
    packages: rows.slice(0, limit),
  };
}

export function renderPackageSurfaceText(surface, { teamId = "", multiOnly = false } = {}) {
  const lines = [
    `Packages · ${teamId || "team"}${multiOnly ? " · on >1 member" : ""}`,
    ``,
    `_From shared package rollups (names/versions only). Same package on several machines is a floor,` +
      ` not a vulnerability claim._`,
    ``,
    `**${surface.totals.packages}** package name(s) · **${surface.totals.multiMember}** on >1 member · ` +
      `**${surface.totals.members}** member(s) with rollups`,
    ``,
  ];
  if (!surface.packages.length) {
    lines.push(
      multiOnly
        ? "No package appears on more than one member yet."
        : "No package rollups yet. Members: rooms team sync (after rooms record packages / hooks).",
    );
    return `${lines.join("\n")}\n`;
  }
  for (const p of surface.packages) {
    lines.push(
      `- ${p.name}${p.version ? `@${p.version}` : ""} · ${p.members} member(s): ${p.memberLogins.map((m) => `@${m}`).join(", ")}` +
        (p.manager ? ` · ${p.manager}` : ""),
    );
  }
  lines.push(``);
  return `${lines.join("\n")}\n`;
}

export async function packageSurfaceForProject(projectDir, { team: teamFlag = null, multiOnly = false, pull = true } = {}) {
  const linked = await teamForProject(projectDir);
  const reg = await readRegistry();
  const id = teamFlag || linked.id || (Object.keys(reg.teams).length === 1 ? Object.keys(reg.teams)[0] : null);
  if (!id || !reg.teams[id]) return { ok: false, why: "No team room. rooms team join <owner/repo>" };
  const room = reg.teams[id];
  if (pull) await pullTeamRoom(room.path);
  const packageRollups = await readPackageRollups(room.path);
  const surface = buildPackageSurface({ packageRollups, multiOnly });
  return { ok: true, id, name: room.name, surface };
}
