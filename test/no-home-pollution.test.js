// The suite must never touch the developer's real identity store.
//
// This is a guard on test/env-setup.js, not on src/. It caught a live case: `~/.iops-rooms` on this
// machine held displayName "cmd-test" and a verified GitHub login of "octocat", both written by
// `npm test`. Nothing failed — the suite passed while quietly replacing the developer's identity.

import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { roomsHomeDir } from "../src/identity.js";

const realHome = join(homedir(), ".iops-rooms");

test("the suite runs against a temp ROOMS_HOME, never the real one", () => {
  assert.ok(process.env.ROOMS_HOME, "test/env-setup.js must be imported by the test script");
  assert.notEqual(roomsHomeDir(), realHome, "identity writes would land in the developer's store");
});

test("and a spawned CLI inherits it, which is where the leak actually happened", () => {
  // The tests that leaked all spawned the real CLI with { ...process.env }. Reading the home the
  // child resolves proves the variable survives the spawn boundary, not just the parent process.
  const r = spawnSync(
    process.execPath,
    ["-e", "import('./src/identity.js').then(m => process.stdout.write(m.roomsHomeDir()))"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, process.env.ROOMS_HOME);
  assert.notEqual(r.stdout, realHome);
});
