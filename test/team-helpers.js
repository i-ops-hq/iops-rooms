// The two-person setup the team room's tests share: alice and bob, each with their own Rooms home,
// GitHub login and clones, and one team room between them. A bare repository stands in for the
// team's private GitHub repository. Not a test file itself (no .test.js), so the runner skips it.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export const exec = promisify(execFile);
export const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");

export async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-team-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function run(cwd, argv, home, env = {}) {
  return new Promise((resolve) => {
    // Killed after thirty seconds: a command that should have refused, and started a server that
    // runs until stopped instead, must fail the test rather than outlive it.
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      timeout: 30000,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ROOMS_NO_GH: "1", ROOMS_HOME: home, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end("");
  });
}

export const git = (cwd, ...args) => exec("git", args, { cwd }).then((r) => r.stdout.trim());

/** A person: their Rooms home, a GitHub login on it, and their own clones of the team room and web. */
export async function person(dir, login) {
  const home = join(dir, login, "home");
  // A file URL, not a path: on Windows, import() reads "D:\\…" as a URL whose scheme is "d:".
  const identity = pathToFileURL(join(root, "src", "identity.js")).href;
  await exec(process.execPath, ["-e", `import(${JSON.stringify(identity)}).then((m) => m.installFixtureIdentity({ login: ${JSON.stringify(login)} }))`], {
    env: { ...process.env, ROOMS_HOME: home },
  });
  const team = join(dir, login, "team");
  const web = join(dir, login, "web");
  for (const [from, to] of [["team.git", team], ["web.git", web]]) {
    await exec("git", ["clone", "-q", join(dir, from), to]);
    await git(to, "config", "user.name", login);
    await git(to, "config", "user.email", `${login}@example.com`);
  }
  // Each person's own Claude Code folder, so one person's setup never reads or writes another's.
  const claude = join(dir, login, "claude");
  return { login, home, team, web, claude, rooms: (cwd, ...argv) => run(cwd, argv, home, { CLAUDE_CONFIG_DIR: claude }) };
}

/** alice makes the team room and the project's first commit, and both people have joined. */
export async function teamOfTwo(dir) {
  await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "team.git")]);
  await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "web.git")]);
  const alice = await person(dir, "alice");
  const made = await alice.rooms(alice.team, "team", "init", "--name", "acme", "--yes", "--confirm-private");
  assert.equal(made.code, 0, made.err);
  await git(alice.team, "push", "-q", "-u", "origin", "main");
  await writeFile(join(alice.web, "app.js"), "one\n", "utf8");
  await git(alice.web, "add", "-A");
  await git(alice.web, "commit", "-q", "-m", "first");
  await git(alice.web, "push", "-q", "-u", "origin", "main");
  const bob = await person(dir, "bob");
  for (const p of [alice, bob]) {
    const joined = await p.rooms(p.web, "team", "join", p.team, "--yes", "--confirm-private");
    assert.equal(joined.code, 0, joined.err);
  }
  return { alice, bob };
}

