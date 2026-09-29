// What an agent's own hooks report: the sessions that ran here and the files they edited, joined by
// the git hook to the commit that carried them.
//
// The case this exists for: an agent edits, and a person commits by hand from another terminal. The
// commit carries no trailer and no agent variables, and until now nothing in Rooms could see that an
// agent had been involved. Claude Code's hooks report each edit; the payload also carries the whole
// file, the tool's output and the last message, and none of those may be kept.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applyClaudeHooks, fromClaudeCode, planClaudeHooks } from "../src/agent-hooks.js";
import { editedByFor } from "../src/activity.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const SENTINEL = "sentinel-5c1e-never-keep";
const exists = (p) => access(p).then(() => true, () => false);

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-edits-"));
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

async function commit(dir, files, message = "change") {
  for (const f of files) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), `${f} ${Math.random()}\n`, "utf8");
  }
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", message], { cwd: dir });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

async function repoWithRoom(dir) {
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await commit(dir, ["first.txt"], "first");
  await run(dir, ["init"]);
}

/** The payload Claude Code sends after an edit, with everything that must never be kept in it. */
function editPayload(dir, file, tool = "Write") {
  return JSON.stringify({
    session_id: "0f8a-session-id-that-names-a-transcript",
    transcript_path: `/Users/someone/.claude/projects/x/${SENTINEL}.jsonl`,
    cwd: dir,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: join(dir, file), file_text: `const key = "${SENTINEL}";`, old_string: SENTINEL },
    tool_output: `wrote ${SENTINEL}`,
    last_assistant_message: SENTINEL,
    prompt: SENTINEL,
  });
}

const activity = async (dir) =>
  (await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("Claude Code's events map to the few fields Rooms keeps", () => {
  const env = { CLAUDECODE: "1", AI_AGENT: "claude-code_2-1-281_agent", CLAUDE_CODE_ENTRYPOINT: "cli" };
  const start = fromClaudeCode({ hook_event_name: "SessionStart", session_id: "abc", model: "claude-opus-5-5" }, env);
  assert.deepEqual(
    { ...start, session: start.session.length },
    { agent: "claude-code", session: 12, source: "hook", kind: "session", phase: "start", model: "claude-opus-5-5", version: "2.1.281", entry: "cli" },
  );
  assert.equal(fromClaudeCode({ hook_event_name: "SessionEnd", session_id: "abc" }).phase, "end");
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.equal(fromClaudeCode({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: "/p/a.js" } }).via, tool);
  }
  assert.equal(fromClaudeCode({ hook_event_name: "PostToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: "/p/n.ipynb" } }).file, "/p/n.ipynb");
  // A read, a shell command, an unknown event, or nothing at all is not an edit.
  assert.equal(fromClaudeCode({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/p/a.js" } }), null);
  assert.equal(fromClaudeCode({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null);
  assert.equal(fromClaudeCode({ hook_event_name: "UserPromptSubmit", prompt: "x" }), null);
  assert.equal(fromClaudeCode(null), null);
});

test("an edit keeps its file's path and nothing else from the payload", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const r = await run(dir, ["agent-hook", "claude-code"], { input: editPayload(dir, "src/a.js") });
    assert.equal(r.code, 0);
    const raw = await readFile(join(dir, ".room", "agent-activity.jsonl"), "utf8");
    const records = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(records.length, 1);
    const [edit] = records;
    assert.equal(edit.kind, "edit");
    assert.equal(edit.path, "src/a.js", "relative to the project, with forward slashes");
    assert.match(edit.session, /^[0-9a-f]{12}$/, "a hash of the session id, not the id");
    // Every key is one the adapter chose; nothing of the payload rode along.
    const allowed = new Set(["agent", "session", "source", "kind", "via", "path", "checkout", "v", "at"]);
    assert.deepEqual(Object.keys(edit).filter((k) => !allowed.has(k)), []);
    assert.doesNotMatch(raw, /sentinel-5c1e|transcript|0f8a-session-id/);
  });
});

test("the hook says nothing and exits 0, whatever it is given", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const cases = [
      editPayload(dir, "a.js"),
      "{not json",
      "",
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: dir }),
      editPayload(join(dir, ".."), "outside.js"),
    ];
    assert.equal(cases.length, 5);
    for (const input of cases) {
      const r = await run(dir, ["agent-hook", "claude-code"], { input });
      assert.deepEqual([r.code, r.out, r.err], [0, "", ""], `for ${input.slice(0, 40)}`);
    }
    const r = await run(dir, ["agent-hook", "no-such-agent"], { input: editPayload(dir, "a.js") });
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  });
});

test("a file outside the project, or a project without a room, records nothing", async () => {
  await scratch(async (dir) => {
    const project = join(dir, "p");
    await repoWithRoom(project);
    await run(project, ["agent-hook", "claude-code"], { input: editPayload(project, "../elsewhere.js") });
    assert.deepEqual(await activity(project), []);

    const bare = join(dir, "bare");
    await exec("git", ["init", "-q", "-b", "main", bare]);
    await run(bare, ["agent-hook", "claude-code"], { input: editPayload(bare, "a.js") });
    assert.equal(await exists(join(bare, ".room")), false);
  });
});

test("a commit made by hand carries the files the agent edited since each was last committed", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await run(dir, ["hooks", "install"]);
    // The agent edits a.txt; the person commits a.txt and b.txt from their own terminal.
    await run(dir, ["agent-hook", "claude-code"], { input: editPayload(dir, "a.txt") });
    const first = await commit(dir, ["a.txt", "b.txt"], "by hand");
    // A.txt changed again by hand, with no new edit from the agent: not the agent's any more.
    const second = await commit(dir, ["a.txt"], "by hand again");
    const commits = (await activity(dir)).filter((r) => r.kind === "commit");
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((c) => [c.sha, c.madeIn, c.editedBy]), [
      [first, null, { "claude-code": ["a.txt"] }],
      [second, null, null],
    ]);
  });
});

test("work split into two commits carries the agent's edits in each, and a deleted file is not carried", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await commit(dir, ["old.txt"], "old.txt, by hand, before any hook");
    await run(dir, ["hooks", "install"]);
    const commitOnly = async (files, message) => {
      for (const f of files) await writeFile(join(dir, f), `${f} ${Math.random()}\n`, "utf8");
      await exec("git", [...IDENT, "add", "-A", "--", ...files], { cwd: dir });
      await exec("git", [...IDENT, "commit", "-q", "-m", message], { cwd: dir });
      return (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    };
    // The agent edits two files; the person commits them one at a time, the way `git add -p` does.
    await run(dir, ["agent-hook", "claude-code"], { input: editPayload(dir, "x.txt") });
    await run(dir, ["agent-hook", "claude-code"], { input: editPayload(dir, "y.txt") });
    const one = await commitOnly(["x.txt"], "x only");
    const two = await commitOnly(["y.txt"], "then y");
    // The agent edits a file that was committed before; the person deletes it instead.
    await run(dir, ["agent-hook", "claude-code"], { input: editPayload(dir, "old.txt", "Edit") });
    await exec("git", [...IDENT, "rm", "-q", "old.txt"], { cwd: dir });
    await exec("git", [...IDENT, "commit", "-q", "-m", "delete old.txt"], { cwd: dir });
    const three = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();

    const commits = (await activity(dir)).filter((r) => r.kind === "commit");
    assert.equal(commits.length, 3);
    assert.deepEqual(commits.map((c) => [c.sha, c.editedBy]), [
      [one, { "claude-code": ["x.txt"] }],
      [two, { "claude-code": ["y.txt"] }],
      [three, null],
    ]);
  });
});

test("an edit in the same second as its file's last commit, but before it, is not carried by the next", async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "-b", "main", dir]);
    // git keeps these to the second; the hook's records keep milliseconds.
    const at = async (when, message) => {
      await writeFile(join(dir, "a.txt"), `${message}\n`, "utf8");
      await exec("git", [...IDENT, "add", "a.txt"], { cwd: dir });
      await exec("git", [...IDENT, "commit", "-q", "-m", message], {
        cwd: dir,
        env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
      });
      return (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    };
    const first = await at("2026-09-29T12:00:00Z", "first");
    const second = await at("2026-09-29T12:00:05Z", "second");
    const log = [
      { kind: "edit", agent: "claude-code", path: "a.txt", at: "2026-09-29T12:00:00.300Z" },
      { kind: "commit", sha: first, at: "2026-09-29T12:00:00.800Z" },
    ];
    assert.deepEqual(await editedByFor(dir, first, log), { "claude-code": ["a.txt"] });
    assert.equal(await editedByFor(dir, second, log), null, "0.300 is after 12:00:00 but before the commit at 0.800");
    const later = [...log, { kind: "edit", agent: "claude-code", path: "a.txt", at: "2026-09-29T12:00:00.900Z" }];
    assert.deepEqual(await editedByFor(dir, second, later), { "claude-code": ["a.txt"] });
  });
});

test("an edit in one worktree is not credited to a commit in another", async () => {
  await scratch(async (dir) => {
    const main = join(dir, "app");
    await repoWithRoom(main);
    await run(main, ["hooks", "install"]);
    const other = join(dir, "app-other");
    await exec("git", ["worktree", "add", "-q", other, "-b", "other"], { cwd: main });
    // The agent in the other worktree edits shared.txt; the main checkout commits its own shared.txt.
    await run(other, ["agent-hook", "claude-code"], { input: editPayload(other, "shared.txt") });
    await commit(main, ["shared.txt"], "main's own");
    const [c] = (await activity(main)).filter((r) => r.kind === "commit");
    assert.equal(c.editedBy, null);
  });
});

test("rooms week counts the commits that carry an agent's edits, apart from the trailers", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    await run(dir, ["hooks", "install"]);
    await run(dir, ["agent-hook", "claude-code"], { input: editPayload(dir, "a.txt") });
    await commit(dir, ["a.txt"], "the agent's edit, committed by hand");
    await commit(dir, ["b.txt"], "mine");
    const week = await run(dir, ["week"]);
    assert.match(week.out, /no agent recorded\s+3/, "the trailer rows are untouched");
    assert.match(week.out, /carry files an agent edited\s+1 of 2 observed \(Claude Code 1\)/);
    assert.match(week.out, /made inside an agent session\s+0 of 2 observed/);
    const json = JSON.parse((await run(dir, ["week", "--json"])).out);
    assert.equal(json.attributed, 0);
    assert.equal(json.observed.agentEdited, 1);
    assert.deepEqual(json.observed.editedByAgent, { "claude-code": 1 });
  });
});

test("installing for Claude Code keeps every other hook, and uninstalling leaves the file as it was", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const settings = join(dir, ".claude", "settings.local.json");
    await mkdir(join(dir, ".claude"));
    // Somebody's own settings, including another tool's Stop hook, in their own formatting.
    const original =
      '{\n    "permissions": { "allow": ["Bash(go test:*)"] },\n    "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "uvx --offline assurance@0.1.11 audit --hook" } ] } ] }\n}\n';
    await writeFile(settings, original, "utf8");

    const installed = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.equal(installed.code, 0, installed.err);
    // The undo line names the build that ran, here a file run with node, not whatever `rooms` is.
    assert.ok(installed.out.includes(`undo: node "${cli}" hooks uninstall --agent claude-code`), installed.out);
    const after = JSON.parse(await readFile(settings, "utf8"));
    assert.deepEqual(after.permissions, { allow: ["Bash(go test:*)"] });
    assert.match(after.hooks.Stop[0].hooks[0].command, /assurance@0\.1\.11/, "the other tool's hook is kept");
    assert.match(after.hooks.PostToolUse[0].hooks[0].command, /agent-hook claude-code$/);
    assert.equal(after.hooks.PostToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
    assert.ok(after.hooks.SessionStart && after.hooks.SessionEnd);
    assert.ok(await exists(join(dir, ".git", "hooks", "post-commit")), "and the git hook that joins edits to commits");

    const again = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.equal(again.code, 0, again.err);
    const twice = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(twice.hooks.PostToolUse.length, 1, "installing twice leaves one entry, not two");

    const removed = await run(dir, ["hooks", "uninstall", "--agent", "claude-code"]);
    assert.equal(removed.code, 0, removed.err);
    assert.equal(await readFile(settings, "utf8"), original, "byte for byte");
    assert.equal(await exists(`${settings}.rooms-backup`), false);
  });
});

test("the install says a copy of the file is kept only when it keeps one", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const settings = join(dir, ".claude", "settings.local.json");
    const copy = `${settings}.rooms-backup`;
    await mkdir(join(dir, ".claude"));
    const original = '{ "permissions": { "allow": [] } }\n';
    await writeFile(settings, original, "utf8");

    const first = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /every hook already in the file stays as it is\n/);
    assert.match(first.out, /a copy of the file as it is now is kept beside it/);
    assert.equal(await readFile(copy, "utf8"), original);

    // The file holds Rooms hooks and nothing is beside it: the state 0.5.14 promised a copy in, and
    // made none, rightly, since a copy of Rooms hooks would put them back on uninstall.
    await rm(copy);
    const again = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /the Rooms hooks already in it are replaced; every other hook stays as it is/);
    assert.doesNotMatch(again.out, /copy/);
    assert.equal(await exists(copy), false);

    // A copy from an earlier install is named as that, and left alone.
    await writeFile(copy, original, "utf8");
    const kept = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.equal(kept.code, 0, kept.err);
    assert.match(kept.out, /the copy beside it, from before Rooms first changed the file, is kept/);
    assert.equal(await readFile(copy, "utf8"), original);
  });
});

test("a permission rule naming the hook is not a Rooms hook, and nothing to remove changes nothing", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const settings = join(dir, ".claude", "settings.local.json");
    await mkdir(join(dir, ".claude"));
    const allowed = '{ "permissions": { "allow": ["Bash(rooms agent-hook claude-code)"] } }\n';
    await writeFile(settings, allowed, "utf8");
    const installed = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.equal(installed.code, 0, installed.err);
    assert.doesNotMatch(installed.out, /already in it are replaced/);
    assert.equal(await readFile(`${settings}.rooms-backup`, "utf8"), allowed, "so its copy is made");
    await run(dir, ["hooks", "uninstall", "--agent", "claude-code"]);
    assert.equal(await readFile(settings, "utf8"), allowed);

    // An empty hooks object, in the person's own spacing, holds no Rooms hooks to take out.
    const empty = '{"hooks": {},   "model": "x"}\n';
    await writeFile(settings, empty, "utf8");
    const removed = await run(dir, ["hooks", "uninstall", "--agent", "claude-code"]);
    assert.equal(removed.code, 0, removed.err);
    assert.match(removed.out, /^no Rooms hooks in /);
    assert.equal(await readFile(settings, "utf8"), empty, "byte for byte");
  });
});

test("a copy that appears while the preview is read is not replaced", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const settings = join(dir, ".claude", "settings.local.json");
    await mkdir(join(dir, ".claude"));
    await writeFile(settings, "{}\n", "utf8");
    const plan = await planClaudeHooks({ cwd: dir, cliPath: cli });
    assert.equal(plan.copy, "write");
    await writeFile(`${settings}.rooms-backup`, "earlier\n", "utf8");
    await applyClaudeHooks(plan, { cwd: dir });
    assert.equal(await readFile(`${settings}.rooms-backup`, "utf8"), "earlier\n");
    assert.match(await readFile(settings, "utf8"), /agent-hook claude-code/);
  });
});

test("a settings file Rooms created is removed again, with its line in .git/info/exclude", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const settings = join(dir, ".claude", "settings.local.json");
    const installed = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.match(installed.out, /settings\.local\.json {2}\(new file\)\n/);
    assert.doesNotMatch(installed.out, /copy|stays as it is/, "nothing was there to keep");
    assert.ok(await exists(settings));
    const exclude = join(dir, ".git", "info", "exclude");
    assert.match(await readFile(exclude, "utf8"), /^\.claude\/settings\.local\.json$/m);
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir });
    assert.doesNotMatch(stdout, /settings\.local\.json/, "it cannot be committed by accident");

    await run(dir, ["hooks", "uninstall", "--agent", "claude-code"]);
    assert.equal(await exists(settings), false);
    assert.doesNotMatch(await readFile(exclude, "utf8"), /settings\.local\.json/);
  });
});

test("without a terminal or --yes nothing is installed, and a broken settings file is refused", async () => {
  await scratch(async (dir) => {
    await repoWithRoom(dir);
    const settings = join(dir, ".claude", "settings.local.json");
    const asked = await run(dir, ["hooks", "install", "--agent", "claude-code"]);
    assert.equal(asked.code, 2);
    assert.match(asked.err, /nothing was changed/);
    assert.equal(await exists(settings), false);

    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(settings, "{ broken", "utf8");
    const refused = await run(dir, ["hooks", "install", "--agent", "claude-code", "--yes"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /not valid JSON/);
    assert.equal(await readFile(settings, "utf8"), "{ broken");
  });
});
