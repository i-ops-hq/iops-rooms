// The fourteen commands nothing ever spawned.
//
// cli.js sat at 31.58% function coverage while the modules it calls ran 76–100%. The gap was never
// in the logic — it was in the wiring: argument parsing, flag handling, error paths and the exit
// codes a script depends on. `rename`, `live` and `hooks` had good module tests that imported their
// modules directly and never went through the CLI at all.
//
// The value here is mostly the failure paths. `auth`, `approve`, `join` and `sync-merge` had no
// test that they fail correctly on bad input, and those are the four where failing wrong is worst:
// a script that reads exit 0 from a refused join carries on.
//
// `live` is spawned with ROOMS_NO_OPEN and killed, because its success path blocks forever by
// design. `open` is spawned the same way so it does not launch a browser on a runner.

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

function run(cwd, argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: {
        ...process.env,
        ROOMS_TOOL: "test",
        ROOMS_ACTOR: "cmd-test",
        ROOMS_NO_OPEN: "1",
        ...env,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function withRoom(fn, { init = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-cmd-"));
  await new Promise((res) => spawn("git", ["init", "-q", "."], { cwd: dir }).on("close", res));
  await new Promise((res) =>
    spawn("git", ["-c", "user.email=t@t.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "s"], {
      cwd: dir,
    }).on("close", res),
  );
  try {
    if (init) await run(dir, ["init", "--name", "cmds"]);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const events = async (dir) =>
  (await readFile(join(dir, ".room", "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ---------------------------------------------------------------- failure paths first

test("every room-scoped command exits non-zero with a reason when there is no room", async () => {
  await withRoom(
    async (dir) => {
      // `open` and `live` are deliberately NOT here — they create a room rather than refusing,
      // because opening a board in a project with no room has exactly one sensible meaning.
      for (const argv of [
        ["post", "x"],
        ["status"],
        ["branches"],
        ["approve"],
        ["request-review"],
        ["export"],
        ["wait", "--timeout", "200"],
      ]) {
        const r = await run(dir, argv);
        assert.equal(r.code, 1, `${argv[0]} should exit 1 with no room, got ${r.code}`);
        assert.ok(
          (r.err + r.out).trim().length > 5,
          `${argv[0]} exited without saying why`,
        );
      }
    },
    { init: false },
  );
});

test("an unknown command exits 1 and prints the help", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["frobnicate"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown command: frobnicate/);
    assert.match(r.err, /Usage:/, "the help must come with the refusal");
  });
});

test("rename with no name is refused rather than clearing the title", async () => {
  await withRoom(async (dir) => {
    const before = JSON.parse(await readFile(join(dir, ".room", "room.json"), "utf8"));
    const r = await run(dir, ["rename"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /usage: rooms rename/);
    const after = JSON.parse(await readFile(join(dir, ".room", "room.json"), "utf8"));
    assert.equal(after.name, before.name, "a refused rename must not have changed anything");
  });
});

test("sync-merge with no bundle is refused", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["sync-merge"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /usage: rooms sync-merge/);
  });
});

test("bare auth defaults to status; an unrecognised subcommand is refused", async () => {
  await withRoom(async (dir) => {
    const home = await mkdtemp(join(tmpdir(), "iops-rooms-authbare-"));
    try {
      // `rest[0] || "status"` — bare `rooms auth` is a status read, not an error.
      const bare = await run(dir, ["auth"], { ROOMS_HOME: home });
      assert.equal(bare.code, 0, `bare auth defaults to status: ${bare.err}`);

      const bogus = await run(dir, ["auth", "frobnicate"], { ROOMS_HOME: home });
      assert.equal(bogus.code, 1, "an unrecognised subcommand must fail");
      assert.match(bogus.err, /usage: rooms auth/);
      assert.match(bogus.err, /github/);
      assert.match(bogus.err, /gitlab/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("auth status reports unlinked without needing the network", async () => {
  await withRoom(async (dir) => {
    const home = await mkdtemp(join(tmpdir(), "iops-rooms-authhome-"));
    try {
      const r = await run(dir, ["auth", "status"], { ROOMS_HOME: home });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out + r.err, /not linked|unlinked|no identity|—/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("join refuses a code that does not match the existing room", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["join", "ZZZZZZ"]);
    assert.equal(r.code, 1, "a mismatched join must not report success to a script");
    assert.ok((r.err + r.out).length > 5);
  });
});

// ---------------------------------------------------------------- success paths

test("approve and request-review write their events through the CLI", async () => {
  await withRoom(async (dir) => {
    assert.equal((await run(dir, ["request-review", "please", "look"])).code, 0);
    assert.equal((await run(dir, ["approve", "looks", "good"])).code, 0);
    const all = await events(dir);
    const asked = all.find((e) => e.type === "review_requested");
    const ok = all.find((e) => e.type === "approved");
    assert.equal(asked.text, "please look", "positional words become the note");
    assert.equal(ok.text, "looks good");
  });
});

test("branches lists the local branch and names the current one", async () => {
  await withRoom(async (dir) => {
    await run(dir, ["post", "so there is activity"]);
    const r = await run(dir, ["branches"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ma(in|ster)/, "the checked-out branch should appear");
  });
});

test("whoami reports actor, tool, device and branch", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["whoami"]);
    assert.equal(r.code, 0, r.err);
    for (const field of ["actor", "tool", "deviceId", "branch"]) {
      assert.match(r.out, new RegExp(field, "i"), `whoami omits ${field}`);
    }
    assert.match(r.out, /cmd-test/);
  });
});

test("open refreshes the board and prints its path without launching anything", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["open"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /opened .*board\.html/);
  });
});

test("export writes markdown containing the posts", async () => {
  await withRoom(async (dir) => {
    await run(dir, ["post", "a line for the export"]);
    const r = await run(dir, ["export"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /a line for the export/, "export goes to stdout");
  });
});

test("wait honours --timeout instead of blocking", async () => {
  await withRoom(async (dir) => {
    const started = Date.now();
    const r = await run(dir, ["wait", "--timeout", "300"]);
    assert.ok(Date.now() - started < 8_000, "the timeout must be respected");
    assert.match(r.out + r.err, /timeout|\[/);
  });
});

test("sync-hint prints the two commands it is about", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["sync-hint"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /export-room/);
    assert.match(r.out, /sync-merge/);
  });
});

test("scm-status degrades cleanly rather than failing the command", async () => {
  await withRoom(async (dir) => {
    const r = await run(dir, ["scm-status", "gitlab"]);
    assert.equal(r.code, 0, "an honest stub is not a command failure");
    assert.match(r.out, /gitlab/);
    assert.match(r.out, /degraded/);
  });
});

test("index scans and writes a page without touching the real home", async () => {
  await withRoom(async (dir) => {
    const home = await mkdtemp(join(tmpdir(), "iops-rooms-idxhome-"));
    try {
      // Listing is the default; writing the page is gated behind --open, as the README shows.
      // os.homedir() reads USERPROFILE on Windows and HOME elsewhere — set both, or the
      // test writes into the real home on one platform and passes for the wrong reason.
      const listed = await run(dir, ["index"], { HOME: home, USERPROFILE: home });
      assert.equal(listed.code, 0, listed.err);
      await assert.rejects(
        () => readFile(join(home, ".iops-rooms", "index.html"), "utf8"),
        "plain `index` lists without writing a page",
      );

      const r = await run(dir, ["index", "--open"], { HOME: home, USERPROFILE: home });
      assert.equal(r.code, 0, r.err);
      const page = await readFile(join(home, ".iops-rooms", "index.html"), "utf8");
      assert.ok(page.length > 100, "a page was written");
      assert.doesNotMatch(page, /\{\{/, "template fully substituted");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("live binds localhost, serves the board, and stops when killed", async () => {
  await withRoom(async (dir) => {
    await run(dir, ["post", "before live"]);
    const child = spawn(process.execPath, [cli, "live", "--port", "0"], {
      cwd: dir,
      env: { ...process.env, ROOMS_NO_OPEN: "1", ROOMS_ACTOR: "cmd-test" },
    });
    try {
      const url = await new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`no url; got: ${out}`)), 10_000);
        child.stdout.on("data", (d) => {
          out += d;
          const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
      });
      assert.match(url, /^http:\/\/127\.0\.0\.1:/, "must bind loopback, never 0.0.0.0");

      // The url is printed as soon as listen() resolves, but on Windows the first connection can
      // still be refused or reset for a moment after that. Retry briefly rather than assert on a
      // race — a flaky test that fails one run in five teaches people to re-run instead of read.
      let html = "";
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          const res = await fetch(url);
          assert.equal(res.status, 200);
          html = await res.text();
          break;
        } catch (err) {
          if (attempt === 11) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      assert.match(html, /before live/, "the served board carries the room's events");
    } finally {
      // Third time this shape has bitten: an unbounded await on a child exiting. `rooms live`
      // blocks forever by design, Windows has no real SIGTERM, and a process that does not answer
      // the polite signal leaves the test waiting rather than failing. Ask, then insist.
      child.kill();
      await new Promise((resolve) => {
        const force = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 3000);
        child.on("close", () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
  });
});

test("open creates the room when there is not one — the first run is one command", async () => {
  // Getting started used to be init, then open, then live: three commands, two of which exist only
  // because the first had not happened yet.
  await withRoom(
    async (dir) => {
      const r = await run(dir, ["open"]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /created room [A-Z0-9]{6}/, "it says what it made");
      assert.match(r.out, /opened .*board\.html/);
      await readFile(join(dir, ".room", "room.json"), "utf8");

      // Running it again must reuse the room, not make a second one.
      const again = await run(dir, ["open"]);
      assert.equal(again.code, 0);
      assert.doesNotMatch(again.out, /created room/, "the second run joins what is already there");
    },
    { init: false },
  );
});

// ---------------------------------------------------------------- the window, not a tab

test("open asks for an app window, and turns a board path into a URL for it", async () => {
  // `--app=` takes a URL and a board is a filesystem path, so the old guard — which only accepted
  // http(s) — rejected every `rooms open` and fell through to the system opener. That produced a
  // browser TAB, which is the one thing app mode exists to avoid, while `rooms live` worked because
  // it already had a URL to hand. Same flag, same session, two different windows.
  const { openPath } = await import("../src/cli.js");
  const prev = process.env.ROOMS_NO_OPEN;
  delete process.env.ROOMS_NO_OPEN;
  try {
    const calls = [];
    const launch = (bin, args) => {
      calls.push({ bin, args });
      return { unref() {} };
    };
    const r = openPath("/Users/x/proj/.room/board.html", {
      app: true,
      findBin: () => "/Applications/Some Browser",
      launch,
    });
    assert.equal(r.mode, "app");
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].args.some((a) => a === "--app=file:///Users/x/proj/.room/board.html"),
      `a file path became a file:// URL, got ${JSON.stringify(calls[0].args)}`,
    );

    // A URL is passed through untouched — `rooms live` hands it one already.
    const live = openPath("http://127.0.0.1:7840/", { app: true, findBin: () => "/b", launch });
    assert.equal(live.url, "http://127.0.0.1:7840/");

    // No app browser installed is not an error; it falls back to whatever opens files.
    const fallback = openPath("/tmp/board.html", { app: true, findBin: () => null, launch });
    assert.equal(fallback.mode, "browser");
  } finally {
    if (prev !== undefined) process.env.ROOMS_NO_OPEN = prev;
  }
});
