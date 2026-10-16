/**
 * Share metadata and inbox (D6): request/grant records in the team hub, plus GitHub Issues as the
 * notification bus. Ciphertext blobs are optional via the `age` CLI when present — otherwise the
 * meta points at an existing setups/ path (Tier A) or a peer must pull.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitIn, pullTeamRoom } from "./team.js";

const execFileAsync = promisify(execFile);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function shareId() {
  return randomBytes(8).toString("hex");
}

/** Allowlisted share_meta for the team hub. */
export function validShareMeta(data) {
  if (!data || data.v !== 1 || data.kind !== "share_meta") return null;
  if (typeof data.id !== "string" || !/^[a-f0-9]{8,32}$/.test(data.id)) return null;
  if (typeof data.at !== "string" || !Number.isFinite(Date.parse(data.at))) return null;
  if (typeof data.from !== "string" || !LOGIN.test(data.from)) return null;
  if (!Array.isArray(data.to) || data.to.length < 1 || data.to.length > 20) return null;
  if (data.to.some((t) => typeof t !== "string" || !LOGIN.test(t))) return null;
  if (!["setup", "request", "doc", "pointer"].includes(data.type)) return null;
  if (typeof data.ref !== "string" || !data.ref || data.ref.length > 200) return null;
  if (data.issue != null && !Number.isInteger(data.issue)) return null;
  if (data.pointer != null && (typeof data.pointer !== "string" || data.pointer.length > 300)) return null;
  if (data.note != null && (typeof data.note !== "string" || data.note.length > 200)) return null;
  // Refuse absolute paths and home dirs in ref/pointer.
  if (/^[/\\]|^~|^\.\./.test(data.ref) || (data.pointer && /^[/\\]|^~/.test(data.pointer))) return null;
  return data;
}

export function sharePath(id) {
  return `shares/${id}.json`;
}

/** `owner/repo` from a registry remote label like `github.com/owner/repo`. */
export function githubRepoFromRemote(remote) {
  if (!remote || typeof remote !== "string") return null;
  const s = remote.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  const m = s.match(/(?:^github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/);
  return m ? m[1] : null;
}

export async function readShares(clonePath) {
  const out = [];
  let skipped = 0;
  let names = [];
  try {
    names = await readdir(join(clonePath, "shares"));
  } catch {
    return { shares: out, skipped };
  }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta = validShareMeta(JSON.parse(await readFile(join(clonePath, "shares", f), "utf8")));
      if (meta) out.push(meta);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { shares: out, skipped };
}

export function buildShareMeta({
  id = shareId(),
  from,
  to,
  type = "request",
  ref,
  issue = null,
  pointer = null,
  note = null,
  now = new Date(),
}) {
  const meta = {
    v: 1,
    kind: "share_meta",
    id,
    at: `${now.toISOString().slice(0, 16)}Z`,
    from,
    to: [...to],
    type,
    ref: String(ref).slice(0, 200),
    ...(issue != null ? { issue } : {}),
    ...(pointer ? { pointer: String(pointer).slice(0, 300) } : {}),
    ...(note ? { note: String(note).slice(0, 200) } : {}),
  };
  return validShareMeta(meta);
}

/** Commit share meta into the team room (member's git). */
export async function commitShare({ clonePath, meta, extraPaths = [] }) {
  const ok = validShareMeta(meta);
  if (!ok) return { ok: false, why: "share meta failed validation" };
  const rel = sharePath(ok.id);
  await mkdir(join(clonePath, "shares"), { recursive: true });
  await writeFile(join(clonePath, rel), `${JSON.stringify(ok, null, 2)}\n`, "utf8");
  const paths = [rel, ...extraPaths];
  const add = await gitIn(clonePath, ["add", "--", ...paths]);
  if (!add.ok) return { ok: false, why: add.err };
  const commit = await gitIn(clonePath, ["commit", "-q", "-m", `share: ${ok.type} ${ok.ref}`, "--", ...paths]);
  if (!commit.ok) return { ok: false, why: commit.err || commit.out };
  let push = await gitIn(clonePath, ["push", "-q"]);
  if (!push.ok && /rejected|fetch first|non-fast-forward/i.test(push.err)) {
    const rebase = await gitIn(clonePath, ["pull", "--rebase", "--autostash", "-q"]);
    if (!rebase.ok) return { ok: false, why: rebase.err };
    push = await gitIn(clonePath, ["push", "-q"]);
  }
  if (!push.ok) return { ok: false, why: push.err, committed: true };
  return { ok: true, rel, meta: ok };
}

async function runGh(args) {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30000,
    maxBuffer: 1_000_000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  return String(stdout || "").trim();
}

/** Open a GitHub Issue on the team hub for inbox notification. Returns issue number or null. */
export async function openShareIssue({ remotePath, meta, dryRun = false }) {
  if (!remotePath || typeof remotePath !== "string") return null;
  const title = `[rooms] ${meta.type}: ${meta.ref} → ${meta.to.map((t) => `@${t}`).join(" ")}`;
  const body =
    `Rooms share metadata (no secrets).\n\n` +
    `- **from:** @${meta.from}\n` +
    `- **to:** ${meta.to.map((t) => `@${t}`).join(", ")}\n` +
    `- **type:** ${meta.type}\n` +
    `- **ref:** \`${meta.ref}\`\n` +
    `- **id:** \`${meta.id}\`\n` +
    (meta.pointer ? `- **pointer:** \`${meta.pointer}\`\n` : "") +
    (meta.note ? `\n${meta.note}\n` : "") +
    `\nAccept with: \`rooms share show ${meta.id}\` then adopt/pull as appropriate.\n`;
  if (dryRun) return { number: null, title, body };
  try {
    const out = await runGh([
      "issue",
      "create",
      "--repo",
      remotePath,
      "--title",
      title,
      "--body",
      body,
      "--assignee",
      meta.to[0],
    ]);
    const m = out.match(/\/issues\/(\d+)/);
    return { number: m ? Number(m[1]) : null, url: out.trim() };
  } catch (e) {
    try {
      const out = await runGh(["issue", "create", "--repo", remotePath, "--title", title, "--body", body]);
      const m = out.match(/\/issues\/(\d+)/);
      return { number: m ? Number(m[1]) : null, url: out.trim(), warn: String(e.stderr || e.message || "") };
    } catch (e2) {
      return { number: null, why: String(e2.stderr || e2.message || e.message) };
    }
  }
}

/**
 * Inbox: open Issues on the team hub assigned to me (or titled [rooms]), plus share_meta for me.
 */
export async function readInbox({ clonePath, remotePath, login, runGh: gh = runGh }) {
  const pulled = await pullTeamRoom(clonePath);
  const { shares } = await readShares(clonePath);
  const forMe = shares.filter((s) => s.to.includes(login) || s.from === login);
  let issues = [];
  if (remotePath && !process.env.ROOMS_NO_GH) {
    try {
      const raw = await gh([
        "issue",
        "list",
        "--repo",
        remotePath,
        "--assignee",
        "@me",
        "--state",
        "open",
        "--json",
        "number,title,createdAt,url,labels",
        "--limit",
        "30",
      ]);
      issues = JSON.parse(raw || "[]").filter(
        (i) =>
          /\[rooms\]/i.test(i.title || "") ||
          (i.labels || []).some((l) => String(l.name || l).toLowerCase() === "rooms"),
      );
    } catch {
      issues = [];
    }
  }
  return { shares: forMe, issues, pullOk: pulled.ok, pullWhy: pulled.why };
}

/** Whether `age` is on PATH (optional encrypt path). */
export async function ageAvailable() {
  try {
    await execFileAsync("age", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function ageEncryptFile({ recipientsPath, outPath, plaintext }) {
  return new Promise((resolve, reject) => {
    const child = spawn("age", ["-R", recipientsPath, "-o", outPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `age exited ${code}`));
    });
    child.stdin.end(plaintext);
  });
}

/**
 * Encrypt bytes to a recipient's GitHub SSH keys via `age -R`. Returns ciphertext path relative
 * to the team room, or null if age/keys unavailable.
 */
export async function encryptToGithubUser({ clonePath, login, plaintext, id }) {
  if (!(await ageAvailable())) return { ok: false, why: "age is not installed (optional; share meta still works)" };
  let keys;
  try {
    keys = await runGh(["api", `users/${login}/keys`, "--jq", ".[].key"]);
  } catch (e) {
    return { ok: false, why: `could not read github.com/${login}.keys: ${e.message}` };
  }
  const ssh = String(keys || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^ssh-/.test(l));
  if (!ssh.length) return { ok: false, why: `@${login} has no SSH keys on GitHub` };
  const recipients = join(clonePath, "shares", `.${id}.recipients`);
  const outRel = `shares/blobs/${id}.age`;
  await mkdir(join(clonePath, "shares", "blobs"), { recursive: true });
  await writeFile(recipients, `${ssh.join("\n")}\n`, "utf8");
  try {
    await ageEncryptFile({ recipientsPath: recipients, outPath: join(clonePath, outRel), plaintext });
  } catch (e) {
    return { ok: false, why: String(e.message || e) };
  } finally {
    await writeFile(recipients, "", "utf8").catch(() => {});
  }
  const digest = createHash("sha256").update(plaintext).digest("hex").slice(0, 16);
  return { ok: true, pointer: outRel, digest };
}
