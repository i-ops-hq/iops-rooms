/**
 * A file to double-click that opens this project's board in its own window, for the people on a
 * team who never open a terminal. Someone who does runs `rooms shortcut` once on that machine;
 * after that it is an icon.
 *
 * What it runs is fixed when it is written: this Node, this install of Rooms, `open`, in this
 * project. Nothing is looked up when it runs, since a launcher started from the desktop gets a bare
 * PATH, not the one a shell profile builds. Every path is quoted for the format it is written in,
 * and a test runs each format's command against a project folder whose name is an attack
 * (`x'; touch pwned; '`), which must reach Rooms as a folder name and run nothing.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Written into every launcher, so `remove` and a second `rooms shortcut` touch only their own. */
export const LAUNCHER_MARK = "iops-rooms launcher";

/** A single-quoted POSIX shell word: safe for any string without a NUL. */
export function shWord(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** An AppleScript string literal. */
export function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The shell command every launcher amounts to: go to the project, run this Rooms's `open`. */
export function shellCommand({ nodeBin, cliPath, projectDir }) {
  return `cd ${shWord(projectDir)} && ${shWord(nodeBin)} ${shWord(cliPath)} open`;
}

/**
 * macOS: the source of an AppleScript application, which runs without opening Terminal. If Rooms
 * fails, the person sees why in a dialog, since there is no terminal to read it in.
 *
 * `dialog: false` leaves the dialog out, for tests: a failure then ends the script with an error.
 * With it in, a test that failed put a dialog on the screen of whoever ran the suite, and the dialog
 * held the test open until someone clicked it, so its temporary folder was never removed.
 */
export function macScript(target, { dialog = true } = {}) {
  const run = `do shell script ${appleScriptString(shellCommand(target))}`;
  if (!dialog) return `-- ${LAUNCHER_MARK}\n${run}\n`;
  return [
    `-- ${LAUNCHER_MARK}`,
    "try",
    `\t${run}`,
    "on error errorMessage",
    `\tdisplay dialog "Rooms could not open the board: " & errorMessage buttons {"OK"} default button 1 with icon caution`,
    "end try",
    "",
  ].join("\n");
}

/**
 * Windows: a .cmd file. A Windows path cannot hold `"`, so double quotes are safe around it; `%`
 * still expands inside them, so it is doubled, and delayed expansion is turned off for `!`.
 */
export function windowsCmd({ nodeBin, cliPath, projectDir }) {
  const q = (value) => `"${String(value).replace(/%/g, "%%")}"`;
  return [
    "@echo off",
    `rem ${LAUNCHER_MARK}`,
    "setlocal DisableDelayedExpansion",
    // If the project has moved, stop: Rooms run from wherever cmd starts would make a room there.
    `cd /d ${q(projectDir)} || exit /b 1`,
    `${q(nodeBin)} ${q(cliPath)} open`,
    "",
  ].join("\r\n");
}

/** A Desktop Entry `Exec` argument: quoted, `"` `` ` `` `$` `\` escaped, `%` doubled, then the file's own escape for `\`. */
function execArg(value) {
  const quoted = `"${String(value).replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%")}"`;
  return quoted.replace(/\\/g, "\\\\");
}

/** A Desktop Entry string value: backslash escaped, and no control character, which would start a new line. */
function desktopString(value) {
  return String(value).replace(/[\u0000-\u001f]/g, " ").replace(/\\/g, "\\\\");
}

/** Linux: a Desktop Entry, which the desktop's application menu lists. */
export function linuxDesktop({ nodeBin, cliPath, projectDir, name }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${desktopString(`Rooms · ${name}`)}`,
    `Comment=${desktopString(`Open the Rooms board for ${name}`)}`,
    `Exec=${execArg(nodeBin)} ${execArg(cliPath)} open`,
    `Path=${desktopString(projectDir)}`,
    "Terminal=false",
    `X-IopsRooms=${LAUNCHER_MARK}`,
    "",
  ].join("\n");
}

/** A file name from a project name: no path separators, nothing Windows refuses, no control characters. */
export function launcherName(name) {
  const clean = String(name || "project").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "project";
  return `Rooms - ${clean}`.slice(0, 80);
}

/** Why a launcher cannot be written for these paths, or "". */
export function refusal({ nodeBin, cliPath, projectDir }) {
  // A line break in a path would end a line of the launcher and start another, which in a Desktop
  // Entry is a new key. No format here is worth the risk of escaping one correctly.
  for (const [what, value] of [["the project folder", projectDir], ["Node", nodeBin], ["Rooms", cliPath]]) {
    if (/[\u0000-\u001f]/.test(String(value))) return `${what}'s path holds a control character, which a launcher file cannot hold safely`;
  }
  // npx keeps packages in a cache that it may clear, and a launcher pointing there stops working
  // with nothing to say why.
  if (/[\\/]_npx[\\/]/.test(cliPath)) {
    return "this Rooms is running from npx's cache, which npm may clear. Install it where it stays first: npm i -g iops-rooms, then run rooms shortcut again";
  }
  return "";
}

/** Where a launcher goes by default: the Desktop, or on Linux the application menu. */
export async function defaultFolder({ os = platform(), home = homedir(), run = execFileAsync } = {}) {
  if (os === "linux") return join(home, ".local", "share", "applications");
  if (os === "win32") {
    // The Desktop is often moved into OneDrive, so Windows is asked rather than assumed.
    try {
      const { stdout } = await run("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { timeout: 8000 });
      const found = String(stdout || "").trim();
      if (found) return found;
    } catch {
      /* fall through */
    }
  }
  return join(home, "Desktop");
}

/** The launcher this platform gets: its path, and how to write it. */
export function plan({ os = platform(), folder, name, nodeBin, cliPath, projectDir }) {
  const target = { nodeBin, cliPath, projectDir, name };
  const base = launcherName(name);
  if (os === "darwin") return { os, path: join(folder, `${base}.app`), kind: "app", content: macScript(target), target };
  if (os === "win32") return { os, path: join(folder, `${base}.cmd`), kind: "file", content: windowsCmd(target), target };
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { os, path: join(folder, `iops-rooms-${id}.desktop`), kind: "file", content: linuxDesktop(target), target };
}

/**
 * Whether something already at `path` is a launcher Rooms wrote, which it may replace or remove.
 * An application is read back with osadecompile rather than marked with a file of its own: adding
 * a file to a signed bundle after it is built breaks its signature.
 */
export async function isOurs(path, kind, { run = execFileAsync } = {}) {
  try {
    const text = kind === "app"
      ? String((await run("osadecompile", [path], { timeout: 10000 })).stdout || "")
      : await readFile(path, "utf8");
    return text.includes(LAUNCHER_MARK);
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    return err && err.code === "EISDIR";
  }
}

/** Write the planned launcher. Refuses to replace anything Rooms did not write. */
export async function writeLauncher(p, { run = execFileAsync } = {}) {
  if ((await exists(p.path)) && !(await isOurs(p.path, p.kind, { run }))) {
    throw new Error(`${p.path} exists and was not written by Rooms; nothing was changed`);
  }
  await mkdir(join(p.path, ".."), { recursive: true });
  if (p.kind === "app") {
    await rm(p.path, { recursive: true, force: true });
    await run("osacompile", ["-o", p.path, "-e", p.content], { timeout: 20000 });
    return;
  }
  await writeFile(p.path, p.content, "utf8");
  if (p.os !== "win32") await chmod(p.path, 0o755);
}

/** Remove a launcher Rooms wrote. Anything else at that path is left alone. */
export async function removeLauncher(p, { run = execFileAsync } = {}) {
  if (!(await exists(p.path))) return "none";
  if (!(await isOurs(p.path, p.kind, { run }))) return "not-ours";
  await rm(p.path, { recursive: true, force: true });
  return "removed";
}
