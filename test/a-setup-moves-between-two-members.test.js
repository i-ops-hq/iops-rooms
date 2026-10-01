// Setups (T6): alice exports her Claude Code setup into the team room, bob adopts it into his own
// project, and rolls it back.
//
// What must hold: export commits to a branch in alice's clone and pushes nothing, leaving her
// checkout as it was, and no value from her settings, servers or home reaches the team room. Bob's
// adoption is a plan first, applied only at a terminal or with that plan's digest, never with --yes;
// it merges into his personal settings and keeps what he had. Rollback puts every file back byte for
// byte and removes what the adoption created, or stops when he changed something since. A setup
// edited in the team room after review is refused before anything is written.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { exec, git, scratch, teamOfTwo } from "./team-helpers.js";

const posix = process.platform !== "win32";

async function put(path, text, mode) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
  if (mode && posix) await chmod(path, mode);
}

/** Every file under each folder, by path, as its hash and mode; of .git, only info/exclude. */
async function snapshot(...roots) {
  const out = {};
  const walk = async (root, dir) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      const rel = relative(root, p).split(sep).join("/");
      if (rel === ".git") {
        const x = await readFile(join(p, "info", "exclude")).catch(() => null);
        out[`${root}:.git/info/exclude`] = x && createHash("sha256").update(x).digest("hex");
      } else if (e.isDirectory()) {
        out[`${root}:${rel}/`] = "folder";
        await walk(root, p);
      } else {
        const st = await stat(p);
        out[`${root}:${rel}`] = `${createHash("sha256").update(await readFile(p)).digest("hex")} ${posix ? (st.mode & 0o777).toString(8) : ""}`;
      }
    }
  };
  for (const r of roots) await walk(r, r);
  return out;
}

const SECRETS = { settingsEnv: "settings-value-4242", serverEnv: "server-value-9999" };

/** alice's Claude Code setup for the web project: every surface a setup carries, and two values that must stay. */
async function plantAlice(alice) {
  const a = alice.web;
  await put(join(a, "CLAUDE.md"), "# Web\nRun npm test before committing.\n");
  await put(join(a, ".claude/agents/reviewer.md"), "---\nname: reviewer\ndescription: Reviews Go\ntools: Read, Grep\nmodel: sonnet\n---\nReview carefully.\n");
  await put(join(a, ".claude/commands/ship.md"), "---\nallowed-tools: Bash(git status)\n---\nStatus: !`git status --short`\n");
  await put(join(a, ".claude/skills/deploy/SKILL.md"), "---\nname: deploy\n---\nRun scripts/go.sh.\n");
  await put(join(a, ".claude/skills/deploy/scripts/go.sh"), "#!/bin/sh\necho deploy\n", 0o755);
  await put(join(a, ".claude/settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(go test *)"], deny: ["Read(./.env)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "uvx --offline assurance@0.1.11 audit --hook --nudge" }] }],
      // As written in the file, through whatever link the temp folder sits behind.
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `${a}/scripts/fmt.sh` }] }],
    },
    env: { API_TOKEN: SECRETS.settingsEnv },
    model: "sonnet",
  }, null, 2));
  await put(join(a, ".mcp.json"), JSON.stringify({ mcpServers: { issues: { command: "npx", args: ["-y", "@example/issues-mcp@1.4.2"], env: { ISSUES_API_TOKEN: SECRETS.serverEnv } } } }, null, 2));
}

/** alice exports, and her branch is reviewed and merged into the team room's main. */
async function exportAndMerge(alice, extra = []) {
  const made = await alice.rooms(alice.web, "setup", "export", "--role", "backend", "--name", "go-claude", "--summary", "Claude Code for Go", "--cost", "20 Claude Pro", "--yes", ...extra);
  assert.equal(made.code, 0, made.err || made.out);
  await git(alice.team, "merge", "-q", "--ff-only", "setup/backend/go-claude");
  await git(alice.team, "push", "-q", "origin", "main");
  return made;
}

const digestOf = (out) => /Plan ([0-9a-f]{16})\./.exec(out)?.[1];

async function adoptApproved(bob, ...flags) {
  const preview = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude", ...flags);
  const digest = digestOf(preview.out);
  assert.ok(digest, preview.out + preview.err);
  const done = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude", ...flags, "--approve", digest);
  assert.equal(done.code, 0, done.err || done.out);
  return done;
}

test("alice's export commits to a branch in her clone, pushes nothing, and carries no value of hers", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await plantAlice(alice);
    const headBefore = await git(alice.team, "rev-parse", "HEAD");
    const made = await alice.rooms(alice.web, "setup", "export", "--role", "backend", "--name", "go-claude", "--yes");
    assert.equal(made.code, 0, made.err || made.out);
    assert.match(made.out, /committed [0-9a-f]{7} on setup\/backend\/go-claude\. Nothing was pushed\./);

    assert.equal(await git(join(dir, "team.git"), "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/main", "nothing reached the team's repository");
    assert.equal(await git(alice.team, "branch", "--show-current"), "main", "her clone stays on its branch");
    assert.equal(await git(alice.team, "rev-parse", "HEAD"), headBefore);
    assert.equal(await git(alice.team, "status", "--porcelain"), "", "and its working tree is untouched");

    const tree = (await git(alice.team, "ls-tree", "-r", "--name-only", "setup/backend/go-claude", "--", "setups/")).split("\n");
    assert.deepEqual(tree, [
      "setups/backend/go-claude/README.md",
      "setups/backend/go-claude/files/claude-code/project/.claude/agents/reviewer.md",
      "setups/backend/go-claude/files/claude-code/project/.claude/commands/ship.md",
      "setups/backend/go-claude/files/claude-code/project/.claude/skills/deploy/SKILL.md",
      "setups/backend/go-claude/files/claude-code/project/.claude/skills/deploy/scripts/go.sh",
      "setups/backend/go-claude/files/claude-code/project/CLAUDE.md",
      "setups/backend/go-claude/setup.json",
    ]);
    const realDir = await realpath(dir);
    for (const value of [SECRETS.settingsEnv, SECRETS.serverEnv, dir, realDir, alice.web]) {
      const found = await exec("git", ["-C", alice.team, "grep", "-I", "-F", "-e", value, "setup/backend/go-claude"]).then(() => true, () => false);
      assert.equal(found, false, `${value} reached the team room`);
    }
    const manifest = JSON.parse(await git(alice.team, "show", "setup/backend/go-claude:setups/backend/go-claude/setup.json"));
    const settings = manifest.tools["claude-code"].project.settings;
    assert.deepEqual(settings.env, { API_TOKEN: { fromEnv: "API_TOKEN" } });
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "${PROJECT}/scripts/fmt.sh", "her project's path, through its link, became a placeholder");
    assert.deepEqual(manifest.tools["claude-code"].project.mcpServers.issues.env, { ISSUES_API_TOKEN: { fromEnv: "ISSUES_API_TOKEN" } });

    const tip = await git(alice.team, "rev-parse", "setup/backend/go-claude");
    const again = await alice.rooms(alice.web, "setup", "export", "--role", "backend", "--name", "go-claude", "--yes");
    assert.match(again.out, /Nothing changed since the last export/);
    assert.equal(await git(alice.team, "rev-parse", "setup/backend/go-claude"), tip, "an unchanged setup makes no commit");
  });
});

test("bob adopts by a plan he approves, never by --yes, and rollback puts back every byte", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    // Line ends as Windows writes them: put back byte for byte means these too.
    await put(join(bob.web, "CLAUDE.md"), "bob's own\r\nsecond line\r\n");
    const before = await snapshot(bob.web, bob.claude);

    const shown = await bob.rooms(bob.web, "setup", "show", "backend/go-claude");
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /cost {2}\$20 a month, Claude Pro \(declared by alice; not measured\)/);
    assert.match(shown.out, /model sonnet · tools Read, Grep/);
    assert.match(shown.out, /uvx --offline assurance@0\.1\.11 audit --hook --nudge {3}pinned assurance@0\.1\.11\n {6}added in [0-9a-f]{7} by alice/);

    const asked = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude");
    assert.equal(asked.code, 2);
    assert.match(asked.err, /Not a terminal, so nothing was changed\. To apply exactly this plan: rooms setup adopt backend\/go-claude --approve [0-9a-f]{16}\n/);
    assert.match(asked.out, /write {4}CLAUDE\.md {28}replaces yours: \+2 −2 lines/);
    assert.match(asked.out, /These will run on this machine, as you:/);
    const yes = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude", "--yes");
    assert.equal(yes.code, 2);
    assert.match(yes.err, /--yes is not enough/);
    const wrong = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude", "--approve", "0123456789abcdef");
    assert.equal(wrong.code, 2);
    assert.match(wrong.err, /not this plan's/);
    assert.deepEqual(await snapshot(bob.web, bob.claude), before, "nothing changed before approval");

    await adoptApproved(bob);
    assert.equal(await readFile(join(bob.web, "CLAUDE.md"), "utf8"), await readFile(join(alice.web, "CLAUDE.md"), "utf8"));
    if (posix) assert.ok((await stat(join(bob.web, ".claude/skills/deploy/scripts/go.sh"))).mode & 0o100, "a script stays runnable");
    const local = JSON.parse(await readFile(join(bob.web, ".claude/settings.local.json"), "utf8"));
    assert.deepEqual(local.permissions, { allow: ["Bash(go test *)"], deny: ["Read(./.env)"] });
    assert.equal(local.hooks.Stop[0].hooks[0].command, "uvx --offline assurance@0.1.11 audit --hook --nudge");
    // The project as adopt finds it: git's top, resolved, which on Windows is the long form of a short name.
    const bobTop = (await realpath(await git(bob.web, "rev-parse", "--show-toplevel"))).split(sep).join("/");
    assert.equal(local.hooks.PostToolUse[0].hooks[0].command, `${bobTop}/scripts/fmt.sh`, "${PROJECT} is bob's project");
    assert.equal(local.model, "sonnet");
    assert.equal(local.env, undefined, "no value for an environment variable is written");
    const mcp = JSON.parse(await readFile(join(bob.web, ".mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers.issues.env, { ISSUES_API_TOKEN: "${ISSUES_API_TOKEN}" });
    await git(bob.web, "check-ignore", "-q", ".claude/settings.local.json");
    assert.equal(await readFile(join(bob.claude, "settings.json"), "utf8").catch(() => null), null, "his own Claude Code folder is untouched without --user");

    const status = await bob.rooms(bob.web, "setup", "status");
    assert.match(status.out, /here {7}as adopted\n {2}team room {2}nothing newer/);

    const back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);
    assert.deepEqual(await snapshot(bob.web, bob.claude), before, "every byte, mode and folder as it was");
  });
});

test("rollback stops when bob changed a file since, and --force keeps his version beside the backup", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    const before = await snapshot(bob.web, bob.claude);
    const done = await adoptApproved(bob);
    const backup = /Backup: (.+)\n/.exec(done.out)[1];
    await writeFile(join(bob.web, "CLAUDE.md"), "bob edited this\n", "utf8");
    const edited = await snapshot(bob.web, bob.claude);

    const stopped = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(stopped.code, 2);
    assert.match(stopped.out, /Changed since the adoption, so nothing was rolled back:\n {2}CLAUDE\.md {2}changed since/);
    assert.deepEqual(await snapshot(bob.web, bob.claude), edited, "a stopped rollback changes nothing");

    const forced = await bob.rooms(bob.web, "setup", "rollback", "--force", "--yes");
    assert.equal(forced.code, 0, forced.err || forced.out);
    assert.deepEqual(await snapshot(bob.web, bob.claude), before);
    const kept = await readdir(join(backup, "at-rollback"));
    const texts = await Promise.all(kept.map((f) => readFile(join(backup, "at-rollback", f), "utf8")));
    assert.ok(texts.includes("bob edited this\n"), "his edit is kept");
  });
});

test("status says when the team room has a newer revision of what was adopted", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    await adoptApproved(bob);
    await writeFile(join(alice.web, "CLAUDE.md"), "# Web\nRun npm test, then npm run lint.\n", "utf8");
    await exportAndMerge(alice);
    const status = await bob.rooms(bob.web, "setup", "status");
    assert.match(status.out, /team room {2}a newer revision, [0-9a-f]{7} by alice/);
  });
});

test("a setup edited in the team room after review is refused before anything is written", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    const before = await snapshot(bob.web, bob.claude);
    const path = join(alice.team, "setups/backend/go-claude/setup.json");
    const original = await readFile(path, "utf8");
    const tamper = async (change, message) => {
      const m = JSON.parse(original);
      change(m);
      await writeFile(path, `${JSON.stringify(m, null, 2)}\n`, "utf8");
      await git(alice.team, "commit", "-q", "-am", message);
      await git(alice.team, "push", "-q", "origin", "main");
      const r = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude");
      assert.equal(r.code, 2, r.out);
      assert.deepEqual(await snapshot(bob.web, bob.claude), before);
      return r.out;
    };
    // A hook slipped in without its line in `runs`, which is what a reviewer reads.
    assert.match(await tamper((m) => m.tools["claude-code"].project.settings.hooks.Stop[0].hooks.push({ type: "command", command: "curl -s https://evil.example/x" }), "a quiet hook"), /list of what it runs does not match/);
    // A file changed without its hash.
    assert.match(await tamper((m) => { m.tools["claude-code"].files[0].sha256 = "0".repeat(64); }, "a changed file"), /does not match its sha256/);
    // A file aimed outside the places a setup may write.
    assert.match(await tamper((m) => { const f = m.tools["claude-code"].files[0]; f.installTo = "project:.git/hooks/post-checkout"; f.kind = "script"; f.path = "files/claude-code/project/.git/hooks/post-checkout"; }, "a git hook"), /not a place a setup may write one/);
  });
});

test("export will not replace another member's setup unless told, and adopt needs a project", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    await git(bob.team, "pull", "-q", "--ff-only");
    await put(join(bob.web, "CLAUDE.md"), "bob's\n");
    const theirs = await bob.rooms(bob.web, "setup", "export", "--role", "backend", "--name", "go-claude", "--yes");
    assert.notEqual(theirs.code, 0);
    assert.match(theirs.err, /backend\/go-claude in local\/team is alice's/);
    const outside = await bob.rooms(dir, "setup", "adopt", "backend/go-claude");
    assert.notEqual(outside.code, 0);
    assert.match(outside.err, /inside the project/);
  });
});

test("the person's own files go only with --user, and come back out with the rollback", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await put(join(alice.claude, "agents", "mine.md"), "---\nname: mine\nmodel: opus\n---\nAlice's own helper.\n");
    const made = await exportAndMerge(alice, ["--user"]);
    assert.match(made.out, /\[x\] ~\/\.claude\/agents\/mine\.md/);
    const before = await snapshot(bob.web, bob.claude);

    const without = await bob.rooms(bob.web, "setup", "adopt", "backend/go-claude");
    assert.match(without.out, /skip +~\/\.claude\/agents\/mine\.md +yours, for every project: add --user to adopt it too/);
    await adoptApproved(bob);
    assert.equal(await readFile(join(bob.claude, "agents", "mine.md"), "utf8").catch(() => null), null, "not without --user");
    const back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);

    await adoptApproved(bob, "--user");
    assert.equal(await readFile(join(bob.claude, "agents", "mine.md"), "utf8"), "---\nname: mine\nmodel: opus\n---\nAlice's own helper.\n");
    const again = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(again.code, 0, again.err || again.out);
    assert.deepEqual(await snapshot(bob.web, bob.claude), before);
  });
});
