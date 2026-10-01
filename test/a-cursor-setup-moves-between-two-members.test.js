// Cursor setups (0.7.2): alice exports what Cursor keeps for her project and for her, bob adopts it into
// his own, and rolls it back.
//
// What must hold: of Cursor's JSON files only servers, hooks and permission rules leave, never a value,
// an env file, the approval mode or the sandbox, nor a rule that lets any shell command run; bob gets
// ${NAME} for each variable and his own paths, the one form both Cursor's editor and its CLI fill in
// (its CLI leaves ${env:…}, ${workspaceFolder} and ${userHome} as written), never a path of alice's or
// a value; the plan says when a hook can answer "allow" for the agent; bob's CLI config is only added
// to, never made; and rollback puts every byte back, in the project and in his ~/.cursor.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { symlink } from "node:fs/promises";
import { exec, git, scratch, teamOfTwo } from "./team-helpers.js";
import { cursorCliDir, cursorWideRule, describeCursorRule, readCursor, scrubCursorHooks, scrubCursorPermissions } from "../src/setup/cursor.js";
import { buildManifest } from "../src/setup/manifest.js";
import { applyAdoption, planAdoption } from "../src/setup/adopt.js";

const posix = process.platform !== "win32";

async function put(path, text, mode) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
  if (mode && posix) await chmod(path, mode);
}

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

const VALUES = { serverEnv: "cursor-value-8181", header: "cursor-header-9191" };
// A GitHub token's shape, made up: the scan knows the prefix, so a skill holding it is refused whole.
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
const BUNDLED_SKILL = await readFile(new URL("../skills/rooms/SKILL.md", import.meta.url), "utf8");

async function plantAlice(alice) {
  const a = alice.web;
  const cursor = join(alice.userhome, ".cursor");
  await put(join(a, ".cursor/rules/style.mdc"), "---\ndescription: House style\nglobs: src/**\nalwaysApply: false\n---\nUse tabs.\n");
  await put(join(a, ".cursorrules"), "Be brief.\n");
  await put(join(a, ".cursor/skills/review/SKILL.md"), "---\nname: review\ndescription: Review a diff\n---\nRun scripts/run.sh.\n");
  await put(join(a, ".cursor/skills/review/scripts/run.sh"), "#!/bin/sh\ngit diff\n", 0o755);
  await put(join(a, ".cursor/agents/reviewer.md"), "---\nname: reviewer\nmodel: inherit\nreadonly: true\n---\nReview.\n");
  await put(join(a, ".cursor/commands/ship.md"), "Ship it.\n");
  await put(join(a, ".cursor/hooks/format.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  await put(join(a, ".cursor/skills/leaky/SKILL.md"), "---\nname: leaky\ndescription: x\n---\nSee notes.\n");
  await put(join(a, ".cursor/skills/leaky/notes.md"), `token ${TOKEN}\n`);
  await put(join(a, ".cursor/skills/rooms/SKILL.md"), BUNDLED_SKILL.replace(/iops-rooms@\d+\.\d+\.\d+/g, "iops-rooms@0.7.0"));
  await put(join(a, ".cursor/hooks.json"), JSON.stringify({
    version: 1,
    hooks: {
      afterFileEdit: [{ command: "./.cursor/hooks/format.sh" }],
      beforeShellExecution: [{ command: "npx -y guard@1.0.0", matcher: "rm", timeout: 10 }],
      // As written in the file, through whatever link the temp folder sits behind.
      stop: [{ command: `${a}/.cursor/hooks/format.sh --final` }, { command: "npx -y iops-rooms@0.7.1 agent-hook cursor" }],
    },
  }, null, 2));
  await put(join(a, ".cursor/mcp.json"), JSON.stringify({
    mcpServers: {
      issues: { command: "npx", args: ["-y", "@example/issues-mcp@1.4.2"], env: { ISSUES_API_TOKEN: VALUES.serverEnv } },
      docs: { url: "https://docs.example.com/mcp", headers: { Authorization: `Bearer ${VALUES.header}` } },
      search: { url: "https://search.example.com/mcp", headers: { Authorization: "Bearer ${env:SEARCH_TOKEN}", "X-Team": "${TEAM_ID}" } },
      tools: { command: "node", args: ["${workspaceFolder}/tools/mcp.js", "--cache", "${userHome}/.cache/tools"], env: { TOOLS_KEY: "${env:TOOLS_SECRET}" }, envFile: "${workspaceFolder}/.env" },
      lint: { command: "node", args: ["${workspaceFolder}${/}lint.js"] },
      "iops-rooms": { command: "npx", args: ["-y", "iops-rooms@0.7.1", "mcp"] },
    },
  }, null, 2));
  await put(join(a, ".cursor/cli.json"), JSON.stringify({ permissions: { allow: ["Shell(git)", "Shell(bash)", "Read(src/**)"], deny: ["Shell(rm)"] } }, null, 2));
  await put(join(a, "AGENTS.md"), "# Web\n");
  await put(join(a, ".cursor/worktrees.json"), JSON.stringify({ "setup-worktree": ["npm ci"] }));
  await put(join(cursor, "mcp.json"), JSON.stringify({ mcpServers: { assurance: { command: "uvx", args: ["assurance@0.1.11", "mcp"] }, here: { command: "node", args: ["${workspaceFolder}/x.js"] } } }, null, 2));
  await put(join(cursor, "cli-config.json"), JSON.stringify({ version: 1, editor: { vimMode: false }, permissions: { allow: ["Shell(ls)"], deny: [] }, approvalMode: "unrestricted", sandbox: { mode: "disabled", networkAccess: "allow" } }, null, 2));
  await put(join(cursor, "agents/me.md"), "---\nname: me\n---\nAlice's own.\n");
  await put(join(cursor, "skills-cursor/builtin/SKILL.md"), "---\nname: builtin\ndescription: x\n---\nCursor's own.\n");
  // A folder that is a link: Rooms reads nothing through it.
  if (posix) {
    await put(join(alice.userhome, "elsewhere/x.md"), "Read through a link.\n");
    await symlink(join(alice.userhome, "elsewhere"), join(cursor, "commands"));
  }
}

async function exportAndMerge(alice) {
  const made = await alice.rooms(alice.web, "setup", "export", "--role", "web", "--name", "cursor-flow", "--tool", "cursor", "--user", "--yes");
  assert.equal(made.code, 0, made.err || made.out);
  await git(alice.team, "merge", "-q", "--ff-only", "setup/web/cursor-flow");
  await git(alice.team, "push", "-q", "origin", "main");
  return made;
}

async function adoptApproved(bob, ...flags) {
  const preview = await bob.rooms(bob.web, "setup", "adopt", "web/cursor-flow", ...flags);
  const digest = /Plan ([0-9a-f]{16})\./.exec(preview.out)?.[1];
  assert.ok(digest, preview.out + preview.err);
  const done = await bob.rooms(bob.web, "setup", "adopt", "web/cursor-flow", ...flags, "--approve", digest);
  assert.equal(done.code, 0, done.err || done.out);
  return { preview, done };
}

test("alice's Cursor setup leaves without a value, an env file, her approval mode or sandbox, or a rule for any command", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await plantAlice(alice);
    const made = await exportAndMerge(alice);
    assert.match(made.out, /Cursor \(checked against Cursor 2026\.04\.17 \(cursor-agent\)\)/);
    assert.match(made.out, /Cursor's User Rules +they live inside Cursor's settings, not in a file/);
    const tree = (await git(alice.team, "ls-tree", "-r", "--name-only", "main", "--", "setups/")).split("\n");
    assert.deepEqual(tree, [
      "setups/web/cursor-flow/README.md",
      "setups/web/cursor-flow/files/cursor/project/.cursor/agents/reviewer.md",
      "setups/web/cursor-flow/files/cursor/project/.cursor/commands/ship.md",
      "setups/web/cursor-flow/files/cursor/project/.cursor/hooks/format.sh",
      "setups/web/cursor-flow/files/cursor/project/.cursor/rules/style.mdc",
      "setups/web/cursor-flow/files/cursor/project/.cursor/skills/review/SKILL.md",
      "setups/web/cursor-flow/files/cursor/project/.cursor/skills/review/scripts/run.sh",
      "setups/web/cursor-flow/files/cursor/project/.cursorrules",
      "setups/web/cursor-flow/files/cursor/user/agents/me.md",
      "setups/web/cursor-flow/setup.json",
    ]);
    for (const value of [...Object.values(VALUES), TOKEN, dir, await realpath(dir), alice.web]) {
      const found = await exec("git", ["-C", alice.team, "grep", "-I", "-F", "-e", value, "main"]).then(() => true, () => false);
      assert.equal(found, false, `${value} reached the team room`);
    }
    const m = JSON.parse(await git(alice.team, "show", "main:setups/web/cursor-flow/setup.json"));
    const cu = m.tools.cursor;
    assert.deepEqual(Object.keys(m.tools), ["cursor"]);
    assert.deepEqual(cu.project.mcpServers, {
      issues: { command: "npx", args: ["-y", "@example/issues-mcp@1.4.2"], env: { ISSUES_API_TOKEN: { fromEnv: "ISSUES_API_TOKEN" } } },
      docs: { url: "https://docs.example.com/mcp", headers: { Authorization: { fromEnv: "DOCS_AUTHORIZATION" } } },
      search: { url: "https://search.example.com/mcp", headers: { Authorization: { fromEnv: "SEARCH_TOKEN", prefix: "Bearer " }, "X-Team": { fromEnv: "TEAM_ID" } } },
      tools: { command: "node", args: ["${PROJECT}/tools/mcp.js", "--cache", "${HOME}/.cache/tools"], env: { TOOLS_KEY: { fromEnv: "TOOLS_SECRET" } } },
    });
    assert.deepEqual(m.requires.filter((q) => q.env).map((q) => q.env), ["DOCS_AUTHORIZATION", "ISSUES_API_TOKEN", "SEARCH_TOKEN", "TEAM_ID", "TOOLS_SECRET"]);
    assert.deepEqual(cu.project.permissions, { allow: ["Shell(git)", "Read(src/**)"], deny: ["Shell(rm)"] });
    assert.deepEqual(cu.project.hooks, {
      afterFileEdit: [{ command: "./.cursor/hooks/format.sh" }],
      beforeShellExecution: [{ command: "npx -y guard@1.0.0", timeout: 10, matcher: "rm" }],
      stop: [{ command: "${PROJECT}/.cursor/hooks/format.sh --final" }],
    }, "her project's path, through its link, became a placeholder, and Rooms' own hook stayed out");
    assert.deepEqual(cu.user, { mcpServers: { assurance: { command: "uvx", args: ["assurance@0.1.11", "mcp"] } }, permissions: { allow: ["Shell(ls)"] } });
    const left = m.notExported.map((n) => `${n.what}: ${n.why}`);
    for (const expected of [
      ".cursor/cli.json permissions.allow[1]: would let any command run without asking; a setup cannot give that to someone else",
      ".cursor/mcp.json tools.envFile: a file on the exporting machine; not exported",
      ".cursor/mcp.json lint: names a ${…} that Cursor's CLI does not fill in",
      "~/.cursor/mcp.json here: names whichever project is open; a setup for every project cannot carry that",
      "~/.cursor/cli-config.json approvalMode: how the agent asks and where it runs stay each person's own",
      "~/.cursor/cli-config.json sandbox: how the agent asks and where it runs stay each person's own",
      "AGENTS.md: read by Cursor too; it goes with Codex (--tool codex)",
      ".cursor/worktrees.json: runs setup scripts when Cursor makes a worktree; not in this version's setups",
      ".cursor/skills/rooms/: Rooms' own skill; rooms mcp install adds it",
      ".cursor/mcp.json iops-rooms: Rooms' own server; rooms mcp install adds it",
      ".cursor/hooks.json hooks: Rooms' own: each machine installs its own",
      ".cursor/skills/leaky/notes.md: holds something that looks like a secret",
      ".cursor/skills/leaky/SKILL.md: holds something that looks like a secret",
    ]) {
      assert.ok(left.includes(expected), `${expected}\nnot in:\n${left.join("\n")}`);
    }
    assert.ok(!left.some((l) => /skills-cursor|User Rules/.test(l)), "the person's own folder names stay on their machine");
    if (posix) assert.match(made.out, /~\/\.cursor\/commands +a link; Rooms does not follow links/);
  });
});

test("bob adopts the project's part, then his own; variables Cursor fills and his own paths, never alice's or a value; rollback puts back every byte", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    // What bob has already: one of alice's hooks and one of her rules, which adopting does not add twice.
    await put(join(bob.web, ".cursor/hooks.json"), `${JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./.cursor/hooks/format.sh" }] } }, null, 2)}\n`);
    await put(join(bob.web, ".cursor/cli.json"), `${JSON.stringify({ permissions: { allow: ["Read(src/**)"] } }, null, 2)}\n`);
    const before = await snapshot(bob.web, bob.userhome);

    const shown = await bob.rooms(bob.web, "setup", "show", "web/cursor-flow");
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Cursor permission rules for the project \(into \.cursor\/cli\.json\)\n +allow +Shell\(git\) +runs "git" with any arguments, without asking\n/);

    const { preview } = await adoptApproved(bob);
    assert.match(preview.out, /cursor hook beforeShellExecution \(rm\) +npx -y guard@1\.0\.0 +pinned guard@1\.0\.0\n +this hook can answer "allow" for the agent/);
    assert.match(preview.out, /allow +Shell\(git\) +runs "git" with any arguments, without asking +\(\.cursor\/cli\.json\)/);
    assert.match(preview.out, /skip +~\/\.cursor\/mcp\.json +yours, for every project: add --user to adopt it too/);
    assert.match(preview.out, /\.cursor\/mcp\.json[^\n]*\n +shared with the project: commit it only if everyone should have it/, "his own paths go into a file the project shares, and the plan says so");
    // The project as adopt finds it: git's top, resolved, which on Windows is the long form of a short name.
    const bobTop = await realpath(await git(bob.web, "rev-parse", "--show-toplevel"));
    const mcp = JSON.parse(await readFile(join(bob.web, ".cursor/mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers, {
      issues: { command: "npx", args: ["-y", "@example/issues-mcp@1.4.2"], env: { ISSUES_API_TOKEN: "${ISSUES_API_TOKEN}" } },
      docs: { url: "https://docs.example.com/mcp", headers: { Authorization: "${DOCS_AUTHORIZATION}" } },
      search: { url: "https://search.example.com/mcp", headers: { Authorization: "Bearer ${SEARCH_TOKEN}", "X-Team": "${TEAM_ID}" } },
      tools: { command: "node", args: [`${bobTop}/tools/mcp.js`, "--cache", `${bob.userhome}/.cache/tools`], env: { TOOLS_KEY: "${TOOLS_SECRET}" } },
    });
    assert.match(preview.out, new RegExp(`cursor mcp tools +node ${bobTop.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}/tools/mcp\\.js --cache`));
    assert.deepEqual(JSON.parse(await readFile(join(bob.web, ".cursor/hooks.json"), "utf8")), {
      version: 1,
      hooks: {
        afterFileEdit: [{ command: "./.cursor/hooks/format.sh" }],
        beforeShellExecution: [{ command: "npx -y guard@1.0.0", timeout: 10, matcher: "rm" }],
        stop: [{ command: `${bobTop.split(sep).join("/")}/.cursor/hooks/format.sh --final` }],
      },
    }, "his own hook is not added again, and ${PROJECT} is his project");
    assert.deepEqual(JSON.parse(await readFile(join(bob.web, ".cursor/cli.json"), "utf8")), { permissions: { allow: ["Read(src/**)", "Shell(git)"], deny: ["Shell(rm)"] } }, "his own rule is not added again");
    assert.equal(await readFile(join(bob.web, ".cursorrules"), "utf8"), "Be brief.\n");
    if (posix) assert.ok((await stat(join(bob.web, ".cursor/hooks/format.sh"))).mode & 0o100, "a hook script stays runnable");
    let back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);
    assert.deepEqual(await snapshot(bob.web, bob.userhome), before);

    const user = await adoptApproved(bob, "--user");
    assert.match(user.preview.out, /skip +~\/\.cursor\/cli-config\.json +Cursor's CLI writes this file the first time it runs: run cursor-agent once, then adopt again/);
    assert.deepEqual(JSON.parse(await readFile(join(bob.userhome, ".cursor/mcp.json"), "utf8")).mcpServers, { assurance: { command: "uvx", args: ["assurance@0.1.11", "mcp"] } });
    assert.equal(await readFile(join(bob.userhome, ".cursor/agents/me.md"), "utf8"), "---\nname: me\n---\nAlice's own.\n");
    assert.equal(await readFile(join(bob.userhome, ".cursor/cli-config.json"), "utf8").catch(() => null), null, "his CLI config is not made for him");
    back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);

    // Once his CLI has made its config, the rules are added to it and nothing else in it changes.
    const made = { version: 1, editor: { vimMode: true }, permissions: { allow: ["Shell(pwd)"], deny: [] }, approvalMode: "allowlist" };
    await put(join(bob.userhome, ".cursor/cli-config.json"), `${JSON.stringify(made, null, 2)}\n`);
    const withConfig = await snapshot(bob.web, bob.userhome);
    await adoptApproved(bob, "--user");
    const after = JSON.parse(await readFile(join(bob.userhome, ".cursor/cli-config.json"), "utf8"));
    assert.deepEqual(after, { ...made, permissions: { allow: ["Shell(pwd)", "Shell(ls)"], deny: [] } }, "the rule is added, and his approval mode and the rest stay his");
    back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);
    assert.deepEqual(await snapshot(bob.web, bob.userhome), withConfig, "the project and ~/.cursor, byte for byte");
  });
});

test("a Shell rule that lets any command run is refused, and every rule is said as what it allows", () => {
  for (const rule of ["Shell(*)", "Shell()", "Shell(* --x)", "Shell(bash)", "Shell(sh -c *)", "Shell(node)", "Shell(npx)", "Shell(sudo apt)", "Shell(python3:*)"]) {
    assert.notEqual(cursorWideRule(rule), "", rule);
  }
  for (const rule of ["Shell(git)", "Shell(ls)", "Shell(npm run test)", "Shell(node scripts/check.js)", "Read(src/**)", "Write(src/**)", "Mcp(issues:*)", "WebFetch(example.com)"]) {
    assert.equal(cursorWideRule(rule), "", rule);
  }
  assert.equal(describeCursorRule("allow", "Shell(git)"), 'runs "git" with any arguments, without asking');

  // Cursor fills nothing in a rule, so a path in one is this machine's, and stays here with any secret.
  const where = { home: "/Users/alice", project: "/Users/alice/code/web" };
  const r = scrubCursorPermissions({
    allow: ["Read(src/**)", "Read(/Users/alice/notes/**)", "Write(/Users/alice/code/web/dist/**)", "Read(/opt/acme/**)", `Shell(curl -H "Authorization: Bearer ${"abcDEF123456".repeat(3)}")`],
    deny: ["Read(.env)"],
  }, { label: "cli.json", where });
  assert.deepEqual(r.value, { allow: ["Read(src/**)"], deny: ["Read(.env)"] });
  assert.deepEqual(r.left.map((l) => `${l.what}: ${l.why}`), [
    "cli.json permissions.allow[1]: names a path on the exporting machine",
    "cli.json permissions.allow[2]: names a path on the exporting machine",
    "cli.json permissions.allow[3]: names a path on the exporting machine",
    "cli.json permissions.allow[4]: holds something that looks like a secret",
  ]);
  assert.equal(describeCursorRule("deny", "Shell(rm)"), 'never runs "rm"');
  assert.equal(describeCursorRule("allow", "Write(src/**)"), "writes src/** without asking");
});

test("a Cursor hook naming this machine, holding a secret or unpinned stays out; Rooms leaves Cursor's own skills and User Rules where they are", async () => {
  const where = { home: "/Users/alice", project: "/Users/alice/code/web" };
  const r = scrubCursorHooks({
    stop: [
      { command: "/opt/acme/bin/notify" },
      { command: `curl -H "Authorization: Bearer ${"abcDEF123456".repeat(3)}" https://hooks.example.com` },
      { command: "npx notifier" },
      { command: "/Users/alice/code/web/.cursor/hooks/done.sh", extra: true },
      { command: "git status --short", matcher: "/Users/alice/private" },
    ],
  }, { label: "hooks.json", where });
  assert.deepEqual(r.value, { stop: [{ command: "${PROJECT}/.cursor/hooks/done.sh" }] });
  assert.deepEqual(r.left.map((l) => `${l.what}: ${l.why}`), [
    "hooks.json hooks.stop[0]: names a path on the exporting machine",
    "hooks.json hooks.stop[1]: holds something that looks like a secret",
    "hooks.json hooks.stop[2]: runs something a setup cannot carry",
    "hooks.json hooks.stop[3].extra: not a key this version exports",
    "hooks.json hooks.stop[4]: a matcher that names a path or looks like a secret",
  ]);

  await scratch(async (dir) => {
    const home = join(dir, "home");
    await put(join(home, ".cursor/skills-cursor/builtin/SKILL.md"), "---\nname: builtin\ndescription: x\n---\nx\n");
    await put(join(home, ".cursor/skills/mine/SKILL.md"), "---\nname: mine\ndescription: x\n---\nx\n");
    const read = await readCursor({ project: null, home });
    assert.deepEqual(read.items.map((i) => i.label), ["~/.cursor/skills/mine/SKILL.md"]);
    assert.deepEqual(read.left.map((l) => l.what).sort(), ["Cursor's User Rules", "~/.cursor/skills-cursor/"]);
    assert.ok(read.left.every((l) => l.local), "names from the person's own folder stay on their machine");
  });
});

test("the CLI's own config is read and written where the CLI keeps it: CURSOR_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.cursor", async () => {
  const at = (env) => cursorCliDir("/h", env);
  assert.deepEqual(at({}), { dir: join("/h", ".cursor"), label: "~/.cursor/cli-config.json" });
  assert.deepEqual(at({ CURSOR_CONFIG_DIR: " " }), at({}), "a blank one is not set, as the CLI reads it");
  assert.deepEqual(at({ XDG_CONFIG_HOME: "/x" }), { dir: join("/x", "cursor"), label: "$XDG_CONFIG_HOME/cursor/cli-config.json" });
  assert.deepEqual(at({ XDG_CONFIG_HOME: "/x", CURSOR_CONFIG_DIR: "/c" }), { dir: "/c", label: "$CURSOR_CONFIG_DIR/cli-config.json" });

  await scratch(async (dir) => {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    const env = { XDG_CONFIG_HOME: xdg };
    const stale = `${JSON.stringify({ permissions: { allow: ["Shell(stale)"] } }, null, 2)}\n`;
    await put(join(home, ".cursor/cli-config.json"), stale);
    await put(join(xdg, "cursor/cli-config.json"), `${JSON.stringify({ version: 1, permissions: { allow: ["Shell(pwd)"], deny: [] }, approvalMode: "allowlist" }, null, 2)}\n`);
    const read = await readCursor({ project: null, home, env });
    const cli = read.items.find((i) => i.kind === "config");
    assert.equal(cli.label, "$XDG_CONFIG_HOME/cursor/cli-config.json");
    assert.deepEqual(cli.value, { permissions: { allow: ["Shell(pwd)"] } }, "the file the CLI reads, never a stale one in ~/.cursor");
    assert.ok(!JSON.stringify([read.items, read.left]).includes(xdg), "the folder the variable holds is never named");

    const project = join(dir, "web");
    await mkdir(project, { recursive: true });
    await exec("git", ["init", "-q", project]);
    const items = [{ selected: true, left: [], tool: "cursor", scope: "user", kind: "config", label: "~/.cursor/cli-config.json", value: { permissions: { allow: ["Shell(ls)"] } } }];
    const { manifest, files } = buildManifest({ role: "web", name: "cli", owner: "alice", version: "0.7.2", items });
    const setup = { manifest: JSON.parse(JSON.stringify(manifest)), files, commit: "c0ffee", revision: "c0ffee", team: "local/team" };
    const plan = await planAdoption({ setup, project, config: join(dir, "claude"), cursorConfig: join(home, ".cursor"), cursorCli: cursorCliDir(home, env), home, user: true });
    assert.deepEqual(plan.writes.filter((w) => w.action !== "same").map((w) => [w.label, w.target]), [["$XDG_CONFIG_HOME/cursor/cli-config.json", join(xdg, "cursor", "cli-config.json")]]);
    await applyAdoption(plan, { backupsDir: join(dir, "backups") });
    assert.deepEqual(JSON.parse(await readFile(join(xdg, "cursor/cli-config.json"), "utf8")).permissions, { allow: ["Shell(pwd)", "Shell(ls)"], deny: [] });
    assert.equal(await readFile(join(home, ".cursor/cli-config.json"), "utf8"), stale, "a file the CLI does not read is left alone");
  });
});
