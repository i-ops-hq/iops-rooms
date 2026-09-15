// The second evidence source: which agents a repository DECLARES, as opposed to which commits
// recorded one.
//
// It exists because the first source is far sparser than the design assumed. Across the newest 500
// commits of six well-known repositories — 3,000 commits — 45 carried a trailer that could be
// attributed. Five of those six declare their agents in a committed file. The dense signal was in
// the same checkout as the sparse one and nothing opened it.
//
// Two properties matter more than the reading itself, and most of this file is about them:
// the contents are never read, and a config file is never allowed to read as a commit.

import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { readAgentConfig, CONFIG_NOTE } from "../src/agent-config.js";
import { buildReport, formatConfig, formatWeek } from "../src/report.js";

const run = promisify(execFile);

/** A repo with one commit, plus whatever `files` asks for, committed unless `commit` is false. */
async function repo(files, fn, { commit = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-cfg-"));
  const git = (...a) =>
    run("git", ["-c", "user.email=ada@team.invalid", "-c", "user.name=Ada", ...a], { cwd: dir });
  await git("init", "-q", "-b", "main", ".");
  await writeFile(join(dir, "seed.txt"), "1\n", "utf8");
  await git("add", "seed.txt");
  await git("commit", "-q", "-m", "seed");

  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf8");
  }
  if (commit && Object.keys(files).length) {
    await git("add", "-A");
    await git("commit", "-q", "-m", "config");
  }
  try {
    await fn({ dir, git });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── what counts as a declaration ────────────────────────────────────────────────────────────────

test("an untracked config file is not a declaration", async () => {
  // The whole reason this asks git rather than the filesystem. A `.claude/` left in a working tree
  // by somebody's own session says nothing about the project, and reporting it as one would tell a
  // reader this repository is set up for Claude Code on the evidence of their own scratch files.
  await repo(
    { "CLAUDE.md": "# notes\n", ".claude/settings.json": "{}\n" },
    async ({ dir, git }) => {
      const before = await readAgentConfig(dir);
      assert.deepEqual(before.agents, [], "on disk, not committed, so not declared");
      assert.equal(before.markers.length, 0);

      await git("add", "-A");
      await git("commit", "-q", "-m", "now committed");

      const after = await readAgentConfig(dir);
      assert.deepEqual(after.agents.map((a) => a.label), ["Claude Code"]);
    },
    { commit: false },
  );
});

test("a tracked directory counts through the files inside it", async () => {
  // git tracks files, not directories, so `.claude` never appears in `ls-files` on its own.
  await repo({ ".claude/settings.json": "{}\n" }, async ({ dir }) => {
    const found = await readAgentConfig(dir);
    assert.deepEqual(found.agents.map((a) => a.label), ["Claude Code"]);
    assert.deepEqual(found.agents[0].files, [".claude/"]);
  });
});

test("one agent, one row, however many files named it", async () => {
  await repo(
    { "CLAUDE.md": "#\n", ".claude/settings.json": "{}\n", ".cursorrules": "x\n" },
    async ({ dir }) => {
      const found = await readAgentConfig(dir);
      assert.deepEqual(found.agents.map((a) => a.label), ["Claude Code", "Cursor"]);
      assert.deepEqual(found.agents[0].files, ["CLAUDE.md", ".claude/"]);
    },
  );
});

test("AGENTS.md is reported as itself and never attributed to a vendor", async () => {
  // It is the cross-vendor file — present in five of the six repositories sampled — and deciding
  // which agent it means would be inventing the one fact it deliberately does not carry.
  await repo({ "AGENTS.md": "# agents\n" }, async ({ dir }) => {
    const found = await readAgentConfig(dir);
    assert.equal(found.crossVendor, true);
    assert.deepEqual(found.agents, [], "no vendor is named by it, so no agent row comes from it");
  });
});

test("a file where a directory is expected does not count", async () => {
  await repo({ ".claude": "not a directory\n" }, async ({ dir }) => {
    assert.deepEqual((await readAgentConfig(dir)).agents, []);
  });
});

test("declaring nothing is a finding, and reads differently from failing to look", async () => {
  await repo({}, async ({ dir }) => {
    const found = await readAgentConfig(dir);
    assert.equal(found.ok, true, "it looked");
    assert.deepEqual(found.markers, [], "and found nothing, which is not the same as not looking");
  });
});

test("somewhere that is not a git checkout says so rather than answering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-nogit-"));
  try {
    const found = await readAgentConfig(dir);
    assert.equal(found.ok, false);
    assert.match(found.note, /git/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the contents are never read ─────────────────────────────────────────────────────────────────

test("the result is built from a fixed vocabulary, so no file data can ride along in it", async () => {
  // The first attempt here was a sentinel: write a secret into CLAUDE.md, assert it never surfaces.
  // It passed with the reader mutated to read every file and append the text to its return value —
  // because `markers` is filtered from the static MARKERS list, so nothing derived from a file has
  // anywhere to go. The sentinel could not fail, which makes it documentation rather than a guard.
  //
  // This is the falsifiable form: every string the reader returns must come from the vocabulary
  // this module defines. Add anything file-derived to the result and this fails.
  const secret = "SENTINEL-c4f1e2-do-not-read-this";
  await repo(
    { "CLAUDE.md": `# ${secret}\n`, ".cursorrules": secret, "AGENTS.md": secret },
    async ({ dir }) => {
      const found = await readAgentConfig(dir);

      const allowed = new Set([
        ...found.markers.flatMap((m) => [m.path, m.kind, m.family, m.label]),
        ...found.agents.flatMap((a) => [a.id, a.label, ...a.files]),
        found.note,
      ]);
      const strings = [];
      JSON.stringify(found, (key, value) => {
        if (typeof value === "string") strings.push(value);
        return value;
      });

      for (const value of strings) {
        assert.ok(allowed.has(value), `"${value.slice(0, 40)}" is not from this module's vocabulary`);
      }
      assert.ok(!strings.some((v) => v.includes(secret)), "a file's contents reached the result");
      assert.ok(strings.length > 0, "nothing was checked, so this asserted nothing");
    },
  );
});

test("the reader has no way to open a file in the first place", async () => {
  // The claim in the module docstring is that contents are never read, and the sentinel test above
  // cannot prove that — it only sees what surfaces. This one reads the source and asserts there is
  // no file-reading call in it at all. Crude, and it catches the realistic regression: somebody
  // adding a readFile to parse CLAUDE.md for something that seems harmless.
  //
  // It cannot catch a deliberate dynamic import, and that is stated rather than papered over. The
  // guard is against drift, not against an author who means to.
  const source = await readFile(new URL("../src/agent-config.js", import.meta.url), "utf8");
  const body = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const forbidden of ["readFile", "createReadStream", "readFileSync", "node:fs"]) {
    assert.ok(
      !body.includes(forbidden),
      `src/agent-config.js references ${forbidden}; this module reads names, never contents`,
    );
  }
});

// ── a config file must never read as a commit ───────────────────────────────────────────────────

test("the configured block carries the caveat that it is not a measurement", async () => {
  await repo({ "CLAUDE.md": "#\n" }, async ({ dir }) => {
    const text = formatConfig(await buildReport(dir));
    assert.match(text, /Configured for: Claude Code/);
    assert.match(text, /never that it was used/, "configured is not used, and it has to say so");
    assert.ok(CONFIG_NOTE.includes("do not belong in the percentages"));
  });
});

test("no percentage or bar is ever attached to a config file", async () => {
  // A second bar chart would invite comparison with the first, and these do not compare: the rows
  // above are commits and these are files. A percentage here would be a denominator out of nothing.
  await repo({ "CLAUDE.md": "#\n", "AGENTS.md": "#\n" }, async ({ dir }) => {
    const text = formatConfig(await buildReport(dir));
    assert.doesNotMatch(text, /%/, "no percentage belongs on a config file");
    assert.doesNotMatch(text, /[█░]/, "and no bar either");
  });
});

test("the commit percentages are untouched by what the config says", async () => {
  // The two sources answer different questions and the first one's arithmetic must not move.
  await repo({}, async ({ dir, git }) => {
    const before = await buildReport(dir);
    await writeFile(join(dir, "CLAUDE.md"), "#\n", "utf8");
    await git("add", "-A");
    await git("commit", "-q", "-m", "config");
    const after = await buildReport(dir);

    const shares = (r) => r.rows.map((x) => `${x.id}:${x.pct}`).join(",");
    assert.equal(
      shares(before).replace(/unrecorded:\d+/, ""),
      shares(after).replace(/unrecorded:\d+/, ""),
      "adding a config file changed an agent percentage",
    );
    assert.equal(after.config.agents.length, 1);
  });
});

test("a repository that declares nothing says so instead of staying silent", async () => {
  // Omitting the block would make "declared nothing" and "did not look" identical to a reader, and
  // the first of those is the reason the trailer count is the only evidence there is.
  await repo({}, async ({ dir }) => {
    // Wrapping is what the reader sees, so collapse it before matching a sentence that spans lines.
    const text = formatConfig(await buildReport(dir)).replace(/\s+/g, " ");
    assert.match(text, /commits no agent config file/);
    assert.match(text, /only evidence there is/);
  });
});

test("the block reaches the surface a person actually runs", async () => {
  await repo({ "AGENTS.md": "#\n" }, async ({ dir }) => {
    assert.match(formatWeek(await buildReport(dir)), /cross-vendor AGENTS\.md/);
  });
});
