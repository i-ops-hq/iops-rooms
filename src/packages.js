/**
 * Package events for the activity log: names, versions, manager, and timestamps — never tarball
 * contents or install scripts. `rooms record packages` diffs the project's lockfile against the
 * last snapshot recorded here and appends `kind: "package"` lines.
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { appendActivity, readActivity } from "./activity.js";
import { findRoomDir } from "./store.js";
import { repositoryTop } from "./git-info.js";

function cleanName(value, max = 80) {
  const s = String(value || "").trim().replace(/[^A-Za-z0-9@/._+-]/g, "").slice(0, max);
  return s || null;
}

function cleanVersion(value) {
  const s = String(value || "").trim().replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 40);
  return s || null;
}

/** Parse package-lock.json v2/v3 into name → version (top-level packages only under node_modules/). */
export function packagesFromNpmLock(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const out = new Map();
  if (data.packages && typeof data.packages === "object") {
    for (const [key, meta] of Object.entries(data.packages)) {
      if (!key.startsWith("node_modules/")) continue;
      const name = key.slice("node_modules/".length);
      if (!name || name.includes("/node_modules/")) continue;
      const ver = cleanVersion(meta?.version);
      const n = cleanName(name);
      if (n && ver) out.set(n, ver);
    }
    return out;
  }
  if (data.dependencies && typeof data.dependencies === "object") {
    for (const [name, meta] of Object.entries(data.dependencies)) {
      const n = cleanName(name);
      const ver = cleanVersion(meta?.version);
      if (n && ver) out.set(n, ver);
    }
  }
  return out;
}

/** Minimal yarn.lock / pnpm-lock name@version lines (best-effort; names only). */
export function packagesFromYarnLike(raw) {
  const out = new Map();
  for (const line of String(raw).split(/\r?\n/)) {
    // "foo@^1.0.0:", "foo@npm:1.0.0:", '"@scope/foo@1.0.0":'
    const m = line.match(/^"?((?:@[^@\s]+\/)?[^@\s"]+)@([^:"]+)"?:/);
    if (!m) continue;
    const n = cleanName(m[1]);
    // Prefer a concrete version later in the block; first pass keeps range as placeholder skip.
    if (!n || /[\^~*]/.test(m[2])) continue;
    const ver = cleanVersion(m[2].replace(/^npm:/, ""));
    if (ver) out.set(n, ver);
  }
  return out;
}

async function readLockfile(top) {
  const candidates = [
    ["npm", "package-lock.json", packagesFromNpmLock],
    ["pnpm", "pnpm-lock.yaml", packagesFromYarnLike],
    ["yarn", "yarn.lock", packagesFromYarnLike],
  ];
  for (const [manager, file, parse] of candidates) {
    const path = join(top, file);
    try {
      await access(path);
      const raw = await readFile(path, "utf8");
      const map = parse(raw);
      if (map) return { manager, file, map };
    } catch {
      /* next */
    }
  }
  return null;
}

function lastPackageSnapshot(activity) {
  const snap = {};
  for (const r of activity) {
    if (r.kind !== "package" || !r.name || !r.version) continue;
    if (r.action === "remove") delete snap[r.name];
    else snap[r.name] = r.version;
  }
  return snap;
}

/**
 * Diff the lockfile against prior package events and append new/upgrade/remove records.
 * Returns counts, or null when there is no room or no lockfile.
 */
export async function recordLockfilePackages(cwd = process.cwd()) {
  const top = (await repositoryTop(cwd)) || cwd;
  const dir = await findRoomDir(cwd);
  if (!dir) return null;
  const lock = await readLockfile(top);
  if (!lock) return null;
  const prior = lastPackageSnapshot(await readActivity(dir));
  const now = lock.map;
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [name, version] of now) {
    const before = prior[name];
    if (!before) {
      await appendActivity(dir, {
        kind: "package",
        action: "seen",
        name,
        version,
        manager: lock.manager,
        source: "lockfile",
      });
      added++;
    } else if (before !== version) {
      await appendActivity(dir, {
        kind: "package",
        action: "upgrade",
        name,
        version,
        previous: before,
        manager: lock.manager,
        source: "lockfile",
      });
      changed++;
    }
  }
  for (const name of Object.keys(prior)) {
    if (now.has(name)) continue;
    await appendActivity(dir, {
      kind: "package",
      action: "remove",
      name,
      version: prior[name],
      manager: lock.manager,
      source: "lockfile",
    });
    removed++;
  }
  return { manager: lock.manager, added, changed, removed };
}

/** Thin rollup for team sync: name, version, manager, first/last seen — no paths. */
export function packageRollupFromActivity(activity, { sinceMs = 7 * 24 * 3600 * 1000 } = {}) {
  const cutoff = Date.now() - sinceMs;
  const byName = new Map();
  for (const r of activity) {
    if (r.kind !== "package" || !r.name) continue;
    const at = Date.parse(r.at || "") || 0;
    if (at && at < cutoff) continue;
    const cur = byName.get(r.name) || {
      name: r.name,
      version: r.version || null,
      manager: r.manager || null,
      firstAt: r.at || null,
      lastAt: r.at || null,
      lastAction: r.action || "seen",
    };
    if (!cur.firstAt || (r.at && r.at < cur.firstAt)) cur.firstAt = r.at;
    if (!cur.lastAt || (r.at && r.at > cur.lastAt)) {
      cur.lastAt = r.at;
      cur.version = r.version || cur.version;
      cur.lastAction = r.action || cur.lastAction;
      cur.manager = r.manager || cur.manager;
    }
    if (r.action === "remove") byName.delete(r.name);
    else byName.set(r.name, cur);
  }
  return [...byName.values()].slice(0, 200);
}
