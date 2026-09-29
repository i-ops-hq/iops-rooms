import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGitSnapshot } from "./git-info.js";

const execFileAsync = promisify(execFile);

async function run(cwd, cmd, args, timeout = 8000) {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd,
    timeout,
    maxBuffer: 512_000,
  });
  return String(stdout || "").trim();
}

async function hasGh(cwd) {
  try {
    await run(cwd, "gh", ["--version"], 3000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only SCM status. GitHub via `gh` when auth works; GitLab stubbed honest.
 * Never uploads Rooms data.
 */
export async function scmStatus(projectDir, opts = {}) {
  const provider = (opts.provider || "github").toLowerCase();
  const git = await readGitSnapshot(projectDir);

  if (provider === "gitlab") {
    return {
      ok: false,
      provider: "gitlab",
      git,
      message:
        "GitLab connect is a stub this slice — use local `rooms branches` for now. GitHub via gh ships first.",
    };
  }

  if (!(await hasGh(projectDir))) {
    return {
      ok: false,
      provider: "github",
      git,
      message:
        "gh not available. Install GitHub CLI and `gh auth login` for branch/PR reads. Local git still works via rooms branches.",
      localBranches: git.branches,
      current: git.current,
    };
  }

  try {
    const repoRaw = await run(projectDir, "gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner,url,defaultBranchRef",
    ]);
    const prsRaw = await run(projectDir, "gh", [
      "pr",
      "list",
      "--limit",
      "8",
      "--json",
      "number,title,headRefName,author,isDraft,url",
    ]);
    let remoteBranches = [];
    try {
      const brRaw = await run(projectDir, "gh", [
        "api",
        "repos/{owner}/{repo}/branches",
        "--jq",
        ".[].name",
      ]);
      remoteBranches = brRaw
        ? brRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20)
        : [];
    } catch {
      remoteBranches = [];
    }

    const repo = JSON.parse(repoRaw || "{}");
    const openPrs = JSON.parse(prsRaw || "[]");
    return {
      ok: true,
      provider: "github",
      git,
      repo,
      openPrs,
      remoteBranches,
      localBranches: git.branches,
      current: git.current,
      message:
        "Read-only via gh on this machine. Not an I-Ops account — your token stays local.",
    };
  } catch (err) {
    return {
      ok: false,
      provider: "github",
      git,
      localBranches: git.branches,
      current: git.current,
      message: `gh present but failed: ${err.message || err}. Try gh auth status.`,
    };
  }
}

export function formatScmStatus(s) {
  const lines = [];
  lines.push(`${s.ok ? "ok" : "degraded"}  ${s.provider}`);
  lines.push(s.message);
  if (s.current) lines.push(`local    ${s.current}`);
  if (s.localBranches?.length) {
    lines.push(`local branches: ${s.localBranches.slice(0, 12).join(", ")}`);
  }
  if (s.ok && s.repo?.nameWithOwner) {
    lines.push(`repo     ${s.repo.nameWithOwner}`);
    lines.push(`default  ${s.repo.defaultBranchRef?.name || "?"}`);
    if (s.remoteBranches?.length) {
      lines.push(`remote branches (sample): ${s.remoteBranches.slice(0, 12).join(", ")}`);
    }
    for (const pr of s.openPrs || []) {
      const who = pr.author?.login || "?";
      const draft = pr.isDraft ? " draft" : "";
      lines.push(`pr #${pr.number}${draft}  ${pr.headRefName}  @${who}  ${pr.title}`);
    }
    if (!(s.openPrs || []).length) lines.push("prs      (none open)");
  }
  return lines.join("\n") + "\n";
}

const PR_CACHE = new Map();
const PR_TTL_MS = 60_000;

/**
 * This branch's pull request, asked of GitHub through the person's own `gh`: one `gh pr view`,
 * which sends the repository and the branch name, and nothing else, to the GitHub their remote
 * already points at, and only for a branch that remote already has. `ROOMS_NO_GH=1` turns it off.
 *
 * Every way of not knowing is kept apart from "none": no `gh`, not signed in, no answer in time.
 * Only GitHub saying it found no pull request for the branch is "none", which the board shows as
 * "no pull request yet". On the default branch nothing is asked; a pull request is not expected.
 *
 * Remembered for a minute per branch, so a live board refreshing on every edit asks once a minute.
 */
export async function branchPullRequest(projectDir, git, { env = process.env, runGh = run, now = Date.now() } = {}) {
  if (!git || !git.ok || !git.current || git.current === "HEAD") return { state: "unknown", why: "no branch is checked out" };
  if (git.defaultBranch && git.current === git.defaultBranch) return { state: "default-branch" };
  if (!git.remote) return { state: "unknown", why: "no hosted remote to ask" };
  // Known here, without asking: a branch the remote does not have cannot head a pull request, and
  // asking would tell GitHub a local branch's name it has never been given.
  if (!git.published) return { state: "unpushed" };
  if (env.ROOMS_NO_GH) return { state: "unknown", why: "ROOMS_NO_GH is set" };
  const key = `${projectDir}\u0000${git.current}`;
  const hit = PR_CACHE.get(key);
  if (hit && now - hit.at < PR_TTL_MS) return hit.value;
  let value;
  try {
    const raw = await runGh(projectDir, "gh", ["pr", "view", git.current, "--json", "number,state,isDraft,url"], 6000);
    const pr = JSON.parse(raw || "{}");
    const state = pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : String(pr.state || "").toLowerCase();
    value = Number.isInteger(pr.number) && ["open", "draft", "merged", "closed"].includes(state)
      ? { state, number: pr.number, url: typeof pr.url === "string" ? pr.url : "" }
      : { state: "unknown", why: "gh answered in a shape this version does not read" };
  } catch (err) {
    const said = String(err?.stderr || err?.message || "");
    if (err?.code === "ENOENT") value = { state: "unknown", why: "gh is not installed" };
    else if (err?.killed || err?.signal === "SIGTERM") value = { state: "unknown", why: "GitHub did not answer in time" };
    else if (/no pull requests found/i.test(said)) value = { state: "none" };
    else if (/gh auth login|not logged in|authentication/i.test(said)) value = { state: "unknown", why: "gh is not signed in" };
    else if (/known GitHub host|none of the git remotes/i.test(said)) value = { state: "unknown", why: "the remote is not on GitHub" };
    else value = { state: "unknown", why: "gh could not say" };
  }
  PR_CACHE.set(key, { at: now, value });
  return value;
}

/** The pull request as a few words, for the board and the terminal alike. Empty on the default branch. */
export function pullRequestWords(pr) {
  if (!pr || pr.state === "default-branch") return "";
  if (pr.state === "none") return "no pull request yet";
  if (pr.state === "unpushed") return "not pushed yet, so no pull request";
  if (pr.state === "unknown") return `pull request unknown: ${pr.why}`;
  const said = { open: "open", draft: "a draft", merged: "merged", closed: "closed without merging" }[pr.state];
  return `pull request #${pr.number}, ${said}`;
}
