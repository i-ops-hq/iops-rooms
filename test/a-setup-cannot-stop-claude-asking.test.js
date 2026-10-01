// What a setup may let Claude Code do without asking (docs/design/TEAM_SETUPS.md §8.2): never a
// mode that stops it asking, never a rule that lets any command run, and nothing that acts from a
// file's frontmatter in a form Rooms cannot read. Every rule it does carry is shown as what it allows.

import test from "node:test";
import assert from "node:assert/strict";
import { describeRule, modeRefusal, wideRule } from "../src/setup/permissions.js";
import { actingRefusal, frontmatter, injections, toolList } from "../src/setup/prose.js";

test("a rule that lets any command run is refused, and a narrow one is not", () => {
  for (const rule of ["Bash", "Bash()", "Bash(*)", "Bash(:*)", "Bash( * )", "Bash(* --help)", "Bash(sh -c *)", "Bash(bash:*)", "Bash(sudo apt install *)", "Bash(xargs *)", "Bash(python3 *)", "Bash(node:*)", "Bash(npx *)", "Bash(env *)", "Bash(/bin/zsh -c *)", "PowerShell(*)"]) {
    assert.notEqual(wideRule(rule), "", rule);
  }
  for (const rule of ["Bash(go test *)", "Bash(npm run test:*)", "Bash(python3 manage.py test *)", "Bash(node scripts/check.js)", "Bash(git status)", "Read(./src/**)", "WebFetch(domain:example.com)", "mcp__issues__list", "Bash(npx -y lint@1.0.0 *)"]) {
    assert.equal(wideRule(rule), "", rule);
  }
});

test("only the modes that keep Claude asking may come from a setup", () => {
  for (const mode of ["bypassPermissions", "auto"]) assert.match(modeRefusal(mode), /stops Claude Code asking/);
  assert.match(modeRefusal("yolo"), /does not know/);
  for (const mode of [undefined, "default", "manual", "acceptEdits", "plan", "dontAsk"]) assert.equal(modeRefusal(mode), "", String(mode));
});

test("frontmatter is read in every form Claude Code accepts, and a form Rooms cannot read is refused", () => {
  const fm = frontmatter("﻿---\nname: \"reviewer\"\ntools:\n  - Read\n  - Grep\nallowed-tools: Bash(git add *) Bash(git commit *), Read\n---\nbody\n");
  assert.equal(fm.keys.name.text, "reviewer");
  assert.deepEqual(toolList(fm.keys.tools), ["Read", "Grep"]);
  assert.deepEqual(toolList(fm.keys["allowed-tools"]), ["Bash(git add *)", "Bash(git commit *)", "Read"]);
  assert.deepEqual(toolList({ text: "[Read, 'Grep']", items: [] }), ["Read", "Grep"]);
  assert.deepEqual(frontmatter("no frontmatter here\nhooks: x\n").keys, {});

  const refusals = {
    "---\nhooks:\n  Stop: []\n---\n": /defines hooks/,
    "---\n'hooks': {}\n---\n": /defines hooks/,
    "---\nhooks : {}\n---\n": /defines hooks/,
    "---\n{hooks: {}}\n---\n": /frontmatter has hooks in a form this version cannot read/,
    "---\nname: x\n  {mcpServers: [a]}\n---\n": /frontmatter has mcpServers in a form/,
    "---\nmcpServers:\n  - issues\n---\n": /defines MCP servers/,
    "---\npermissionMode: auto\n---\n": /stops Claude Code asking/,
    "---\nallowed-tools:\n  - Bash(*)\n---\n": /allowed-tools: Bash\(\*\) lets Claude run any command/,
    "Run !`npx tool` first.\n": /line 1 runs a command as it loads: npx tool names no exact version/,
    "```!\ngit status\nuvx thing\n```\n": /line 3 runs a command as it loads: uvx thing names no exact version/,
    "Then !`/opt/acme/check`.\n": /line 1 runs a command as it loads: \/opt\/acme\/check is a path on this machine/,
  };
  for (const [text, expected] of Object.entries(refusals)) {
    const no = actingRefusal(text);
    assert.ok(no && expected.test(no.detail), `${JSON.stringify(text)}: ${JSON.stringify(no)}`);
    assert.ok(!no.why.includes("npx tool") && !no.why.includes("/opt/acme"), "the committed reason names nothing from the file");
  }
  for (const text of ["---\nname: x\nallowed-tools: Bash(git status)\nmodel: sonnet\n---\n!`git status --short`\n", "---\npermissionMode: plan\n---\n", "plain text, no frontmatter\n"]) {
    assert.equal(actingRefusal(text), null, text);
  }
});

test("the commands a file runs as it loads are found inline and in ```! blocks", () => {
  assert.deepEqual(injections("a !`git status` b !`git log -1`\n```!\nnode -v\n\nnpm ls\n```\n```\n!not a block\n```\n"), [
    { line: 1, command: "git status" },
    { line: 1, command: "git log -1" },
    { line: 3, command: "node -v" },
    { line: 5, command: "npm ls" },
  ]);
});

test("every rule is shown as what it allows", () => {
  assert.equal(describeRule("allow", "Bash(go test *)"), 'runs "go test" with any arguments, without asking');
  assert.equal(describeRule("allow", "Bash(git status)"), 'runs "git status" exactly, without asking');
  assert.equal(describeRule("ask", "Bash(git push:*)"), 'runs "git push" with any arguments, asking each time');
  assert.equal(describeRule("deny", "Bash(rm *)"), 'never runs "rm" with any arguments');
  assert.equal(describeRule("allow", "WebFetch(domain:example.com)"), "without asking");
  assert.equal(describeRule("deny", "Read(./.env)"), "refused");
});
