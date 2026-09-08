import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, postNote } from "../src/store.js";
import { runDoctor } from "../src/doctor.js";
import {
  installMcp,
  mergeMcpConfig,
  mergeCodexConfigToml,
  mcpServerEntry,
  resolvePinnedVersion,
} from "../src/mcp-install.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// What `mcp install` pins is package.json's version. Hardcoding it here made three tests fail on
// every release for no reason and taught nothing — the assertion worth holding is that the
// installer and the manifest agree, not that either equals a literal typed last week.
const PKG_VERSION = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

// An arbitrary version for the pure merge tests. Deliberately NOT the real one, so a reader can
// see at a glance which assertions are about merging and which are about the release.
const FIXTURE_VERSION = "9.9.9";
const cli = join(root, "src", "cli.js");

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-mcp-"));
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

test("mergeMcpConfig keeps unrelated servers", () => {
  const existing = {
    mcpServers: {
      other: { command: "echo", args: ["hi"] },
      "iops-rooms": { command: "old", args: [] },
    },
  };
  const { config, created } = mergeMcpConfig(existing, mcpServerEntry(FIXTURE_VERSION));
  assert.equal(created, false);
  assert.deepEqual(config.mcpServers.other, { command: "echo", args: ["hi"] });
  assert.deepEqual(config.mcpServers["iops-rooms"], {
    command: "npx",
    args: ["-y", `iops-rooms@${FIXTURE_VERSION}`, "mcp"],
  });
});

test("mergeMcpConfig creates mcpServers when missing", () => {
  const { config, created } = mergeMcpConfig({}, mcpServerEntry(FIXTURE_VERSION));
  assert.equal(created, true);
  assert.equal(config.mcpServers["iops-rooms"].command, "npx");
});

test("mergeCodexConfigToml upserts stdio block", () => {
  const first = mergeCodexConfigToml("", mcpServerEntry(FIXTURE_VERSION));
  assert.match(first.text, /\[mcp_servers\.iops-rooms\]/);
  assert.match(first.text, new RegExp(`iops-rooms@${FIXTURE_VERSION}`));
  const second = mergeCodexConfigToml(first.text + "\n[other]\nx = 1\n", mcpServerEntry(FIXTURE_VERSION));
  assert.equal((second.text.match(/\[mcp_servers\.iops-rooms\]/g) || []).length, 1);
  assert.match(second.text, /\[other\]/);
});

test("installMcp writes Cursor + Claude + Codex and copies skills", async () => {
  const dir = await tmp();
  try {
    const ver = await resolvePinnedVersion();
    assert.equal(ver, PKG_VERSION);
    const result = await installMcp({ cwd: dir });
    assert.equal(result.version, PKG_VERSION);
    assert.equal(result.fileExisted, false);
    assert.equal(result.serverCreated, true);
    assert.equal(result.skill.copied, true);
    assert.equal(result.clients.cursor.serverCreated, true);
    assert.equal(result.clients.claude.serverCreated, true);
    assert.equal(result.clients.codex.serverCreated, true);

    const body = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(body.mcpServers["iops-rooms"], {
      command: "npx",
      args: ["-y", `iops-rooms@${PKG_VERSION}`, "mcp"],
    });
    const claude = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(claude.mcpServers["iops-rooms"], body.mcpServers["iops-rooms"]);
    const codex = await readFile(join(dir, ".codex", "config.toml"), "utf8");
    assert.match(codex, /\[mcp_servers\.iops-rooms\]/);
    const skill = await readFile(join(dir, ".cursor", "skills", "rooms", "SKILL.md"), "utf8");
    assert.match(skill, /Rooms by I-Ops/);
    const cskill = await readFile(join(dir, ".claude", "skills", "rooms", "SKILL.md"), "utf8");
    assert.match(cskill, /Rooms by I-Ops/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installMcp merges without wiping other servers", async () => {
  const dir = await tmp();
  try {
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        },
      }),
      "utf8",
    );
    await installMcp({ cwd: dir });
    const body = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
    assert.ok(body.mcpServers.filesystem);
    assert.ok(body.mcpServers["iops-rooms"]);
    assert.match(
      body.mcpServers["iops-rooms"].args.join(" "),
      new RegExp(`iops-rooms@${PKG_VERSION.replace(/\./g, "\\.")}`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli: rooms mcp install creates mcp.json", async () => {
  const dir = await tmp();
  try {
    const out = await runCli(dir, ["mcp", "install"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /cursor/);
    assert.match(out.stdout, /claude/);
    assert.match(out.stdout, /codex/);
    assert.match(out.stdout, new RegExp(`iops-rooms@${PKG_VERSION.replace(/\./g, "\\.")}`));
    const body = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
    assert.equal(body.mcpServers["iops-rooms"].command, "npx");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli: rooms init --mcp installs MCP after init", async () => {
  const dir = await tmp();
  try {
    const out = await runCli(dir, ["init", "--name", "mcp-init", "--mcp"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /created/);
    assert.match(out.stdout, /mcp\s+/);
    const body = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
    assert.ok(body.mcpServers["iops-rooms"]);
    assert.ok(JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers["iops-rooms"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init without --name uses folder basename", async () => {
  const parent = await tmp();
  const dir = join(parent, "my-cool-project");
  await mkdir(dir, { recursive: true });
  try {
    const { meta } = await initRoom({ cwd: dir });
    assert.equal(meta.name, "my-cool-project");
    const out = await runCli(dir, ["init"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /already/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("doctor: WARN mcp before install, OK after", async () => {
  const dir = await tmp();
  try {
    await initRoom({ cwd: dir, name: "mcp-doc" });
    await postNote(dir, { text: "posted" });

    const before = await runDoctor({ cwd: dir });
    const mcpBefore = before.checks.find((c) => c.id === "mcp");
    assert.equal(mcpBefore.ok, false);
    assert.match(before.format(), /WARN\s+mcp/);

    await installMcp({ cwd: dir });

    const after = await runDoctor({ cwd: dir });
    const mcpAfter = after.checks.find((c) => c.id === "mcp");
    assert.equal(mcpAfter.ok, true);
    assert.match(after.format(), /OK\s+mcp/);
    assert.equal(after.severity, "ok");
    assert.equal(after.exitCode, 0);

    const cliAfter = await runCli(dir, ["doctor"]);
    assert.equal(cliAfter.code, 0);
    assert.match(cliAfter.stdout, /OK\s+mcp/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("help lists mcp install", async () => {
  const dir = await tmp();
  try {
    const out = await runCli(dir, ["help"]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /rooms mcp install/);
    assert.match(out.stdout, /rooms init .*--mcp/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
