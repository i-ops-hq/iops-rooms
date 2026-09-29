// The GitHub Release for a version, both parts taken from that version's CHANGELOG section. The
// release job in .github/workflows/publish.yml runs it for each tag; it was also run by hand for the
// tags published before that job existed.
//
//   node scripts/release-notes.mjs 0.5.15           the notes
//   node scripts/release-notes.mjs 0.5.15 --title   the title
//
// The CHANGELOG is wrapped at 100 columns, and a Release shows every newline inside a paragraph as a
// line break, so each paragraph and list item is joined back onto one line. Nothing else changes:
// headings, code, tables and quotes are left exactly as written.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FENCE = /^ {0,3}(```|~~~)/;

/** The lines under `## <version>`, up to the next `## ` heading. Null when there is no such heading. */
export function section(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) return null;
  let end = lines.length;
  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    else if (!fenced && lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join("\n");
}

/** `v<version> — <the section's first ### heading>`, as plain text, or the version alone. */
export function title(changelog, version) {
  const body = section(changelog, version);
  if (body === null) return null;
  const heading = body.split("\n").find((l) => l.startsWith("### "));
  return heading ? `v${version} — ${heading.slice(4).replace(/`/g, "").trim()}` : `v${version}`;
}

/** Each paragraph and list item on one line. Only whitespace changes. */
export function unwrap(markdown) {
  const out = [];
  let kind = "blank";
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (fenced || FENCE.test(line)) {
      if (FENCE.test(line)) fenced = !fenced;
      out.push(line);
      kind = "fence";
    } else if (!line.trim()) {
      out.push("");
      kind = "blank";
    } else if (/^( {4}|\t)/.test(line) && (kind === "blank" || kind === "code")) {
      out.push(line);
      kind = "code";
    } else if (/^ {0,3}(#{1,6} |\||>|<)/.test(line)) {
      out.push(line);
      kind = "block";
    } else if (/^\s*([-*+]|\d+[.)]) /.test(line)) {
      out.push(line);
      kind = "item";
    } else if ((kind === "para" || kind === "item") && !/( {2}|\\)$/.test(out[out.length - 1])) {
      // Joined, unless the line before ends in a hard break the author meant: two spaces or a "\".
      out[out.length - 1] = `${out[out.length - 1].trimEnd()} ${line.trimStart()}`;
    } else {
      out.push(line);
      kind = "para";
    }
  }
  return out.join("\n");
}

async function main([version, flag, ...extra]) {
  if (!version || extra.length || (flag !== undefined && flag !== "--title")) {
    process.stderr.write("usage: node scripts/release-notes.mjs <version> [--title]\n");
    return 2;
  }
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const body = section(changelog, version);
  if (!body) {
    // An empty Release would read as a version with nothing in it, so there is none.
    process.stderr.write(`CHANGELOG.md has no '## ${version}' section, or it is empty.\n`);
    return 1;
  }
  process.stdout.write(`${flag === "--title" ? title(changelog, version) : unwrap(body)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
