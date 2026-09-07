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
    assert.match(text, /empty because nothing was posted/i);
    assert.match(text, /Board looks empty/);
    assert.match(text, /rooms post/);
    assert.match(text, /hooks install/);
    assert.match(text, /WARN\s+events/);

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
    assert.match(text, /OK\s+events/);
    assert.match(text, /OK\s+mcp/);

    const cliOut = await runCli(dir, ["doctor"]);
    assert.equal(cliOut.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
