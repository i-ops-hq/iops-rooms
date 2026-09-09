#!/usr/bin/env node
/**
 * Stdio MCP server. No network. Writes only under .room/.
 * Protocol: JSON-RPC 2.0, one message per line (Content-Length also accepted).
 */
import {
  initRoom,
  joinRoom,
  postNote,
  renameRoom,
  readEvents,
  requireRoomDir,
  roomPaths,
  waitForNewEvents,
} from "./store.js";
import { capDiff } from "./diff-source.js";

process.env.ROOMS_TOOL = process.env.ROOMS_TOOL || "mcp";

const TOOLS = [
  {
    name: "create_room",
    description:
      "Create a local Rooms by I-Ops room in the current project (.room/). Offline. No secrets.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short room title" },
        code: { type: "string", description: "Optional 6-character room id" },
      },
    },
  },
  {
    name: "join_room",
    description:
      "Join a local room by code. If .room/ exists, the code must match. If not, creates one with that code.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        name: { type: "string" },
      },
    },
  },
  {
    name: "rename_room",
    description: "Rename the local room display title (code stays the same).",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "New display name, e.g. Rooms" },
      },
    },
  },
  {
    name: "post_note",
    description: "Append a note to the local room transcript and refresh board.html.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
  },
  {
    name: "share_diff",
    description: "Share a unified diff or file excerpt. Does not run git. Does not upload.",
    inputSchema: {
      type: "object",
      required: ["diff"],
      properties: {
        diff: { type: "string" },
        path: { type: "string" },
        note: { type: "string" },
      },
    },
  },
  // These two write a row and nothing else.
  //
  // An agent reads these descriptions and decides what a tool DOES. "Mark the room as waiting for
  // review" and "record an approval" both read like a gate: call approve, and the write is allowed.
  // Nothing here permits anything — there is no policy, no check, no merge. Rooms answers who acted
  // and which agent signed it; whether an action is allowed is a different question with a different
  // answer, and a tool that blurs the two would let an agent believe it had cleared itself.
  {
    name: "request_review",
    description:
      "Write a 'review requested' row in this project's local log. This does not notify anyone, " +
      "block anything, or gate a write — it is a note in a file that a person may read later.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
    },
  },
  {
    name: "approve",
    description:
      "Write an 'approved' row in this project's local log. This does NOT grant permission, " +
      "authorise an action, or merge anything, and it is not a substitute for a human approving " +
      "the work. It records that an approval was claimed, nothing more.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
    },
  },
  {
    name: "read_transcript",
    description: "Read the local room events (newest last). Optional limit.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "doctor",
    description:
      "Diagnose the local room: .room/ present?, event count, identity, MCP/skill hints, live port. Explains empty boards and next actions.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Live board port to probe (default 7840)" },
      },
    },
  },
  {
    name: "wait_for_peer",
    description:
      "Wait until a new event appears after since (ISO time), or timeout_ms (default 15000).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        timeout_ms: { type: "number" },
      },
    },
  },
];

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, message) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function textResult(s) {
  return { content: [{ type: "text", text: s }] };
}

async function waitForPeer({ since, timeout_ms = 15_000 }) {
  const dir = await requireRoomDir();
  const fresh = await waitForNewEvents(dir, {
    since,
    timeoutMs: timeout_ms,
  });
  if (!fresh.length) return textResult("timeout: no new events");
  return textResult(JSON.stringify(fresh, null, 2));
}

async function callTool(name, args = {}) {
  switch (name) {
    case "create_room": {
      const { meta, created, projectDir } = await initRoom({
        name: args.name,
        code: args.code,
      });
      const { board } = roomPaths(projectDir);
      return textResult(
        JSON.stringify({ created, id: meta.id, name: meta.name, board }, null, 2),
      );
    }
    case "join_room": {
      const { meta, created, projectDir } = await joinRoom({
        name: args.name,
        code: args.code,
      });
      return textResult(
        JSON.stringify(
          {
            created,
            id: meta.id,
            name: meta.name,
            board: roomPaths(projectDir).board,
          },
          null,
          2,
        ),
      );
    }
    case "rename_room": {
      const dir = await requireRoomDir();
      const meta = await renameRoom(dir, args.name);
      return textResult(JSON.stringify({ id: meta.id, name: meta.name }, null, 2));
    }
    case "post_note": {
      const dir = await requireRoomDir();
      const ev = await postNote(dir, { text: args.text });
      return textResult(`${ev.id} noted`);
    }
    case "share_diff": {
      const dir = await requireRoomDir();
      // The agent supplies the bytes; this tool never reads a file. Only the cap applies, and it
      // is recorded rather than applied silently.
      const { diff, truncated } = capDiff(args.diff);
      await postNote(dir, {
        type: "diff",
        text: args.note || "shared a diff",
        extra: { path: args.path || "", diff, ...(truncated ? { truncated: true } : {}) },
      });
      return textResult(truncated ? "diff stored locally (truncated)" : "diff stored locally");
    }
    case "request_review": {
      const dir = await requireRoomDir();
      await postNote(dir, {
        type: "review_requested",
        text: args.note || "please review",
      });
      return textResult("recorded: review requested (a row in the log — nobody was notified)");
    }
    case "approve": {
      const dir = await requireRoomDir();
      await postNote(dir, { type: "approved", text: args.note || "approved" });
      // Not "approved" on its own: an agent that reads that back will act as though something
      // cleared it. What happened is that a row was written.
      return textResult("recorded: approved (a row in the log — this permits nothing)");
    }
    case "read_transcript": {
      const dir = await requireRoomDir();
      const events = await readEvents(dir);
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
      const slice = events.slice(-limit);
      return textResult(JSON.stringify(slice, null, 2));
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      const report = await runDoctor({
        cwd: process.cwd(),
        livePort: args.port,
      });
      return textResult(report.format());
    }
    case "wait_for_peer":
      return waitForPeer(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  const { id, method, params } = msg;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "iops-rooms", version: "0.5.1" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return ok(id, result);
    } catch (err) {
      return ok(id, {
        isError: true,
        content: [{ type: "text", text: err.message || String(err) }],
      });
    }
  }
  if (id !== undefined) return fail(id, `unsupported method: ${method}`);
  return null;
}

function send(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n${json}`);
}

let buffer = Buffer.alloc(0);

function consumeContentLength() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString("utf8");
    buffer = buffer.subarray(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    Promise.resolve(handle(msg)).then((res) => {
      if (res) send(res);
    });
  }
}

if (process.stdin.isTTY) {
  process.stderr.write("iops-rooms MCP: waiting on stdio (not a TTY client).\n");
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  consumeContentLength();
  const asText = buffer.toString("utf8");
  if (!asText.includes("Content-Length:") && asText.includes("\n")) {
    const lines = asText.split("\n");
    buffer = Buffer.from(lines.pop() || "", "utf8");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      Promise.resolve(handle(msg)).then((res) => {
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
      });
    }
  }
});

// A stdio server lives exactly as long as its client's pipe. `end` is the clean case; `close`
// covers a parent that went away without a tidy EOF, and an errored pipe is not recoverable
// either. Listening only for `end` left the process alive on platforms where a closed pipe does
// not raise it — an orphaned node process for the user, and a test that hangs rather than fails.
const stop = () => process.exit(0);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
