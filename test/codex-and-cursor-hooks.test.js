// Codex and Cursor hooks: same quiet allowlisted log as Claude Code.
// Payload shapes from vendor docs (2026-10-16); see docs/design/HOOK_PAYLOADS.md (local).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  fromCodex,
  fromCursor,
  fromCustom,
  pathsFromApplyPatch,
  planCodexHooks,
  planCursorHooks,
  applyCodexHooks,
  applyCursorHooks,
} from "../src/agent-hooks.js";
import { packagesFromNpmLock, packageRollupFromActivity } from "../src/packages.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const SENTINEL = "sentinel-codex-cursor-never-keep";
const exists = (p) => access(p).then(() => true, () => false);

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-cc-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd, argv, { input = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ROOMS_NO_OPEN: "1", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}

async function repoWithRoom(dir) {
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(join(dir, "first.txt"), "x\n", "utf8");
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", "first"], { cwd: dir });
  await run(dir, ["init"]);
}

const activity = async (dir) =>
  (await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("pathsFromApplyPatch keeps only file lines, never the patch body", () => {
  const cmd = `*** Begin Patch\n*** Update File: src/a.js\n@@\n-const x = "${SENTINEL}";\n+const x = 1;\n*** Add File: src/b.js\n+hi\n*** End Patch`;
  assert.deepEqual(pathsFromApplyPatch(cmd), ["src/a.js", "src/b.js"]);
  assert.doesNotMatch(pathsFromApplyPatch(cmd).join(""), /sentinel/);
});

test("Codex events map to the few fields Rooms keeps", () => {
  const start = fromCodex({ hook_event_name: "SessionStart", session_id: "s1", model: "gpt-5", transcript_path: `/t/${SENTINEL}` });
  assert.equal(start.kind, "session");
  assert.equal(start.phase, "start");
  assert.equal(start.agent, "codex");
  assert.equal(start.model, "gpt-5");
  assert.match(start.session, /^[0-9a-f]{12}$/);
  assert.equal(fromCodex({ hook_event_name: "SessionEnd", session_id: "s1" }).phase, "end");
  const edit = fromCodex({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "apply_patch",
    tool_input: { command: `*** Update File: src/x.js\n@@\n-${SENTINEL}\n` },
    tool_response: SENTINEL,
  });
  assert.equal(edit.via, "apply_patch");
  assert.deepEqual(edit.files, ["src/x.js"]);
  assert.equal(fromCodex({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null);
});

test("Cursor events map to the few fields Rooms keeps", () => {
  const start = fromCursor({
    hook_event_name: "sessionStart",
    session_id: "conv-1",
    composer_mode: "agent",
    model: "composer",
  });
  assert.equal(start.agent, "cursor");
  assert.equal(start.phase, "start");
  assert.equal(start.entry, "agent");
  const edit = fromCursor({
    hook_event_name: "afterFileEdit",
    conversation_id: "conv-1",
    file_path: "/proj/src/a.ts",
    edits: [{ old_string: SENTINEL, new_string: "safe" }],
  });
  assert.equal(edit.via, "afterFileEdit");
  assert.equal(edit.file, "/proj/src/a.ts");
  assert.equal(fromCursor({ hook_event_name: "afterTabFileEdit", file_path: "/x" }), null);
});

test("a Codex apply_patch edit keeps paths and nothing of the patch", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.js"), "1\n", "utf8");
    const input = JSON.stringify({
      session_id: "codex-session-with-secret-name",
      transcript_path: `/Users/x/.codex/${SENTINEL}.jsonl`,
      cwd: dir,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: `*** Update File: src/a.js\n@@\n-old ${SENTINEL}\n+new\n` },
      tool_response: SENTINEL,
    });
    const r = await run(dir, ["agent-hook", "codex"], { input });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    const raw = await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8");
    assert.doesNotMatch(raw, new RegExp(SENTINEL));
    assert.doesNotMatch(raw, /codex-session-with-secret/);
    const [edit] = await activity(dir);
    assert.equal(edit.agent, "codex");
    assert.equal(edit.path, "src/a.js");
    assert.equal(edit.via, "apply_patch");
  });
});

test("a Cursor afterFileEdit keeps the path and nothing of the edits", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "1\n", "utf8");
    const input = JSON.stringify({
      hook_event_name: "afterFileEdit",
      conversation_id: "cursor-conv-secret",
      cwd: dir,
      file_path: join(dir, "src", "a.ts"),
      edits: [{ old_string: SENTINEL, new_string: "x" }],
    });
    const r = await run(dir, ["agent-hook", "cursor"], { input });
    assert.equal(r.code, 0);
    const raw = await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8");
    assert.doesNotMatch(raw, new RegExp(SENTINEL));
    assert.doesNotMatch(raw, /cursor-conv-secret/);
    const [edit] = await activity(dir);
    assert.equal(edit.agent, "cursor");
    assert.equal(edit.path, "src/a.ts");
  });
});

test("installing Codex and Cursor hooks is reversible", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    for (const agent of ["codex", "cursor"]) {
      const installed = await run(dir, ["hooks", "install", "--agent", agent, "--yes"]);
      assert.equal(installed.code, 0, installed.err + installed.out);
      const path =
        agent === "codex" ? join(dir, ".codex", "hooks.json") : join(dir, ".cursor", "hooks.json");
      assert.ok(await exists(path));
      const doc = JSON.parse(await readFile(path, "utf8"));
      if (agent === "codex") {
        assert.match(doc.hooks.PostToolUse[0].hooks[0].command, /agent-hook codex$/);
        assert.equal(doc.hooks.PostToolUse[0].matcher, "apply_patch|Edit|Write");
      } else {
        assert.equal(doc.version, 1);
        assert.match(doc.hooks.afterFileEdit[0].command, /agent-hook cursor$/);
      }
      const removed = await run(dir, ["hooks", "uninstall", "--agent", agent]);
      assert.equal(removed.code, 0, removed.err);
    }
  });
});

test("custom record session and edit use AI_AGENT and keep no extras", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const env = { AI_AGENT: "mybot_1-0-0_agent", AI_AGENT_MODEL: "custom-model" };
    const start = await run(dir, ["record", "session-start"], {
      input: JSON.stringify({ session: "custom-sess", model: "ignored-if-env" }),
      env,
    });
    assert.equal(start.code, 0);
    const edit = await run(dir, ["record", "edit", "--path", "first.txt"], { env });
    assert.equal(edit.code, 0);
    const rows = await activity(dir);
    assert.equal(rows[0].agent, "mybot");
    assert.equal(rows[0].kind, "session");
    assert.equal(rows[1].kind, "edit");
    assert.equal(rows[1].path, "first.txt");
    assert.equal(fromCustom({ kind: "edit", path: "a.js" }, {}), null, "needs an agent id");
  });
});

test("package-lock parse and rollup keep names and versions only", () => {
  const lock = {
    packages: {
      "": { name: "app" },
      "node_modules/left-pad": { version: "1.3.0" },
      "node_modules/@scope/pkg": { version: "2.0.0" },
    },
  };
  const map = packagesFromNpmLock(JSON.stringify(lock));
  assert.equal(map.get("left-pad"), "1.3.0");
  assert.equal(map.get("@scope/pkg"), "2.0.0");
  const rollup = packageRollupFromActivity([
    { kind: "package", name: "left-pad", version: "1.3.0", manager: "npm", action: "seen", at: new Date().toISOString() },
  ]);
  assert.equal(rollup[0].name, "left-pad");
  assert.equal(rollup[0].version, "1.3.0");
});

test("rooms record packages writes package events from package-lock.json", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": {},
          "node_modules/demo-pkg": { version: "9.9.9" },
        },
      }),
      "utf8",
    );
    const r = await run(dir, ["record", "packages"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 new/);
    const pkgs = (await activity(dir)).filter((a) => a.kind === "package");
    assert.equal(pkgs[0].name, "demo-pkg");
    assert.equal(pkgs[0].version, "9.9.9");
    assert.equal(pkgs[0].action, "seen");
  });
});

test("planCodexHooks and planCursorHooks preview without writing", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const codex = await planCodexHooks({ cwd: dir, cliPath: cli });
    assert.match(codex.path, /\.codex[/\\]hooks\.json$/);
    assert.match(codex.after, /agent-hook codex/);
    assert.equal(await exists(codex.path), false);
    await applyCodexHooks(codex, { cwd: dir });
    assert.ok(await exists(codex.path));

    const cursor = await planCursorHooks({ cwd: dir, cliPath: cli });
    assert.match(cursor.after, /"version": 1/);
    await applyCursorHooks(cursor, { cwd: dir });
    assert.ok(await exists(cursor.path));
  });
});
