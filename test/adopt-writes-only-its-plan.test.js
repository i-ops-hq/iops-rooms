// What adopting may write (docs/design/TEAM_SETUPS.md §8.2): the plan that was approved, and only
// that. A file that changed between the plan and the approval means it is not that plan; a link
// where a file would go is not written through; a command a shell would split is not written with
// a path dropped into it; and a file aimed outside the places a setup may write is refused even if
// it got as far as the planner.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildManifest } from "../src/setup/manifest.js";
import { applyAdoption, planAdoption, readAdoptions, rollBack } from "../src/setup/adopt.js";

const exec = promisify(execFile);

async function place(fn, { projectName = "web" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-adopt-"));
  const project = join(dir, projectName);
  await mkdir(project, { recursive: true });
  await exec("git", ["init", "-q", project]);
  try {
    await fn({ dir, project, config: join(dir, "claude"), home: join(dir, "home"), backupsDir: join(dir, "backups") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function setupOf(items) {
  const { manifest, files } = buildManifest({ role: "backend", name: "go-claude", owner: "alice", version: "0.7.0", items: items.map((i) => ({ selected: true, left: [], ...i })) });
  return { manifest: JSON.parse(JSON.stringify(manifest)), files, commit: "c0ffee", revision: "c0ffee", team: "local/team" };
}

const claudeMd = { scope: "project", kind: "instructions", installTo: "project:CLAUDE.md", label: "CLAUDE.md", content: "# From the setup\n" };

test("a file that changed after the plan was made stops the adoption, and nothing is written", async () => {
  await place(async ({ project, config, home, backupsDir }) => {
    await writeFile(join(project, "CLAUDE.md"), "mine\n", "utf8");
    const plan = await planAdoption({ setup: setupOf([claudeMd]), project, config, home });
    assert.equal(plan.writes[0].action, "replace");
    await writeFile(join(project, "CLAUDE.md"), "mine, edited while the plan was read\n", "utf8");
    await assert.rejects(applyAdoption(plan, { backupsDir }), /CLAUDE\.md changed since the plan was made\. Nothing was changed/);
    assert.equal(await readFile(join(project, "CLAUDE.md"), "utf8"), "mine, edited while the plan was read\n");
    assert.deepEqual(await readdir(backupsDir).catch(() => []), [], "not even a backup was started");
  });
});

test("a link where a file would go is refused, and nothing is written through it", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async () => {
  await place(async ({ dir, project, config, home }) => {
    await writeFile(join(dir, "precious.txt"), "do not touch\n", "utf8");
    await symlink(join(dir, "precious.txt"), join(project, "CLAUDE.md"));
    const plan = await planAdoption({ setup: setupOf([claudeMd]), project, config, home });
    assert.deepEqual(plan.refused, ["CLAUDE.md is a link here; Rooms does not write through it"]);
    assert.equal(plan.writes.length, 0);
    assert.equal(await readFile(join(dir, "precious.txt"), "utf8"), "do not touch\n");
  });
});

test("a hook naming the project is refused when the project's path is one a shell would split", async () => {
  const settings = { scope: "project", kind: "settings", label: ".claude/settings.json", value: { hooks: { Stop: [{ hooks: [{ type: "command", command: "${PROJECT}/scripts/check.sh" }] }] } } };
  await place(async ({ project, config, home }) => {
    const plan = await planAdoption({ setup: setupOf([settings]), project, config, home });
    assert.match(plan.refused[0], /\.claude\/settings\.local\.json: a Stop hook: this project's path has characters a shell would split/);
  }, { projectName: "my web" });
  await place(async ({ project, config, home }) => {
    const plan = await planAdoption({ setup: setupOf([settings]), project, config, home });
    assert.deepEqual(plan.refused, []);
    assert.match(plan.runs[0].shown, /\/web\/scripts\/check\.sh$/);
  });
});

test("a file aimed outside the places a setup may write is refused, even at the planner", async () => {
  await place(async ({ project, config, home }) => {
    const setup = setupOf([claudeMd]);
    Object.assign(setup.manifest.tools["claude-code"].files[0], { installTo: "project:../outside.md" });
    const plan = await planAdoption({ setup, project, config, home });
    assert.deepEqual(plan.refused, ["project:../outside.md is not a place a setup may write"]);
    assert.equal(plan.writes.length, 0);
  });
});

test("rollback itself stops at a file changed since the adoption, whoever calls it", async () => {
  await place(async ({ project, config, home, backupsDir }) => {
    await writeFile(join(project, "CLAUDE.md"), "mine\n", "utf8");
    const plan = await planAdoption({ setup: setupOf([claudeMd]), project, config, home });
    await applyAdoption(plan, { backupsDir });
    await writeFile(join(project, "CLAUDE.md"), "changed after adopting\n", "utf8");
    const [record] = await readAdoptions(backupsDir);
    const stopped = await rollBack(record);
    assert.deepEqual(stopped, { ok: false, changed: [{ label: "CLAUDE.md", how: "changed since" }] });
    assert.equal(await readFile(join(project, "CLAUDE.md"), "utf8"), "changed after adopting\n");
    assert.equal((await rollBack(record, { force: true })).ok, true);
    assert.equal(await readFile(join(project, "CLAUDE.md"), "utf8"), "mine\n");
  });
});
