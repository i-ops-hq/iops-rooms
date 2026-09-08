import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, postNote } from "../src/store.js";
import { runDoctor } from "../src/doctor.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-doctor-"));
}

function runCli(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ROOMS_TOOL: "test" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("doctor: missing room → unhealthy (exit 1)", async () => {
  const dir = await tmp();
  try {
    const report = await runDoctor({ cwd: dir });
    assert.equal(report.severity, "fail");
    assert.equal(report.exitCode, 1);
    assert.equal(report.ok, false);
    const room = report.checks.find((c) => c.id === "room");
    assert.equal(room.ok, false);
    assert.match(report.format(), /No \.room\//);
    assert.match(report.format(), /rooms init/);

    const cliOut = await runCli(dir, ["doctor"]);
    assert.equal(cliOut.code, 1);
    assert.match(cliOut.stdout, /FAIL\s+room/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor: empty / near-empty room → WARN + exit 2", async () => {
  const dir = await tmp();
  try {
    await initRoom({ cwd: dir, name: "empty-board" });
    const report = await runDoctor({ cwd: dir });
    assert.equal(report.severity, "warn");
    assert.equal(report.exitCode, 2);
    assert.equal(report.ok, false);
    assert.equal(report.nonSystemCount, 0);
    const text = report.format();
    assert.match(text, /no git history and 0 posts/i, "neither source has anything");
    assert.match(text, /rooms post/);
    assert.match(text, /hooks install/);
    assert.match(text, /WARN\s+board/);

    const cliOut = await runCli(dir, ["doctor"]);
    assert.equal(cliOut.code, 2);
    assert.match(cliOut.stdout, /empty/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor: room with posts → healthy (exit 0)", async () => {
  const dir = await tmp();
  try {
    await initRoom({ cwd: dir, name: "healthy" });
    await postNote(dir, { text: "hello from test" });
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { "iops-rooms": { command: "node", args: ["src/mcp.js"] } },
      }),
      "utf8",
    );

    const report = await runDoctor({ cwd: dir });
    assert.equal(report.severity, "ok");
    assert.equal(report.exitCode, 0);
    assert.equal(report.ok, true);
    assert.ok(report.nonSystemCount >= 1);
    const text = report.format();
    assert.match(text, /Healthy/);
    assert.match(text, /OK\s+room/);
    assert.match(text, /OK\s+board/);
    assert.match(text, /OK\s+mcp/);

    const cliOut = await runCli(dir, ["doctor"]);
    assert.equal(cliOut.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repo with commits and no posts is healthy — git history IS the board", async () => {
  // This check was written when a room's posts were the only thing on the page. Since the board
  // started reading git, a repo with commits and nobody posting renders a full board — and doctor
  // called it empty and exited 2. Telling someone their working tool is broken is the worse error.
  const dir = await tmp();
  const git = (args) =>
    new Promise((resolve, reject) => {
      const c = spawn("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { cwd: dir });
      c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`))));
    });
  try {
    await git(["init", "-q", "-b", "main"]);
    await git(["commit", "-q", "--allow-empty", "-m", "real work happened here"]);
    await git(["commit", "-q", "--allow-empty", "-m", "and more of it"]);
    await initRoom({ cwd: dir, name: "history-only" });

    const report = await runDoctor({ cwd: dir });
    assert.equal(report.nonSystemCount, 0, "nobody posted anything");
    const board = report.checks.find((c) => c.id === "board");
    assert.equal(board.ok, true, "but the board has two commits to draw");
    assert.match(board.detail, /2 commits of git history · 0 room posts/);
    assert.doesNotMatch(report.format(), /nothing for the board to show/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
