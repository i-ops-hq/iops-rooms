#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import {
  actor,
  deviceId,
  exportRoomBundle,
  importRoomBundle,
  mergeRoomBundle,
  initRoom,
  joinRoom,
  postNote,
  readEvents,
  readMeta,
  refreshBoard,
  requireRoomDir,
  roomPaths,
  tool,
  transcriptMarkdown,
  waitForNewEvents,
} from "./store.js";

const HELP = `Rooms by I-Ops — local shared rooms for agent sessions

Usage:
  rooms init [--name <n>] [--code <id>] [--share]
  rooms join <code> [--name <n>]
  rooms status
  rooms open
  rooms live [--port 7840]
  rooms branches
  rooms scm-status
  rooms sync-hint
  rooms sync-merge <bundle-dir>
  rooms post <message>
  rooms share-diff [--path <file>] [--note <text>]
  rooms request-review [note]
  rooms approve [note]
  rooms wait [--since <iso>] [--timeout 15000]
  rooms export [file.md]
  rooms export-room [dir]
  rooms import-room <dir>
  rooms whoami
  rooms index [--open]
  rooms mcp
  rooms help

One .room/ per project. Other AI windows are not scanned.
Cursor/Claude Code only show up if the Rooms MCP is installed and they post.
`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function openPath(path) {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const child =
    platform() === "win32"
      ? spawn("cmd", ["/c", "start", "", path], { detached: true, stdio: "ignore" })
      : spawn(cmd, [path], { detached: true, stdio: "ignore" });
  child.unref();
}

async function status() {
  const dir = await requireRoomDir();
  const meta = await readMeta(dir);
  const events = await readEvents(dir);
  const last = events[events.length - 1];
  const paths = roomPaths(dir);
  process.stdout.write(
    [
      `Rooms by I-Ops`,
      `name     ${meta.name}`,
      `code     ${meta.id}`,
      `events   ${events.length}`,
      `network  ${meta.network}`,
      `dir      ${paths.root}`,
      `board    ${paths.board}`,
      last ? `last     ${last.at}  ${last.actor}  ${last.type}` : `last     —`,
      "",
    ].join("\n"),
  );
}

async function exportMd(outPath) {
  const dir = await requireRoomDir();
  const meta = await readMeta(dir);
  const events = await readEvents(dir);
  const body = transcriptMarkdown(meta, events);
  if (outPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outPath, body, "utf8");
    process.stdout.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(body);
  }
}

async function shareDiff(opts) {
  const dir = await requireRoomDir();
  let diff = "";
  let path = opts.path || "";
  if (opts.path) {
    diff = await readFile(opts.path, "utf8");
  } else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    diff = Buffer.concat(chunks).toString("utf8");
  }
  if (!diff.trim()) throw new Error("No diff. Pass --path or pipe a patch on stdin.");
  await postNote(dir, {
    type: "diff",
    text: opts.note || "shared a diff",
    extra: { path, diff: diff.slice(0, 100_000) },
  });
}

async function main() {
  const argv = args(process.argv.slice(2));
  const cmd = argv._[0] || "help";
  const rest = argv._.slice(1);

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "mcp") {
    process.env.ROOMS_TOOL = process.env.ROOMS_TOOL || "mcp";
    await import("./mcp.js");
    return;
  }

  if (cmd === "init") {
    const { projectDir, meta, created } = await initRoom({
      name: argv.name,
      code: argv.code,
      share: Boolean(argv.share),
    });
    const { board } = roomPaths(projectDir);
    process.stdout.write(
      created
        ? `created ${meta.id}  ${meta.name}\nboard   ${board}\n`
        : `already ${meta.id}  ${meta.name}\nboard   ${board}\n`,
    );
    return;
  }

  if (cmd === "join") {
    const code = rest[0] || argv.code;
    const { projectDir, meta, created } = await joinRoom({
      code,
      name: argv.name,
    });
    const { board } = roomPaths(projectDir);
    process.stdout.write(
      `${created ? "created" : "joined"} ${meta.id}  ${meta.name}\nboard   ${board}\n`,
    );
    return;
  }

  if (cmd === "status") {
    await status();
    return;
  }

  if (cmd === "index") {
    const { listRooms, writeIndex } = await import("./index-page.js");
    const rooms = await listRooms();
    process.stdout.write(
      rooms.length
        ? rooms
            .map(
              (r) =>
                `${r.id}  ${r.name}  ${r.events} ev  ${r.projectDir}`,
            )
            .join("\n") + "\n"
        : "no rooms found under ~/Projects (init first)\n",
    );
    if (argv.open) {
      const path = await writeIndex(rooms);
      openPath(path);
      process.stdout.write(`opened ${path}\n`);
    }
    return;
  }


  if (cmd === "live") {
    const dir = await requireRoomDir();
    const { startLiveBoard } = await import("./live.js");
    const live = await startLiveBoard(dir, { port: argv.port });
    openPath(live.url);
    process.stdout.write(`live  ${live.url}\n(bind ${live.host} only — Ctrl+C to stop)\n`);
    await new Promise(() => {});
    return;
  }

  if (cmd === "open") {
    const dir = await requireRoomDir();
    const board = await refreshBoard(dir);
    openPath(board);
    process.stdout.write(`opened ${board}\n`);
    return;
  }

  if (cmd === "post") {
    const text = rest.join(" ") || argv.note;
    const dir = await requireRoomDir();
    const ev = await postNote(dir, { text });
    process.stdout.write(`${ev.id}  ${ev.type}\n`);
    return;
  }

  if (cmd === "share-diff") {
    await shareDiff(argv);
    process.stdout.write("shared diff\n");
    return;
  }

  if (cmd === "request-review") {
    const dir = await requireRoomDir();
    await postNote(dir, {
      type: "review_requested",
      text: rest.join(" ") || "please review",
    });
    process.stdout.write("review requested\n");
    return;
  }

  if (cmd === "approve") {
    const dir = await requireRoomDir();
    await postNote(dir, { type: "approved", text: rest.join(" ") || "approved" });
    process.stdout.write("approved\n");
    return;
  }

  if (cmd === "wait") {
    const dir = await requireRoomDir();
    const timeout = Number(argv.timeout) || 15_000;
    const fresh = await waitForNewEvents(dir, {
      since: argv.since,
      timeoutMs: timeout,
    });
    if (!fresh.length) {
      process.stdout.write("timeout: no new events\n");
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${fresh.length} new\n`);
    for (const ev of fresh) {
      process.stdout.write(`${ev.at}  ${ev.actor}  ${ev.type}  ${ev.text || ""}\n`);
    }
    return;
  }

  if (cmd === "whoami") {
    const a = await actor();
    const t = await tool();
    const d = await deviceId();
    const dir = await requireRoomDir().catch(() => process.cwd());
    const { resolveBranch } = await import("./git-info.js");
    const b = await resolveBranch(dir);
    process.stdout.write(`actor     ${a}\ntool      ${t}\ndeviceId  ${d}\nbranch    ${b || "—"}\n`);
    return;
  }

  if (cmd === "branches") {
    const dir = await requireRoomDir();
    const { readGitSnapshot } = await import("./git-info.js");
    const git = await readGitSnapshot(dir);
    const events = await readEvents(dir);
    process.stdout.write(`current  ${git.current || "—"}\n`);
    if (git.head) process.stdout.write(`head     ${git.head}\n`);
    process.stdout.write(`note     ${git.note}\n`);
    for (const name of git.branches) {
      const n = events.filter((e) => e.type !== "system" && (e.branch || "") === name).length;
      const mark = name === git.current ? "*" : " ";
      process.stdout.write(`${mark} ${name}  (${n} posts)\n`);
    }
    return;
  }

  if (cmd === "scm-status") {
    const dir = await requireRoomDir();
    const { scmStatus, formatScmStatus } = await import("./scm.js");
    const provider = argv.provider || rest[0] || "github";
    const s = await scmStatus(dir, { provider });
    process.stdout.write(formatScmStatus(s));
    return;
  }

  if (cmd === "sync-merge") {
    const bundle = rest[0];
    if (!bundle) throw new Error("usage: rooms sync-merge <bundle-dir>");
    const dir = await requireRoomDir();
    const result = await mergeRoomBundle(bundle, dir);
    process.stdout.write(`merged  +${result.added} events  (total ids ${result.total})  room ${result.meta.id}\n`);
    return;
  }

  if (cmd === "sync-hint") {
    const { syncHint } = await import("./sync-hint.js");
    const h = syncHint();
    process.stdout.write(`${h.status}  ${h.message}\n`);
    for (const step of h.steps) process.stdout.write(`- ${step}\n`);
    return;
  }

  if (cmd === "export") {
    await exportMd(rest[0]);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exitCode = 1;
});
