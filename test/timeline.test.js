import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { writeBoard, buildTimelineModel, normalizeTool, toolLabel, toolIconSvg, TOOL_IDS } from "../src/board.js";

test("normalizeTool maps common agent stamps lightly", () => {
  assert.equal(normalizeTool("cli"), "cli");
  assert.equal(normalizeTool("Cursor"), "cursor");
  assert.equal(normalizeTool("claude-code"), "claude");
  assert.equal(normalizeTool("codex"), "codex");
  assert.equal(normalizeTool("mcp-server"), "mcp");
  assert.equal(normalizeTool("git-hook"), "git-hook");
  assert.equal(normalizeTool("mystery-bot"), "unknown");
  assert.equal(toolLabel("claude-code"), "Claude Code");
  assert.equal(toolLabel("unknown"), "unknown");
  for (const id of TOOL_IDS) {
    const svg = toolIconSvg(id);
    assert.match(svg, /<svg /);
    assert.doesNotMatch(svg, /cdn\.|jsdelivr|unpkg|googleapis/i);
  }
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
  assert.equal(tom.diffCount, 1);
  assert.equal(tom.postCount, 0);
  assert.equal(ada.postCount, 1);
  assert.equal(ada.diffCount, 0);
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
    assert.doesNotMatch(html, /class="tl-avatar"[^>]*\stitle=/);
    assert.match(html, />AS</); // Ashwinth initials
    assert.match(html, />ST</); // Steve initials
    assert.match(html, /data-rooms-timeline/);
    assert.match(html, /agents-strip/);
    assert.match(html, /agent-chip/);
    assert.match(html, /data-tool="cli"/);
    assert.match(html, /data-tool="claude"/);
    assert.match(html, /data-posts=/);
    assert.match(html, /data-diffs=/);
    assert.match(html, /tl-tip-icons/);
    assert.match(html, /From \.room\/events\.jsonl — not live IDE/);
    assert.doesNotMatch(html, /cdn\.|jsdelivr|unpkg|googleapis/i);
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

test("timeline tip carries post/diff counts and keeps verify quiet by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-icons-"));
  try {
    const boardPath = join(dir, "board.html");
    const events = [
      {
        type: "note",
        actor: "Steve",
        tool: "Cursor",
        branch: "agent-icons-hover",
        at: "2026-09-06T10:00:00.000Z",
        text: "icons",
      },
      {
        type: "diff",
        actor: "Steve",
        tool: "mcp",
        branch: "agent-icons-hover",
        at: "2026-09-06T11:00:00.000Z",
        text: "share",
        diff: "+icon\n",
      },
      {
        type: "note",
        actor: "Steve",
        tool: "weird-agent",
        branch: "agent-icons-hover",
        at: "2026-09-06T12:00:00.000Z",
        text: "fallback",
      },
    ];
    await writeBoard(
      boardPath,
      {
        id: "ICONS1",
        name: "icons-room",
        createdAt: "2026-09-06T09:00:00.000Z",
        createdBy: "Steve",
        network: "off",
      },
      events,
      { projectDir: dir },
    );
    const html = await readFile(boardPath, "utf8");
    assert.match(html, /data-actor="Steve"/);
    assert.match(html, /data-tools="[^"]*cursor[^"]*"/);
    assert.match(html, /data-tools="[^"]*mcp[^"]*"/);
    assert.match(html, /data-tools="[^"]*unknown[^"]*"/);
    assert.match(html, /data-posts="2"/);
    assert.match(html, /data-diffs="1"/);
    assert.match(html, /data-tool="unknown"/);
    assert.match(html, /Claude Code|Cursor|Codex|MCP|CLI|git-hook/);
    // 3-state verify still present in CSS / script path; unsigned stays quiet
    assert.doesNotMatch(html, /class="verify-badge"[^>]*>unverified</);
    assert.doesNotMatch(html, /class="tl-avatar"[^>]*data-verify="unverified"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
