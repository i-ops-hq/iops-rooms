// Docs must agree with package.json, and the skill mirror must agree with itself.
//
// Every version in these files is an instruction — "pin this" — so a stale one tells a reader to
// install something three releases old. On 2026-09-07 SECURITY.md still said `iops-rooms@0.1.0`
// in the very step that teaches pinning, and the framing doc pointed at `github.com/i-ops/rooms`,
// an org that is not ours. README, SKILL.md and examples/mcp.json had been moved to 0.3.1 by hand
// in a different pass, which is exactly how a set of files drifts apart: each one is correct on the
// day someone remembers it.
//
// `.cursor/skills/rooms/SKILL.md` is a copy of `skills/rooms/SKILL.md` written by `rooms mcp
// install`. Two files holding one fact is a mirror, and a mirror nothing checks is a mirror that
// drifts, so it is asserted here rather than trusted.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Files that tell a reader which version to install, or where the repo lives.
 *
 * A private planning document used to be listed here and is no longer part of this repository.
 * Do not add it back.
 */
const DOCS = [
  "README.md",
  "SECURITY.md",
  "skills/rooms/SKILL.md",
  ".cursor/skills/rooms/SKILL.md",
  "examples/mcp.json",
];

const PINNED = /iops-rooms@(\d+\.\d+\.\d+)/g;
const GH_REPO = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g;

async function readPkg() {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

test("every pinned version in the docs is the version in package.json", async () => {
  const pkg = await readPkg();
  const wrong = [];
  for (const rel of DOCS) {
    const text = await readFile(join(root, rel), "utf8");
    for (const m of text.matchAll(PINNED)) {
      if (m[1] !== pkg.version) {
        wrong.push(`${rel}:${lineOf(text, m.index)} pins ${m[1]}, package.json is ${pkg.version}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `stale install pins:\n  ${wrong.join("\n  ")}`);
});

test("docs point at the repo package.json declares, not a near-miss org", async () => {
  const pkg = await readPkg();
  const expected = pkg.repository.url.replace(/^git\+/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const wrong = [];
  for (const rel of DOCS) {
    const text = await readFile(join(root, rel), "utf8");
    for (const m of text.matchAll(GH_REPO)) {
      const slug = m[1].replace(/\.git$/, "");
      // Other orgs are fine to cite; a near-miss of our own name is what this catches.
      const [owner, repo] = slug.split("/");
      const [okOwner, okRepo] = expected.split("/");
      const looksLikeUs = owner.startsWith("i-ops") || repo.startsWith("iops-rooms") || repo === "rooms";
      if (looksLikeUs && (owner !== okOwner || repo !== okRepo)) {
        wrong.push(`${rel}:${lineOf(text, m.index)} says ${slug}, package.json says ${expected}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `wrong repo slug:\n  ${wrong.join("\n  ")}`);
});

test("the installed skill copy matches the packaged one", async () => {
  const packaged = await readFile(join(root, "skills/rooms/SKILL.md"), "utf8");
  const installed = await readFile(join(root, ".cursor/skills/rooms/SKILL.md"), "utf8");
  assert.equal(
    installed,
    packaged,
    ".cursor/skills/rooms/SKILL.md has drifted from skills/rooms/SKILL.md — re-run `rooms mcp install`",
  );
});

test("every image the README points at exists in the repo", async () => {
  // A missing screenshot is not a local annoyance: the README is the npm package page and the
  // GitHub front door, and a broken image is the first thing a stranger sees. `docs/screenshots/
  // board.png` was referenced for a release and never committed.
  const readme = await readFile(join(root, "README.md"), "utf8");
  const refs = [...readme.matchAll(/(?:src|\]\()="?([^"'()\s]+\.(?:png|jpg|jpeg|gif|svg))/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^https?:/i.test(r));
  assert.ok(local.length > 0, "the README shows the product at all");

  const missing = [];
  for (const rel of local) {
    try {
      await readFile(join(root, rel));
    } catch {
      missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], `README points at images that are not in the repo:\n  ${missing.join("\n  ")}`);
});
