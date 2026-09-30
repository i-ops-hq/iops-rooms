// The team room (T3): a repository the team owns, where each member's Rooms shares one small status
// file per project and reads everyone else's.
//
// Two people, alice and bob, each with their own Rooms home and their own clones, share one team
// room. A bare repository stands in for the team's private GitHub repository, and the checks that
// need GitHub are tested with `gh` replaced.
//
// What must hold: nothing leaves without being shown first; only the member's own file is pushed;
// the file holds counts and states, never a file name or a line of code; a public team room is
// refused; and a status from a teammate's machine is checked field by field and escaped.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applySync, checkPrivate, planSync, readStatuses, validStatus } from "../src/team.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-team-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd, argv, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ROOMS_NO_GH: "1", ROOMS_HOME: home },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end("");
  });
}

const git = (cwd, ...args) => exec("git", args, { cwd }).then((r) => r.stdout.trim());

/** A person: their Rooms home, a GitHub login on it, and their own clones of the team room and web. */
async function person(dir, login) {
  const home = join(dir, login, "home");
  await exec(process.execPath, ["-e", `import(${JSON.stringify(join(root, "src", "identity.js"))}).then((m) => m.installFixtureIdentity({ login: ${JSON.stringify(login)} }))`], {
    env: { ...process.env, ROOMS_HOME: home },
  });
  const team = join(dir, login, "team");
  const web = join(dir, login, "web");
  for (const [from, to] of [["team.git", team], ["web.git", web]]) {
    await exec("git", ["clone", "-q", join(dir, from), to]);
    await git(to, "config", "user.name", login);
    await git(to, "config", "user.email", `${login}@example.com`);
  }
  return { login, home, team, web, rooms: (cwd, ...argv) => run(cwd, argv, home) };
}

/** alice makes the team room and the project's first commit, and both people have joined. */
async function teamOfTwo(dir) {
  await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "team.git")]);
  await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "web.git")]);
  const alice = await person(dir, "alice");
  const made = await alice.rooms(alice.team, "team", "init", "--name", "acme", "--yes", "--confirm-private");
  assert.equal(made.code, 0, made.err);
  await git(alice.team, "push", "-q", "-u", "origin", "main");
  await writeFile(join(alice.web, "app.js"), "one\n", "utf8");
  await git(alice.web, "add", "-A");
  await git(alice.web, "commit", "-q", "-m", "first");
  await git(alice.web, "push", "-q", "-u", "origin", "main");
  const bob = await person(dir, "bob");
  for (const p of [alice, bob]) {
    const joined = await p.rooms(p.web, "team", "join", p.team, "--yes", "--confirm-private");
    assert.equal(joined.code, 0, joined.err);
  }
  return { alice, bob };
}

const ALLOWED = ["v", "member", "project", "at", "branch", "upstream", "ahead", "behind", "uncommitted", "pr", "agents7d"];

test("init makes the team room in one local commit, and pushes nothing", async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "team.git")]);
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(dir, "web.git")]);
    const alice = await person(dir, "alice");
    const refused = await alice.rooms(alice.team, "team", "init", "--yes");
    assert.notEqual(refused.code, 0, "not on GitHub, and not confirmed private");
    assert.match(refused.err, /cannot ask whether it is private.*--confirm-private/s);
    const made = await alice.rooms(alice.team, "team", "init", "--name", "acme", "--yes", "--confirm-private");
    assert.equal(made.code, 0, made.err);
    assert.equal(await git(alice.team, "log", "--format=%s"), "Team room: acme");
    assert.deepEqual((await git(alice.team, "show", "--name-only", "--format=", "HEAD")).split("\n").sort(), [".gitattributes", "README.md", "room.json", "status/.gitkeep"]);
    assert.equal(await git(join(dir, "team.git"), "rev-list", "--all", "--count"), "0", "the remote has nothing until alice pushes");
  });
});

test("sync shows the file and asks, then pushes that one file, and never a file name or a line of code", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await git(alice.web, "switch", "-q", "-c", "login-page");
    await writeFile(join(alice.web, "app.js"), "one\ntwo\n", "utf8");
    await writeFile(join(alice.web, "secret-plan.txt"), "the launch date is in here\n", "utf8");

    const asked = await alice.rooms(alice.web, "team", "sync");
    assert.equal(asked.code, 2);
    assert.match(asked.out, /status\/alice\/web\.json\n\{/, "the exact file is shown");
    assert.equal(await git(join(dir, "team.git"), "rev-list", "--count", "main"), "1", "nothing was pushed");

    const shared = await alice.rooms(alice.web, "team", "sync", "--yes");
    assert.equal(shared.code, 0, shared.err);
    assert.equal(await git(join(dir, "team.git"), "log", "-1", "--format=%an: %s", "main"), "alice: status: alice · web");
    assert.equal(await git(join(dir, "team.git"), "show", "--name-only", "--format=", "main"), "status/alice/web.json");
    const status = JSON.parse(await git(join(dir, "team.git"), "show", "main:status/alice/web.json"));
    assert.deepEqual(Object.keys(status).filter((k) => !ALLOWED.includes(k)), []);
    assert.deepEqual([status.branch, status.uncommitted], ["login-page", { files: 1, added: 1, removed: 0, untracked: 1 }]);
    const everything = await git(join(dir, "team.git"), "log", "-p", "--all");
    assert.doesNotMatch(everything, /secret-plan|launch date|app\.js|one\ntwo/);

    const again = await alice.rooms(alice.web, "team", "sync", "--yes");
    assert.match(again.out, /has not changed since your last sync, so nothing was pushed/);
    assert.equal(await git(join(dir, "team.git"), "rev-list", "--count", "main"), "2");
  });
});

test("bob reads alice's status on his board, and shares his own without the branch", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    await writeFile(join(alice.web, "fresh.txt"), "new\n", "utf8");
    await alice.rooms(alice.web, "team", "sync", "--yes");
    await git(bob.web, "pull", "-q");
    const mine = await bob.rooms(bob.web, "team", "sync", "--yes", "--no-branch");
    assert.equal(mine.code, 0, mine.err);
    const bobs = JSON.parse(await git(join(dir, "team.git"), "show", "main:status/bob/web.json"));
    assert.equal("branch" in bobs || "upstream" in bobs, false);

    const board = await bob.rooms(bob.web, "team", "board");
    assert.equal(board.code, 0, board.err);
    assert.match(board.out, /2 statuses from 2 member\(s\)/);
    const html = await readFile(board.out.match(/^team board {2}(.+)$/m)[1], "utf8");
    const cards = [...html.matchAll(/<li class="member">[\s\S]*?<\/li>/g)].map((m) => m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    assert.equal(cards.length, 2);
    assert.match(cards[0], /^alice updated .* main uncommitted: 1 new file in step with origin\/main/);
    assert.match(cards[1], /^bob updated .* branch not shared nothing uncommitted/);
  });
});

test("only the member's own file goes into the commit, and a push that lost the race is caught up once", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    // Something else changed in alice's clone; it must stay out of her status commit.
    await writeFile(join(alice.team, "README.md"), "edited by hand\n", "utf8");
    // bob pushes first, so alice's push is rejected and has to catch up.
    await bob.rooms(bob.web, "team", "sync", "--yes");
    const plan = await planSync({
      clonePath: alice.team,
      status: { v: 1, member: "alice", project: "web", at: "2026-09-30T05:00Z", ahead: 0, behind: 0, uncommitted: { files: 0, added: 0, removed: 0, untracked: 0 }, pr: { state: "none" }, agents7d: {} },
    });
    const done = await applySync({ clonePath: alice.team, plan });
    assert.equal(done.ok, true, done.why);
    assert.equal(await git(alice.team, "show", "--name-only", "--format=", "HEAD"), "status/alice/web.json");
    assert.match(await git(alice.team, "status", "--porcelain"), /README\.md/, "the hand edit is still uncommitted");
    const remote = await git(join(dir, "team.git"), "ls-tree", "-r", "--name-only", "main");
    assert.match(remote, /status\/alice\/web\.json/);
    assert.match(remote, /status\/bob\/web\.json/);
  });
});

test("a status from a teammate's machine is checked field by field, and whatever it says is escaped", async () => {
  await scratch(async (dir) => {
    const { bob } = await teamOfTwo(dir);
    const base = { v: 1, project: "web", at: "2026-09-30T05:00Z", ahead: 0, behind: 0, uncommitted: { files: 0, added: 0, removed: 0, untracked: 0 }, pr: { state: "none" }, agents7d: {} };
    const put = async (folder, name, data) => {
      await mkdir(join(bob.team, "status", folder), { recursive: true });
      await writeFile(join(bob.team, "status", folder, name), JSON.stringify(data), "utf8");
    };
    await put("mallory", "web.json", { ...base, member: "mallory", branch: '<img src=x onerror="alert(1)">', project: "<script>alert(2)</script>" });
    await put("mallory", "other.json", { ...base, member: "alice" });
    await put("eve", "web.json", { ...base, member: "eve", uncommitted: { files: -1, added: 0, removed: 0, untracked: 0 } });
    const { statuses, skipped } = await readStatuses(bob.team);
    assert.deepEqual([statuses.map((s) => s.member), skipped], [["mallory"], 2], "one filed under someone else's folder, one with a negative count");

    const { renderTeamBoard } = await import("../src/team-board.js");
    const html = await renderTeamBoard({ name: "acme", id: "acme/team", statuses, skipped });
    assert.doesNotMatch(html.slice(html.indexOf("<body>")), /<img|<script/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /2 files were not a status this version reads/);
  });
});

test("validStatus refuses what a status cannot be", () => {
  const ok = { v: 1, member: "alice", project: "web", at: "2026-09-30T05:00Z", ahead: 0, behind: null, uncommitted: { files: 1, added: null, removed: null, untracked: 0 }, pr: { state: "open", number: 4 }, agents7d: { "claude-code": { sessions: 2, filesEdited: 5 } } };
  assert.ok(validStatus(ok, "alice"));
  const bad = [
    [{ ...ok, v: 2 }, "a format this version does not read"],
    [ok, "filed under another member", "bob"],
    [{ ...ok, member: "../alice" }, "a login GitHub would refuse", "../alice"],
    [{ ...ok, branch: "x".repeat(300) }, "a branch longer than any"],
    [{ ...ok, ahead: 1.5 }, "a count that is not a whole number"],
    [{ ...ok, pr: { state: "shipped" } }, "a pull request state it does not know"],
    [{ ...ok, at: "yesterday" }, "a time that is not one"],
    [{ ...ok, agents7d: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, { sessions: 1, filesEdited: 1 }])) }, "more agents than any machine runs"],
  ];
  for (const [data, why, folder = "alice"] of bad) assert.equal(validStatus(data, folder), null, why);
});

test("a public team room is refused, and one Rooms cannot check needs the person to say they checked", async () => {
  const gh = (visibility) => async () => JSON.stringify({ visibility });
  const onGitHub = { host: "github.com", path: "acme/team" };
  assert.equal((await checkPrivate(onGitHub, { runGh: gh("PRIVATE"), env: {} })).ok, true);
  assert.equal((await checkPrivate(onGitHub, { runGh: gh("INTERNAL"), env: {} })).ok, true);
  const pub = await checkPrivate(onGitHub, { runGh: gh("PUBLIC"), env: {} });
  assert.deepEqual([pub.ok, /readable|read by anyone/.test(pub.why)], [false, true]);
  assert.equal((await checkPrivate(onGitHub, { runGh: gh("PUBLIC"), allowPublic: true, env: {} })).ok, true, "only when the person says --public");
  assert.equal((await checkPrivate(onGitHub, { runGh: gh("PUBLIC"), confirmPrivate: true, env: {} })).ok, false, "confirming does not override GitHub");
  const noGh = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
  assert.match((await checkPrivate(onGitHub, { runGh: noGh, env: {} })).why, /gh is not installed/);
  assert.equal((await checkPrivate(onGitHub, { runGh: noGh, confirmPrivate: true, env: {} })).ok, true);
  assert.equal((await checkPrivate(onGitHub, { runGh: gh("PRIVATE"), env: { ROOMS_NO_GH: "1" } })).ok, false, "not asked with the question off");
  assert.equal((await checkPrivate({ host: "gitlab.com", path: "g/t" }, { env: {} })).ok, false);
  assert.equal((await checkPrivate(null, { confirmPrivate: true, env: {} })).ok, true);
});

test("sync needs the member's GitHub login, since the file is filed under it", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await rm(join(alice.home, "identity.json"));
    const refused = await alice.rooms(alice.web, "team", "sync", "--yes");
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /rooms auth github/);
    assert.equal(await git(join(dir, "team.git"), "rev-list", "--count", "main"), "1");
  });
});

test("the team board uses the project board's design tokens, so the two cannot drift apart", async () => {
  const tokens = (html) => html.slice(html.indexOf(":root {"), html.indexOf("body {"));
  const board = await readFile(join(root, "templates", "board.html"), "utf8");
  const team = await readFile(join(root, "templates", "team.html"), "utf8");
  assert.ok(tokens(board).length > 500);
  assert.equal(tokens(team), tokens(board));
});
