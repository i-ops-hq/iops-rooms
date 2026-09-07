// share-diff must not read whatever it is pointed at.
//
// The original finding, 2026-09-07: `rooms share-diff --path ../fake-secret.env` read a file one
// directory above the room and published its contents into events.jsonl and onto the board, in one
// command. With `--share` on, that room is committed and pushed to the whole team. There was no
// confinement, no filter, and the 100 KB cap was applied AFTER reading the entire file.
//
// These drive the real CLI rather than the module, because the real CLI is what the finding used
// and what git hooks and scripts call.

import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

function runCli(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_TOOL: "test", ROOMS_ACTOR: "confine-test" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** A workspace with a room in `project/` and room for files beside it. */
async function withProject(fn) {
  const base = await mkdtemp(join(tmpdir(), "iops-rooms-confine-"));
  const project = join(base, "project");
  await mkdir(project, { recursive: true });
  try {
    await runCli(project, ["init", "--name", "confine"]);
    await fn({ base, project });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function diffEvents(project) {
  const raw = await readFile(join(project, ".room", "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "diff");
}

test("the original repro: a secret one directory up is refused, and never lands in the room", async () => {
  await withProject(async ({ base, project }) => {
    await writeFile(join(base, "fake-secret.env"), "SECRET_KEY=hunter2\n", "utf8");

    const r = await runCli(project, ["share-diff", "--path", "../fake-secret.env", "--note", "x"]);
    assert.equal(r.code, 1, "must exit non-zero");
    assert.match(r.err, /Refused/);

    const room = await readFile(join(project, ".room", "events.jsonl"), "utf8");
    assert.doesNotMatch(room, /hunter2/, "the secret must not reach the room");
    assert.equal((await diffEvents(project)).length, 0, "no diff event may be written");
  });
});

test("--allow-outside is the deliberate way through", async () => {
  await withProject(async ({ base, project }) => {
    await writeFile(join(base, "notes.txt"), "just some notes\n", "utf8");

    const r = await runCli(project, [
      "share-diff",
      "--path",
      "../notes.txt",
      "--note",
      "on purpose",
      "--allow-outside",
    ]);
    assert.equal(r.code, 0, r.err);
    const diffs = await diffEvents(project);
    assert.equal(diffs.length, 1);
    assert.match(diffs[0].diff, /just some notes/);
  });
});

test("a secret INSIDE the project is refused too — confinement alone would not catch it", async () => {
  await withProject(async ({ project }) => {
    await writeFile(join(project, ".env"), "TOKEN=abc123\n", "utf8");

    const r = await runCli(project, ["share-diff", "--path", ".env", "--note", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /looks like a secret file/);
    assert.match(r.err, /pipe it instead/, "the refusal must name the deliberate route");

    const room = await readFile(join(project, ".room", "events.jsonl"), "utf8");
    assert.doesNotMatch(room, /abc123/);
  });
});

test("--allow-outside does not also wave through a secret name", async () => {
  await withProject(async ({ base, project }) => {
    await writeFile(join(base, "id_rsa"), "PRIVATE KEY MATERIAL\n", "utf8");

    const r = await runCli(project, [
      "share-diff",
      "--path",
      "../id_rsa",
      "--allow-outside",
      "--note",
      "x",
    ]);
    assert.equal(r.code, 1, "the two controls are independent");
    assert.match(r.err, /looks like a secret file/);
  });
});

test("an ancestor directory named credentials does not refuse the whole project", async () => {
  // isSecretPathToken matches /credentials/i anywhere, so testing the resolved absolute path would
  // refuse every file under such a directory. A control that over-refuses gets overridden by habit.
  const base = await mkdtemp(join(tmpdir(), "iops-rooms-credentials-"));
  const project = join(base, "credentials-service", "app");
  await mkdir(project, { recursive: true });
  try {
    await runCli(project, ["init", "--name", "ok"]);
    await writeFile(join(project, "main.js"), "console.log(1);\n", "utf8");
    const r = await runCli(project, ["share-diff", "--path", "main.js", "--note", "fine"]);
    assert.equal(r.code, 0, r.err);
    assert.equal((await diffEvents(project)).length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an ordinary file inside the project is recorded project-relative", async () => {
  await withProject(async ({ project }) => {
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "a.js"), "const a = 1;\n", "utf8");

    const r = await runCli(project, ["share-diff", "--path", "src/a.js", "--note", "ok"]);
    assert.equal(r.code, 0, r.err);
    const [d] = await diffEvents(project);
    assert.equal(d.path, join("src", "a.js"));
    assert.match(d.diff, /const a = 1;/);
    assert.equal(d.truncated, undefined, "a small file is not truncated");
  });
});

test("a file past the cap is truncated, and the event says so", async () => {
  await withProject(async ({ project }) => {
    const big = join(project, "big.txt");
    await writeFile(big, "x".repeat(250_000), "utf8");

    const r = await runCli(project, ["share-diff", "--path", "big.txt", "--note", "big"]);
    assert.equal(r.code, 0, r.err);
    const [d] = await diffEvents(project);
    assert.equal(d.diff.length, 100_000, "kept exactly the cap");
    assert.equal(d.truncated, true, "unrecorded-cap: the reader must be told");

    const board = await readFile(join(project, ".room", "board.html"), "utf8");
    assert.match(board, /cut at 100 KB/, "and it must be visible on the board");
  });
});

test("piped content is capped and recorded, but not filtered — the bytes were the caller's choice", async () => {
  await withProject(async ({ project }) => {
    const child = spawn(process.execPath, [cli, "share-diff", "--note", "piped"], {
      cwd: project,
      env: { ...process.env, ROOMS_TOOL: "test", ROOMS_ACTOR: "confine-test" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end("y".repeat(150_000));
    await new Promise((r) => child.on("close", r));

    const [d] = await diffEvents(project);
    assert.equal(d.diff.length, 100_000);
    assert.equal(d.truncated, true);
  });
});
