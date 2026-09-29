// What a first run says when it has little to go on, reproduced on a clean profile with Claude Code
// CLI sessions only (docs/design/first-run-probe): a quiet week with no way on, `doctor` over MCP
// warning that MCP was missing, help text that tied attribution to MCP, a SECURITY.md that said
// nothing was written outside .room/, and `rooms week` in a German locale printing git's German
// failure where it meant "not a git checkout".

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");
const IDENT = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const DAY = 86_400_000;

async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-first-run-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A repository whose commits were all made `daysAgo` days back. */
async function repoFrom(dir, daysAgo) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const when = new Date(Date.now() - daysAgo * DAY).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  for (const n of [1, 2]) {
    await writeFile(join(dir, `a${n}.txt`), `${n}\n`, "utf8");
    await exec("git", [...IDENT, "add", "-A"], { cwd: dir, env });
    await exec("git", [...IDENT, "commit", "-q", "-m", `change ${n}`], { cwd: dir, env });
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

test("a quiet week says how old the newest commit is, and the window it names reaches it", async () => {
  await scratch(async (dir) => {
    // 9.5 days rather than 10, so the count cannot tip from 10 to 11 while the test runs.
    await repoFrom(dir, 9.5);
    const week = await run(dir, ["week"]);
    assert.equal(week.code, 0, week.err);
    assert.match(week.out, /no commits in this window/);
    // Whitespace collapsed, because the sentence is wrapped to the terminal's width.
    assert.match(
      week.out.replace(/\s+/g, " "),
      /The newest commit here is 10 days old; rooms week --since 14d reads back to it\./,
    );

    // The advice has to work, or it is one more wrong sentence.
    const reached = await run(dir, ["week", "--since", "14d"]);
    assert.match(reached.out, /2 commits/);
    assert.doesNotMatch(reached.out, /The newest commit here is/, "nothing to point at once it is in the window");

    const json = JSON.parse((await run(dir, ["week", "--json"])).out);
    assert.doesNotMatch(JSON.stringify(json), /newest commit here/, "--json is unchanged");
  });
});

test("an empty repository has no newest commit to point at", async () => {
  await scratch(async (dir) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const week = await run(dir, ["week"]);
    assert.equal(week.code, 0, week.err);
    assert.doesNotMatch(week.out, /The newest commit here/);
  });
});

test("doctor asked over MCP does not report MCP as missing", async () => {
  await scratch(async (dir) => {
    await repoFrom(dir, 1);
    await run(dir, ["init"]);
    // A server registered with `claude mcp add` leaves no project file, which is this repository.
    const text = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [cli, "mcp"], { cwd: dir, env: { ...process.env, ROOMS_NO_OPEN: "1" } });
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        for (const line of buf.split("\n").slice(0, -1)) {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            child.stdin.end();
            done(msg.result?.content?.[0]?.text || "");
          }
        }
        buf = buf.slice(buf.lastIndexOf("\n") + 1);
      });
      child.on("error", fail);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "doctor", arguments: {} } })}\n`);
    });
    assert.match(text, /OK\s+mcp\s+this check came over MCP/);
    assert.doesNotMatch(text, /WARN\s+mcp/);

    // The CLI, which cannot know, still looks for the files.
    const cliDoctor = await run(dir, ["doctor"]);
    assert.match(cliDoctor.out, /WARN\s+mcp\s+no \.cursor\/mcp\.json/);
  });
});

test("help says attribution needs nothing installed, and only room posts need MCP", async () => {
  const help = await run(root, ["help"]);
  assert.match(help.out, /The attribution above needs nothing installed/);
  assert.doesNotMatch(help.out, /only show up if the Rooms MCP is installed/);
});

test("the first rooms open writes .gitignore and nothing else outside .room/, and SECURITY.md says so", async () => {
  await scratch(async (dir) => {
    await repoFrom(dir, 1);
    const opened = await run(dir, ["open"]);
    assert.equal(opened.code, 0, opened.err);
    const { stdout } = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir });
    const outside = stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((p) => p && !p.startsWith(".room/"));
    assert.deepEqual(outside, [".gitignore"]);
    const security = await readFile(join(root, "SECURITY.md"), "utf8");
    assert.match(security, /Append `\.room\/` to the project's `\.gitignore`/);
  });
});

test("rooms week outside a repository is recognised in any locale", async (t) => {
  await scratch(async (dir) => {
    const german = { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", LANGUAGE: "de" };
    const said = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, env: { ...process.env, ...german } })
      .then(() => "", (err) => String(err.stderr || ""));
    if (!said || /not a git repository/i.test(said)) {
      t.skip("git here has no German translation, so a translated message cannot be produced");
      return;
    }
    const week = await run(dir, ["week"], german);
    assert.equal(week.code, 1);
    assert.match(week.err, /not a git checkout/);
    assert.match(week.err, /run them inside a repository/, "and the hint that is only true here");
  });
});
