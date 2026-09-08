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

/**
 * A remote URL, safe to put on a page.
 *
 * `git remote get-url` returns exactly what is configured, and a remote configured over HTTPS in CI
 * or on a shared box is often `https://x-access-token:ghp_…@github.com/owner/repo`. The board is a
 * file people screenshot and paste into issues, so the credential is stripped before it can be
 * rendered — not at the point of rendering, where the next caller would have to remember.
 *
 * Returns `{ host, path, label }`; label is what to show. Never the password.
 */
export function sanitizeRemote(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  // scp-style: git@github.com:owner/repo.git — no scheme, so URL() will not parse it.
  const scp = raw.match(/^(?:([^@/]+)@)?([^:/]+):(.+)$/);
  // `C:\Users\me\origin.git` matches the scp-style shape with a "host" of `C`. On Windows CI a
  // clone from a local directory was reported as the remote `C/Users/...`, which is not a forge and
  // not a place anybody can visit. A drive letter is one character; a hostname never is.
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return null;
  let host = "";
  let path = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else if (scp && !raw.includes("://")) {
    host = scp[2];
    path = scp[3];
  } else {
    return null;
  }
  path = path.replace(/^\/+/, "").replace(/\.git$/i, "");
  if (!host || !path) return null;
  return { host, path, label: `${host}/${path}` };
}

/** Ahead/behind against the configured upstream, or nulls when there is no upstream to compare to. */
async function readTracking(projectDir) {
  const upstream = await git(projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream) return { upstream: "", ahead: null, behind: null };
  const counts = await git(projectDir, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n));
  return {
    upstream,
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

/** Local git snapshot. Env ROOMS_BRANCH overrides current branch for smoke. */
export async function readGitSnapshot(projectDir) {
  const envBranch = (process.env.ROOMS_BRANCH || "").trim();
  const inside = await git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true" && !envBranch) {
    return {
      ok: false,
      current: "",
      defaultBranch: "",
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
  // Was 16, which silently cut a real branch out of the list and left the board calling it "not a
  // branch in this checkout". The panel groups finished branches behind a disclosure now, so a long
  // list costs nothing; the bound is only here so a pathological repo cannot render forever.
  branches = branches.slice(0, 500);
  // Exactly one branch is the default. Asking git rather than matching /^(main|master)$/ — a repo
  // part-way through a rename has both, and badging both "default" says the board does not know.
  const originHead = await git(projectDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let defaultBranch = originHead ? originHead.replace(/^origin\//, "") : "";
  if (!defaultBranch || !branches.includes(defaultBranch)) {
    defaultBranch = ["main", "master", "trunk", "develop"].find((n) => branches.includes(n)) || current || "";
  }
  const remote = sanitizeRemote(await git(projectDir, ["remote", "get-url", "origin"]));
  const porcelain = await git(projectDir, ["status", "--porcelain"]);
  const dirty = porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0;
  const tracking = await readTracking(projectDir);
  return {
    ok: true,
    current,
    defaultBranch,
    branches,
    head,
    remote,
    dirty,
    ...tracking,
    note: "Read from the local checkout. Nothing is fetched and nothing is pushed.",
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
