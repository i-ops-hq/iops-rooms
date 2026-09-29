// A GitHub Release per tag, its title and notes taken from that version's CHANGELOG section by
// scripts/release-notes.mjs. The publish workflow runs it after npm has the version.
//
// Two ways it could say something untrue: notes that hold another version's section (`## 0.5.1` is a
// prefix of `## 0.5.14`), and notes whose wrapped lines a Release shows as line breaks mid-sentence.
// And one way it could say nothing: a version with no section, which must fail rather than publish
// an empty Release.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { section, title, unwrap } from "../scripts/release-notes.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "release-notes.mjs");
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]);
const collapse = (s) => s.replace(/\s+/g, " ").trim();

test("every version's notes are its own section, with only the whitespace changed", () => {
  assert.ok(versions.length >= 17, `${versions.length} versions found`);
  for (const [i, v] of versions.entries()) {
    const own = section(changelog, v);
    assert.ok(own, `${v} has a section`);
    assert.doesNotMatch(own, /^## /m, `${v} stops at the next version`);
    assert.equal(collapse(unwrap(own)), collapse(own), `${v}: only whitespace changes`);
    const next = versions[i - 1];
    if (next) assert.ok(!own.includes(section(changelog, next).split("\n")[0]), `${v} holds none of ${next}`);
  }
  // The prefix a lookup by "starts with" gets wrong: 0.5.14 is higher in the file than 0.5.1.
  assert.match(section(changelog, "0.5.1"), /^### The live board answered to any hostname/);
});

test("a wrapped paragraph or list item is one line; code is left exactly as written", () => {
  const notes = unwrap(section(changelog, "0.5.14")).split("\n");
  assert.ok(
    notes.includes(
      "The commonest way to use a CLI agent left no trace: it edits, and you commit by hand from another " +
        "terminal, so the commit carries no trailer and none of the agent's variables. Claude Code's own " +
        "hooks do see the edits. `rooms hooks install --agent claude-code` adds them, and `rooms week` " +
        "gains a line in the observed block:",
    ),
  );
  const code = notes.indexOf("    carry files an agent edited   1 of 2 observed (Claude Code 1)");
  assert.ok(code > 0 && notes[code - 1] === "" && notes[code + 1] === "", "the code line keeps its indent and its blank lines");

  const item = unwrap(section(changelog, "0.5.12")).split("\n").find((l) => l.startsWith("- **Committing by hand is named.**"));
  assert.ok(item?.includes("records nothing. The note under an empty result"), "the item's second line joins it");

  assert.equal(unwrap("para one\nstill one  \nnew line\n\n| a |\n| b |\n```\nx\ny\n```"), "para one still one  \nnew line\n\n| a |\n| b |\n```\nx\ny\n```");
  assert.equal(unwrap("text\n\n    code one\n    code two\n\nafter"), "text\n\n    code one\n    code two\n\nafter");
});

test("the title is the version and the section's first ### heading, as plain text", () => {
  assert.equal(title(changelog, "0.5.14"), "v0.5.14 — An agent's edits, committed by hand, are seen");
  assert.equal(title(changelog, "0.5.7"), "v0.5.7 — --json on week, branch and file");
  // 0.5.2 opens with a paragraph; its first heading is the first fix.
  assert.equal(title(changelog, "0.5.2"), 'v0.5.2 — git failures were reported as "0 commits", with exit 0');
  const bare = "# Changelog\n\n## 2.0.0\n\nText.\n\n```\n## not a version\n```\n\nMore.\n\n## 1.0.0\n\nOld.\n";
  assert.equal(title(bare, "2.0.0"), "v2.0.0");
  assert.equal(section(bare, "2.0.0"), "Text.\n\n```\n## not a version\n```\n\nMore.", "a fenced ## does not end it");
  assert.equal(section(bare, "1.0.0"), "Old.", "the last section runs to the end");
  assert.equal(section(bare, "3.0.0"), null);
});

test("a version with no section fails, and prints nothing a Release could be made from", async () => {
  for (const args of [["9.9.9"], ["9.9.9", "--title"]]) {
    const err = await exec(process.execPath, [script, ...args]).then(() => null, (e) => e);
    assert.ok(err, `${args.join(" ")} fails`);
    assert.equal(err.code, 1);
    assert.equal(err.stdout, "");
    assert.match(err.stderr, /no '## 9\.9\.9' section/);
  }
  const ok = await exec(process.execPath, [script, versions[0], "--title"]);
  assert.equal(ok.stdout, `${title(changelog, versions[0])}\n`);
});
