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
