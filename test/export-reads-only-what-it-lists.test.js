// What `rooms setup export` reads (docs/design/TEAM_SETUPS.md §7.3 and §9.3): known files and known
// keys, from the project and from the person's Claude Code folder, and nothing else. Of
// ~/.claude.json, which also holds the account and every project's state, only mcpServers. A key it
// does not take is listed by name with why, never dropped silently, and never with its value.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCode, scrubMcpServers, selectItems } from "../src/setup/claude-code.js";

async function put(path, text) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function planted(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-reader-"));
  const home = join(dir, "home");
  const project = join(home, "code", "web");
  const config = join(dir, "claude");
  try {
    await put(join(project, "CLAUDE.md"), "# Web\n");
    await put(join(project, "src/app.js"), "console.log('app');\n");
    await put(join(project, ".claude/agents/reviewer.md"), "---\nname: reviewer\n---\nReview.\n");
    await put(join(project, ".claude/agents/keyed.md"), `---\nname: keyed\n---\nUse ${"gh" + "p_" + "a1B2".repeat(9)} for the API.\n`);
    await put(join(project, ".claude/commands/hooked.md"), "---\nhooks:\n  Stop:\n    - hooks: []\n---\nx\n");
    await put(join(project, ".claude/skills/ok/SKILL.md"), "---\nname: ok\n---\nFine.\n");
    await put(join(project, ".claude/skills/leaky/SKILL.md"), "---\nname: leaky\n---\nSee notes.\n");
    await put(join(project, ".claude/skills/leaky/.env"), "TOKEN=x\n");
    await put(join(project, ".claude/skills/homey/SKILL.md"), `---\nname: homey\n---\nRead ${home}/notes.md first.\n`);
    await put(join(project, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(rm -rf *)"] } }));
    await put(join(project, "CLAUDE.local.md"), "my sandbox is at https://sandbox.internal\n");
    await put(join(project, ".claude/settings.json"), JSON.stringify({
      permissions: { allow: ["Bash(npm test *)", "Bash(*)", `Read(/${home}/secrets/**)`], defaultMode: "bypassPermissions" },
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: `"/usr/bin/node" "/x/src/cli.js" agent-hook claude-code` },
            { type: "command", command: "npx -y lint@1.0.0" },
            { type: "command", command: `curl -H "Authorization: Bearer ${"abcDEF123456".repeat(3)}" https://hooks.example.com` },
            { type: "command", command: "npx unpinned" },
            { type: "command", command: "echo checked", statusMessage: `checking ${project}` },
          ],
        }],
      },
      apiKeyHelper: "/bin/print-key",
      enabledPlugins: { "x@y": true },
      theme: "dark",
    }));
    await put(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "iops-rooms": { command: "npx", args: ["-y", "iops-rooms@0.6.2", "mcp"] }, issues: { command: "npx", args: ["-y", "@example/issues@1.0.0"], env: { TOKEN: "issues-value-77" } } } }));
    await put(join(config, "CLAUDE.md"), "Mine.\n");
    await put(join(config, "agents/me.md"), "---\nname: me\n---\nMine.\n");
    await put(join(config, "projects/-code-web/session.jsonl"), '{"prompt":"my secret plans"}\n');
    await put(join(config, "settings.json"), JSON.stringify({ theme: "light", hooks: {} }));
    await put(join(config, ".claude.json"), JSON.stringify({
      oauthAccount: { emailAddress: "alice@example.com" },
      userID: "user-id-123",
      projects: { [project]: { mcpServers: { local: { command: "npx", args: ["-y", "local@1.0.0"] } } } },
      mcpServers: { mine: { command: "uvx", args: ["mine@2.0.0"] } },
    }));
    await fn({ dir, home, project, config, env: { CLAUDE_CONFIG_DIR: config } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("export lists known files and keys, and every value it leaves out stays out", async () => {
  await planted(async ({ home, project, env }) => {
    const read = await readClaudeCode({ project, home, env });
    assert.deepEqual(read.items.map((i) => `${i.label}${i.refused ? " REFUSED" : ""}`), [
      "CLAUDE.md",
      ".claude/agents/keyed.md REFUSED",
      ".claude/agents/reviewer.md",
      ".claude/commands/hooked.md REFUSED",
      ".claude/skills/homey/SKILL.md REFUSED",
      ".claude/skills/leaky/.env REFUSED",
      ".claude/skills/leaky/SKILL.md REFUSED",
      ".claude/skills/ok/SKILL.md",
      ".claude/settings.json",
      ".mcp.json",
      "~/.claude/CLAUDE.md",
      "~/.claude/agents/me.md",
      "~/.claude/settings.json",
      "~/.claude.json",
    ]);
    const all = JSON.stringify(read);
    for (const value of ["alice@example.com", "user-id-123", "local@1.0.0", "issues-value-77", "my secret plans", "sandbox.internal", "rm -rf", "/bin/print-key", "console.log"]) {
      assert.ok(!all.includes(value), `${value} was read into what export holds`);
    }
    const byLabel = Object.fromEntries(read.items.map((i) => [i.label, i]));
    assert.match(byLabel[".claude/skills/leaky/SKILL.md"].refused, /\.claude\/skills\/leaky\/: \.claude\/skills\/leaky\/\.env is never read/, "one refused file refuses its skill");
    assert.match(byLabel[".claude/skills/homey/SKILL.md"].refused, /line 4 names a folder in your home/);
    assert.match(byLabel[".claude/agents/keyed.md"].refused, /line 4 looks like a GitHub token/);
    assert.match(byLabel[".claude/commands/hooked.md"].refused, /defines hooks in its frontmatter/);
    assert.equal(byLabel[".claude/skills/homey/SKILL.md"].refusedWhy, "names a folder on the exporting machine", "the committed reason names no folder");
    assert.deepEqual(Object.keys(byLabel["~/.claude.json"].value), ["mine"], "of the account file, only its servers");

    const left = [...read.left, ...read.items.flatMap((i) => i.left)].map((l) => `${l.what}: ${l.why}`);
    for (const expected of [
      ".claude/settings.local.json: personal to this project on this machine",
      "CLAUDE.local.md: personal to this project on this machine",
      ".claude/settings.json apiKeyHelper: a command that prints credentials; never exported",
      ".claude/settings.json enabledPlugins: plugins are not in this version's setups",
      ".claude/settings.json theme: not a key this version exports",
      ".claude/settings.json hooks: Rooms' own: each machine installs its own, with rooms hooks install",
      ".mcp.json iops-rooms: Rooms' own server; rooms mcp install adds it",
      ".claude/settings.json permissions.allow[1]: would let any command run without asking; a setup cannot give that to someone else",
      ".claude/settings.json permissions.allow[2]: names a path on the exporting machine; write it with ~/ and export again",
      ".claude/settings.json permissions.defaultMode: permission mode bypassPermissions stops Claude Code asking; a setup cannot set it for someone else",
      ".claude/settings.json hooks.Stop[0].hooks[2]: holds something that looks like a secret",
      ".claude/settings.json hooks.Stop[0].hooks[3]: runs something a setup cannot carry",
      ".claude/settings.json hooks.Stop[0].hooks[4]: names a path on the exporting machine",
    ]) {
      assert.ok(left.includes(expected), `${expected}\nnot in:\n${left.join("\n")}`);
    }
    assert.deepEqual(byLabel[".claude/settings.json"].value.hooks.Stop[0].hooks.map((h) => h.command), ["npx -y lint@1.0.0"]);
    assert.deepEqual(byLabel[".claude/settings.json"].value.permissions, { allow: ["Bash(npm test *)"] });
  });
});

test("the project's files are selected and the person's own are not, unless asked, and a name that matches nothing stops it", async () => {
  await planted(async ({ home, project, env }) => {
    const { items } = await readClaudeCode({ project, home, env });
    const picked = (opts) => selectItems(items, opts).filter((i) => i.selected).map((i) => i.label);
    assert.deepEqual(picked({}), ["CLAUDE.md", ".claude/agents/reviewer.md", ".claude/skills/ok/SKILL.md", ".claude/settings.json", ".mcp.json"]);
    assert.ok(picked({ user: true }).includes("~/.claude/agents/me.md"));
    assert.ok(!picked({ user: true }).includes("~/.claude/settings.json"), "a settings file with nothing to carry is not selected");
    assert.deepEqual(picked({ skip: [".claude/", ".mcp.json"] }), ["CLAUDE.md"]);
    assert.deepEqual(picked({ only: ["~/.claude/agents/me.md"] }), ["~/.claude/agents/me.md"]);
    assert.throws(() => selectItems(items, { skip: [".claude/agent/"] }), /Nothing here is called \.claude\/agent\//);
  });
});

test("a link is listed and never followed", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async () => {
  await planted(async ({ dir, home, project, env }) => {
    await put(join(dir, "elsewhere", "notes.md"), "private notes\n");
    await symlink(join(dir, "elsewhere"), join(project, ".claude", "rules"));
    const read = await readClaudeCode({ project, home, env });
    assert.ok(!JSON.stringify(read.items).includes("private notes"));
    assert.ok(read.left.some((l) => l.what === ".claude/rules" && /a link; Rooms does not follow links/.test(l.why)));
  });
});

test("a server's values become placeholders, and an address or command that carries one is left out", () => {
  const where = { home: "/Users/alice", project: "/Users/alice/code/web" };
  const r = scrubMcpServers({
    docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "acme-team-value" } },
    login: { type: "http", url: "https://user:pass@x.example.com/mcp" },
    keyed: { type: "sse", url: "https://x.example.com/sse?access_token=abc" },
    local: { command: "node", args: ["/Users/alice/code/web/tools/mcp.js"], env: { HOME_URL: "https://intranet" } },
    abs: { command: "/usr/local/bin/server" },
    loose: { command: "npx", args: ["server"] },
  }, { label: ".mcp.json", where });
  assert.deepEqual(r.value, {
    docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: { fromEnv: "DOCS_TOKEN", prefix: "Bearer " }, "X-Team": { fromEnv: "DOCS_X_TEAM" } } },
    local: { command: "node", args: ["${PROJECT}/tools/mcp.js"], env: { HOME_URL: { fromEnv: "HOME_URL" } } },
  });
  assert.deepEqual(r.left.map((l) => l.what), [".mcp.json login", ".mcp.json keyed", ".mcp.json abs", ".mcp.json loose"]);
  assert.ok(!JSON.stringify(r.value).includes("acme-team-value") && !JSON.stringify(r.left).includes("pass@"));
});

test("the skill rooms mcp install copied, from any version, stays out; one the person edited is theirs", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const bundled = await read(new URL("../skills/rooms/SKILL.md", import.meta.url), "utf8");
  await planted(async ({ home, project, env }) => {
    const older = bundled.replace(/iops-rooms@\d+\.\d+\.\d+/g, "iops-rooms@0.5.9");
    await put(join(project, ".claude/skills/rooms/SKILL.md"), older);
    const copied = await readClaudeCode({ project, home, env, bundledSkill: bundled });
    assert.ok(!copied.items.some((i) => i.label.startsWith(".claude/skills/rooms/")));
    assert.ok(copied.left.some((l) => l.what === ".claude/skills/rooms/" && /Rooms' own skill/.test(l.why)));
    await put(join(project, ".claude/skills/rooms/SKILL.md"), `${older}\nAlso post when a test fails.\n`);
    const edited = await readClaudeCode({ project, home, env, bundledSkill: bundled });
    assert.ok(edited.items.some((i) => i.label === ".claude/skills/rooms/SKILL.md" && !i.refused));
  });
});
