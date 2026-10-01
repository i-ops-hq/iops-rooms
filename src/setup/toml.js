/**
 * TOML, as much as Codex's `config.toml` needs, and no more (docs/design/TEAM_SETUPS.md §7.6).
 *
 * Rooms has no dependencies, so it reads TOML itself, strictly: tables, arrays of tables, dotted and
 * quoted keys, strings of all four kinds, integers, floats, booleans, arrays, inline tables, and
 * dates and times, which are kept as text and never exported. Anything else, or anything TOML 1.0
 * does not allow (a key defined twice, an inline table across lines), stops the reading with the line
 * and the reason, rather than a guess.
 *
 * Writing goes the other way round: Rooms never re-serialises someone's config. It adds the lines a
 * setup needs to the text that is there, so every comment, key order and blank line stays as it was,
 * and checks that the result still reads.
 */

class TomlError extends Error {
  constructor(line, why) {
    super(why);
    this.line = line;
  }
}

const BARE = /^[A-Za-z0-9_-]+$/;
const kinds = new WeakMap();

/** Read a TOML document: `{ ok, value, topKeys, firstTable }`, or `{ ok: false, line, why }`. */
export function parseToml(text) {
  const src = String(text).replace(/^﻿/, "");
  let i = 0;
  let line = 1;
  const root = {};
  kinds.set(root, "header");
  let current = root;
  const topKeys = new Map();
  let firstTable = 0;

  const fail = (why) => {
    throw new TomlError(line, why);
  };
  const peek = (n = 0) => src[i + n];
  const startsWith = (t) => src.startsWith(t, i);

  function skipSpaces() {
    while (i < src.length && (src[i] === " " || src[i] === "\t")) i += 1;
  }
  function skipComment() {
    if (src[i] === "#") {
      while (i < src.length && src[i] !== "\n") {
        const c = src.charCodeAt(i);
        if ((c < 0x20 && c !== 0x09) || c === 0x7f) fail("a control character in a comment");
        i += 1;
      }
    }
  }
  function newline() {
    if (src[i] === "\r" && src[i + 1] === "\n") i += 2;
    else if (src[i] === "\n") i += 1;
    else return false;
    line += 1;
    return true;
  }
  function endOfLine() {
    skipSpaces();
    skipComment();
    if (i < src.length && !newline()) fail(`something after a value on the same line: ${JSON.stringify(src.slice(i, i + 12))}`);
  }
  /** Spaces, comments and line breaks, as inside an array. */
  function skipBlank() {
    for (;;) {
      skipSpaces();
      skipComment();
      if (!newline()) return;
    }
  }

  function basicString() {
    i += 1;
    let out = "";
    for (;;) {
      if (i >= src.length || src[i] === "\n" || src[i] === "\r") fail("a string that does not end on its line");
      const c = src[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === "\\") {
        out += escape();
        continue;
      }
      const code = src.charCodeAt(i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail("a control character in a string");
      out += c;
      i += 1;
    }
  }
  function escape() {
    const e = src[i + 1];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (e in simple) {
      i += 2;
      return simple[e];
    }
    if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const hex = src.slice(i + 2, i + 2 + n);
      if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) fail("an escape that is not a code point");
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail("an escape that is not a code point");
      i += 2 + n;
      return String.fromCodePoint(cp);
    }
    return fail(`an escape TOML does not have: \\${e ?? ""}`);
  }
  function multiBasic() {
    i += 3;
    if (newline()) {
      // a line break straight after the opening quotes is not part of the string
    }
    let out = "";
    for (;;) {
      if (i >= src.length) fail('a """ string that never ends');
      if (startsWith('"""')) {
        // Up to two quotes may sit right before the closing three.
        let extra = 0;
        while (src[i + 3 + extra] === '"' && extra < 2) extra += 1;
        out += '"'.repeat(extra);
        i += 3 + extra;
        return out;
      }
      const c = src[i];
      if (c === "\\") {
        const after = /^\\[ \t]*\r?\n/.exec(src.slice(i));
        if (after) {
          // A line-ending backslash: the break and the whitespace after it go.
          i += 1;
          skipSpaces();
          while (newline()) skipSpaces();
          continue;
        }
        out += escape();
        continue;
      }
      if (newline()) {
        out += "\n";
        continue;
      }
      const code = src.charCodeAt(i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail("a control character in a string");
      out += c;
      i += 1;
    }
  }
  function literalString() {
    i += 1;
    const start = i;
    while (i < src.length && src[i] !== "'") {
      if (src[i] === "\n" || src[i] === "\r") fail("a string that does not end on its line");
      i += 1;
    }
    if (i >= src.length) fail("a string that does not end on its line");
    const out = src.slice(start, i);
    i += 1;
    return out;
  }
  function multiLiteral() {
    i += 3;
    newline();
    let out = "";
    for (;;) {
      if (i >= src.length) fail("a ''' string that never ends");
      if (startsWith("'''")) {
        let extra = 0;
        while (src[i + 3 + extra] === "'" && extra < 2) extra += 1;
        out += "'".repeat(extra);
        i += 3 + extra;
        return out;
      }
      if (newline()) {
        out += "\n";
        continue;
      }
      out += src[i];
      i += 1;
    }
  }

  function key() {
    const parts = [];
    for (;;) {
      skipSpaces();
      if (src[i] === '"') {
        if (startsWith('"""')) fail("a key written as a multi-line string");
        parts.push(basicString());
      } else if (src[i] === "'") {
        if (startsWith("'''")) fail("a key written as a multi-line string");
        parts.push(literalString());
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200));
        if (!m) fail(`a key TOML does not allow: ${JSON.stringify(src.slice(i, i + 12))}`);
        parts.push(m[0]);
        i += m[0].length;
      }
      skipSpaces();
      if (src[i] !== ".") return parts;
      i += 1;
    }
  }

  const DATE = /^(\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
  const NUMBER = /^(?:[+-]?(?:inf|nan)|[+-]?0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|[+-]?0o[0-7](?:_?[0-7])*|[+-]?0b[01](?:_?[01])*|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)/;

  function value() {
    const c = src[i];
    if (c === '"') return startsWith('"""') ? multiBasic() : basicString();
    if (c === "'") return startsWith("'''") ? multiLiteral() : literalString();
    if (c === "[") return array();
    if (c === "{") return inlineTable();
    if (startsWith("true") && !/[A-Za-z0-9_-]/.test(src[i + 4] ?? "")) {
      i += 4;
      return true;
    }
    if (startsWith("false") && !/[A-Za-z0-9_-]/.test(src[i + 5] ?? "")) {
      i += 5;
      return false;
    }
    const rest = src.slice(i, i + 80);
    const date = DATE.exec(rest);
    if (date && /^\d{2}:|^\d{4}-/.test(rest)) {
      i += date[0].length;
      return { datetime: date[0] };
    }
    const num = NUMBER.exec(rest);
    if (num && num[0] && !/[A-Za-z0-9_.]/.test(rest[num[0].length] ?? "")) {
      i += num[0].length;
      const t = num[0].replace(/_/g, "");
      if (/inf$/.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
      if (/nan$/.test(t)) return NaN;
      if (/^[+-]?0[xob]/.test(t)) {
        const sign = t.startsWith("-") ? -1 : 1;
        const body = t.replace(/^[+-]/, "");
        return sign * Number(body);
      }
      return Number(t);
    }
    return fail(`a value TOML does not have: ${JSON.stringify(rest.slice(0, 12))}`);
  }
  function array() {
    i += 1;
    const out = [];
    for (;;) {
      skipBlank();
      if (src[i] === "]") {
        i += 1;
        kinds.set(out, "inline");
        return out;
      }
      if (i >= src.length) fail("an array that never ends");
      out.push(value());
      skipBlank();
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      if (src[i] !== "]") fail("an array whose values are not separated by commas");
    }
  }
  function inlineTable() {
    i += 1;
    const out = {};
    kinds.set(out, "inline");
    skipSpaces();
    if (src[i] === "}") {
      i += 1;
      return out;
    }
    for (;;) {
      const k = key();
      if (src[i] !== "=") fail("a key without = in an inline table");
      i += 1;
      skipSpaces();
      if (src[i] === "\n" || src[i] === "\r") fail("an inline table across lines");
      assign(out, k, value(), true);
      skipSpaces();
      if (src[i] === ",") {
        i += 1;
        skipSpaces();
        if (src[i] === "}") fail("a comma before the end of an inline table");
        if (src[i] === "\n" || src[i] === "\r") fail("an inline table across lines");
        continue;
      }
      if (src[i] === "}") {
        i += 1;
        return out;
      }
      fail(src[i] === "\n" || src[i] === "\r" ? "an inline table across lines" : "an inline table whose keys are not separated by commas");
    }
  }

  /** Put a value at a dotted key inside `table`, making the tables between as dotted ones. */
  function assign(table, parts, v, inline = false) {
    let t = table;
    for (const p of parts.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(t, p)) {
        t[p] = {};
        kinds.set(t[p], inline ? "inline-dotted" : "dotted");
      } else if (!isTable(t[p]) || kinds.get(t[p]) === "inline" || kinds.get(t[p]) === "header" || kinds.get(t[p]) === "implicit") {
        fail(`${parts.join(".")} adds to a table already defined elsewhere`);
      }
      t = t[p];
    }
    const last = parts[parts.length - 1];
    if (Object.prototype.hasOwnProperty.call(t, last)) fail(`${parts.join(".")} is defined twice`);
    t[last] = v;
  }

  function header() {
    const many = startsWith("[[");
    i += many ? 2 : 1;
    const parts = key();
    if (many ? !startsWith("]]") : src[i] !== "]") fail(`a table header that does not close with ${many ? "]]" : "]"}`);
    i += many ? 2 : 1;
    let t = root;
    for (const p of parts.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(t, p)) {
        t[p] = {};
        kinds.set(t[p], "implicit");
      }
      let next = t[p];
      if (Array.isArray(next) && kinds.get(next) === "tables") next = next[next.length - 1];
      if (!isTable(next) || kinds.get(next) === "inline" || kinds.get(next) === "inline-dotted") fail(`[${parts.join(".")}] goes inside something that is not a table`);
      t = next;
    }
    const last = parts[parts.length - 1];
    if (many) {
      if (!Object.prototype.hasOwnProperty.call(t, last)) {
        t[last] = [];
        kinds.set(t[last], "tables");
      } else if (!Array.isArray(t[last]) || kinds.get(t[last]) !== "tables") fail(`[[${parts.join(".")}]] was already defined as something else`);
      const element = {};
      kinds.set(element, "header");
      t[last].push(element);
      return element;
    }
    if (!Object.prototype.hasOwnProperty.call(t, last)) {
      t[last] = {};
    } else {
      const kind = kinds.get(t[last]);
      if (!isTable(t[last]) || kind !== "implicit") fail(`[${parts.join(".")}] is defined twice`);
    }
    kinds.set(t[last], "header");
    return t[last];
  }

  try {
    for (;;) {
      skipSpaces();
      skipComment();
      if (i >= src.length) break;
      if (newline()) continue;
      if (src[i] === "[") {
        if (!firstTable) firstTable = line;
        current = header();
        endOfLine();
        continue;
      }
      const start = line;
      const parts = key();
      if (src[i] !== "=") fail(`a key without =: ${parts.join(".")}`);
      i += 1;
      skipSpaces();
      if (i >= src.length || src[i] === "\n" || src[i] === "\r") fail(`${parts.join(".")} has no value`);
      const v = value();
      assign(current, parts, v);
      if (current === root) topKeys.set(parts[0], { start, end: line, dotted: parts.length > 1 });
      endOfLine();
    }
  } catch (e) {
    if (e instanceof TomlError) return { ok: false, line: e.line, why: e.message };
    throw e;
  }
  return { ok: true, value: root, topKeys, firstTable };
}

const isTable = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && !("datetime" in v && Object.keys(v).length === 1 && kinds.get(v) === undefined);

/** How a table was made: by a header, by dotted keys, inline, or only on the way to another. */
export const tableKind = (t) => kinds.get(t) || null;

// ---- writing --------------------------------------------------------------------------------------

export function tomlString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

export const tomlKey = (k) => (BARE.test(k) ? k : tomlString(k));

/** A value as TOML, on one line: strings, numbers, booleans, arrays, and tables as inline tables. */
export function tomlValue(v) {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("a number TOML cannot hold here");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    const pairs = Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`);
    return pairs.length ? `{ ${pairs.join(", ")} }` : "{}";
  }
  throw new Error("a value TOML cannot hold here");
}

const plain = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * Codex's config text with `top` keys set and `servers` added under `[mcp_servers.<name>]`, the
 * rest of the text untouched. A key already set is replaced on its own lines; a new one goes after the
 * last top-level key, before any table; a server is added at the end. A server already there by that
 * name is kept as it is, and named in `kept`. Throws if the file does not read, or would not after.
 */
export function mergeCodexToml(text, { top = {}, servers = {} } = {}) {
  const before = parseToml(text);
  if (!before.ok) throw new Error(`line ${before.line}: ${before.why}`);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  let lines = text === "" ? [] : String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const changes = [];
  const kept = [];

  const edits = [];
  const inserts = [];
  for (const [k, v] of Object.entries(top)) {
    const at = before.topKeys.get(k);
    const want = `${tomlKey(k)} = ${tomlValue(v)}`;
    if (at && at.dotted) throw new Error(`${k} is set with dotted keys in this file; set it by hand`);
    if (at) {
      if (plain(before.value[k]) === plain(v)) continue;
      edits.push({ start: at.start, end: at.end, text: want });
      changes.push({ kind: "setting", key: k, was: before.value[k], now: v });
    } else {
      inserts.push(want);
      changes.push({ kind: "setting", key: k, was: null, now: v });
    }
  }
  // New keys go in first, after the last top-level key, so the lines being replaced above do not move.
  if (inserts.length) {
    const lastTop = Math.max(0, ...[...before.topKeys.values()].map((t) => t.end));
    if (lastTop) lines.splice(lastTop, 0, ...inserts);
    else if (before.firstTable) lines.splice(0, 0, ...inserts, "");
    else lines.push(...inserts);
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) lines.splice(e.start - 1, e.end - e.start + 1, e.text);

  const have = before.value.mcp_servers;
  if (have !== undefined && (!isTable(have) || tableKind(have) === "inline")) {
    if (Object.keys(servers).length) throw new Error("mcp_servers in this file is not a table Rooms can add to; add the servers by hand");
  }
  for (const [name, server] of Object.entries(servers)) {
    if (have && Object.prototype.hasOwnProperty.call(have, name)) {
      if (plain(have[name]) !== plain(server)) kept.push(name);
      continue;
    }
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    for (const [k, v] of Object.entries(server)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    changes.push({ kind: "server", name });
  }

  const out = lines.length ? `${lines.join(eol)}${eol}` : "";
  const after = parseToml(out);
  if (!after.ok) throw new Error(`the merged config would not read: line ${after.line}: ${after.why}`);
  for (const [k, v] of Object.entries(top)) if (plain(after.value[k]) !== plain(v)) throw new Error(`the merged config does not hold ${k} as set`);
  for (const c of changes) {
    if (c.kind === "server" && plain(after.value.mcp_servers?.[c.name]) !== plain(servers[c.name])) throw new Error(`the merged config does not hold the server ${c.name} as given`);
  }
  return { text: out, changes, kept };
}
