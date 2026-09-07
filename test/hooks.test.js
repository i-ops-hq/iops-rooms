import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, readEvents } from "../src/store.js";
import {
  generatePostCommitHook,
  generatePostCheckoutHook,
  installHooks,
  uninstallHooks,
  redactSecretPaths,
  MARKER,
} from "../src/hooks.js";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

async function tmp() {
  return mkdtemp(join(tmpdir(), "iops-rooms-hooks-"));
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return String(stdout || "").trim();
}

test("redactSecretPaths hides .env / pem / id_rsa style paths", () => {
  const raw = [
    " src/cli.js | 2 ++",
    " .env | 1 +",
    " secrets/id_rsa | 10 +",
    " cert.pem | 3 +",
  ].join("\n");
  const out = redactSecretPaths(raw);
  assert.match(out, /\[redacted-secret-path\]/);
  assert.doesNotMatch(out, /\.env/);
  assert.doesNotMatch(out, /id_rsa/);
  assert.match(out, /src\/cli\.js/);
});

test("hook script generation bakes absolute node + cli paths", () => {
  const nodeBin = "/usr/bin/node";
  const body = generatePostCommitHook({ nodeBin, cliPath: cli });
  assert.match(body, new RegExp(MARKER));
  assert.match(body, /ROOMS_TOOL=git-hook/);
  assert.match(body, /post-commit|commit %s/s);
  assert.ok(body.includes(nodeBin));
  assert.ok(body.includes(cli));
  assert.match(body, /git show --stat/);

  const co = generatePostCheckoutHook({ nodeBin, cliPath: cli });
  assert.match(co, new RegExp(MARKER));
  assert.match(co, /checked out branch/);
  assert.ok(co.includes(cli));
});

test("install writes hooks; commit triggers post", async () => {
  const dir = await tmp();
  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Hooks Test"]);
    // avoid commit.gpgsign prompts
    await git(dir, ["config", "commit.gpgsign", "false"]);

    await initRoom({ cwd: dir, name: "hooks-demo" });
    const before = await readEvents(dir);
    const beforeNonSystem = before.filter((e) => e.type !== "system").length;

    const result = await installHooks({
      cwd: dir,
      force: true,
      nodeBin: process.execPath,
      cliPath: cli,
    });
    assert.equal(result.written.length, 2);

    const postCommit = await readFile(join(dir, ".git", "hooks", "post-commit"), "utf8");
    assert.match(postCommit, new RegExp(MARKER));
    assert.ok(postCommit.includes(cli));

    await writeFile(join(dir, "hello.txt"), "hi\n", "utf8");
    await git(dir, ["add", "hello.txt"]);
    await git(dir, ["commit", "-m", "add hello"]);

    // hook runs async-ish but should finish before git commit returns (set -e + sync invoke)
    const events = await readEvents(dir);
    const notes = events.filter((e) => e.type === "note");
    assert.ok(notes.length > beforeNonSystem, "expected a hook-posted note");
    const last = notes[notes.length - 1];
    assert.match(last.text, /commit /);
    assert.match(last.text, /add hello/);
    assert.equal(last.tool, "git-hook");

    // uninstall removes ours
    const un = await uninstallHooks({ cwd: dir });
    assert.ok(un.removed.length >= 1);
    await assert.rejects(
      () => access(join(dir, ".git", "hooks", "post-commit"), constants.F_OK),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install refuses foreign hook without --force", async () => {
  const dir = await tmp();
  try {
    await git(dir, ["init"]);
    await writeFile(join(dir, ".git", "hooks", "post-commit"), "#!/bin/sh\necho foreign\n", {
      mode: 0o755,
    });
    await assert.rejects(
      () =>
        installHooks({
          cwd: dir,
          force: false,
          nodeBin: process.execPath,
          cliPath: cli,
        }),
      /Refusing to overwrite/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
