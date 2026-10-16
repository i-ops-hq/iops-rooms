// Regression: `rooms episode` must be a top-level command, not nested under week/branch/file/badge.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");

function run(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ROOMS_HOME: join(cwd, "home") },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("rooms episode is a real command (not unknown)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-episode-cli-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "x\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await mkdir(join(dir, ".room"), { recursive: true });
  await writeFile(
    join(dir, ".room", "room.json"),
    JSON.stringify({ version: 1, id: "TEST01", name: "t", createdAt: new Date().toISOString() }),
  );
  await writeFile(join(dir, ".room", "agent-activity.jsonl"), "");

  const r = await run(dir, ["episode", "--days", "7"]);
  assert.equal(r.code, 0, r.err || r.out);
  assert.doesNotMatch(r.err + r.out, /unknown command: episode/);
  assert.match(r.out, /Episodes/);
});
