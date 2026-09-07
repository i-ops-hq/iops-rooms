import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 4000,
      maxBuffer: 256_000,
    });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

/** Local git snapshot. Env ROOMS_BRANCH overrides current branch for smoke. */
export async function readGitSnapshot(projectDir) {
  const envBranch = (process.env.ROOMS_BRANCH || "").trim();
  const inside = await git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true" && !envBranch) {
    return {
      ok: false,
      current: "",
      branches: [],
      head: "",
      note: "Not a git checkout — branch stamps stay empty until you init git or set ROOMS_BRANCH.",
    };
  }
  const current =
    envBranch ||
    (await git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])) ||
    "";
  const head = await git(projectDir, ["rev-parse", "--short", "HEAD"]);
  const listRaw = await git(projectDir, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  let branches = listRaw
    ? listRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  if (current && !branches.includes(current)) branches = [current, ...branches];
  branches = branches.slice(0, 16);
  return {
    ok: true,
    current,
    branches,
    head,
    note: "Local git only — remotes/PRs land in a later SCM slice.",
  };
}

export async function resolveBranch(projectDir) {
  const envBranch = (process.env.ROOMS_BRANCH || "").trim();
  if (envBranch) return envBranch;
  const snap = await readGitSnapshot(projectDir);
  return snap.current || "";
}

/**
 * Best-effort repo leaf name from origin URL or git toplevel basename.
 * Never throws — empty string when not a git checkout.
 */
export async function resolveGitRepoName(projectDir) {
  const url = await git(projectDir, ["remote", "get-url", "origin"]);
  if (url) {
    let leaf = url.trim().replace(/\.git$/i, "");
    leaf = leaf.split(/[/:]/).filter(Boolean).pop() || "";
    if (leaf && leaf !== "." && leaf !== "..") return leaf;
  }
  const top = await git(projectDir, ["rev-parse", "--show-toplevel"]);
  if (top) {
    const leaf = basename(top);
    if (leaf && leaf !== "." && leaf !== "..") return leaf;
  }
  return "";
}
