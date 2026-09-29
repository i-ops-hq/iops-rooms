import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { describeGitError } from "./git-history.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT = 4000;

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
 * Why git gave no answer here: one of four reasons, in git's own words where it gave any.
 *
 * The board used to read every git failure as "not a git checkout" and advise `git init`. Someone
 * whose repository git would not open, because another user owns it, or who started Rooms from a
 * shell with no git, was told their project was not a project. `rooms week` has named the real cause
 * since 0.5.2; this gives the board, `doctor` and everything else that reads the checkout through
 * here the same answer.
 *
 * - `not-a-repo`: nothing is wrong. This folder is not inside a repository.
 * - `git-missing`: there is no git on the PATH this process was started with.
 * - `git-refused`: git found the repository and declined it for dubious ownership, which WSL paths,
 *   external drives and clones made with sudo all produce. git's first line does not carry the fix
 *   and a later one does (`git config --global --add safe.directory …`), so that line is kept as `fix`.
 * - `git-failed`: anything else, such as a timeout, or macOS's stub git before the command line tools
 *   are installed, with the first line git printed.
 */
export function classifyGitFailure(err, timeout = PROBE_TIMEOUT) {
  const stderr = String(err?.stderr || "");
  if (err?.code === "ENOENT") return { reason: "git-missing", detail: describeGitError(err, [], timeout), fix: "" };
  if (/not a git repository/i.test(stderr)) return { reason: "not-a-repo", detail: "", fix: "" };
  const detail = describeGitError(err, ["rev-parse"], timeout);
  if (/dubious ownership/i.test(stderr)) {
    const fix = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("git config --global --add safe.directory"));
    return { reason: "git-refused", detail, fix: fix || "" };
  }
  return { reason: "git-failed", detail, fix: "" };
}

/** Whether `dir` is inside a git working tree and, when it is not, why (see classifyGitFailure). */
export async function probeCheckout(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      timeout: PROBE_TIMEOUT,
      maxBuffer: 256_000,
      // git translates its messages, and the four reasons are told apart by them: under a German
      // locale "not a git repository" arrives as "Kein Git-Repository" and would read as a failure.
      env: { ...process.env, LC_ALL: "C" },
    });
    return String(stdout || "").trim() === "true"
      ? { ok: true, reason: "", detail: "", fix: "" }
      : { ok: false, reason: "not-a-repo", detail: "", fix: "" };
  } catch (err) {
    return { ok: false, ...classifyGitFailure(err) };
  }
}

/** The sentence for a checkout git could not read, by reason. */
export function unreadableNote(probe) {
  switch (probe?.reason) {
    case "git-missing":
      return "git is not on the PATH Rooms was started with, so nothing here can be read from git. Start Rooms from a shell where `git --version` works.";
    case "git-refused":
      return `git refused to read this repository: ${probe.detail}${probe.fix ? ` git's own fix: ${probe.fix}` : ""}`;
    case "git-failed":
      return `git failed here: ${probe.detail}`;
    default:
      return "Not a git checkout — branch stamps stay empty until you init git or set ROOMS_BRANCH.";
  }
}

/**
 * The git repositories inside `dir`, one or two folders down.
 *
 * `rooms open` in the folder that holds somebody's projects made a room there, and a board that could
 * read none of them. This is what they meant instead. Asked of the filesystem rather than of git,
 * because the only question is where the command should have been run, and a `.git` entry (a folder,
 * or the file a worktree or submodule has) is enough to point at.
 */
export async function repositoriesBelow(dir, { depth = 2, limit = 50 } = {}) {
  const found = [];
  async function walk(folder, level) {
    if (level > depth || found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(folder, entry.name);
      try {
        await stat(join(child, ".git"));
        found.push(child);
        continue;
      } catch {
        /* not a repository; look one level further */
      }
      await walk(child, level + 1);
    }
  }
  await walk(resolve(dir), 1);
  return found.sort();
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

/** `git diff --shortstat` as numbers: " 3 files changed, 10 insertions(+), 2 deletions(-)". */
export function parseShortstat(text) {
  const n = (re) => Number((String(text || "").match(re) || [])[1] || 0);
  return { added: n(/(\d+) insertions?\(\+\)/), removed: n(/(\d+) deletions?\(-\)/) };
}

/**
 * What is not committed yet, as counts only: tracked files changed, staged or not, with their
 * lines; and new files git does not track yet. Which files is not kept, since this is what a
 * member's status will carry to their team (docs/design/TEAM_LIVE.md §4.1). Lines are null when git
 * could not say: before the first commit there is no HEAD to compare with, and a diff too large to
 * finish in time is not reported as nothing.
 */
async function readUncommitted(projectDir, changes, head) {
  const untracked = changes.filter((line) => line.startsWith("??")).length;
  const files = changes.length - untracked;
  if (!files) return { files, added: 0, removed: 0, untracked };
  const stat = head ? await git(projectDir, ["diff", "--shortstat", "HEAD"]) : "";
  if (!stat) return { files, added: null, removed: null, untracked };
  return { files, ...parseShortstat(stat), untracked };
}

/** "+1,000 −21 in 14 files, and 3 new files": what is not committed, as counts. Empty when clean. */
export function uncommittedWords(u) {
  if (!u || (!u.files && !u.untracked)) return "";
  const n = (v) => Number(v).toLocaleString("en-US");
  const files = u.files ? `${n(u.files)} file${u.files === 1 ? "" : "s"}` : "";
  const lines = u.files && u.added != null ? `+${n(u.added)} −${n(u.removed)} in ` : "";
  const fresh = u.untracked ? `${n(u.untracked)} new file${u.untracked === 1 ? "" : "s"}` : "";
  return [files && `${lines}${files}`, fresh].filter(Boolean).join(", and ");
}

/** Where the branch stands against its upstream, as the board's Git card and `rooms week` say it. */
export function trackingWords(git) {
  if (!git || !git.upstream) {
    return { state: "none", text: git && git.remote ? "this branch tracks nothing yet" : "no remote configured" };
  }
  const ab = [];
  if (git.ahead) ab.push(`${git.ahead} ahead`);
  if (git.behind) ab.push(`${git.behind} behind`);
  return ab.length
    ? { state: "warn", text: `${ab.join(", ")} ${git.upstream}` }
    : { state: "ok", text: `in step with ${git.upstream}` };
}

/** Local git snapshot. Env ROOMS_BRANCH overrides current branch for smoke. */
export async function readGitSnapshot(projectDir) {
  const envBranch = (process.env.ROOMS_BRANCH || "").trim();
  const probe = await probeCheckout(projectDir);
  if (!probe.ok && !envBranch) {
    return {
      ok: false,
      reason: probe.reason,
      detail: probe.detail,
      fix: probe.fix,
      current: "",
      defaultBranch: "",
      branches: [],
      head: "",
      note: unreadableNote(probe),
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
  const changes = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
  const dirty = changes.length;
  const tracking = await readTracking(projectDir);
  // Whether the remote already has this branch, as far as this clone knows: it tracks an upstream,
  // or origin has a branch of the same name. Only such a branch is asked about on GitHub, so a
  // local branch's name is never sent anywhere it was not already pushed.
  const published = Boolean(
    tracking.upstream ||
      (current && current !== "HEAD" && (await git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${current}`]))),
  );
  return {
    ok: true,
    current,
    defaultBranch,
    branches,
    head,
    remote,
    dirty,
    uncommitted: await readUncommitted(projectDir, changes, head),
    published,
    ...tracking,
    note: "Read from the local checkout. Nothing is fetched and nothing is pushed.",
  };
}

/**
 * The project a command is about, from anywhere inside it.
 *
 * Running `rooms open` in `src/api/` used to create `src/api/.room/` and call the project "api".
 * Two people in the same repo working from different subdirectories got two different rooms, the
 * `.gitignore` and merge driver landed in the wrong place, and the board was named after a folder.
 * A repository is one project, so a command run anywhere inside it is about the whole thing.
 *
 * Falls back to the directory itself when there is no repo — a plain folder can still hold a room.
 */
export async function resolveProjectRoot(cwd = process.cwd()) {
  return (await repositoryTop(cwd)) || resolve(cwd);
}

/**
 * The top of the repository `cwd` is in, spelled the way the person reached it, or "" outside one.
 *
 * Also the ceiling for finding a room: a room above the top of a repository belongs to the folder
 * holding it, not to the repository (see findRoomDir in store.js).
 */
export async function repositoryTop(cwd = process.cwd()) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return "";

  // git reports the toplevel with symlinks resolved, which is often not the path the person typed:
  // a workspace under a symlinked home, or macOS's /var -> /private/var, and `rooms open` answers
  // with a directory they have never seen. Walk up from THEIR spelling to the first ancestor that
  // is the same directory as the toplevel, and answer in that.
  let realTop;
  try {
    realTop = await realpath(top);
  } catch {
    return top;
  }
  let here = resolve(cwd);
  for (;;) {
    try {
      if ((await realpath(here)) === realTop) return here;
    } catch {
      /* a path that cannot be resolved cannot be the root */
    }
    const parent = dirname(here);
    if (parent === here) return top;
    here = parent;
  }
}

/**
 * Where a checkout's room lives: the top of the main checkout, for the main checkout and for every
 * worktree of it. "" outside a repository.
 *
 * People running agents in parallel give each one a worktree on its own branch. A worktree beside the
 * main checkout (`git worktree add ../feature`) found no room, because the search walked up folders
 * and never passed through the main one; one nested inside it (`.claude/worktrees/…`) found the room
 * only because the folders happened to line up. git already knows they are one repository: every
 * worktree shares the main checkout's `.git`, which `--git-common-dir` names. A bare repository's
 * common directory is not inside any checkout, so a worktree of one keeps its own top.
 *
 * `top` may be passed when the caller already has it, to save a git call.
 */
export async function roomHome(cwd = process.cwd(), top = null) {
  const checkoutTop = top ?? (await repositoryTop(cwd));
  if (!checkoutTop) return "";
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || basename(common) !== ".git") return checkoutTop;
  const mainTop = dirname(common);
  try {
    if ((await realpath(mainTop)) === (await realpath(checkoutTop))) return checkoutTop;
  } catch {
    return checkoutTop;
  }
  return mainTop;
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
