import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Honest SCM sketch — GitHub via `gh` when available.
 * Does not upload Rooms data. Degrades if gh/token missing.
 */
export async function scmStatus(projectDir) {
  try {
    const { stdout: which } = await execFileAsync("gh", ["--version"], {
      cwd: projectDir,
      timeout: 3000,
    });
    if (!which) throw new Error("no gh");
  } catch {
    return {
      ok: false,
      provider: "github",
      message:
        "gh not available. Install GitHub CLI and auth (`gh auth login`) for optional SCM status. Rooms itself stays local.",
    };
  }
  try {
    const { stdout: repo } = await execFileAsync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"],
      { cwd: projectDir, timeout: 8000 },
    );
    const { stdout: prs } = await execFileAsync(
      "gh",
      ["pr", "list", "--limit", "5", "--json", "number,title,headRefName,author"],
      { cwd: projectDir, timeout: 8000 },
    );
    return {
      ok: true,
      provider: "github",
      repo: JSON.parse(repo || "{}"),
      openPrs: JSON.parse(prs || "[]"),
      message: "Read-only via gh. Not connected as a Rooms account — your token, your machine.",
    };
  } catch (err) {
    return {
      ok: false,
      provider: "github",
      message: `gh present but repo view failed: ${err.message || err}. Auth or cwd may be wrong.`,
    };
  }
}
