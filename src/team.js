/**
 * The team room: a repository the team owns, where each member's Rooms shares a small status of the
 * work on their machine, and reads everyone else's (docs/design/TEAM_LIVE.md, T3).
 *
 * GitHub is the medium and the access control. Rooms has no server: a member's own git fetches the
 * team room and pushes to it, and nothing reaches I-Ops. What a member shares is one file per
 * project, `status/<login>/<project>.json`, overwritten rather than appended, holding counts and
 * states from an allowlist and never a file name, a line of code or a commit message. The first
 * push to a team is shown in full and asked about. A team room on GitHub must be private: a public
 * one would publish every status to the internet, so Rooms asks GitHub and refuses it.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { roomsHomeDir } from "./identity.js";
import { readGitSnapshot, repositoryTop, sanitizeRemote } from "./git-info.js";
import { branchPullRequest } from "./scm.js";
import { readActivity } from "./activity.js";

const execFileAsync = promisify(execFile);

export const TEAM_FORMAT = "iops-rooms/team-room";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PR_STATES = new Set(["open", "draft", "merged", "closed", "none", "unpushed", "default-branch", "unknown"]);

/** git with its failure kept, since a team room that cannot be pulled or pushed must say why. */
export async function gitIn(cwd, args, { timeout = 30000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: 4_000_000,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: String(stdout || "").trim(), err: String(stderr || "").trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || e.message || "").trim() };
  }
}

// ---- the registry: which team rooms this person has, and which project belongs to which --------

function registryPath() {
  return join(roomsHomeDir(), "teams.json");
}

export async function readRegistry() {
  try {
    const data = JSON.parse(await readFile(registryPath(), "utf8"));
    return { v: 1, teams: data.teams || {}, projects: data.projects || {} };
  } catch {
    return { v: 1, teams: {}, projects: {} };
  }
}

export async function writeRegistry(reg) {
  await mkdir(roomsHomeDir(), { recursive: true });
  await writeFile(registryPath(), `${JSON.stringify(reg, null, 2)}\n`, "utf8");
}

/** A team is named by its repository on the remote, `owner/repo`, or by its folder when it has none. */
export async function teamIdFor(clonePath) {
  const url = await gitIn(clonePath, ["remote", "get-url", "origin"]);
  const remote = url.ok ? sanitizeRemote(url.out) : null;
  return { id: remote ? remote.path : `local/${basename(clonePath)}`, remote };
}

/** The team room at `path`, if it is one: its format, name and id. */
export async function readTeamRoom(path) {
  try {
    const room = JSON.parse(await readFile(join(path, "room.json"), "utf8"));
    if (room.format !== TEAM_FORMAT) return null;
    return { name: String(room.name || basename(path)), ...(await teamIdFor(path)) };
  } catch {
    return null;
  }
}

// ---- private, or refused ------------------------------------------------------------------------

async function runGhDefault(args) {
  const { stdout } = await execFileAsync("gh", args, { timeout: 15000, maxBuffer: 512_000 });
  return String(stdout || "");
}

/**
 * Whether the team room may hold statuses: private on GitHub, as GitHub says through the person's
 * own `gh`. Public is refused unless the person says `--public`; anything Rooms cannot check (no
 * `gh`, a remote that is not GitHub) needs them to say they checked, with `--confirm-private`.
 */
export async function checkPrivate(remote, { confirmPrivate = false, allowPublic = false, runGh = runGhDefault, env = process.env } = {}) {
  const checkIt = "check it yourself, then pass --confirm-private";
  if (!remote || remote.host !== "github.com") {
    return confirmPrivate
      ? { ok: true, how: "you confirmed it is private" }
      : { ok: false, why: "this team room is not on GitHub, so Rooms cannot ask whether it is private", fix: checkIt };
  }
  if (env.ROOMS_NO_GH) {
    return confirmPrivate
      ? { ok: true, how: "you confirmed it is private" }
      : { ok: false, why: "ROOMS_NO_GH is set, so Rooms cannot ask GitHub whether it is private", fix: checkIt };
  }
  let visibility = "";
  try {
    visibility = JSON.parse(await runGh(["repo", "view", remote.path, "--json", "visibility"])).visibility || "";
  } catch (e) {
    if (confirmPrivate) return { ok: true, how: "you confirmed it is private" };
    const why = e?.code === "ENOENT" ? "gh is not installed" : "gh could not say";
    return { ok: false, why: `Rooms could not ask GitHub whether ${remote.path} is private: ${why}`, fix: checkIt };
  }
  if (visibility === "PRIVATE" || visibility === "INTERNAL") return { ok: true, how: `GitHub says ${remote.path} is ${visibility.toLowerCase()}` };
  if (visibility === "PUBLIC") {
    return allowPublic
      ? { ok: true, how: `${remote.path} is public, and you said so: every status in it is readable by anyone` }
      : {
          ok: false,
          why: `GitHub says ${remote.path} is public, so every status pushed to it could be read by anyone`,
          fix: "make it private in its settings on GitHub, or pass --public if the team means it",
        };
  }
  return confirmPrivate
    ? { ok: true, how: "you confirmed it is private" }
    : { ok: false, why: `GitHub answered with a visibility this version does not read: ${visibility || "none"}`, fix: checkIt };
}

// ---- init ----------------------------------------------------------------------------------------

const README = (name) => `# ${name} · team room

This repository is a Rooms team room. Each member's Rooms shares a small status of the work on their
machine here, one file per project under \`status/<login>/\`, and reads everyone else's.

What a status holds: the project, and, if the member shares it, the branch; how far the branch is
ahead of or behind its upstream; its pull request's state; what is not committed yet, as counts of
files and lines; and how many agent sessions this machine's hooks saw in the last seven days. Never
a file name, a line of code, a commit message or a prompt.

Join from a project: \`rooms team join <owner>/<repo>\`. Share: \`rooms team sync\`, which shows the
file and asks before the first push. See everyone's: \`rooms team board\`.

Keep this repository private. Anyone who can read it reads every status in it.
`;

export function teamRoomFiles(name) {
  return {
    "room.json": `${JSON.stringify({ format: TEAM_FORMAT, v: 1, name }, null, 2)}\n`,
    "README.md": README(name),
    "status/.gitkeep": "",
    ".gitattributes": "status/** text eol=lf\n",
  };
}

// ---- the status ----------------------------------------------------------------------------------

/** Agent sessions and files edited per agent in the last seven days, from this machine's hooks. */
export function agentsLast7Days(activity, now = Date.now()) {
  const since = now - 7 * 86_400_000;
  const by = {};
  for (const a of activity || []) {
    if (!a || !a.agent || !(Date.parse(a.at) >= since)) continue;
    if (a.kind !== "session" && a.kind !== "edit") continue;
    const agent = String(a.agent).slice(0, 40);
    const entry = (by[agent] ||= { sessions: new Set(), files: new Set() });
    if (a.session) entry.sessions.add(String(a.session));
    if (a.kind === "edit" && a.path) entry.files.add(String(a.path));
  }
  return Object.fromEntries(
    Object.entries(by).map(([agent, e]) => [agent, { sessions: e.sessions.size, filesEdited: e.files.size }]),
  );
}

/** `acme/web` → `acme--web`: a file name that cannot climb out of the member's folder. */
export function projectSlug(project) {
  return String(project).toLowerCase().replace(/[^a-z0-9._]+/g, "--").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100) || "project";
}

/**
 * This member's status for one project. Every field is chosen here; nothing from the checkout is
 * copied in whole. `withBranch: false` leaves the branch and its upstream out, since a branch name
 * can say more than its owner means to share.
 */
export async function buildStatus({ projectDir, login, withBranch = true, now = new Date(), env = process.env }) {
  const git = await readGitSnapshot(projectDir);
  if (!git.ok) throw new Error(`git cannot read this project: ${git.note || git.reason}`);
  const pr = await branchPullRequest(projectDir, git, { env });
  const u = git.uncommitted || {};
  return {
    v: 1,
    member: login,
    project: await projectIdFor(projectDir, git),
    at: `${now.toISOString().slice(0, 16)}Z`,
    ...(withBranch ? { branch: git.current || null, upstream: git.upstream || null } : {}),
    ahead: git.ahead ?? null,
    behind: git.behind ?? null,
    uncommitted: { files: u.files ?? 0, added: u.added ?? null, removed: u.removed ?? null, untracked: u.untracked ?? 0 },
    pr: Number.isInteger(pr.number) ? { state: pr.state, number: pr.number } : pr.why ? { state: pr.state, why: pr.why } : { state: pr.state },
    agents7d: agentsLast7Days(await readActivity(projectDir), now.getTime()),
  };
}

/**
 * The project's name as every member's clone of it agrees: `owner/repo` on a hosted remote, the
 * remote's repository name otherwise, and the folder's name only when there is no remote at all.
 */
async function projectIdFor(projectDir, git) {
  if (git.remote) return git.remote.path;
  const url = await gitIn(projectDir, ["remote", "get-url", "origin"]);
  if (url.ok && url.out) return basename(url.out.replace(/[\\/]+$/, "")).replace(/\.git$/i, "") || basename(projectDir);
  return basename(projectDir);
}

export function statusPath(status) {
  return `status/${status.member}/${projectSlug(status.project)}.json`;
}

/** The same status apart from when it was taken: an unchanged one is not pushed again. */
function sameApartFromTime(a, b) {
  const strip = (s) => JSON.stringify({ ...s, at: null });
  return Boolean(a && b) && strip(a) === strip(b);
}

/**
 * What `sync` would do: the file, its content, and whether it differs from what the team room
 * already holds for this member and project.
 */
export async function planSync({ clonePath, status }) {
  const rel = statusPath(status);
  let before = null;
  try {
    before = JSON.parse(await readFile(join(clonePath, rel), "utf8"));
  } catch {
    before = null;
  }
  return { rel, status, content: `${JSON.stringify(status, null, 2)}\n`, changed: !sameApartFromTime(before, status) };
}

/**
 * Write, commit and push the member's own status file, and nothing else. The commit names only
 * that path, so anything else changed in the clone stays out of it. A push the remote rejects is
 * rebased once onto what arrived, which cannot conflict, since no one else writes this file.
 */
export async function applySync({ clonePath, plan }) {
  await mkdir(join(clonePath, plan.rel, ".."), { recursive: true });
  await writeFile(join(clonePath, plan.rel), plan.content, "utf8");
  const add = await gitIn(clonePath, ["add", "--", plan.rel]);
  if (!add.ok) return { ok: false, why: `git could not stage it: ${add.err}` };
  const message = `status: ${plan.status.member} · ${plan.status.project}`;
  const commit = await gitIn(clonePath, ["commit", "-q", "-m", message, "--", plan.rel]);
  if (!commit.ok) return { ok: false, why: `git could not commit it: ${commit.err || commit.out}` };
  let push = await gitIn(clonePath, ["push", "-q"]);
  if (!push.ok && /rejected|fetch first|non-fast-forward/i.test(push.err)) {
    // --autostash: anything else changed in the clone is set aside and put back, uncommitted, rather
    // than stopping the member's status from ever being shared.
    const rebase = await gitIn(clonePath, ["pull", "--rebase", "--autostash", "-q"]);
    if (!rebase.ok) return { ok: false, why: `the team room moved and could not be caught up with: ${rebase.err}` };
    push = await gitIn(clonePath, ["push", "-q"]);
  }
  if (!push.ok) return { ok: false, why: `git could not push it: ${push.err}`, committed: true };
  return { ok: true };
}

/** Bring the member's clone of the team room up to date. Fast-forward only: it never merges. */
export async function pullTeamRoom(clonePath) {
  const pull = await gitIn(clonePath, ["pull", "--ff-only", "-q"]);
  return pull.ok ? { ok: true } : { ok: false, why: pull.err || "git pull failed" };
}

// ---- reading everyone's --------------------------------------------------------------------------

function isCount(v) {
  return v === null || (Number.isInteger(v) && v >= 0 && v < 10_000_000);
}

/**
 * A status as it may be shown, or null. Checked field by field, since the file came from a
 * teammate's machine through git and the board renders it: anything unexpected is not a status.
 * A file under another member's folder than the one it names is refused too.
 */
export function validStatus(data, folderLogin) {
  if (!data || typeof data !== "object" || data.v !== 1) return null;
  if (typeof data.member !== "string" || !LOGIN.test(data.member) || data.member !== folderLogin) return null;
  if (typeof data.project !== "string" || !data.project || data.project.length > 200) return null;
  if (typeof data.at !== "string" || !Number.isFinite(Date.parse(data.at))) return null;
  for (const key of ["branch", "upstream"]) {
    if (key in data && data[key] !== null && (typeof data[key] !== "string" || data[key].length > 250)) return null;
  }
  if (!isCount(data.ahead) || !isCount(data.behind)) return null;
  const u = data.uncommitted;
  if (!u || !["files", "added", "removed", "untracked"].every((k) => isCount(u[k] ?? null))) return null;
  const pr = data.pr;
  if (!pr || !PR_STATES.has(pr.state) || ("number" in pr && !Number.isInteger(pr.number))) return null;
  if ("why" in pr && (typeof pr.why !== "string" || pr.why.length > 200)) return null;
  const agents = data.agents7d || {};
  if (typeof agents !== "object" || Object.keys(agents).length > 20) return null;
  for (const [id, a] of Object.entries(agents)) {
    if (id.length > 40 || !a || !isCount(a.sessions) || !isCount(a.filesEdited)) return null;
  }
  return data;
}

/** Every member's status in the team room, and how many files were not ones this version reads. */
export async function readStatuses(clonePath) {
  const out = [];
  let skipped = 0;
  let members = [];
  try {
    members = await readdir(join(clonePath, "status"), { withFileTypes: true });
  } catch {
    return { statuses: out, skipped };
  }
  for (const m of members) {
    if (!m.isDirectory()) continue;
    for (const f of await readdir(join(clonePath, "status", m.name))) {
      if (!f.endsWith(".json")) continue;
      try {
        const status = validStatus(JSON.parse(await readFile(join(clonePath, "status", m.name, f), "utf8")), m.name);
        if (status) out.push(status);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  out.sort((a, b) => a.project.localeCompare(b.project) || a.member.localeCompare(b.member));
  return { statuses: out, skipped };
}

/** The team room this project is linked to, from the registry. */
export async function teamForProject(projectDir) {
  const reg = await readRegistry();
  const top = await realpath(resolve((await repositoryTop(projectDir)) || projectDir)).catch(() => resolve(projectDir));
  const id = reg.projects[top];
  return id && reg.teams[id] ? { reg, top, id, team: reg.teams[id] } : { reg, top, id: null, team: null };
}
