// `rooms team live` (T4): the team board, kept current while it is open.
//
// What must hold: a teammate's new status reaches an open board within one interval; a check that
// finds nothing new does not reload the page, it only updates when it last looked; this member's
// status is shared on its own only when sharing is on, and never otherwise; closing waits for a
// check already running; and the page is served to this machine only.

import test from "node:test";
import assert from "node:assert/strict";
import { get, request } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTeamLive } from "../src/team-live.js";
import { git, scratch, teamOfTwo } from "./team-helpers.js";

/** Every message the page's stream sends, as it arrives. */
function listen(url) {
  const messages = [];
  const req = get(`${url}stream`, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (line) messages.push({ at: Date.now(), data: JSON.parse(line.slice(6)) });
      }
    });
  });
  req.on("error", () => {});
  return { messages, close: () => req.destroy() };
}

const page = (url, host) =>
  new Promise((resolve) => {
    const req = request(url, { headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.end();
  });

async function until(condition, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await condition()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return condition();
}

const commits = (dir) => git(join(dir, "team.git"), "rev-list", "--count", "main").then(Number);

test("a teammate's new status reaches an open live board within one interval", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    const live = await startTeamLive({ id: "local/team", room: { name: "acme", path: alice.team }, everyMs: 300 });
    const stream = listen(live.url);
    try {
      assert.match((await page(live.url)).body, /Nobody has shared a status here yet/);
      await new Promise((r) => setTimeout(r, 400));
      const before = Date.now();
      const shared = await bob.rooms(bob.web, "team", "sync", "--yes");
      assert.equal(shared.code, 0, shared.err);
      assert.ok(await until(() => stream.messages.some((m) => m.at > before && m.data.reload)), "no reload after bob shared");
      const body = (await page(live.url)).body;
      assert.match(body, /<b>bob<\/b>/);
      assert.match(body, /<p class="checked" data-checked>checked /, "the page says when it last looked");
    } finally {
      stream.close();
      await live.close();
    }
  });
});

test("a check that finds nothing new updates when it last looked, and does not reload", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    const live = await startTeamLive({ id: "local/team", room: { name: "acme", path: alice.team }, everyMs: 300 });
    const stream = listen(live.url);
    try {
      assert.ok(await until(() => stream.messages.filter((m) => m.data.checked).length >= 3), "no 'checked' updates");
      assert.equal(stream.messages.filter((m) => m.data.reload).length, 0, "reloaded with nothing new");
      assert.match(stream.messages.at(-1).data.checked, /^checked .*; your status is not shared from here$/);
    } finally {
      stream.close();
      await live.close();
    }
  });
});

test("with sharing on, a change in this member's project is shared within one interval; with it off, never", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    const room = { name: "acme", path: alice.team };
    await writeFile(join(alice.web, "first.txt"), "1\n", "utf8");
    const on = await startTeamLive({ id: "local/team", room, projectDir: alice.web, login: "alice", share: true, everyMs: 300 });
    try {
      assert.ok(await until(async () => (await commits(dir)) === 2), "the first status was not shared");
      await writeFile(join(alice.web, "second.txt"), "2\n", "utf8");
      assert.ok(await until(async () => (await commits(dir)) === 3), "the change was not shared");
      const status = JSON.parse(await git(join(dir, "team.git"), "show", "main:status/alice/web.json"));
      assert.equal(status.uncommitted.untracked, 2);
    } finally {
      await on.close();
    }
    const off = await startTeamLive({ id: "local/team", room, projectDir: alice.web, login: "alice", share: false, everyMs: 300 });
    try {
      await writeFile(join(alice.web, "third.txt"), "3\n", "utf8");
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await commits(dir), 3, "nothing is pushed with sharing off");
    } finally {
      await off.close();
    }
  });
});

test("a team room that stops being private while the board is open gets no more statuses", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    let publicNow = false;
    const mayShare = async () => (publicNow ? { ok: false, why: "GitHub says acme/team is public" } : { ok: true });
    const live = await startTeamLive({ id: "local/team", room: { name: "acme", path: alice.team }, projectDir: alice.web, login: "alice", share: true, everyMs: 300, mayShare });
    try {
      assert.ok(await until(async () => (await commits(dir)) === 2), "the first status was not shared");
      publicNow = true;
      await writeFile(join(alice.web, "after.txt"), "after\n", "utf8");
      const stream = listen(live.url);
      assert.ok(await until(() => stream.messages.some((m) => /not shared: GitHub says acme\/team is public/.test(m.data.checked || ""))), "the page did not say why");
      stream.close();
      assert.equal(await commits(dir), 2, "nothing was pushed to the public room");
    } finally {
      await live.close();
    }
  });
});

test("closing waits for a check already running, so nothing is pushed after it", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    const room = { name: "acme", path: alice.team };
    const live = await startTeamLive({ id: "local/team", room, projectDir: alice.web, login: "alice", share: true, everyMs: 60_000 });
    let closing = null;
    try {
      await writeFile(join(alice.web, "late.txt"), "late\n", "utf8");
      const running = live.checkNow();
      // The check checkNow queues starts on the next microtask and then waits on git, so one await
      // later it is running, however fast the machine. Polling for it every 50 ms, as this test did,
      // missed a check that started and finished between two looks on a fast Linux runner, and the
      // next one was a minute away.
      await Promise.resolve();
      assert.equal(live.checking(), true, "the check is running when the board closes");
      closing = live.close();
      await closing;
      const after = await commits(dir);
      await running;
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(await commits(dir), after, "a push landed after close returned");
      assert.equal(after, 3, "the first check's share and the one that was running both finished first");
    } finally {
      // Closed whatever happened above: a board left open keeps the test file running, and the
      // coverage job, which then had no time limit, waited six hours for it.
      await (closing || live.close());
    }
  });
});

test("the live team board is served to this machine only", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    const live = await startTeamLive({ id: "local/team", room: { name: "acme", path: alice.team }, everyMs: 60_000 });
    try {
      assert.match(live.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.equal((await page(live.url)).status, 200);
      assert.equal((await page(live.url, `evil.example:${live.port}`)).status, 403);
    } finally {
      await live.close();
    }
  });
});

test("the interval is thirty seconds at the least, and says what it takes", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    const quick = await alice.rooms(alice.web, "team", "live", "--every", "10s");
    assert.notEqual(quick.code, 0);
    assert.match(quick.err, /thirty seconds at the least/);
    const odd = await alice.rooms(alice.web, "team", "live", "--every", "soon");
    assert.match(odd.err, /takes a time like 5m, 90s or 1h/);
  });
});
