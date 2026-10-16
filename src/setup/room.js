/**
 * Setups in the team room, through git alone (docs/design/TEAM_SETUPS.md §6 and §8).
 *
 * Export commits onto `setup/<role>/<name>` without touching the clone's checkout: the files go
 * straight into git's object store through a temporary index. The clone's working tree, index and
 * current branch stay exactly as they were, so `rooms team sync`, which commits and pushes the
 * current branch, can never carry a setup that nobody pushed on purpose.
 *
 * Reading goes through git too. A setup is read at a commit, never from the working tree, so what
 * was shown is what is adopted, and an edit sitting in someone's clone is not part of it. Only the
 * paths a checked manifest allows are ever read.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePathFor, installPlace, TOOLS } from "./manifest.js";

export const branchFor = (role, name) => `setup/${role}/${name}`;
export const dirFor = (role, name) => `setups/${role}/${name}`;

/**
 * git, with extra environment and its output kept whole: a blob is returned byte for byte. Only a
 * command given `input` gets a pipe to read it from. On Linux, writing to that pipe after git has
 * exited fails even when there is nothing to write, and a fast `git rev-parse` under load can exit
 * before the write: that crashed export on CI. A command that stops before reading all its input
 * has answered with its exit code, so the broken pipe is not a second error.
 */
export function runGit(cwd, args, { input = null, env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      timeout,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...env },
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => resolve({ ok: false, out: "", err: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8").trim() }));
    if (input !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

const git = runGit;

/**
 * Commit `files` (relative path → { content, executable }) as the whole of `setups/<role>/<name>/`,
 * onto `setup/<role>/<name>`: on top of that branch if it exists, otherwise on the clone's HEAD.
 * Nothing is pushed, and nothing outside that folder changes.
 */
export async function commitSetup({ clone, role, name, files, message }) {
  const branch = branchFor(role, name);
  const dir = dirFor(role, name);
  const head = await git(clone, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (head.ok && head.out.trim() === branch) {
    return { ok: false, why: `the team room's clone has ${branch} checked out; switch it back (git -C "${clone}" switch -) and export again` };
  }
  const tip = await git(clone, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`]);
  const old = tip.ok ? tip.out.trim() : "";
  const baseAt = old ? tip : await git(clone, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  if (!baseAt.ok) return { ok: false, why: "the team room has no commit yet" };
  const base = baseAt.out.trim();
  const index = join(tmpdir(), `iops-rooms-index-${randomBytes(6).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const steps = [
      await git(clone, ["read-tree", base], { env }),
      await git(clone, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", dir], { env }),
    ];
    for (const [rel, { content, executable }] of files) {
      // No --path, so no filter or line-ending rule changes the bytes on their way in.
      const blob = await git(clone, ["hash-object", "-w", "--stdin"], { input: content });
      steps.push(blob);
      if (!blob.ok) break;
      steps.push(await git(clone, ["update-index", "--add", "--cacheinfo", `${executable ? "100755" : "100644"},${blob.out.trim()},${dir}/${rel}`], { env }));
    }
    const failed = steps.find((s) => !s.ok);
    if (failed) return { ok: false, why: `git could not stage it: ${failed.err}` };
    const tree = await git(clone, ["write-tree"], { env });
    const baseTree = await git(clone, ["rev-parse", `${base}^{tree}`]);
    if (!tree.ok || !baseTree.ok) return { ok: false, why: `git could not stage it: ${tree.err || baseTree.err}` };
    if (tree.out.trim() === baseTree.out.trim()) return { ok: true, unchanged: true, branch, commit: base };
    const commit = await git(clone, ["commit-tree", tree.out.trim(), "-p", base, "-m", message]);
    if (!commit.ok) return { ok: false, why: `git could not commit it: ${commit.err}` };
    const id = commit.out.trim();
    // The branch moves only from the tip this export started from, and is created only if absent.
    const moved = await git(clone, ["update-ref", "-m", "rooms setup export", `refs/heads/${branch}`, id, old]);
    if (!moved.ok) return { ok: false, why: `git could not move ${branch}: ${moved.err}` };
    return { ok: true, branch, commit: id, created: !old };
  } finally {
    await rm(index, { force: true });
  }
}

/** A revision of the team room as a full commit id, or null. */
export async function resolveCommit(clone, rev = "HEAD") {
  const r = await git(clone, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]);
  return r.ok ? r.out.trim() : null;
}

/** Every setup at a commit, as `{ role, name }`. */
export async function listSetups(clone, commit) {
  const r = await git(clone, ["ls-tree", "-r", "-z", "--name-only", commit, "--", "setups/"]);
  if (!r.ok) return [];
  const found = [];
  for (const path of r.out.split("\0")) {
    const m = /^setups\/([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,39})\/setup\.json$/.exec(path);
    if (m) found.push({ role: m[1], name: m[2] });
  }
  return found;
}

/**
 * Catalog metadata from setup.json only — never file bodies.
 * Allowlisted: role, name, owner, summary, cost (declared), exportedWith, tools present + file counts.
 */
export function catalogMetaFromManifest(role, name, manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const tools = {};
  for (const [tool, part] of Object.entries(manifest.tools || {})) {
    if (!part || typeof part !== "object") continue;
    const files = Array.isArray(part.files) ? part.files.length : 0;
    tools[String(tool).slice(0, 40)] = {
      checkedAgainst: typeof part.checkedAgainst === "string" ? part.checkedAgainst.slice(0, 80) : null,
      files,
    };
  }
  return {
    v: 1,
    kind: "setup_catalog_entry",
    role: String(role).slice(0, 40),
    name: String(name).slice(0, 40),
    owner: typeof manifest.owner === "string" ? manifest.owner.slice(0, 39) : null,
    summary: typeof manifest.summary === "string" ? manifest.summary.slice(0, 300) : null,
    cost:
      manifest.cost && typeof manifest.cost === "object"
        ? {
            usdPerMonth: Number.isFinite(manifest.cost.usdPerMonth) ? manifest.cost.usdPerMonth : null,
            what: typeof manifest.cost.what === "string" ? manifest.cost.what.slice(0, 120) : null,
          }
        : null,
    exportedWith: typeof manifest.exportedWith === "string" ? manifest.exportedWith.slice(0, 60) : null,
    tools,
  };
}

/** Read only setups/.../setup.json for catalog — never install targets or file contents. */
export async function readSetupMetaAt(clone, commit, role, name) {
  const dir = dirFor(role, name);
  const text = await blob(clone, commit, `${dir}/setup.json`);
  if (text === null) return { found: false };
  try {
    const manifest = JSON.parse(text);
    const meta = catalogMetaFromManifest(role, name, manifest);
    return meta ? { found: true, meta } : { found: true, meta: null };
  } catch {
    return { found: true, meta: null };
  }
}

/** Full catalog for a team room commit. */
export async function listSetupCatalog(clone, commit) {
  const setups = await listSetups(clone, commit);
  const entries = [];
  for (const { role, name } of setups) {
    const { meta } = await readSetupMetaAt(clone, commit, role, name);
    if (meta) entries.push(meta);
  }
  return {
    v: 1,
    kind: "setup_catalog",
    at: new Date().toISOString(),
    commit: String(commit).slice(0, 40),
    count: entries.length,
    setups: entries,
  };
}

async function blob(clone, commit, path) {
  const r = await git(clone, ["cat-file", "blob", `${commit}:${path}`]);
  return r.ok ? r.out : null;
}

/**
 * A setup as it is at `commit`: its manifest and the text of each file it lists, read only from a
 * path the manifest may name. `{ found: false }` when there is no such setup.
 */
export async function readSetupAt(clone, commit, role, name) {
  const dir = dirFor(role, name);
  const text = await blob(clone, commit, `${dir}/setup.json`);
  if (text === null) return { found: false };
  let manifest = null;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { found: true, manifest: null, files: new Map(), problems: ["setup.json is not valid JSON"] };
  }
  const files = new Map();
  for (const tool of TOOLS) {
    const part = manifest?.tools && Object.prototype.hasOwnProperty.call(manifest.tools, tool) ? manifest.tools[tool] : null;
    const list = part && Array.isArray(part.files) ? part.files.slice(0, 500) : [];
    for (const f of list) {
      if (!f || typeof f.installTo !== "string" || !installPlace(f.installTo, f.kind, tool) || f.path !== filePathFor(f.installTo, tool)) continue;
      const t = await blob(clone, commit, `${dir}/${f.path}`);
      if (t !== null) files.set(f.path, t);
    }
  }
  return { found: true, manifest, files, problems: [] };
}

const parseLog = (line) => {
  const [full, short, author, at] = String(line || "").split("\t");
  return full ? { commit: full, short, author, at } : null;
};

/** The commit, at or before `commit`, that first added `needle` to `path`, or that first added the file. */
export async function whoAdded(clone, commit, path, needle = null) {
  const args = ["log", "--reverse", "--format=%H%x09%h%x09%an%x09%aI"];
  if (needle) args.push(`-S${needle}`);
  else args.push("--diff-filter=A");
  const r = await git(clone, [...args, commit, "--", path]);
  return r.ok ? parseLog(r.out.split("\n").find(Boolean)) : null;
}

/** The last commit, at or before `commit`, that changed anything under `path`. */
export async function lastChange(clone, commit, path) {
  const r = await git(clone, ["log", "-1", "--format=%H%x09%h%x09%an%x09%aI", commit, "--", path]);
  return r.ok ? parseLog(r.out.trim()) : null;
}
