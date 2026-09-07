import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { writeBoard, buildTimelineModel, normalizeTool } from "../src/board.js";

test("normalizeTool maps common agent stamps lightly", () => {
  assert.equal(normalizeTool("cli"), "cli");
  assert.equal(normalizeTool("Cursor"), "cursor");
  assert.equal(normalizeTool("claude-code"), "claude");
  assert.equal(normalizeTool("codex"), "codex");
  assert.equal(normalizeTool("mcp-server"), "mcp");
  assert.equal(normalizeTool("git-hook"), "git-hook");
});

test("buildTimelineModel places actors on branch lanes with initials", () => {
  const events = [
    {
      type: "note",
      actor: "Ada Lovelace",
      tool: "cursor",
      branch: "main",
      at: "2026-09-06T10:00:00.000Z",
      text: "kickoff",
    },
    {
      type: "diff",
      actor: "Tom",
      tool: "cli",
      branch: "feature/timeline",
      at: "2026-09-06T12:00:00.000Z",
      text: "share-diff",
      diff: "+hello\n",
    },
    {
      type: "note",
      actor: "Ada Lovelace",
      tool: "mcp",
      branch: "feature/timeline",
      at: "2026-09-06T13:00:00.000Z",
      text: "agent note",
    },
    { type: "system", actor: "sys", tool: "cli", text: "ignore", at: "2026-09-06T09:00:00.000Z" },
  ];
  const model = buildTimelineModel(events, {
    current: "feature/timeline",
    branches: ["main", "feature/timeline"],
    head: "abc1234",
  });
  assert.ok(model.lanes.length >= 2);
  assert.equal(model.lanes[0].name, "main");
  assert.equal(model.lanes[0].isMain, true);
  const feat = model.lanes.find((l) => l.name === "feature/timeline");
  assert.ok(feat);
  assert.equal(feat.isCurrent, true);
  const ada = feat.people.find((p) => p.actor === "Ada Lovelace");
  assert.ok(ada);
  assert.equal(ada.initials, "AL");
  assert.ok(ada.tools.includes("mcp"));
  assert.ok(ada.pct > 50);
  const tom = feat.people.find((p) => p.actor === "Tom");
  assert.ok(tom);
  assert.equal(tom.initials, "TO");
  assert.equal(tom.lastDiff, true);
});

test("board HTML includes timeline lane markers and initials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-timeline-"));
  try {
    const boardPath = join(dir, "board.html");
    const events = [
      {
        type: "note",
        actor: "Ashwinth",
        tool: "cli",
        branch: "master",
        at: "2026-09-06T10:00:00.000Z",
        text: "on master",
        deviceId: "dev-a",
      },
      {
        type: "note",
        actor: "Steve",
        tool: "claude",
        branch: "board-timeline-viz",
        at: "2026-09-06T14:00:00.000Z",
        text: "viz work",
        deviceId: "dev-b",
      },
      {
        type: "diff",
        actor: "Steve",
        tool: "cli",
        branch: "board-timeline-viz",
        at: "2026-09-06T15:00:00.000Z",
        text: "share",
        diff: "+lane\n",
        deviceId: "dev-b",
      },
    ];
    const meta = {
      id: "TMLN01",
      name: "timeline-room",
      createdAt: "2026-09-06T09:00:00.000Z",
      createdBy: "Ashwinth",
      network: "off",
    };
    process.env.ROOMS_BRANCH = "board-timeline-viz";
    await writeBoard(boardPath, meta, events, { projectDir: dir });
    const html = await readFile(boardPath, "utf8");
    assert.match(html, /data-timeline="1"/);
    assert.match(html, /class="timeline"/);
    assert.match(html, /tl-lane/);
    assert.match(html, /data-branch="master"/);
    assert.match(html, /data-branch="board-timeline-viz"/);
    assert.match(html, /class="tl-avatar"/);
    assert.match(html, />AS</); // Ashwinth initials
    assert.match(html, />ST</); // Steve initials
    assert.match(html, /Agents\/tools/);
    assert.match(html, /data-rooms-timeline/);
    // Keep existing feed + empty-banner path intact for non-empty boards
    assert.match(html, /class="event"/);
    assert.match(html, /Rooms · timeline-room/);
    // leave-open live client still injectable path — writeBoard injects if missing
    assert.match(html, /data-rooms-live/);
  } finally {
    delete process.env.ROOMS_BRANCH;
    await rm(dir, { recursive: true, force: true });
  }
});
