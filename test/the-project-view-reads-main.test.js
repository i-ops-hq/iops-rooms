// On any branch but the default one, the view of the whole project, `rooms week`, `rooms badge` and
// the board, reads the default branch's history where it stands, and never moves the checkout. It
// says so, and says what the checkout's own branch adds. The project is named as every clone of it
// names it, `owner/repo` on a hosted remote; and the board says how a teammate joins, apart from how
// your own other machines do.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { scratch as teamScratch, teamOfTwo } from "./team-helpers.js";

const exec = promisify(execFile);
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const CLAUDE = "\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-main-view-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ROOMS_NO_OPEN: "1" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

const git = (dir, ...args) => exec("git", [...IDENT, ...args], { cwd: dir }).then((r) => r.stdout.trim());

async function commit(dir, file, message) {
  await mkdir(join(dir, file, ".."), { recursive: true });
  await writeFile(join(dir, file), `${file} ${Math.random()}\n`, "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
}

/** main: one plain commit and one Claude commit; feature/x: one of each again, checked out. */
async function branchedRepo(dir) {
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await commit(dir, "m1.txt", "m1");
  await commit(dir, "m2.txt", `m2${CLAUDE}`);
  await git(dir, "switch", "-q", "-c", "feature/x");
  await commit(dir, "f1.txt", `f1${CLAUDE}`);
  await commit(dir, "f2.txt", "f2");
}

/** main: one plain commit and one Claude commit (50%); feature/x: two Claude commits, so 75% with it. */
async function claudeBranchRepo(dir) {
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await commit(dir, "m1.txt", "m1");
  await commit(dir, "m2.txt", `m2${CLAUDE}`);
  await git(dir, "switch", "-q", "-c", "feature/x");
  await commit(dir, "f1.txt", `f1${CLAUDE}`);
  await commit(dir, "f2.txt", `f2${CLAUDE}`);
}

const SENTENCE = /This checkout is on feature\/x: 2 commits not in main yet \(Claude 1, no agent\s+recorded 1\)\. rooms branch shows them\./;

test("rooms week on a branch reads main, says so, adds what the branch has, and leaves the checkout alone", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await branchedRepo(web);
    await writeFile(join(web, "draft.txt"), "not committed\n");
    const status = await git(web, "status", "--porcelain");

    const r = await run(web, ["week"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\nweb · main · last 7d\n2 commits · /, "main's two commits, not the branch's four");
    assert.match(r.out, SENTENCE);
    assert.equal(await git(web, "branch", "--show-current"), "feature/x", "the checkout stays on its branch");
    assert.equal(await git(web, "status", "--porcelain"), status, "and its uncommitted work is untouched");

    await git(web, "stash", "-q", "-u");
    await git(web, "switch", "-q", "main");
    const onMain = await run(web, ["week"]);
    assert.match(onMain.out, /\nweb · last 7d\n2 commits · /, "on main, the header is as it was");
    assert.doesNotMatch(onMain.out, /This checkout is on/);
  });
});

test("it reads origin's copy of main, which fetch keeps current, over a local main nobody pulled", async () => {
  await scratch(async (dir) => {
    const origin = join(dir, "origin.git");
    const mine = join(dir, "mine");
    const theirs = join(dir, "theirs");
    await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
    await exec("git", ["clone", "-q", origin, mine]);
    await commit(mine, "a.txt", "a");
    await git(mine, "push", "-q", "-u", "origin", "main");
    await exec("git", ["clone", "-q", origin, theirs]);
    await commit(theirs, "b.txt", `b${CLAUDE}`);
    await commit(theirs, "c.txt", `c${CLAUDE}`);
    await git(theirs, "push", "-q", "origin", "main");
    await git(mine, "fetch", "-q");
    await git(mine, "switch", "-q", "-c", "feature/y");
    await commit(mine, "d.txt", "d");

    const r = await run(mine, ["week", "--json"]);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.commits.seen, 3, "origin/main's three commits; the local main has one");
    assert.equal(j.history.ref, "origin/main");
    assert.equal(j.history.branch, "main");
    assert.equal(j.history.checkout.branch, "feature/y");
    assert.equal(j.history.checkout.commits, 1);
    assert.equal(j.project, "origin", "a folder remote names the project after itself");
  });
});

test("--json says which history it read and what the branch adds, and nothing extra on main", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await branchedRepo(web);
    const j = JSON.parse((await run(web, ["week", "--json"])).out);
    assert.deepEqual(j.history, {
      branch: "main",
      ref: "main",
      checkout: {
        branch: "feature/x",
        commits: 2,
        rows: [
          { id: "claude", label: "Claude", commits: 1 },
          { id: "unrecorded", label: "no agent recorded", commits: 1 },
        ],
      },
    });
    assert.equal(j.commits.seen, 2);
    await git(web, "switch", "-q", "main");
    assert.equal(JSON.parse((await run(web, ["week", "--json"])).out).history, undefined);
  });
});

test("the badge is the project's: the same on a branch as on main", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await claudeBranchRepo(web);
    const onBranch = (await run(web, ["badge"])).out;
    await git(web, "switch", "-q", "main");
    const onMain = (await run(web, ["badge"])).out;
    assert.ok(onMain.startsWith("<svg"), onMain.slice(0, 80));
    assert.match(onMain, /50%/, "main is one Claude commit of two");
    assert.equal(onBranch, onMain, "with the branch's two it would read 75%");
  });
});

test("the board on a branch shows main's week, with the sentence rooms week ends with", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await branchedRepo(web);
    const opened = await run(web, ["open"]);
    assert.equal(opened.code, 0, opened.err);
    const html = await readFile(join(web, ".room", "board.html"), "utf8");
    const week = (html.match(/<section class="week"[\s\S]*?<\/section>/) || [""])[0];
    assert.match(week, /main · Last 7 days · 2 commits/);
    assert.match(week.replace(/\s+/g, " "), SENTENCE);
  });
});

test("the board's numbers on a branch are main's: its share of agent-assisted commits", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await claudeBranchRepo(web);
    await run(web, ["open"]);
    const text = (await readFile(join(web, ".room", "board.html"), "utf8")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(text, / 50% agent-assisted /, "main is one of two; with the branch it would read 75%");
  });
});

test("a quiet week on main says how old main's newest commit is, not the branch's", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await exec("git", ["init", "-q", "-b", "main", web]);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    for (const name of ["m1", "m2"]) {
      await writeFile(join(web, `${name}.txt`), `${name}\n`);
      await git(web, "add", "-A");
      await exec("git", [...IDENT, "commit", "-q", "-m", name], { cwd: web, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
    }
    await git(web, "switch", "-q", "-c", "feature/x");
    await commit(web, "f1.txt", "f1");
    const r = await run(web, ["week"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^web · main · last 7d\n0 commits/);
    assert.match(r.out.replace(/\s+/g, " "), /The newest commit here is 20 days old; rooms week --since 30d reads back to it\./);
  });
});

test("a project is named as every clone names it: owner/repo on a hosted remote", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await exec("git", ["init", "-q", "-b", "main", web]);
    await commit(web, "a.txt", "a");
    await git(web, "remote", "add", "origin", "git@github.com:acme/storefront.git");
    assert.match((await run(web, ["week"])).out, /\nacme\/storefront · last 7d\n/);
    assert.equal(JSON.parse((await run(web, ["week", "--json"])).out).project, "acme/storefront");
    await run(web, ["open"]);
    const html = await readFile(join(web, ".room", "board.html"), "utf8");
    assert.match(html, /<title>Rooms · acme\/storefront<\/title>/);
    assert.match(html, /<h1 class="h-display">Rooms · acme\/storefront<\/h1>/);
  });
});

test("the board says how a teammate joins, apart from how your own other machines do", async () => {
  await scratch(async (dir) => {
    const web = join(dir, "web");
    await exec("git", ["init", "-q", "-b", "main", web]);
    await commit(web, "a.txt", "a");
    await run(web, ["open"]);
    const html = await readFile(join(web, ".room", "board.html"), "utf8");
    const code = JSON.parse(await readFile(join(web, ".room", "room.json"), "utf8")).id;
    const join_ = (html.match(/<p class="lead lead-join">([\s\S]*?)<\/p>/) || ["", ""])[1].replace(/<[^>]+>/g, "");
    assert.match(join_, /^Teammates: rooms team join &lt;owner\/repo&gt;, through a private repository your team owns, made once with rooms team init\./);
    assert.match(join_, new RegExp(`Your other machines: rooms join ${code} opens this room there\\.$`));
    assert.doesNotMatch(html, /sync among your devices only/, "a room code shares nothing by itself");
  });
  await teamScratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await alice.rooms(alice.web, "open");
    const html = await readFile(join(alice.web, ".room", "board.html"), "utf8");
    assert.match(html.replace(/<[^>]+>/g, ""), /Teammates: rooms team join \S+, in their clone of this project\./);
  });
});
