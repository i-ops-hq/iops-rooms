// The attribution action, and CI's test of it, run the published package they name, never whatever
// happens to be on PATH.
//
// `npx iops-rooms@X`, run inside a checkout of this repository whose package.json is also X, first
// asks whether the project it is standing in satisfies the spec. It does, so npm installs nothing and
// runs whatever `iops-rooms` is on PATH: nothing on a CI runner, and on the laptop this was found on
// a global 0.5.1. After 0.5.7 shipped, CI's probe reported "iops-rooms@0.5.7 has no --json yet"
// about a release that has it, the action's end-to-end step was skipped with a notice rather than
// failed, and the job stayed green. That step had never run on main.
//
// `npm exec --prefix <an empty directory>` takes the checkout out of the resolution and still runs the
// command in the directory it was called from. This file checks the source statically, because the
// suite makes no network calls; the behaviour is exercised by CI's end-to-end step, which this file
// also checks can no longer skip itself.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Shell and YAML comments quote the old invocation on purpose, to say why it is gone.
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line));
const BARE_NPX = /\bnpx\b.*\biops-rooms@/;

test("the action runs its pinned package from an empty prefix, not with bare npx", () => {
  const lines = codeLines(read("actions/attribution/run.sh"));
  assert.ok(!lines.some((line) => BARE_NPX.test(line)), "run.sh asks bare npx for iops-rooms@…");
  assert.ok(
    lines.some((line) =>
      /\bnpm exec\b.*--prefix "\$npx_prefix".*"iops-rooms@\$\{ROOMS_VERSION\}"/.test(line),
    ),
    "run.sh resolves iops-rooms@${ROOMS_VERSION} from its empty prefix",
  );
  assert.ok(
    lines.some((line) => /^npx_prefix=\$\(mktemp -d\)$/.test(line)),
    "the prefix is a fresh empty directory",
  );
});

test("CI's probe of the published package resolves it the same way", () => {
  const lines = codeLines(read(".github/workflows/tests.yml"));
  assert.ok(!lines.some((line) => BARE_NPX.test(line)), "tests.yml asks bare npx for iops-rooms@…");
  assert.ok(
    lines.some((line) => /\bnpm exec\b.*--prefix "\$\(mktemp -d\)".*"iops-rooms@\$VERSION"/.test(line)),
    "the probe resolves the published version from an empty prefix",
  );
});

test("the end-to-end step against the published package cannot skip itself", () => {
  const yml = read(".github/workflows/tests.yml");
  const step = yml.match(
    /- name: The action runs end to end against the published package\n([\s\S]*?)\n\s*- (?:name|uses):/,
  );
  assert.ok(step, "the end-to-end step exists");
  assert.doesNotMatch(step[1], /^\s*if:/m, "the end-to-end step is conditional, so it can be skipped");
  assert.doesNotMatch(yml, /outputs\.ready\b/, "a readiness gate is back, and with it a way to skip");
});
