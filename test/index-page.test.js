// The multi-project surface: `rooms index` and `rooms sync-hint`. Both were at zero coverage.
//
// index-page.js carries its OWN copy of escapeHtml, separate from the one in board.js. Two copies
// of an escaping function is a mirror, and this one renders room names and project paths that come
// off other people's disks — so it gets the same injection battery the board got, rather than being
// trusted because its sibling passed.
//
// It also writes to homedir() directly rather than through roomsHomeDir(), so ROOMS_HOME does not
// redirect it and these tests move HOME instead.

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { indexPath, writeIndex } from "../src/index-page.js";
import { syncHint } from "../src/sync-hint.js";

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

const room = (over = {}) => ({
  id: "ABC123",
  name: "a project",
  lastTool: "cli",
  lastAt: "2026-09-07T12:00:00.000Z",
  events: 4,
  projectDir: "/Users/someone/Projects/thing",
  boardUrl: "file:///Users/someone/Projects/thing/.room/board.html",
  ...over,
});

test("indexPath lands under the rooms home, not the project", async () => {
  await withHome(async (home) => {
    const p = indexPath();
    assert.equal(p, join(home, ".iops-rooms", "index.html"));
  });
});

test("an empty index says why it is empty and what to do", async () => {
  await withHome(async () => {
    const out = await writeIndex([]);
    const html = await readFile(out, "utf8");
    assert.match(html, /No \.room\/ folders found/);
    assert.match(html, /rooms index again/, "an empty page must name the next action");
    assert.match(html, /not watched/, "and must not imply it sees browser chats");
    assert.doesNotMatch(html, /\{\{ROWS\}\}|\{\{COUNT\}\}/, "no unsubstituted placeholders");
  });
});

test("rooms render with their id, name, tool, count and a link to the board", async () => {
  await withHome(async () => {
    const out = await writeIndex([room()]);
    const html = await readFile(out, "utf8");
    assert.match(html, /ABC123/);
    assert.match(html, /a project/);
    assert.match(html, /4 events/);
    assert.match(html, /href="file:\/\/\/Users\/someone\/Projects\/thing\/\.room\/board\.html"/);
    assert.doesNotMatch(html, /\{\{/, "template fully substituted");
  });
});

test("the count reflects how many rooms were found", async () => {
  await withHome(async () => {
    const html = await readFile(await writeIndex([room(), room({ id: "DEF456" })]), "utf8");
    assert.match(html, /\b2\b/);
    assert.match(html, /DEF456/);
  });
});

test("markup in a room name or path is escaped, not rendered", async () => {
  await withHome(async () => {
    const out = await writeIndex([
      room({
        name: '<script>alert("index")</script>',
        projectDir: '"><img src=x onerror=alert(1)>',
        id: "<b>ID</b>",
      }),
    ]);
    const html = await readFile(out, "utf8");
    assert.doesNotMatch(html, /<script>alert\("index"\)<\/script>/, "no injected script tag");
    assert.doesNotMatch(html, /<img src=x onerror=/, "no injected handler");
    assert.match(html, /&lt;script&gt;/, "shown as text instead");
    assert.match(html, /&quot;&gt;&lt;img src=x/, "the attribute break-out is neutralised");
  });
});

test("sync-hint tells you it is dogfood and never claims a cloud", () => {
  const h = syncHint();
  assert.equal(h.status, "dogfood");
  assert.ok(Array.isArray(h.steps) && h.steps.length > 3);
  assert.match(h.message, /devices you control/);
  assert.match(h.message, /127\.0\.0\.1/, "the live board stays local and the hint should say so");
  const all = `${h.message} ${h.steps.join(" ")}`;
  assert.doesNotMatch(all, /i-ops\.dev|cloud|upload|relay/i, "no hosted-sync language");
  assert.ok(
    h.steps.some((s) => s.includes("export-room")) && h.steps.some((s) => s.includes("sync-merge")),
    "the two commands the hint is about must actually appear in it",
  );
});
