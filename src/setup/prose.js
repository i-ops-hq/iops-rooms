/**
 * The prose a setup carries, read for what it does rather than what it says (docs/design/TEAM_SETUPS.md
 * §7.3; checked against Claude Code 2.1.277 and its documentation on 2026-09-30).
 *
 * An agent, command or skill starts with frontmatter, and some of its keys act: `hooks` registers
 * commands, `mcpServers` starts servers, `allowed-tools` lets tools run without asking, and
 * `permissionMode` changes how a subagent asks. A skill or command can also run a shell command
 * as it loads: `` !`cmd` `` inline, or a fenced block opened with ```` ```! ````. Rooms reads only
 * those, with no YAML parser: a handful of keys, line by line. A key that acts, written in a form
 * this reader does not see, is reported as unread, so the caller refuses it instead of missing it.
 */

import { checkShellLine } from "./pins.js";
import { portableText } from "./paths.js";
import { modeRefusal, wideRule } from "./permissions.js";

/** Frontmatter keys that make a file do something beyond being read. */
const ACTING = ["hooks", "mcpServers", "allowed-tools", "permissionMode"];

const unquote = (v) => {
  const t = String(v).trim();
  return /^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t;
};

/**
 * The frontmatter between the first two `---` lines: each top-level key's inline text and, for a
 * block list, its items. `unread` names acting keys that appear but were not read as keys.
 */
export function frontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { found: false, keys: {}, unread: [] };
  const keys = {};
  let current = null;
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^["']?([A-Za-z][\w-]*)["']?[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (top) {
      current = top[1];
      keys[current] = { text: unquote(top[2] ?? ""), items: [], nested: false };
      continue;
    }
    const item = /^[ \t]+-[ \t]+(.*?)[ \t]*$/.exec(line);
    if (item && current) keys[current].items.push(unquote(item[1]));
    else if (current && /^[ \t]+\S/.test(line)) keys[current].nested = true;
  }
  const unread = ACTING.filter((k) => new RegExp(`(^|[\\s{,])["']?${k}["']?\\s*:`, "m").test(m[1]) && !(k in keys));
  return { found: true, keys, unread };
}

/**
 * A frontmatter list of tools, in any of the forms Claude Code accepts: `Read, Grep`, a YAML list,
 * `[Read, Grep]`, or space-separated rules whose parentheses hold spaces: `Bash(git add *) Read`.
 */
export function toolList(entry) {
  if (!entry) return [];
  if (entry.items.length) return entry.items.filter(Boolean);
  let t = entry.text.trim();
  if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  const out = [];
  let cur = "";
  let depth = 0;
  for (const c of t) {
    if (c === "(") depth += 1;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === "," || /\s/.test(c))) {
      if (cur.trim()) out.push(unquote(cur));
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(unquote(cur));
  return out;
}

/** The shell commands a skill or command runs as it loads, each with its line. */
export function injections(text) {
  const found = [];
  const lines = String(text).split(/\r?\n/);
  let block = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (block) {
      if (/^\s*(```|~~~)/.test(line)) block = false;
      else if (line.trim()) found.push({ line: i + 1, command: line.trim() });
      continue;
    }
    if (/^\s*```!/.test(line)) {
      block = true;
      continue;
    }
    for (const m of line.matchAll(/!`([^`\n]+)`/g)) found.push({ line: i + 1, command: m[1].trim() });
  }
  return found;
}

/**
 * The first line naming `folder` (this machine's home, say) as a path: `/Users/alice` or
 * `/Users/alice/x`, never `/Users/alicex`. 0 when none does.
 */
export function lineNaming(text, folder) {
  if (!folder) return 0;
  const forms = [...new Set([String(folder), String(folder).split("\\").join("/")])];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const f of forms) {
      for (let at = lines[i].indexOf(f); at >= 0; at = lines[i].indexOf(f, at + 1)) {
        const after = lines[i][at + f.length];
        if (after === undefined || !/[\w.-]/.test(after)) return i + 1;
      }
    }
  }
  return 0;
}

/**
 * Why an agent, command or skill acts in a way a setup may not, or null: hooks or MCP servers in its
 * frontmatter, a permission mode or an `allowed-tools` rule that stops Claude asking, or a command it
 * runs as it loads that is unpinned or names a path. `detail` may name what it found; `why` never
 * does. `where` is the exporting machine's home and project; a reader of a setup passes none, so
 * every absolute path is refused.
 */
export function actingRefusal(content, where = {}) {
  const fm = frontmatter(content);
  if (fm.unread.length) {
    return { detail: `its frontmatter has ${fm.unread.join(", ")} in a form this version cannot read`, why: "frontmatter this version cannot read" };
  }
  if (fm.keys.hooks) return { detail: "it defines hooks in its frontmatter, which this version does not export yet", why: "defines hooks in its frontmatter" };
  if (fm.keys.mcpServers) {
    return { detail: "it defines MCP servers in its frontmatter, which this version does not export yet", why: "defines MCP servers in its frontmatter" };
  }
  const mode = modeRefusal(fm.keys.permissionMode?.text);
  if (mode) return { detail: mode, why: mode };
  for (const rule of toolList(fm.keys["allowed-tools"])) {
    const wide = wideRule(rule);
    if (wide) return { detail: `allowed-tools: ${wide}`, why: "allowed-tools would let any command run without asking" };
  }
  for (const inj of injections(content)) {
    const paths = portableText(inj.command, where);
    const check = paths.ok ? checkShellLine(inj.command) : { ok: false, why: paths.why };
    if (!check.ok) return { detail: `line ${inj.line} runs a command as it loads: ${check.why}`, why: "runs a command as it loads that a setup cannot carry" };
  }
  return null;
}
