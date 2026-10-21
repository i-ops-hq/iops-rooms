// Dashboard projections (D7): local + team JSON floors for rooms dash.

import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { hostIsLocal } from "../src/live.js";
import { DASH_DEFAULT_PORT, startDash } from "../src/dash.js";
import { buildLocalProjection, buildTeamProjection } from "../src/dash-projection.js";
import { appendActivity } from "../src/activity.js";
import { initRoom } from "../src/store.js";
import { scratch, teamOfTwo, git } from "./team-helpers.js";

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), "iops-rooms-dash-"));
  await new Promise((res) => spawn("git", ["init", "-q", "-b", "main", dir]).on("close", res));
  await new Promise((res) =>
    spawn("git", ["-c", "user.email=t@t.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "s"], {
      cwd: dir,
    }).on("close", res),
  );
  try {
    await initRoom({ cwd: dir, name: "dash" });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildLocalProjection counts sessions and packages without inventing work", async () => {
  await withProject(async (dir) => {
    await appendActivity(dir, {
      kind: "session",
      agent: "claude",
      session: "aaaaaaaaaaaa",
      source: "test",
      phase: "start",
      model: "x",
    });
    await appendActivity(dir, {
      kind: "edit",
      agent: "claude",
      session: "aaaaaaaaaaaa",
      source: "test",
      via: "Edit",
      path: "src/a.js",
      checkout: "bbbbbbbbbbbb",
    });
    await appendActivity(dir, {
      kind: "package",
      action: "seen",
      name: "lodash",
      version: "4.17.21",
      manager: "npm",
      source: "lockfile",
    });
    const p = await buildLocalProjection(dir);
    assert.equal(p.kind, "dash_local");
    assert.ok(p.agents7d.claude);
    assert.equal(p.agents7d.claude.sessions, 1);
    assert.equal(p.packages[0].name, "lodash");
    assert.equal(p.sessions[0].filesEdited, 1);
    assert.deepEqual(p.sessions[0].paths, ["src/a.js"]);
  });
});

test("dash serves JSON on localhost and refuses a foreign Host", async () => {
  await withProject(async (dir) => {
    const dash = await startDash(dir, { port: 0 });
    try {
      assert.equal(DASH_DEFAULT_PORT, 7841);
      assert.equal(hostIsLocal(`evil.example.com:${dash.port}`, dash.port), false);

      const body = await new Promise((resolve, reject) => {
        const r = request(
          {
            host: "127.0.0.1",
            port: dash.port,
            path: "/api/local.json",
            headers: { Host: `evil.example.com:${dash.port}` },
          },
          (res2) => {
            let d = "";
            res2.on("data", (c) => (d += c));
            res2.on("end", () => resolve({ status: res2.statusCode, d }));
          },
        );
        r.on("error", reject);
        r.end();
      });
      assert.equal(body.status, 403);
      assert.match(body.d, /localhost only/);

      const ok = await new Promise((resolve, reject) => {
        const r = request(
          {
            host: "127.0.0.1",
            port: dash.port,
            path: "/api/local.json",
            headers: { Host: `127.0.0.1:${dash.port}` },
          },
          (res2) => {
            let d = "";
            res2.on("data", (c) => (d += c));
            res2.on("end", () => resolve(JSON.parse(d)));
          },
        );
        r.on("error", reject);
        r.end();
      });
      assert.equal(ok.kind, "dash_local");
    } finally {
      await dash.close();
    }
  });
});

test("team projection marks linked after join", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await alice.rooms(alice.web, "team", "sync", "--yes");
    const prev = process.env.ROOMS_HOME;
    process.env.ROOMS_HOME = alice.home;
    try {
      const team = await buildTeamProjection(alice.web);
      assert.equal(team.linked, true);
      assert.ok(team.statuses >= 1);
      assert.ok(team.packages?.totals);
      assert.ok(team.coverage?.totals);
      assert.equal(typeof team.catalog?.count, "number");
      assert.doesNotMatch(JSON.stringify(team.catalog), /files\/|CLAUDE\.md|# /);
    } finally {
      if (prev === undefined) delete process.env.ROOMS_HOME;
      else process.env.ROOMS_HOME = prev;
    }
    assert.ok(await git(join(dir, "team.git"), "rev-parse", "HEAD"));
  });
});

/** GET a path from a running dash, as the browser would. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    });
    r.on("error", reject);
    r.end();
  });
}

test("a team room that could not be fetched reads as stale on the dash, as the CLI says it", async () => {
  await scratch(async (dir) => {
    const { alice } = await teamOfTwo(dir);
    await alice.rooms(alice.web, "team", "sync", "--yes");
    const prev = process.env.ROOMS_HOME;
    process.env.ROOMS_HOME = alice.home;
    try {
      const fresh = await buildTeamProjection(alice.web);
      assert.equal(fresh.pullOk, true);
      assert.equal(fresh.pullWhy, undefined);
      assert.equal((await buildTeamProjection(alice.web, { pull: false })).pullOk, undefined, "no pull asked, nothing claimed");

      // A healthy team room says nothing stale, however many panels read its one clone.
      const healthy = await startDash(alice.web, { port: 0 });
      try {
        for (let i = 0; i < 3; i++) assert.doesNotMatch(await get(healthy.port, "/"), /class="stale"/);
      } finally {
        await healthy.close();
      }

      await git(alice.team, "remote", "set-url", "origin", join(dir, "gone.git"));
      const stale = await buildTeamProjection(alice.web);
      assert.equal(stale.pullOk, false);
      assert.ok(stale.pullWhy, "with git's reason");
      assert.doesNotMatch(stale.pullWhy, /\n|\.$/, "its first line, without git's full stop");
      assert.ok(stale.statuses >= 1, "and what this machine last fetched is still shown");

      const dash = await startDash(alice.web, { port: 0 });
      try {
        const team = JSON.parse(await get(dash.port, "/api/team.json"));
        assert.equal(team.pullOk, false);
        const inbox = JSON.parse(await get(dash.port, "/api/inbox.json"));
        assert.equal(inbox.pullOk, false, "the inbox reads the same clone");
        assert.ok(inbox.pullWhy);
        const html = await get(dash.port, "/");
        const stale = html.match(/<p class="stale">Team room not updated: [^<]+\. Showing what this machine last fetched\.<\/p>/g) || [];
        assert.equal(stale.length, 2, "said on the team panel and on the inbox");
      } finally {
        await dash.close();
      }
    } finally {
      if (prev === undefined) delete process.env.ROOMS_HOME;
      else process.env.ROOMS_HOME = prev;
    }
  });
});
