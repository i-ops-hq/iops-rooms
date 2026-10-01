// Codex setups (0.7.1): alice exports what Codex keeps for her project and for her, bob adopts it into
// his own, and rolls it back.
//
// What must hold: of a Codex config only the allowed keys leave, never a value from an environment
// table, a server's env or a header, never a [projects] folder, and never a mode that lets commands
// out of the sandbox; Codex's settings go into bob's ~/.codex/config.toml only with --user, added to
// his text with his comments and his own same-named server kept; Codex's skills in ~/.agents/skills
// are his own too; and rollback puts every byte back, in the project, in ~/.codex and in his home.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { exec, git, scratch, teamOfTwo } from "./team-helpers.js";
import { parseToml } from "../src/setup/toml.js";
import { readCodex, scrubCodexConfig } from "../src/setup/codex.js";

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

const VALUES = { serverEnv: "codex-value-5151", header: "header-value-6262", shellEnv: "shell-value-7373" };

async function plantAlice(alice) {
  const a = alice.web;
  await put(join(a, "CLAUDE.md"), "# Web, for Claude\n");
  await put(join(a, "AGENTS.md"), "# Web\nUse pnpm.\n");
  await put(join(a, ".agents/skills/release/SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\nRun scripts/tag.sh.\n");
  await put(join(a, ".agents/skills/release/scripts/tag.sh"), "#!/bin/sh\ngit tag \"$1\"\n", 0o755);
  await put(join(a, ".codex/config.toml"), [
    'model = "gpt-6"',
    "",
    "[mcp_servers.issues]",
    'command = "npx"',
    'args = ["-y", "@example/issues-mcp@1.4.2"]',
    `env = { ISSUES_API_TOKEN = "${VALUES.serverEnv}" }`,
    "",
    "[mcp_servers.docs]",
    'url = "https://docs.example.com/mcp"',
    `http_headers = { Authorization = "Bearer ${VALUES.header}" }`,
    "",
    "[mcp_servers.helper]",
    'url = "https://helper.example.com/mcp"',
    'http_headers_helper = "make-headers --now"',
    "",
  ].join("\n"));
  await put(join(alice.codex, "AGENTS.md"), "Be brief.\n");
  await put(join(alice.codex, "prompts/review.md"), "---\ndescription: Review the diff\n---\nReview $ARGUMENTS.\n");
  await put(join(alice.codex, "config.toml"), [
    'model = "gpt-6.1-sol"',
    'model_reasoning_effort = "high"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'notify = ["say", "done"]',
    'service_tier = "fast"',
    "",
    `[projects.${JSON.stringify(await realpath(a))}]`,
    'trust_level = "trusted"',
    "",
    "[shell_environment_policy.set]",
    `SECRET_THING = "${VALUES.shellEnv}"`,
    "",
    "[mcp_servers.search]",
    'command = "uvx"',
    'args = ["search-mcp@2.0.0"]',
    "",
  ].join("\n"));
  await put(join(alice.userhome, ".agents/skills/notes/SKILL.md"), "---\nname: notes\ndescription: Keep notes\n---\nKeep notes.\n");
}

async function exportAndMerge(alice) {
  const made = await alice.rooms(alice.web, "setup", "export", "--role", "web", "--name", "codex-flow", "--tool", "codex", "--user", "--yes");
  assert.equal(made.code, 0, made.err || made.out);
  await git(alice.team, "merge", "-q", "--ff-only", "setup/web/codex-flow");
  await git(alice.team, "push", "-q", "origin", "main");
  return made;
}

async function adoptApproved(bob, ...flags) {
  const preview = await bob.rooms(bob.web, "setup", "adopt", "web/codex-flow", ...flags);
  const digest = /Plan ([0-9a-f]{16})\./.exec(preview.out)?.[1];
  assert.ok(digest, preview.out + preview.err);
  const done = await bob.rooms(bob.web, "setup", "adopt", "web/codex-flow", ...flags, "--approve", digest);
  assert.equal(done.code, 0, done.err || done.out);
  return { preview, done };
}

test("alice's Codex setup leaves without a value of hers, a folder of hers, or a way out of the sandbox", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await plantAlice(alice);
    const made = await exportAndMerge(alice);
    assert.match(made.out, /Codex \(checked against Codex CLI 0\.159\.0\)/);
    const tree = (await git(alice.team, "ls-tree", "-r", "--name-only", "main", "--", "setups/")).split("\n");
    assert.deepEqual(tree, [
      "setups/web/codex-flow/README.md",
      "setups/web/codex-flow/files/codex/home/.agents/skills/notes/SKILL.md",
      "setups/web/codex-flow/files/codex/project/.agents/skills/release/SKILL.md",
      "setups/web/codex-flow/files/codex/project/.agents/skills/release/scripts/tag.sh",
      "setups/web/codex-flow/files/codex/project/AGENTS.md",
      "setups/web/codex-flow/files/codex/user/AGENTS.md",
      "setups/web/codex-flow/files/codex/user/prompts/review.md",
      "setups/web/codex-flow/setup.json",
    ]);
    for (const value of [...Object.values(VALUES), dir, await realpath(dir), alice.web]) {
      const found = await exec("git", ["-C", alice.team, "grep", "-I", "-F", "-e", value, "main"]).then(() => true, () => false);
      assert.equal(found, false, `${value} reached the team room`);
    }
    const m = JSON.parse(await git(alice.team, "show", "main:setups/web/codex-flow/setup.json"));
    const cx = m.tools.codex;
    assert.deepEqual(Object.keys(m.tools), ["codex"]);
    assert.deepEqual(cx.project.mcpServers.issues, { command: "npx", args: ["-y", "@example/issues-mcp@1.4.2"], env: { ISSUES_API_TOKEN: { fromEnv: "ISSUES_API_TOKEN" } } });
    assert.deepEqual(cx.project.mcpServers.docs, { url: "https://docs.example.com/mcp", env_http_headers: { Authorization: "DOCS_AUTHORIZATION" } });
    assert.deepEqual(cx.project.mcpServers.helper, { url: "https://helper.example.com/mcp" });
    assert.equal(cx.project.settings, undefined, "a project's Codex config carries only its servers");
    assert.deepEqual(cx.user.settings, { model: "gpt-6.1-sol", model_reasoning_effort: "high", approval_policy: "on-request", sandbox_mode: "workspace-write", notify: ["say", "done"] });
    const left = m.notExported.map((n) => `${n.what}: ${n.why}`);
    for (const expected of [
      ".codex/config.toml model: a project's Codex config carries only its MCP servers in a setup",
      ".codex/config.toml mcp_servers.helper.http_headers_helper: runs a command to make headers; not in this version's setups",
      "~/.codex/config.toml [projects]: names folders on this machine; never exported",
      "~/.codex/config.toml [shell_environment_policy]: may hold environment values; never exported",
      "~/.codex/config.toml service_tier: not a key this version exports",
    ]) {
      assert.ok(left.includes(expected), `${expected}\nnot in:\n${left.join("\n")}`);
    }
    assert.deepEqual(m.runs.map((r) => `${r.tool} ${r.scope} ${r.surface} ${r.name || r.file || ""}`.trim()), [
      "codex project mcp docs",
      "codex project mcp helper",
      "codex project mcp issues",
      "codex user notify",
      "codex user mcp search",
      "codex project script project:.agents/skills/release/scripts/tag.sh",
    ]);
    assert.ok(m.requires.some((q) => q.env === "DOCS_AUTHORIZATION") && m.requires.some((q) => q.env === "ISSUES_API_TOKEN"));
  });
});

test("bob adopts the project's part, then his own with --user, into his text, and rollback puts back every byte", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await plantAlice(alice);
    await exportAndMerge(alice);
    const bobsOwn = '# bob\'s Codex\nmodel = "gpt-5"\n\n[mcp_servers.search]\ncommand = "uvx"\nargs = ["other@1.0.0"]\n';
    await put(join(bob.codex, "config.toml"), bobsOwn);
    const before = await snapshot(bob.web, bob.codex, bob.userhome);

    const { preview } = await adoptApproved(bob);
    assert.match(preview.out, /skip +~\/\.codex\/config\.toml +your Codex settings for every project: add --user to adopt them too/);
    assert.match(preview.out, /Codex reads it only in a project you trust/);
    assert.match(preview.out, /write +\.codex\/config\.toml +new file: \+ issues · \+ docs · \+ helper\n/, "a new config says what it holds");
    assert.equal(await readFile(join(bob.web, "AGENTS.md"), "utf8"), "# Web\nUse pnpm.\n");
    const project = parseToml(await readFile(join(bob.web, ".codex/config.toml"), "utf8"));
    assert.ok(project.ok);
    assert.deepEqual(project.value.mcp_servers, {
      docs: { url: "https://docs.example.com/mcp", env_http_headers: { Authorization: "DOCS_AUTHORIZATION" } },
      helper: { url: "https://helper.example.com/mcp" },
      issues: { command: "npx", args: ["-y", "@example/issues-mcp@1.4.2"], env_vars: ["ISSUES_API_TOKEN"] },
    });
    assert.equal(await readFile(join(bob.codex, "config.toml"), "utf8"), bobsOwn, "his own config is untouched without --user");
    assert.equal(await readFile(join(bob.userhome, ".agents/skills/notes/SKILL.md"), "utf8").catch(() => null), null, "and so are the skills in his home");
    assert.equal(await readFile(join(bob.web, "CLAUDE.md"), "utf8").catch(() => null), null, "--tool codex took Codex alone");
    let back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);
    assert.deepEqual(await snapshot(bob.web, bob.codex, bob.userhome), before);

    const user = await adoptApproved(bob, "--user");
    assert.match(user.preview.out, /approval_policy on-request \(was unset\) {3}Codex asks when a command needs more than its sandbox allows/);
    assert.match(user.preview.out, /sandbox_mode workspace-write \(was unset\) {3}commands may write in the project, and nowhere else/);
    assert.match(user.preview.out, /kept yours: search/);
    const merged = await readFile(join(bob.codex, "config.toml"), "utf8");
    assert.ok(merged.startsWith('# bob\'s Codex\nmodel = "gpt-6.1-sol"\n'), merged);
    const config = parseToml(merged);
    assert.ok(config.ok);
    assert.deepEqual(config.value.notify, ["say", "done"]);
    assert.equal(config.value.sandbox_mode, "workspace-write");
    assert.deepEqual(config.value.mcp_servers.search, { command: "uvx", args: ["other@1.0.0"] }, "his own server by that name stays his");
    assert.equal(await readFile(join(bob.codex, "prompts/review.md"), "utf8"), "---\ndescription: Review the diff\n---\nReview $ARGUMENTS.\n");
    assert.equal(await readFile(join(bob.userhome, ".agents/skills/notes/SKILL.md"), "utf8"), "---\nname: notes\ndescription: Keep notes\n---\nKeep notes.\n");
    back = await bob.rooms(bob.web, "setup", "rollback", "--yes");
    assert.equal(back.code, 0, back.err || back.out);
    assert.deepEqual(await snapshot(bob.web, bob.codex, bob.userhome), before, "the project, ~/.codex and his home, byte for byte");
  });
});

test("Codex export leaves out a way out of the sandbox, a rules folder, and a skill that declares dependencies", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await put(join(alice.codex, "config.toml"), 'sandbox_mode = "danger-full-access"\napproval_policy = { granular = { rules = true } }\nmodel = "gpt-6"\n');
    await put(join(alice.codex, "rules/default.rules"), 'prefix_rule(pattern = ["git"], decision = "allow")\n');
    await put(join(alice.web, ".agents/skills/deps/SKILL.md"), "---\nname: deps\ndescription: x\n---\nx\n");
    await put(join(alice.web, ".agents/skills/deps/agents/openai.yaml"), "dependencies:\n  tools:\n    - type: mcp\n");
    const read = await readCodex({ project: await realpath(alice.web), env: { CODEX_HOME: alice.codex }, home: alice.userhome });
    const config = read.items.find((i) => i.label === "~/.codex/config.toml");
    assert.deepEqual(config.value, { settings: { model: "gpt-6" } });
    const left = [...read.left, ...config.left].map((l) => `${l.what}: ${l.why}`);
    assert.ok(left.includes("~/.codex/config.toml sandbox_mode: sandbox_mode danger-full-access lets commands reach anything on the machine; a setup cannot set it for someone else"), left.join("\n"));
    assert.ok(left.includes("~/.codex/config.toml approval_policy: a granular approval policy; not in this version's setups"));
    assert.ok(left.includes("~/.codex/rules/: rules let commands run outside the sandbox without asking; not in this version's setups"));
    const deps = read.items.filter((i) => i.label.startsWith(".agents/skills/deps/"));
    assert.equal(deps.length, 2);
    assert.ok(deps.every((i) => /declares dependencies/.test(i.refused)), "the whole skill");
  });
});

test("a project's Codex config gives its servers only, and a server's values become names", () => {
  const where = { home: "/Users/alice", project: "/Users/alice/code/web" };
  const r = scrubCodexConfig({
    model: "gpt-6",
    mcp_servers: {
      local: { command: "node", args: ["/Users/alice/code/web/tools/mcp.js"], cwd: "/Users/alice/code/web", env: { TOKEN: "t-value" }, env_vars: ["HOME_URL", { name: "REMOTE", source: "remote" }] },
      named: { command: "node", env_vars: ["A", { name: "B", source: "local" }], tools: { search: { approval_mode: "approve" } } },
      unpinned: { command: "npx", args: ["server"] },
      "iops-rooms": { command: "npx", args: ["-y", "iops-rooms@0.7.0", "mcp"] },
    },
  }, { label: ".codex/config.toml", where, settings: false });
  assert.deepEqual(r.value.mcpServers, { named: { command: "node", env_vars: ["A", "B"] } });
  const left = r.left.map((l) => `${l.what}: ${l.why}`);
  assert.deepEqual(left, [
    ".codex/config.toml model: a project's Codex config carries only its MCP servers in a setup",
    ".codex/config.toml mcp_servers.local: env_vars this version does not read",
    ".codex/config.toml mcp_servers.named.tools: per-tool approvals are not in this version's setups",
    ".codex/config.toml mcp_servers.unpinned: runs something a setup cannot carry",
    ".codex/config.toml mcp_servers.iops-rooms: Rooms' own server; rooms mcp install adds it",
  ]);
  const ok = scrubCodexConfig({ mcp_servers: { local: { command: "node", args: ["/Users/alice/code/web/tools/mcp.js"], cwd: "/Users/alice/code/web", env: { TOKEN: "t-value" } } } }, { label: "c", where, settings: false });
  assert.deepEqual(ok.value.mcpServers.local, { command: "node", args: ["${PROJECT}/tools/mcp.js"], cwd: "${PROJECT}", env: { TOKEN: { fromEnv: "TOKEN" } } });
  assert.ok(!JSON.stringify(ok).includes("t-value"));
});
