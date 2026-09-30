// BOARD.md (T5): the team board as Markdown in the team room, rebuilt by a GitHub Action, for people
// who read the repository on GitHub and run nothing themselves.
//
// What must hold: a teammate's status cannot become markup (an image that loads for every reader, a
// column of its own); the file carries no time of its own, so an hourly rebuild with nothing new
// commits nothing; and the workflow runs an exact version, on a schedule and on demand only, with
// no permission beyond writing the repository, and commits BOARD.md and nothing else.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { renderTeamMarkdown } from "../src/team-board.js";
import { boardWorkflow } from "../src/team.js";
import { exec, git, person, root, scratch } from "./team-helpers.js";

const status = (member, project, extra = {}) => ({
  v: 1, member, project, at: "2026-09-30T09:56Z", ahead: 0, behind: 0,
  uncommitted: { files: 0, added: 0, removed: 0, untracked: 0 }, pr: { state: "none" }, agents7d: {}, ...extra,
});

/** A table row's cells, split on the pipes Markdown reads as column breaks: those not escaped. */
const cells = (row) => row.replace(/\\\\/g, "").split(/(?<!\\)\|/).slice(1, -1);

test("a teammate's status cannot become markup: no image, no tag, no column of its own", () => {
  const hostile = status("mallory", "acme/web", {
    branch: "![x](https://evil/p.png) | <script>alert(1)</script> <img src=x onerror=alert(2)>\nX-Row: 1",
    upstream: null,
  });
  const md = renderTeamMarkdown({ name: "acme", statuses: [hostile] });
  const row = md.split("\n").find((l) => l.startsWith("| mallory"));
  assert.ok(row, md);
  assert.equal(cells(row).length, 7, row);
  assert.doesNotMatch(md, /(?<!\\)!(?<!\\)\[/, "an image would load for every reader");
  assert.doesNotMatch(md, /(?<!\\)<(script|img)/);
  assert.equal(md.split("\n").filter((l) => l.startsWith("X-Row")).length, 0, "a line break cannot start a line");
});

test("BOARD.md carries no time of its own, so the same statuses give the same file", () => {
  const statuses = [status("bob", "acme/web"), status("alice", "acme/web", { branch: "login", upstream: "origin/login" }), status("chen", "acme/api")];
  statuses.sort((a, b) => a.project.localeCompare(b.project) || a.member.localeCompare(b.member));
  const first = renderTeamMarkdown({ name: "acme", statuses });
  assert.equal(renderTeamMarkdown({ name: "acme", statuses }), first);
  assert.doesNotMatch(first, / ago\b|just now/, "a relative time is wrong by the time anyone reads it");
  assert.match(first, /\| 2026-09-30 09:56 UTC \|/);
  const order = [...first.matchAll(/^\| (alice|bob|chen) \|/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["chen", "alice", "bob"], "projects, then members, alphabetically: nothing ranked");
  assert.match(first, /^## acme\/api$/m);
  assert.match(first, /\| alice \| login \| nothing \| in step with origin\/login \| no pull request yet \| none seen \|/);
});

test("rooms team board --markdown reads the clone it runs in, which is how the workflow runs it", async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "team.git")]);
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "web.git")]);
    const alice = await person(dir, "alice");
    await alice.rooms(alice.team, "team", "init", "--name", "acme", "--yes", "--confirm-private");
    await mkdir(join(alice.team, "status", "alice"), { recursive: true });
    await writeFile(join(alice.team, "status", "alice", "acme--web.json"), JSON.stringify(status("alice", "acme/web")), "utf8");
    // A different Rooms home with no team registered: the clone itself is the team room.
    const out = await alice.rooms(alice.team, "team", "board", "--markdown");
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /^# acme · team room\n/);
    assert.match(out.out, /^\| alice \| not shared \|/m);
    const wrote = await alice.rooms(alice.team, "team", "board", "--markdown", "--out", "BOARD.md");
    assert.match(wrote.out, /wrote .*BOARD\.md: 1 status/);
    assert.equal(await readFile(join(alice.team, "BOARD.md"), "utf8"), out.out);
  });
});

test("the workflow runs an exact version, on a schedule and on demand only, and may only write the repository", () => {
  const yml = boardWorkflow({ version: "0.6.2" });
  const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"));
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ["schedule", "workflow_dispatch"], "no push trigger, so its own commit cannot start it again");
  assert.match(on, /cron: "17 \* \* \* \*"/);
  assert.equal(yml.slice(yml.indexOf("\npermissions:"), yml.indexOf("\nconcurrency:")).trim(), "permissions:\n  contents: write");
  for (const uses of yml.match(/uses: \S+/g)) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is pinned to a commit`);
  assert.match(yml, /ROOMS_VERSION: "0\.6\.2"/);
  assert.match(yml, /npm exec --yes --prefix "\$prefix" -- "iops-rooms@\$ROOMS_VERSION"/, "from an empty prefix, never bare npx");
  assert.doesNotMatch(yml, /@latest|npx /);
  assert.match(yml, /git commit -q -m "[^"]+" -- BOARD\.md/, "commits BOARD.md and nothing else");
  assert.match(boardWorkflow({ version: "0.6.2", hours: 6 }), /cron: "17 \*\/6 \* \* \*"/);
  for (const bad of [{ version: "latest" }, { version: "^0.6.0" }, { version: "0.6.2", hours: 0 }, { version: "0.6.2", hours: 25 }, { version: "0.6.2", hours: 1.5 }]) {
    assert.throws(() => boardWorkflow(bad), undefined, JSON.stringify(bad));
  }
});

test("the workflow's own step, run: BOARD.md is committed once, not again for nothing, and again when a status changes", { skip: process.platform === "win32" && "a stand-in npm needs a POSIX shell" }, async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "team.git")]);
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "web.git")]);
    const alice = await person(dir, "alice");
    await alice.rooms(alice.team, "team", "init", "--name", "acme", "--yes", "--confirm-private");
    await git(alice.team, "push", "-q", "-u", "origin", "main");
    const put = async (added) => {
      await mkdir(join(alice.team, "status", "alice"), { recursive: true });
      await writeFile(join(alice.team, "status", "alice", "acme--web.json"), JSON.stringify(status("alice", "acme/web", { uncommitted: { files: 1, added, removed: 0, untracked: 0 } })), "utf8");
      await git(alice.team, "add", "status");
      await git(alice.team, "commit", "-q", "-m", `status ${added}`);
      await git(alice.team, "push", "-q");
    };
    await put(10);
    // The step as the workflow holds it, with npm standing in for the registry: `npm view` says the
    // version exists, and `npm exec … -- iops-rooms@X <args>` runs this checkout's Rooms.
    const yml = boardWorkflow({ version: "0.6.2" });
    const step = yml.slice(yml.indexOf("        run: |\n") + 15).split("\n").map((l) => l.slice(10)).join("\n");
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "npm"), `#!/bin/sh\nif [ "$1" = view ]; then echo "$ROOMS_VERSION"; exit 0; fi\nwhile [ "$1" != "--" ]; do shift; done; shift; shift\nexec "${process.execPath}" "${join(root, "src", "cli.js")}" "$@"\n`, "utf8");
    await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(dir, "step.sh"), step, "utf8");
    const run = () => exec("bash", ["-e", join(dir, "step.sh")], {
      cwd: alice.team,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOMS_VERSION: "0.6.2", ROOMS_NO_GH: "1", ROOMS_HOME: alice.home },
      timeout: 30000,
    });
    const remote = () => git(join(dir, "team.git"), "log", "--format=%an: %s", "main");

    await run();
    assert.equal((await remote()).split("\n")[0], "github-actions[bot]: BOARD.md: rebuilt from the members' statuses");
    assert.equal(await git(join(dir, "team.git"), "show", "--name-only", "--format=", "main"), "BOARD.md");
    const count = (await remote()).split("\n").length;
    const again = await run();
    assert.match(again.stdout, /BOARD\.md has not changed\./);
    assert.equal((await remote()).split("\n").length, count, "nothing new, nothing committed");
    await git(alice.team, "config", "user.name", "alice");
    await put(99);
    await run();
    assert.equal((await remote()).split("\n")[0], "github-actions[bot]: BOARD.md: rebuilt from the members' statuses");
    assert.match(await git(join(dir, "team.git"), "show", "main:BOARD.md"), /\+99 −0 in 1 file/);
  });
});

test("rooms team workflow asks first, commits only the workflow, and pins the version that wrote it", async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "team.git")]);
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "web.git")]);
    const alice = await person(dir, "alice");
    const outside = await alice.rooms(alice.web, "team", "workflow", "--yes");
    assert.match(outside.err, /clone of the team room/);
    await alice.rooms(alice.team, "team", "init", "--name", "acme", "--yes", "--confirm-private");
    const asked = await alice.rooms(alice.team, "team", "workflow");
    assert.equal(asked.code, 2);
    assert.match(asked.out, /about 720 runs a month/);
    assert.equal(await git(alice.team, "rev-list", "--count", "HEAD"), "1", "nothing was committed");
    const made = await alice.rooms(alice.team, "team", "workflow", "--yes", "--hours", "6");
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /gh auth refresh -s workflow/);
    assert.equal(await git(alice.team, "show", "--name-only", "--format=", "HEAD"), ".github/workflows/rooms-board.yml");
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const yml = await readFile(join(alice.team, ".github", "workflows", "rooms-board.yml"), "utf8");
    assert.match(yml, new RegExp(`ROOMS_VERSION: "${version.replace(/\./g, "\\.")}"`));
    assert.match(yml, /cron: "17 \*\/6 \* \* \*"/);
    assert.equal(await git(join(dir, "team.git"), "rev-list", "--all", "--count"), "0", "and nothing was pushed");
  });
});
