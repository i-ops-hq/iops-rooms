/**
 * `rooms companion`: light foreground loop — pull inbox / team pulse, OS-notify on new items,
 * pause naturally when the process stops (sleep/laptop close). Opt-in launcher via install.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { roomsHomeDir, authStatus } from "./identity.js";
import { teamForProject, pullTeamRoom, gitIn, readStatuses } from "./team.js";
import { githubRepoFromRemote, readInbox } from "./share.js";
import { notify } from "./companion-notify.js";
import {
  defaultFolder,
  plan as shortcutPlan,
  refusal,
  shWord,
  appleScriptString,
  LAUNCHER_MARK,
} from "./shortcut.js";

const execFileAsync = promisify(execFile);

export const COMPANION_MARK = "iops-rooms companion";
export const COMPANION_STATE = "companion.json";

export function companionStatePath() {
  return join(roomsHomeDir(), COMPANION_STATE);
}

export async function readCompanionState() {
  try {
    return JSON.parse(await readFile(companionStatePath(), "utf8"));
  } catch {
    return { v: 1, shareIds: [], issueNumbers: [], teamHead: null, lastTick: null };
  }
}

export async function writeCompanionState(state) {
  await mkdir(roomsHomeDir(), { recursive: true });
  await writeFile(companionStatePath(), `${JSON.stringify({ v: 1, ...state }, null, 2)}\n`, "utf8");
}

/**
 * Diff inbox + team HEAD against prior state. Returns notifications to fire (deduped).
 * After a long gap (sleep), suppress backlog: only announce counts, not every item.
 */
export function planNotifications({ prev, inbox, teamHead, now = Date.now(), everyMs = 300_000 }) {
  const prevShares = new Set(prev.shareIds || []);
  const prevIssues = new Set(prev.issueNumbers || []);
  const newShares = (inbox.shares || []).filter((s) => !prevShares.has(s.id));
  const newIssues = (inbox.issues || []).filter((i) => !prevIssues.has(i.number));
  const headChanged = Boolean(teamHead && prev.teamHead && teamHead !== prev.teamHead);
  const gap = prev.lastTick ? now - Date.parse(prev.lastTick) : 0;
  const slept = gap > everyMs * 2.5;
  const notes = [];
  if (slept && (newShares.length || newIssues.length || headChanged)) {
    notes.push({
      title: "Rooms",
      body:
        `Back after a pause: ${newShares.length} share(s), ${newIssues.length} issue(s)` +
        (headChanged ? ", team board moved" : ""),
    });
  } else {
    for (const s of newShares.slice(0, 5)) {
      notes.push({
        title: "Rooms share",
        body: `${s.type}: ${s.ref} from @${s.from}`,
      });
    }
    for (const i of newIssues.slice(0, 5)) {
      notes.push({ title: "Rooms issue", body: `#${i.number} ${i.title}` });
    }
    if (headChanged && !newShares.length && !newIssues.length) {
      notes.push({ title: "Rooms team", body: "Team room updated" });
    }
  }
  const next = {
    shareIds: [...new Set([...(prev.shareIds || []), ...(inbox.shares || []).map((s) => s.id)])].slice(-200),
    issueNumbers: [
      ...new Set([...(prev.issueNumbers || []), ...(inbox.issues || []).map((i) => i.number)]),
    ].slice(-200),
    teamHead: teamHead || prev.teamHead || null,
    lastTick: new Date(now).toISOString(),
  };
  return { notes, next };
}

/** One companion tick. */
export async function companionTick({
  projectDir,
  everyMs = 300_000,
  notifyFn = notify,
  now = Date.now(),
  silent = false,
} = {}) {
  const login = (await authStatus()).github?.login;
  const linked = await teamForProject(projectDir);
  if (!linked.team) return { ok: false, why: "no team room linked", notes: [] };
  if (!login) return { ok: false, why: "no GitHub login (rooms auth github)", notes: [] };

  await pullTeamRoom(linked.team.path);
  const head = (await gitIn(linked.team.path, ["rev-parse", "HEAD"])).out || null;
  const inbox = await readInbox({
    clonePath: linked.team.path,
    remotePath: githubRepoFromRemote(linked.team.remote),
    login,
  });
  // Touch statuses so a pull that only moved rollups still refreshes the floor.
  await readStatuses(linked.team.path);

  const prev = await readCompanionState();
  const { notes, next } = planNotifications({ prev, inbox, teamHead: head, now, everyMs });
  await writeCompanionState(next);
  if (!silent) {
    for (const n of notes) await notifyFn(n);
  }
  return { ok: true, notes, inbox, head, team: linked.id };
}

/** Foreground loop until abort. */
export async function runCompanion({
  projectDir,
  everyMs = 300_000,
  notifyFn = notify,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal = null,
} = {}) {
  process.stdout.write(
    `companion  every ${Math.round(everyMs / 1000)}s · team inbox + board · Ctrl+C to stop\n` +
      `(pauses when this process stops — laptop sleep included)\n`,
  );
  while (!signal?.aborted) {
    const tick = await companionTick({ projectDir, everyMs, notifyFn });
    if (!tick.ok) {
      process.stderr.write(`companion: ${tick.why}\n`);
    } else if (tick.notes.length) {
      process.stdout.write(`notified ${tick.notes.length} · ${tick.team}\n`);
    }
    await sleep(everyMs);
  }
}

/** Launcher that runs `rooms companion` in this project (opt-in startup). */
export function companionShell({ nodeBin, cliPath, projectDir }) {
  return `cd ${shWord(projectDir)} && ${shWord(nodeBin)} ${shWord(cliPath)} companion`;
}

export function companionMacScript(target, { dialog = true } = {}) {
  const run = `do shell script ${appleScriptString(companionShell(target))}`;
  if (!dialog) return `-- ${COMPANION_MARK}\n${run}\n`;
  return [
    `-- ${COMPANION_MARK}`,
    "try",
    `\t${run}`,
    "on error errorMessage",
    `\tdisplay dialog "Rooms companion stopped: " & errorMessage buttons {"OK"} default button 1 with icon caution`,
    "end try",
    "",
  ].join("\n");
}

export function planCompanionLauncher({ folder, name, nodeBin, cliPath, projectDir, os }) {
  const base = shortcutPlan({
    os,
    folder,
    name: `${name} companion`,
    nodeBin,
    cliPath,
    projectDir,
  });
  // Rewrite content to run companion, not open, and mark as companion.
  const target = { nodeBin, cliPath, projectDir, name };
  if (base.os === "darwin") {
    return { ...base, content: companionMacScript(target), mark: COMPANION_MARK };
  }
  if (base.os === "win32") {
    const q = (value) => `"${String(value).replace(/%/g, "%%")}"`;
    const content = [
      "@echo off",
      "chcp 65001 >nul",
      `rem ${COMPANION_MARK}`,
      "setlocal DisableDelayedExpansion",
      `cd /d ${q(projectDir)} || exit /b 1`,
      `${q(nodeBin)} ${q(cliPath)} companion`,
      "",
    ].join("\r\n");
    return { ...base, content, mark: COMPANION_MARK };
  }
  const content = base.content
    .replace(new RegExp(`${LAUNCHER_MARK}`, "g"), COMPANION_MARK)
    .replace(/ open(\n|$)/, " companion$1")
    .replace(/Open the Rooms board/, "Run the Rooms companion");
  return { ...base, content, mark: COMPANION_MARK };
}

async function companionIsOurs(path, kind, { run = execFileAsync } = {}) {
  try {
    const text =
      kind === "app"
        ? String((await run("osadecompile", [path], { timeout: 10000 })).stdout || "")
        : await readFile(path, "utf8");
    return text.includes(COMPANION_MARK);
  } catch {
    return false;
  }
}

export async function installCompanionLauncher(opts, { run = execFileAsync } = {}) {
  const why = refusal(opts);
  if (why) throw new Error(why);
  const folder = opts.folder || (await defaultFolder());
  const p = planCompanionLauncher({ ...opts, folder, os: opts.os || platform() });
  let exists = false;
  try {
    await readFile(p.path);
    exists = true;
  } catch (e) {
    exists = e && e.code === "EISDIR";
  }
  if (exists && !(await companionIsOurs(p.path, p.kind, { run }))) {
    throw new Error(`${p.path} exists and was not written by Rooms companion; nothing was changed`);
  }
  await mkdir(join(p.path, ".."), { recursive: true });
  if (p.kind === "app") {
    await rm(p.path, { recursive: true, force: true });
    await run("osacompile", ["-o", p.path, "-e", p.content], { timeout: 20000 });
  } else {
    await writeFile(p.path, p.content, "utf8");
    if (p.os !== "win32") await chmod(p.path, 0o755);
  }
  return p;
}

export async function removeCompanionLauncher(opts, { run = execFileAsync } = {}) {
  const folder = opts.folder || (await defaultFolder());
  const p = planCompanionLauncher({ ...opts, folder, os: opts.os || platform() });
  try {
    await readFile(p.path);
  } catch (e) {
    if (e && e.code === "EISDIR") {
      /* app bundle */
    } else {
      return "none";
    }
  }
  if (!(await companionIsOurs(p.path, p.kind, { run }))) return "not-ours";
  await rm(p.path, { recursive: true, force: true });
  return "removed";
}
