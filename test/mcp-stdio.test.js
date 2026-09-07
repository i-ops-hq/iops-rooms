// The MCP server, driven over its real transport.
//
// Until now nothing imported src/mcp.js — 328 lines and ten tools at zero coverage, while
// mcp-install.js (which writes the config pointing at it) sat at 100%. The installer was
// immaculate and the thing it installs had never been run by a test.
//
// These spawn `node src/mcp.js` and speak JSON-RPC at it rather than importing callTool, because
// the framework between the two is where the last MCP defect lived: an error reached the agent as
// six words with the detail dropped, and that was only visible by driving the server over stdio.
// Importing the handlers would have shown a perfectly good error message and proved nothing.

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "src", "mcp.js");

/**
 * A minimal MCP client over stdio. Sends newline-delimited JSON, and parses either framing back
 * because the server answers in whichever style it was addressed in.
 */
function connect(cwd, env = {}) {
  const child = spawn(process.execPath, [server], {
    cwd,
    env: { ...process.env, ROOMS_ACTOR: "mcp-test", ROOMS_DEVICE_ID: "mcpdev", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let stdout = "";
  let stderr = "";

  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    stdout += d;
    for (;;) {
      const framed = stdout.match(/Content-Length:\s*(\d+)\r\n\r\n/i);
      if (framed) {
        const start = framed.index + framed[0].length;
        const len = Number(framed[1]);
        if (stdout.length < start + len) break;
        deliver(stdout.slice(start, start + len));
        stdout = stdout.slice(start + len);
        continue;
      }
      const nl = stdout.indexOf("\n");
      if (nl === -1) break;
      const line = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      if (line) deliver(line);
    }
  });

  function deliver(json) {
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }

  let nextId = 1;
  return {
    request(method, params) {
      const id = nextId++;
      const p = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`timeout: ${method}\nstderr: ${stderr}`));
        }, 10_000);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return p;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    call(name, args = {}) {
      return this.request("tools/call", { name, arguments: args });
    },
    get stderr() {
      return stderr;
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.on("close", r));
    },
  };
}

/** A project dir with a real git repo, since events are stamped with the branch. */
async function withProject(fn, { room = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), "iops-rooms-stdio-"));
  const project = join(base, "project");
  await mkdir(project, { recursive: true });
  await new Promise((res) => {
    const g = spawn("git", ["init", "-q", "."], { cwd: project });
    g.on("close", res);
  });
  const client = connect(project);
  try {
    await client.request("initialize", { protocolVersion: "2024-11-05" });
    client.notify("notifications/initialized");
    if (room) await client.call("create_room", { name: "stdio" });
    await fn({ project, client });
  } finally {
    await client.close();
    await rm(base, { recursive: true, force: true });
  }
}

const textOf = (res) => res.result?.content?.[0]?.text ?? "";

async function events(project) {
  const raw = await readFile(join(project, ".room", "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- protocol

test("initialize returns a handshake, and serverInfo.version matches package.json", async () => {
  await withProject(async ({ client }) => {
    const res = await client.request("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(res.result.protocolVersion, "2024-11-05");
    assert.equal(res.result.serverInfo.name, "iops-rooms");
    assert.deepEqual(res.result.capabilities, { tools: {} });

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(
      res.result.serverInfo.version,
      pkg.version,
      "serverInfo.version is hardcoded in src/mcp.js and mirrors package.json — a mirror nothing checks is one that drifts",
    );
  });
});

test("tools/list advertises every tool the server can dispatch", async () => {
  await withProject(async ({ client }) => {
    const res = await client.request("tools/list");
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "approve",
      "create_room",
      "doctor",
      "join_room",
      "post_note",
      "read_transcript",
      "rename_room",
      "request_review",
      "share_diff",
      "wait_for_peer",
    ]);
    for (const t of res.result.tools) {
      assert.ok(t.description, `${t.name} has no description for the agent to read`);
      assert.equal(t.inputSchema.type, "object", `${t.name} has no object schema`);
    }
  });
});

test("ping answers, and an unsupported method is a JSON-RPC error", async () => {
  await withProject(async ({ client }) => {
    assert.deepEqual((await client.request("ping")).result, {});
    const bad = await client.request("resources/list");
    assert.ok(bad.error, "an unsupported method must be an error, not a silent null");
    assert.match(bad.error.message, /unsupported method/);
  });
});

test("Content-Length framing is accepted, not only newline-delimited", async () => {
  const base = await mkdtemp(join(tmpdir(), "iops-rooms-framing-"));
  const child = spawn(process.execPath, [server], { cwd: base, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const out = await new Promise((resolve) => {
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("}")) resolve(buf);
      });
    });
    assert.match(out, /Content-Length:/, "a framed request must get a framed reply");
    assert.match(out, /"id":1/);
  } finally {
    child.stdin.end();
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the ten tools

test("create_room makes a real room on disk", async () => {
  await withProject(
    async ({ project, client }) => {
      const res = await client.call("create_room", { name: "made by mcp", code: "MCPRM1" });
      const payload = JSON.parse(textOf(res));
      assert.equal(payload.created, true);
      assert.equal(payload.id, "MCPRM1");
      assert.equal(payload.name, "made by mcp");

      const meta = JSON.parse(await readFile(join(project, ".room", "room.json"), "utf8"));
      assert.equal(meta.id, "MCPRM1");
      assert.ok((await events(project)).length >= 1, "creation is recorded");
    },
    { room: false },
  );
});

test("join_room matches an existing code and refuses a different one", async () => {
  await withProject(async ({ project, client }) => {
    const code = JSON.parse(
      await readFile(join(project, ".room", "room.json"), "utf8"),
    ).id;

    const ok = await client.call("join_room", { code });
    assert.notEqual(ok.result.isError, true, textOf(ok));

    const wrong = await client.call("join_room", { code: "ZZZZZZ" });
    assert.equal(wrong.result.isError, true, "joining a different code must not silently succeed");
    assert.ok(textOf(wrong).length > 10, "the agent needs a reason it can act on");
  });
});

test("rename_room changes the title and leaves the code alone", async () => {
  await withProject(async ({ project, client }) => {
    const before = JSON.parse(await readFile(join(project, ".room", "room.json"), "utf8"));
    await client.call("rename_room", { name: "Renamed By Agent" });
    const after = JSON.parse(await readFile(join(project, ".room", "room.json"), "utf8"));
    assert.equal(after.name, "Renamed By Agent");
    assert.equal(after.id, before.id, "the code is identity and must not move");
  });
});

test("post_note lands an event stamped tool=mcp", async () => {
  await withProject(async ({ project, client }) => {
    await client.call("post_note", { text: "agent working on the parser" });
    const notes = (await events(project)).filter((e) => e.type === "note");
    const mine = notes.find((e) => e.text === "agent working on the parser");
    assert.ok(mine, "the note must reach events.jsonl");
    assert.equal(mine.tool, "mcp", "this is the stamp the whole product is about");
    assert.equal(mine.actor, "mcp-test");
    assert.ok(mine.id && mine.at, "reserved fields are stamped by the store");
  });
});

test("share_diff stores the agent's bytes and never reads a file", async () => {
  await withProject(async ({ project, client }) => {
    await writeFile(join(project, "secret-decoy.txt"), "NEVER-READ-ME\n", "utf8");
    await client.call("share_diff", {
      path: "secret-decoy.txt",
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      note: "one hunk",
    });
    const [d] = (await events(project)).filter((e) => e.type === "diff");
    assert.equal(d.path, "secret-decoy.txt", "path is a label the agent supplied");
    assert.match(d.diff, /\+new/);
    assert.doesNotMatch(
      d.diff,
      /NEVER-READ-ME/,
      "the MCP tool must never open the file its path names",
    );
  });
});

test("share_diff records truncation instead of silently capping", async () => {
  await withProject(async ({ project, client }) => {
    const res = await client.call("share_diff", { diff: "z".repeat(150_000), note: "big" });
    assert.match(textOf(res), /truncated/, "the agent is told, not just the file");
    const [d] = (await events(project)).filter((e) => e.type === "diff");
    assert.equal(d.diff.length, 100_000);
    assert.equal(d.truncated, true);
  });
});

test("request_review and approve write the audit pair, using the argument the schema declares", async () => {
  await withProject(async ({ project, client }) => {
    // Both schemas declare `note`. Passing `text` here would silently fall through to the default
    // and the test would still pass while proving nothing — so assert the note actually lands.
    await client.call("request_review", { note: "does this read?" });
    await client.call("approve", { note: "looks right to me" });

    const all = await events(project);
    const asked = all.find((e) => e.type === "review_requested");
    const approved = all.find((e) => e.type === "approved");

    assert.ok(asked, `no review_requested — saw ${JSON.stringify([...new Set(all.map((e) => e.type))])}`);
    assert.equal(asked.text, "does this read?", "the declared `note` argument must reach the event");
    assert.ok(approved, "an approval must be recorded");
    assert.equal(approved.text, "looks right to me");
    assert.equal(approved.tool, "mcp");
  });
});

test("read_transcript returns events and honours limit", async () => {
  await withProject(async ({ client }) => {
    for (let i = 0; i < 4; i += 1) await client.call("post_note", { text: `note ${i}` });
    const all = JSON.parse(textOf(await client.call("read_transcript", {})));
    assert.ok(Array.isArray(all) && all.length >= 4);

    const two = JSON.parse(textOf(await client.call("read_transcript", { limit: 2 })));
    assert.equal(two.length, 2, "limit must actually limit");
    assert.equal(two[1].text, "note 3", "newest last");
  });
});

test("doctor reports on the room through the agent surface", async () => {
  await withProject(async ({ client }) => {
    await client.call("post_note", { text: "so the room is not empty" });
    const text = textOf(await client.call("doctor", {}));
    assert.ok(text.length > 20, "doctor must return a readable report");
    assert.match(text, /room|events|actor|device/i);
  });
});

test("wait_for_peer times out with a usable answer rather than hanging", async () => {
  await withProject(async ({ client }) => {
    const started = Date.now();
    const text = textOf(await client.call("wait_for_peer", { timeout_ms: 400 }));
    assert.ok(Date.now() - started < 8_000, "the timeout must be honoured");
    assert.match(text, /timeout|\[/, "either a timeout note or the fresh events as JSON");
  });
});

// ---------------------------------------------------------------- failure paths

test("an unknown tool returns a reason the agent can act on, not a flattened stub", async () => {
  await withProject(async ({ client }) => {
    const res = await client.call("no_such_tool", {});
    assert.equal(res.result.isError, true);
    const text = textOf(res);
    assert.match(text, /unknown tool: no_such_tool/);
    assert.notEqual(
      text,
      "Error executing tool no_such_tool",
      "this is the defect the CLI-level tests could not see: the framework flattening the detail",
    );
  });
});

test("a tool called with no room explains itself instead of crashing the server", async () => {
  await withProject(
    async ({ client }) => {
      const res = await client.call("post_note", { text: "before any room exists" });
      assert.equal(res.result.isError, true);
      assert.ok(textOf(res).length > 10, `expected a real message, got: ${textOf(res)}`);

      // The server must still be alive for the next call — one bad tool call is not fatal.
      const still = await client.request("ping");
      assert.deepEqual(still.result, {}, "the server survived the error");
    },
    { room: false },
  );
});
