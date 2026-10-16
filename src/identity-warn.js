/**
 * Traceability warn: GitHub login about to sync vs this project's git author.
 * Never merges two people; prints a floor and asks on first share / when mismatched.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitConfig(cwd, key) {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", key], {
      cwd,
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
    });
    return String(stdout || "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ ok: true } | { ok: false, why: string, detail: string }}
 */
export async function authorLoginMismatch(projectDir, login, { runGit = gitConfig } = {}) {
  if (!login) return { ok: true };
  const name = await runGit(projectDir, "user.name");
  const email = await runGit(projectDir, "user.email");
  if (!name && !email) return { ok: true }; // nothing to compare

  const loginLower = String(login).toLowerCase();
  const emailLocal = email ? email.split("@")[0].toLowerCase() : "";
  const nameFlat = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const loginFlat = loginLower.replace(/[^a-z0-9]/g, "");

  // Match if email local-part or sanitized name equals login (common gh noreply forms too).
  const emailOk =
    !email ||
    emailLocal === loginLower ||
    email.toLowerCase().includes(`${loginLower}@`) ||
    email.toLowerCase().includes(`${loginLower}@users.noreply.github.com`) ||
    /^\d+\+/.test(emailLocal) && emailLocal.endsWith(loginLower);

  const nameOk = !name || nameFlat === loginFlat || nameFlat.includes(loginFlat) || loginFlat.includes(nameFlat);

  if (emailOk || nameOk) return { ok: true };

  return {
    ok: false,
    why: "git author on this project does not look like the GitHub login that will sync",
    detail:
      `sync as @${login}` +
      (name ? `, git user.name=${JSON.stringify(name)}` : "") +
      (email ? `, user.email=${JSON.stringify(email)}` : "") +
      ". Rooms will not merge two identities. Continue only if that is intentional.",
  };
}
