// When git gives no answer, the board says which of four reasons it was, instead of "run git init".
//
// A first-time user reported a board reading "no git" and nothing about the project. `rooms week`
// had named git's real failure since 0.5.2, but the board read the checkout through a helper that
// turned every error into "not a git checkout", so a repository git refused to open, a shell with no
// git, and a broken git all read as a folder that was not a project, with advice to run `git init`.
//
// Dubious ownership is produced with git's own GIT_TEST_ASSUME_DIFFERENT_OWNER, with the global and
// system config set aside so a runner's `safe.directory` cannot quietly allow it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { probeCheckout, readGitSnapshot } from "../src/git-info.js";
import { renderHeroFacts, renderHeroSide } from "../src/board.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-nogit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function repoIn(dir) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "main.go"), "package main\n", "utf8");
  await exec("git", [...IDENT, "add", "-A"], { cwd: dir });
  await exec("git", [...IDENT, "commit", "-q", "-m", "first"], { cwd: dir });
}

/** Environment in which git refuses every repository for dubious ownership. */
async function refusingEnv(dir) {
  const empty = join(dir, "empty-gitconfig");
  await writeFile(empty, "", "utf8");
  return { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Run fn with these variables set in this process, and put the old values back afterwards. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function run(cwd, argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ROOMS_TOOL: "test", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("a folder that is not a repository is still reported as exactly that", async () => {
  await scratch(async (dir) => {
    const probe = await probeCheckout(dir);
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "not-a-repo");
    const snap = await readGitSnapshot(dir);
    assert.match(snap.note, /Not a git checkout/, "the sentence for a real non-repository is unchanged");
  });
});

test("a translated git message is still read as not-a-repo", async (t) => {
  await scratch(async (dir) => {
    const german = { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", LANGUAGE: "de" };
    // Only meaningful where git actually speaks German; elsewhere it could not tell the fix from its absence.
    const said = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, env: { ...process.env, ...german } })
      .then(() => "", (err) => String(err.stderr || ""));
    if (/not a git repository/i.test(said) || !said) {
      t.skip("git here has no German translation, so a translated message cannot be produced");
      return;
    }
    const probe = await withEnv(german, () => probeCheckout(dir));
    assert.equal(probe.reason, "not-a-repo", `read ${JSON.stringify(said.trim())} as ${probe.reason}`);
  });
});

test("a repository git refuses names the refusal and git's own fix", async (t) => {
  await scratch(async (dir) => {
    await repoIn(dir);
    const probe = await withEnv(await refusingEnv(dir), () => probeCheckout(dir));
    if (probe.ok) {
      t.skip("this git does not honour GIT_TEST_ASSUME_DIFFERENT_OWNER, so the refusal cannot be produced here");
      return;
    }
    assert.equal(probe.reason, "git-refused");
    assert.match(probe.detail, /dubious ownership/);
    assert.match(probe.fix, /^git config --global --add safe\.directory /, "the line that tells a reader what to do");
    const snap = await withEnv(await refusingEnv(dir), () => readGitSnapshot(dir));
    assert.match(snap.note, /git refused to read this repository/);
    assert.doesNotMatch(snap.note, /init git/, "git init is not advice for a repository that exists");
  });
});

test("no git on the PATH is named as that", async () => {
  await scratch(async (dir) => {
    // An empty folder as the whole PATH: there is no git to find.
    const probe = await withEnv({ PATH: dir }, () => probeCheckout(dir));
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "git-missing");
    assert.match(probe.detail, /not on PATH/);
  });
});

test("a git that fails says what git said", { skip: process.platform === "win32" && "a stub git is a shell script, and Windows runs no .cmd without a shell" }, async () => {
  await scratch(async (dir) => {
    // macOS's /usr/bin/git before the command line tools are installed.
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      "#!/bin/sh\necho 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)' >&2\nexit 1\n",
      "utf8",
    );
    await chmod(join(bin, "git"), 0o755);
    const probe = await withEnv({ PATH: bin }, () => probeCheckout(dir));
    assert.equal(probe.reason, "git-failed");
    assert.match(probe.detail, /xcrun: error: invalid active developer path/);
  });
});

test("the board's cards say the reason, and only a real non-repository is told to run git init", () => {
  const cases = [
    [{ ok: false }, "no git", /run git init here/, /not a git checkout/],
    [{ ok: false, reason: "not-a-repo" }, "no git", /run git init here/, /not a git checkout/],
    [{ ok: false, reason: "git-missing", detail: "git is not on PATH" }, "no git", /not on the PATH/, /git not found/],
    [
      { ok: false, reason: "git-refused", detail: "fatal: detected dubious ownership", fix: "git config --global --add safe.directory /x" },
      "unread",
      /refused to read this repository/,
      /git refused this repository[\s\S]*dubious ownership[\s\S]*safe\.directory \/x/,
    ],
    [{ ok: false, reason: "git-failed", detail: "xcrun: error" }, "unread", /git failed here/, /git failed here[\s\S]*xcrun: error/],
  ];
  assert.equal(cases.length, 5);
  for (const [git, value, card, side] of cases) {
    const facts = renderHeroFacts(null, [], git);
    assert.ok(facts.includes(`>${value}<`), `card value for ${git.reason || "no reason"}: ${value}`);
    assert.match(facts, card);
    assert.match(renderHeroSide({ git }), side);
    if (git.reason && git.reason !== "not-a-repo") {
      assert.doesNotMatch(facts + renderHeroSide({ git }), /git init/, `${git.reason} must not advise git init`);
    }
  }
});

test("rooms open and doctor in a refused repository say why, and doctor does not call it healthy", async (t) => {
  await scratch(async (dir) => {
    const project = join(dir, "svc");
    await mkdir(project);
    await repoIn(project);
    const env = await refusingEnv(dir);
    if ((await withEnv(env, () => probeCheckout(project))).ok) {
      t.skip("this git does not honour GIT_TEST_ASSUME_DIFFERENT_OWNER");
      return;
    }
    const opened = await run(project, ["open"], env);
    assert.equal(opened.code, 0, opened.err);
    assert.match(opened.out, /git refused to read this repository/, "said when the room is made");
    const board = await readFile(join(project, ".room", "board.html"), "utf8");
    assert.match(board, /git refused this repository/);
    assert.match(board, /safe\.directory/);
    assert.doesNotMatch(board, /git init here/);

    const doctor = await run(project, ["doctor"], env);
    assert.equal(doctor.code, 2, "a board git cannot read is not healthy");
    assert.match(doctor.out, /WARN\s+git\s+git refused to read this repository/);
    assert.match(doctor.out, /git could not read this project/);
    assert.doesNotMatch(doctor.out, /Healthy/);
    const next = doctor.out.split("Next:")[1] || "";
    assert.match(next.trim().split("\n")[0], /safe\.directory/, "git's fix comes before anything optional");
  });
});
