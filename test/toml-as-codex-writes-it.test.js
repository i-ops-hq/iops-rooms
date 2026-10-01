// Codex keeps its settings in TOML, and Rooms reads and adds to them itself, with no dependency
// (docs/design/TEAM_SETUPS.md §7.6). What must hold: everything TOML 1.0 allows that Codex's config
// holds is read, as the specification reads it; anything else stops with the line and the reason,
// never a guess; and adding to a config leaves every other line, comment and blank line as it was.

import test from "node:test";
import assert from "node:assert/strict";
import { mergeCodexToml, parseToml, tomlValue } from "../src/setup/toml.js";

const read = (text) => {
  const r = parseToml(text);
  assert.ok(r.ok, `${JSON.stringify(text)}: line ${r.line}: ${r.why}`);
  return r.value;
};

test("everything a Codex config holds is read as TOML reads it", () => {
  const value = read([
    "# Codex",
    'model = "gpt-6.1-sol"',
    "notify = [",
    '  "python3", # the program',
    '  "notify.py",',
    "]",
    "",
    '[projects."/Users/alice/code/web"]',
    'trust_level = "trusted"',
    "",
    '[plugins."canva@openai-curated"]',
    "enabled = true",
    "",
    "[mcp_servers.node_repl]",
    'command = "node"',
    "args = []",
    "startup_timeout_sec = 20.5",
    "",
    "[mcp_servers.node_repl.env]",
    'NODE_ENV = "test"',
    "",
    "[desktop.appearanceDarkChromeTheme]",
    "contrast = 1_000",
    "fonts = {}",
    'semantic = { diffAdded = "#0f0", "diff removed" = \'#f00\' }',
    "",
    "[[apps.list]]",
    'name = "a"',
    "[[apps.list]]",
    'name = "b"',
    "[apps.list.extra]",
    "x = 0x10",
    "",
    "[times]",
    "at = 1979-05-27T07:32:00Z",
    "day = 1979-05-27",
    "clock = 07:32:00",
    "big = 1e3",
    "none = -inf",
    'paths = """',
    "C:\\\\one",
    'two \\',
    '   three"""',
    "raw = '''",
    "C:\\path\\x'''",
  ].join("\n"));
  assert.equal(value.model, "gpt-6.1-sol");
  assert.deepEqual(value.notify, ["python3", "notify.py"]);
  assert.deepEqual(Object.keys(value.projects), ["/Users/alice/code/web"]);
  assert.equal(value.plugins["canva@openai-curated"].enabled, true);
  assert.deepEqual(value.mcp_servers.node_repl, { command: "node", args: [], startup_timeout_sec: 20.5, env: { NODE_ENV: "test" } });
  assert.deepEqual(value.desktop.appearanceDarkChromeTheme, { contrast: 1000, fonts: {}, semantic: { diffAdded: "#0f0", "diff removed": "#f00" } });
  assert.deepEqual(value.apps.list, [{ name: "a" }, { name: "b", extra: { x: 16 } }]);
  assert.deepEqual(value.times.at, { datetime: "1979-05-27T07:32:00Z" });
  assert.deepEqual(value.times.day, { datetime: "1979-05-27" });
  assert.equal(value.times.big, 1000);
  assert.equal(value.times.none, -Infinity);
  assert.equal(value.times.paths, "C:\\one\ntwo three");
  assert.equal(value.times.raw, "C:\\path\\x");
});

test("what TOML does not allow stops the reading, with its line and the reason", () => {
  const refused = {
    "a = 1\na = 2\n": [2, /a is defined twice/],
    "[t]\nx = 1\n[t]\n": [3, /\[t\] is defined twice/],
    "a.b = 1\n[a]\n": [2, /\[a\] is defined twice/],
    "[a]\nb.c = 1\n[a.b]\n": [3, /\[a\.b\] is defined twice/],
    "x = { a = 1,\n b = 2 }\n": [1, /an inline table across lines/],
    "x = { a = 1, }\n": [1, /a comma before the end of an inline table/],
    "n = 012\n": [1, /a value TOML does not have/],
    's = "never ends\n': [1, /a string that does not end on its line/],
    "k = 1 x\n": [1, /something after a value on the same line/],
    "k =\n": [1, /k has no value/],
    "[a\n": [1, /a table header that does not close/],
    'e = "\\q"\n': [1, /an escape TOML does not have/],
    "x = [1 2]\n": [1, /not separated by commas/],
    "x = { a = 1 }\nx.b = 2\n": [2, /x\.b adds to a table already defined elsewhere/],
    "[[a]]\n[a]\n": [2, /\[a\] is defined twice/],
    "a = 1\n[[a]]\n": [2, /\[\[a\]\] was already defined as something else/],
  };
  for (const [text, [line, why]] of Object.entries(refused)) {
    const r = parseToml(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.equal(r.line, line, `${JSON.stringify(text)}: ${r.why}`);
    assert.match(r.why, why, JSON.stringify(text));
  }
});

test("adding to a config leaves every other line as it was, and the result reads back", () => {
  const before = [
    "# my Codex",
    'model = "gpt-5"',
    "notify = [",
    '  "python3",',
    '  "x.py",',
    "]",
    "",
    "# servers below",
    "[mcp_servers.old]",
    'command = "old"',
    "",
  ].join("\n");
  const { text, changes, kept } = mergeCodexToml(before, {
    top: { notify: ["say", "done"], model_reasoning_effort: "high", model: "gpt-5" },
    servers: { issues: { command: "npx", args: ["-y", "@example/issues@1.0.0"], env_vars: ["ISSUES_TOKEN"] }, old: { command: "different" } },
  });
  assert.equal(text, [
    "# my Codex",
    'model = "gpt-5"',
    'notify = ["say", "done"]',
    'model_reasoning_effort = "high"',
    "",
    "# servers below",
    "[mcp_servers.old]",
    'command = "old"',
    "",
    "[mcp_servers.issues]",
    'command = "npx"',
    'args = ["-y", "@example/issues@1.0.0"]',
    'env_vars = ["ISSUES_TOKEN"]',
    "",
  ].join("\n"));
  assert.deepEqual(changes.map((c) => `${c.kind} ${c.key || c.name}`), ["setting notify", "setting model_reasoning_effort", "server issues"], "an unchanged model is not a change");
  assert.deepEqual(kept, ["old"], "a server by the same name is kept as the person has it");
  assert.deepEqual(read(text).mcp_servers.old, { command: "old" });

  const crlf = mergeCodexToml('model = "a"\r\n[x]\r\ny = 1\r\n', { top: { model: "b" } }).text;
  assert.equal(crlf, 'model = "b"\r\n[x]\r\ny = 1\r\n', "line ends as the file had them");
  assert.equal(mergeCodexToml("[x]\ny = 1\n", { top: { model: "m" } }).text, 'model = "m"\n\n[x]\ny = 1\n', "a top-level key goes before the first table");
  assert.equal(mergeCodexToml("", { servers: { "my.server": { url: "https://x.example/mcp", env_http_headers: { Authorization: "X_AUTH" } } } }).text, '[mcp_servers."my.server"]\nurl = "https://x.example/mcp"\nenv_http_headers = { Authorization = "X_AUTH" }\n');
  assert.throws(() => mergeCodexToml("a = 1\na = 2\n", { top: { model: "m" } }), /line 2: a is defined twice/, "a config that does not read is not written to");
  assert.throws(() => mergeCodexToml("mcp_servers = { a = { command = \"x\" } }\n", { servers: { b: { command: "y" } } }), /not a table Rooms can add to/);
});

test("values are written so TOML reads them back as they were", () => {
  const odd = { "a key": 'quote " back \\ line\nend\ttab \u0001', list: [1, 2.5, true, "x"], nested: { "k.k": ["y"] } };
  assert.deepEqual(read(`v = ${tomlValue(odd)}\n`).v, odd);
  assert.throws(() => tomlValue(NaN));
});
