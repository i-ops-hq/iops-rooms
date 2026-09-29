// `rooms shortcut`: a file to double-click that opens this project's board, for the people on a team
// who never open a terminal.
//
// A launcher is a command stored in a file and run later, from a double-click, with no one looking
// at it. The project's folder name is written into it, and a folder name is text anyone can choose.
// So each format is run for real here, against a folder whose name is an attack, and must deliver
// that name to Rooms as a folder and run nothing else.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  defaultFolder,
  linuxDesktop,
  macScript,
  plan,
  refusal,
  shellCommand,
  windowsCmd,
} from "../src/shortcut.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const exists = (p) => access(p).then(() => true, () => false);
const os = platform();
// Names a person could give a folder, each aimed at a different layer of quoting.
const HOSTILE = os === "win32"
  ? ["100% & done", "a ^ b | c", "x !path! y", "semi;colon (1)"]
  : ["x'; touch pwned; '", 'q"$(touch pwned2)"', "b`touch pwned3`", "sp ace\\slash %d"];

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-launch-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A stand-in for Rooms that records where it ran and what it was given, and does nothing else. */
async function recorder(dir) {
  const log = join(dir, "ran.json");
  const path = join(dir, "record.mjs");
  await writeFile(path, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`, "utf8");
  return { path, log };
}

async function nothingElseRan(dir) {
  for (const name of ["pwned", "pwned2", "pwned3"]) {
    assert.equal(await exists(join(dir, name)), false, `${name} was created`);
  }
}

test("the shell command every launcher runs delivers a hostile folder name intact", { skip: os === "win32" && "no POSIX shell" }, async () => {
  await scratch(async (dir) => {
    const rec = await recorder(dir);
    for (const name of HOSTILE) {
      const projectDir = join(dir, name);
      await mkdir(projectDir);
      await exec("/bin/sh", ["-c", shellCommand({ nodeBin: process.execPath, cliPath: rec.path, projectDir })], { cwd: dir, timeout: 20000 });
      const ran = JSON.parse(await readFile(rec.log, "utf8"));
      assert.deepEqual(ran.args, ["open"], name);
      assert.equal(await realpath(ran.cwd), await realpath(projectDir), name);
      await nothingElseRan(dir);
      await nothingElseRan(projectDir);
    }
  });
});

test("the macOS application's script does the same once AppleScript has read it", { skip: os !== "darwin" && "osascript is macOS's" }, async () => {
  await scratch(async (dir) => {
    const rec = await recorder(dir);
    for (const name of HOSTILE) {
      const projectDir = join(dir, name);
      await mkdir(projectDir);
      const target = { nodeBin: process.execPath, cliPath: rec.path, projectDir };
      // Run without the failure dialog, which would appear on the screen of whoever runs the suite
      // and hold the test open until clicked; the launcher's script is that same line inside it.
      const quiet = macScript(target, { dialog: false });
      const line = quiet.split("\n")[1];
      assert.ok(macScript(target).includes(`\t${line}\non error errorMessage\n\tdisplay dialog`), "the launcher runs the same line");
      await exec("osascript", ["-e", quiet], { cwd: dir, timeout: 20000 });
      const ran = JSON.parse(await readFile(rec.log, "utf8"));
      assert.deepEqual(ran.args, ["open"], name);
      assert.equal(await realpath(ran.cwd), await realpath(projectDir), name);
      await nothingElseRan(dir);
    }
  });
});

test("the Windows launcher does the same when cmd runs it, and stops if the project has moved", { skip: os !== "win32" && "cmd is Windows's" }, async () => {
  await scratch(async (dir) => {
    const rec = await recorder(dir);
    for (const name of HOSTILE) {
      const projectDir = join(dir, name);
      await mkdir(projectDir);
      const file = join(dir, "launch.cmd");
      await writeFile(file, windowsCmd({ nodeBin: process.execPath, cliPath: rec.path, projectDir }), "utf8");
      await exec("cmd.exe", ["/d", "/c", file], { cwd: dir, timeout: 20000 });
      const ran = JSON.parse(await readFile(rec.log, "utf8"));
      // Compared as real paths: Windows temp folders often come back in their 8.3 short form.
      assert.deepEqual([await realpath.native(ran.cwd), ran.args], [await realpath.native(projectDir), ["open"]], name);
      await rm(rec.log);
    }
    const file = join(dir, "moved.cmd");
    await writeFile(file, windowsCmd({ nodeBin: process.execPath, cliPath: rec.path, projectDir: join(dir, "gone") }), "utf8");
    await exec("cmd.exe", ["/d", "/c", file], { cwd: dir, timeout: 20000 }).catch(() => null);
    assert.equal(await exists(rec.log), false, "nothing ran from the wrong folder");
  });
});

/**
 * The Desktop Entry specification's own reading of Exec and a string value: the string escapes
 * first (`\\` to `\`), then the quoting rules (`\"` `\`` `\$` `\\` inside double quotes), then `%%`.
 */
function readDesktop(text) {
  const values = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const unescapeString = (v) => v.replace(/\\(.)/g, (_, c) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c] ?? `\\${c}`);
  const argv = [];
  const exec = unescapeString(values.Exec);
  let i = 0;
  while (i < exec.length) {
    if (exec[i] === " ") { i++; continue; }
    let arg = "";
    if (exec[i] === '"') {
      i++;
      while (i < exec.length && exec[i] !== '"') {
        if (exec[i] === "\\" && '"`$\\'.includes(exec[i + 1])) { arg += exec[i + 1]; i += 2; } else arg += exec[i++];
      }
      i++;
    } else {
      while (i < exec.length && exec[i] !== " ") arg += exec[i++];
    }
    // `%%` is a percent sign; any other `%x` is a field code the desktop fills in itself (`%f` a
    // file, `%u` a URL), which a folder name must never become.
    argv.push(arg.replace(/%(.)/g, (_, c) => (c === "%" ? "%" : `<field code %${c}>`)));
  }
  return { argv, path: unescapeString(values.Path), name: unescapeString(values.Name), keys: Object.keys(values) };
}

test("the Linux launcher reads back, by the specification's rules, as exactly this Rooms in this folder", () => {
  // A backslash is the hard case: the file's own escape and the quoting rule's both use it, and a
  // path ending in one, or with one before a quote or a dollar, reads back wrong unless both apply.
  const names = ["x'; touch pwned; '", 'q"$(touch pwned2)"', "b`touch pwned3`", "sp ace\\slash %d", 'all "`$\\% of it', "ends in \\", 'back\\"quote', "back\\$dollar", "100%f %u"];
  for (const name of names) {
    const target = { nodeBin: `/opt/${name}/node`, cliPath: `/usr/lib/${name}/cli.js`, projectDir: `/home/p/${name}`, name };
    const read = readDesktop(linuxDesktop(target));
    assert.deepEqual(read.argv, [target.nodeBin, target.cliPath, "open"], name);
    assert.equal(read.path, target.projectDir, name);
  }
  // A project name with a line break cannot start a line, and so a key, of its own.
  const text = linuxDesktop({ nodeBin: "/n", cliPath: "/c", projectDir: "/p", name: "a\nExec=/bin/evil" });
  assert.deepEqual(text.split("\n").filter((l) => l.startsWith("Exec=")), ['Exec="/n" "/c" open']);
  assert.deepEqual(readDesktop(text).argv, ["/n", "/c", "open"]);
});

test("a path with a line break, or Rooms running from npx's cache, is refused", () => {
  const ok = { nodeBin: "/n/node", cliPath: "/usr/lib/node_modules/iops-rooms/src/cli.js", projectDir: "/p" };
  assert.equal(refusal(ok), "");
  assert.match(refusal({ ...ok, projectDir: "/p/a\nb" }), /control character/);
  assert.match(refusal({ ...ok, cliPath: "/Users/x/.npm/_npx/1a2b/node_modules/iops-rooms/src/cli.js" }), /npm i -g iops-rooms/);
  assert.match(refusal({ ...ok, cliPath: "C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\iops-rooms\\src\\cli.js" }), /npx's cache/);
});

test("the launcher goes to the Desktop, Windows's own idea of it, or on Linux the applications menu", async () => {
  assert.equal(await defaultFolder({ os: "linux", home: "/home/p" }), join("/home/p", ".local", "share", "applications"));
  assert.equal(await defaultFolder({ os: "darwin", home: "/Users/p" }), join("/Users/p", "Desktop"));
  const onedrive = async () => ({ stdout: "C:\\Users\\p\\OneDrive\\Desktop\r\n" });
  assert.equal(await defaultFolder({ os: "win32", home: "C:\\Users\\p", run: onedrive }), "C:\\Users\\p\\OneDrive\\Desktop");
  const broken = async () => { throw new Error("no powershell"); };
  assert.equal(await defaultFolder({ os: "win32", home: "C:\\Users\\p", run: broken }), join("C:\\Users\\p", "Desktop"));
  assert.match(plan({ os: "win32", folder: "D", name: 'a:b/c\\d*e?"f<g>h|i', nodeBin: "n", cliPath: "c", projectDir: "p" }).path, /Rooms - a-b-c-d-e--f-g-h-i\.cmd$/);
});

function run(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ROOMS_NO_OPEN: "1" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end("");
  });
}

test("rooms shortcut asks first, replaces only its own launcher, and removes only its own", async () => {
  await scratch(async (dir) => {
    const project = join(dir, "proj");
    await mkdir(project);
    await exec("git", ["init", "-q", "-b", "main", project]);
    const out = join(dir, "out");

    const asked = await run(project, ["shortcut", "--to", out]);
    assert.equal(asked.code, 2);
    assert.match(asked.err, /nothing was changed/);
    assert.equal(await exists(out), false);

    const made = await run(project, ["shortcut", "--to", out, "--yes"]);
    assert.equal(made.code, 0, made.err);
    const path = made.out.match(/^Launcher {2}(.+)$/m)[1];
    assert.ok(await exists(path), path);
    assert.match(made.out, /remove: .* shortcut remove --to /);
    const again = await run(project, ["shortcut", "--to", out, "--yes"]);
    assert.equal(again.code, 0, "its own launcher is replaced");

    const removed = await run(project, ["shortcut", "remove", "--to", out]);
    assert.match(removed.out, /^removed /);
    assert.equal(await exists(path), false);

    // Someone's own file (on macOS, a folder) where the launcher would go: left exactly as it was.
    const mine = os === "darwin" ? join(path, "mine.txt") : path;
    await mkdir(join(mine, ".."), { recursive: true });
    await writeFile(mine, "not Rooms's\n", "utf8");
    const refused = await run(project, ["shortcut", "--to", out, "--yes"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /was not written by Rooms; nothing was changed/);
    const kept = await run(project, ["shortcut", "remove", "--to", out]);
    assert.match(kept.out, /was not written by Rooms, so it was left alone/);
    assert.equal(await readFile(mine, "utf8"), "not Rooms's\n");
  });
});
