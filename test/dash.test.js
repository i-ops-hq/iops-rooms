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
