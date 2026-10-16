/**
 * Cross-member package surface from team hub package_rollups (observe layer).
 * Names/versions/member counts only — never lockfile bodies or install scripts.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanName, cleanVersion } from "./packages.js";
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
      const name = cleanName(p?.name);
      if (!name) continue;
      const version = p.version != null ? cleanVersion(p.version) : null;
      const key = `${name}@${version || "?"}`;
      const hit =
        by.get(key) ||
        {
          name,
          version: version || null,
          manager: typeof p.manager === "string" ? p.manager.slice(0, 20) : null,
          members: new Set(),
          projects: new Set(),
          lastAt: r.at || null,
        };
      hit.members.add(r.member);
      if (r.project) hit.projects.add(r.project);
      if (r.at && (!hit.lastAt || r.at > hit.lastAt)) hit.lastAt = r.at;
      if (p.manager && !hit.manager && typeof p.manager === "string") hit.manager = p.manager.slice(0, 20);
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
  const total = rows.length;
  const listed = rows.slice(0, limit);
  return {
    v: 1,
    kind: "team_packages",
    at: new Date().toISOString(),
    totals: {
      packages: total,
      listed: listed.length,
      multiMember: rows.filter((r) => r.members > 1).length,
      members: new Set(packageRollups.map((r) => r.member)).size,
    },
    ...(total > limit ? { truncated: true } : {}),
    packages: listed,
  };
}

export function renderPackageSurfaceText(surface, { teamId = "", multiOnly = false } = {}) {
  const lines = [
    `Packages · ${teamId || "team"}${multiOnly ? " · on >1 member" : ""}`,
    ``,
    `_From shared package rollups (names/versions only). Same package on several machines is a floor,` +
      ` not a vulnerability claim._`,
    ``,
    `**${surface.totals.packages}** package name(s)` +
      (surface.truncated ? ` · showing ${surface.totals.listed}` : "") +
      ` · **${surface.totals.multiMember}** on >1 member · ` +
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
  if (surface.truncated) lines.push(`_(truncated — ${surface.totals.packages - surface.totals.listed} more not shown)_`);
  lines.push(``);
  return `${lines.join("\n")}\n`;
}

export async function packageSurfaceForProject(projectDir, { team: teamFlag = null, multiOnly = false, pull = true } = {}) {
  const linked = await teamForProject(projectDir);
  const reg = await readRegistry();
  const id = teamFlag || linked.id || (Object.keys(reg.teams).length === 1 ? Object.keys(reg.teams)[0] : null);
  if (!id || !reg.teams[id]) return { ok: false, why: "No team room. rooms team join <owner/repo>" };
  const room = reg.teams[id];
  let pullOk = true;
  let pullWhy = null;
  if (pull) {
    const pulled = await pullTeamRoom(room.path);
    pullOk = pulled.ok;
    pullWhy = pulled.ok ? null : pulled.why || "git pull failed";
  }
  const packageRollups = await readPackageRollups(room.path);
  const surface = buildPackageSurface({ packageRollups, multiOnly });
  return { ok: true, id, name: room.name, surface, pullOk, pullWhy };
}
