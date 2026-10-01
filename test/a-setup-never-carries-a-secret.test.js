// What a setup may never carry (docs/design/TEAM_SETUPS.md §7.5 and §7.4): secrets, launchers that
// could fetch different code tomorrow, and paths that name the exporter's machine.
//
// Every planted secret below is assembled while the test runs, so this file holds no string a
// scanner (GitHub's included) would take for a real one.

import test from "node:test";
import assert from "node:assert/strict";
import { neverRead, refusalFor, scanText } from "../src/setup/secrets.js";
import { checkCommandLine, checkShellLine, shellWords } from "../src/setup/pins.js";
import { localPath, portablePath, portableText } from "../src/setup/paths.js";

const planted = {
  "a private key": ["-----BEGIN " + "OPENSSH PRIVATE KEY-----", "-----BEGIN " + "RSA PRIVATE KEY-----"],
  "a GitHub token": ["gh" + "p_" + "a1B2".repeat(9), "gh" + "s_" + "Z9y8".repeat(9), "github" + "_pat_" + "A1b2C3d4E5f6G7h8I9j0K1"],
  "an Anthropic API key": ["sk-" + "ant-" + "api03-" + "x7Y".repeat(8)],
  "an OpenAI API key": ["sk-" + "proj-" + "Ab1".repeat(8), "sk-" + "Qw9".repeat(8)],
  "an AWS access key": ["AK" + "IA" + "ABCDEFGHIJ234567", "AS" + "IA" + "QRSTUVWXYZ765432"],
  "a Slack token": ["xo" + "xb-" + "1234567890-abcdefghij", "xo" + "xp-" + "0987654321-zyxwv"],
  "a Stripe live key": ["sk" + "_live_" + "a1b2c3d4e5f6g7h8i9", "rk" + "_live_" + "Z1Y2X3W4V5U6T7S8"],
  "a Google API key": ["AI" + "za" + "Sy" + "Bx9".repeat(11)],
  "an npm token": ["np" + "m_" + "a1".repeat(18)],
  "a JSON Web Token": ["ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  "a bearer token": ["Authorization: Bearer " + "abcDEF123456".repeat(3)],
};

test("every kind of secret is found, on its line, and named without its value", () => {
  let checked = 0;
  for (const [kind, values] of Object.entries(planted)) {
    for (const value of values) {
      const text = `# Review rules\n\nUse this when calling the API:\n  key = ${value}\nThanks.\n`;
      assert.deepEqual(scanText(text), [{ line: 4, kind }], `${kind}: ${value.slice(0, 12)}…`);
      const why = refusalFor("skills/deploy/SKILL.md", text);
      assert.equal(why, `skills/deploy/SKILL.md line 4 looks like ${kind}`);
      assert.ok(!why.includes(value) && !why.includes(value.slice(4, 16)), "the value is never repeated");
      checked += 1;
    }
  }
  assert.equal(checked, 18);
});

test("ordinary prose about keys is not a key", () => {
  const prose = [
    "Name things like sk-learn does.",
    "AKIA is how AWS access key ids begin.",
    "The npm_config_ variables come from npm.",
    "Send Authorization: Bearer <your token here>.",
    "GitHub tokens start with ghp_ or github_pat_.",
    "A JWT looks like eyJ....eyJ....sig.",
    "-----BEGIN PUBLIC KEY-----",
  ].join("\n");
  assert.deepEqual(scanText(prose), []);
  assert.equal(refusalFor("CLAUDE.md", prose), "");
});

test("a file whose name says it holds secrets is never read at all", () => {
  for (const name of [".env", ".env.local", "config/.env.production", "key.pem", "server.key", "id_rsa", ".ssh/id_ed25519.pub", "my-secrets.md", "aws-credentials.json", "auth.json", ".claude.json", ".npmrc", ".netrc", ".pypirc", ".git-credentials"]) {
    assert.equal(neverRead(name), true, name);
    assert.match(refusalFor(name, "nothing secret inside"), /is never read/);
  }
  for (const name of ["CLAUDE.md", ".claude/settings.json", ".claude/skills/review/SKILL.md", ".claude/agents/reviewer.md", "AGENTS.md", ".mcp.json"]) {
    assert.equal(neverRead(name), false, name);
  }
});

test("a launcher runs one exact version, and anything else says how to pin it", () => {
  const accepted = {
    "npx -y @example/issues-mcp@1.4.2": "@example/issues-mcp@1.4.2",
    "npx -y -p @example/tools@2.0.0 tool --x": "@example/tools@2.0.0",
    "bunx pkg@1.2.3": "pkg@1.2.3",
    "pnpm dlx pkg@1.2.3-beta.1": "pkg@1.2.3-beta.1",
    "uvx --offline assurance@0.1.11 audit --hook --nudge": "assurance@0.1.11",
    "uvx --from assurance==0.1.11 assurance audit": "assurance==0.1.11",
    "go run golang.org/x/tools/cmd/stringer@v0.25.0": "golang.org/x/tools/cmd/stringer@v0.25.0",
    [`docker run --rm ghcr.io/o/i@sha256:${"a".repeat(64)}`]: `ghcr.io/o/i@sha256:${"a".repeat(64)}`,
  };
  for (const [line, pinned] of Object.entries(accepted)) assert.deepEqual(checkCommandLine(line), { ok: true, pinned }, line);
  const refused = ["npx pkg", "npx -y pkg@latest", "npx pkg@^1.2.0", "npx pkg@~1.2.0", "npx pkg@1.x", "bunx pkg", "pnpm dlx pkg@next", "uvx assurance", "uvx assurance>=0.1", "go run golang.org/x/tools/cmd/stringer@latest", "docker run ghcr.io/o/i:1.0", "/usr/local/bin/tool --serve"];
  for (const line of refused) {
    const r = checkCommandLine(line);
    assert.equal(r.ok, false, line);
    assert.match(r.why, /exact version|digest|path on the exporting machine/, line);
  }
  assert.deepEqual(checkCommandLine("git status --porcelain"), { ok: true, pinned: null, needs: "git" }, "a program, not a package: needed, not pinned");
});

test("a path from this machine becomes ${HOME} or ${PROJECT}, or is refused", () => {
  const where = { home: "/Users/alice", project: "/Users/alice/code/web" };
  assert.deepEqual(portablePath("/Users/alice/code/web/.claude/hooks/check.sh", where), { ok: true, value: "${PROJECT}/.claude/hooks/check.sh" }, "the project wins over the home that holds it");
  assert.deepEqual(portablePath("/Users/alice/.claude/agents/r.md", where), { ok: true, value: "${HOME}/.claude/agents/r.md" });
  assert.equal(portablePath("/opt/acme-client-x/bin/tool", where).ok, false, "a path outside both names this machine");
  assert.equal(localPath("${HOME}/.claude/agents/r.md", { home: "/home/bob", project: "/src/web" }), "/home/bob/.claude/agents/r.md");
  const hook = portableText("/Users/alice/.nvm/versions/node/v22/bin/node /Users/alice/code/web/scripts/check.mjs --strict", where);
  assert.deepEqual(hook, { ok: true, value: "${HOME}/.nvm/versions/node/v22/bin/node ${PROJECT}/scripts/check.mjs --strict" });
  assert.equal(portableText("/usr/local/bin/tool --x", where).ok, false);
});

test("a runner is found wherever it stands in a hook's command, quoted, chained or substituted", () => {
  const refused = {
    "sudo npx pkg": "npx pkg",
    "timeout 5 bunx pkg": "bunx pkg",
    "FOO=1 npx pkg": "npx pkg",
    "if npx pkg; then echo ok; fi": "npx pkg",
    'echo "$(uvx tool)" 2>/dev/null': "uvx tool",
    'echo "$(true)";npx evil': "npx evil",
    "x=`npx q`": "npx q",
    "x=$( (cd a && npx b) )": "npx b",
    "git status && npx pkg@latest": "npx pkg@latest",
  };
  for (const [line, named] of Object.entries(refused)) {
    const r = checkShellLine(line);
    assert.equal(r.ok, false, line);
    assert.ok(r.why.startsWith(named), `${line}: ${r.why}`);
  }
  assert.deepEqual(checkShellLine('cd "$CLAUDE_PROJECT_DIR" && npx -y a@1.0.0 | jq . && uvx --from b==2.0.0 b'), { ok: true, pinned: ["a@1.0.0", "b==2.0.0"], needs: ["npx", "jq", "uvx"] });
  assert.deepEqual(checkShellLine('echo "a; npx b" && git status'), { ok: true, pinned: [], needs: ["git"] }, "inside quotes it is text");
  assert.deepEqual(checkShellLine("echo $((1+2))").needs, [], "arithmetic is not a program");
  assert.deepEqual(shellWords('"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh --x "a b"'), ["$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh", "--x", "a b"]);
  assert.deepEqual(checkCommandLine(`docker run --rm -v /a:/b -e X=1 ghcr.io/o/i@sha256:${"a".repeat(64)}`), { ok: true, pinned: `ghcr.io/o/i@sha256:${"a".repeat(64)}` }, "a volume is not the image");
});

test("what names no machine is left as it is: variables, relative and ~ paths, URLs, /dev/null", () => {
  const where = { home: "/Users/alice", project: "/Users/alice/code/web" };
  const win = { home: "C:\\Users\\RUNNER~1", project: "C:\\Users\\RUNNER~1\\code\\web" };
  assert.deepEqual(portableText("node C:\\Users\\RUNNER~1\\code\\web/scripts/x.js", win), { ok: true, value: "node ${PROJECT}/scripts/x.js" }, "a short name, both separators");
  for (const text of ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh', "curl -s https://hooks.example.com/notify", "node ./scripts/x.js ~/notes 2>/dev/null >/tmp/rooms.log", "${HOME}/bin/tool"]) {
    assert.deepEqual(portableText(text, where), { ok: true, value: text }, text);
  }
});
