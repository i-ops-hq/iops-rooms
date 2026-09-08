#!/usr/bin/env node
import { spawn } from "node:child_process";
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
  renameRoom,
  readEvents,
  readMeta,
  refreshBoard,
  requireRoomDir,
  roomPaths,
  tool,
  transcriptMarkdown,
  waitForNewEvents,
} from "./store.js";
import {
  capDiff,
  readDiffFile,
  resolveSharePath,
} from "./diff-source.js";

const HELP = `Rooms by I-Ops — local shared rooms for agent sessions

Usage:
  rooms init [--name <n>] [--code <id>] [--share] [--mcp]
             (name defaults to folder / git repo when omitted)
  rooms join <code> [--name <n>]
  rooms status
  rooms doctor
  rooms rename <name>
  rooms open
  rooms live [--port 7840]        (ROOMS_NO_OPEN=1 to skip launching a browser)
  rooms branches
  rooms scm-status
  rooms sync-hint
  rooms sync-merge <bundle-dir>
  rooms post <message>
  rooms share-diff [--path <file>] [--note <text>] [--allow-outside]
  rooms request-review [note]
  rooms approve [note]
  rooms wait [--since <iso>] [--timeout 15000]
  rooms export [file.md]
  rooms export-room [dir]
  rooms import-room <dir>
  rooms whoami
  rooms index [--open]
  rooms hooks install [--force]
  rooms hooks uninstall
  rooms mcp
  rooms mcp install   # Cursor + Claude Code + Codex (project-local)
  rooms auth github
  rooms auth gitlab
  rooms auth status
  rooms auth logout
  rooms help

One .room/ per project. Other AI windows are not scanned.
Cursor/Claude Code only show up if the Rooms MCP is installed and they post.
Hooks are local opt-in only — never auto-installed; not IDE telemetry.
Auth mints a local verified GitHub/GitLab identity only — does not upload room events.
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
  // A headless box has nothing to open with, and an office VM — the deployment this is meant for —
  // often has no browser at all. `rooms live` would spawn xdg-open and get an error nobody reads.
  // ROOMS_NO_OPEN skips the launch; the caller still prints the path, which is also what makes
  // `open` and `live` testable.
  if (process.env.ROOMS_NO_OPEN) return;
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
  let truncated = false;
  if (opts.path) {
    // Refuses an escape from the project and a secret-looking name; see src/diff-source.js.
    const src = resolveSharePath(dir, opts.path, {
      allowOutside: Boolean(opts["allow-outside"]),
    });
    path = src.label;
    ({ diff, truncated } = await readDiffFile(src.absolute));
  } else if (!process.stdin.isTTY) {
    // Piped content is the caller's own choice of bytes, so it is not filtered — only capped.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    ({ diff, truncated } = capDiff(Buffer.concat(chunks).toString("utf8")));
  }
  if (!diff.trim()) throw new Error("No diff. Pass --path or pipe a patch on stdin.");
  await postNote(dir, {
    type: "diff",
    text: opts.note || "shared a diff",
    extra: { path, diff, ...(truncated ? { truncated: true } : {}) },
  });
}

async function runGithubDeviceFlow(clientId) {
  const { authGithubDeviceFlow } = await import("./identity.js");
  process.stdout.write("GitHub device flow — local identity only (no room upload).\n");
  return authGithubDeviceFlow({
    clientId,
    openUrl: (url) => openPath(url),
    onUserCode: ({ userCode, verificationUri }) => {
      process.stdout.write(`Open ${verificationUri} and enter code: ${userCode}\n`);
    },
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
    const sub = rest[0];
    if (sub === "install") {
      const { installMcp } = await import("./mcp-install.js");
      const result = await installMcp({ cwd: process.cwd() });
      const clients = result.clients || {};
      const label = (c) => {
        if (!c) return "skipped";
        if (!c.fileExisted) return "wrote";
        return c.serverCreated ? "merged" : "updated";
      };
      process.stdout.write(
        `cursor  ${label(clients.cursor)}  ${clients.cursor?.path || result.mcpPath}\n` +
          `claude  ${label(clients.claude)}  ${clients.claude?.path || ""}\n` +
          `codex   ${label(clients.codex)}  ${clients.codex?.path || ""}\n` +
          `server  ${result.serverKey}  npx -y iops-rooms@${result.version} mcp\n`,
      );
      if (result.skills?.cursor?.copied) process.stdout.write(`skill   cursor  ${result.skills.cursor.path}\n`);
      if (result.skills?.claude?.copied) process.stdout.write(`skill   claude  ${result.skills.claude.path}\n`);
      if (result.skills?.codex?.note) process.stdout.write(`skill   codex   ${result.skills.codex.note}\n`);
      process.stdout.write(
        `(${result.note})\n` +
          `Honest: Cursor → .cursor/mcp.json + .cursor/skills/; ` +
          `Claude Code → .mcp.json + .claude/skills/; ` +
          `Codex → .codex/config.toml (trusted project; no SKILL.md). Local only — see README.\n`,
      );
      return;
    }
    if (sub && sub !== "install") {
      throw new Error("usage: rooms mcp | rooms mcp install");
    }
    process.env.ROOMS_TOOL = process.env.ROOMS_TOOL || "mcp";
    await import("./mcp.js");
    return;
  }

  if (cmd === "init") {
    const { normalizeRoomNameOpt } = await import("./store.js");
    const { projectDir, meta, created } = await initRoom({
      name: normalizeRoomNameOpt(argv.name),
      code: argv.code,
      share: Boolean(argv.share),
    });
    const { board } = roomPaths(projectDir);
    process.stdout.write(
      created
        ? `created ${meta.id}  ${meta.name}\nboard   ${board}\n`
        : `already ${meta.id}  ${meta.name}\nboard   ${board}\n`,
    );
    if (argv.mcp) {
      const { installMcp } = await import("./mcp-install.js");
      const result = await installMcp({ cwd: projectDir });
      process.stdout.write(
        `mcp     cursor  ${result.clients?.cursor?.path || result.mcpPath}\n` +
          `mcp     claude  ${result.clients?.claude?.path || ""}\n` +
          `mcp     codex   ${result.clients?.codex?.path || ""} (iops-rooms@${result.version})\n`,
      );
      if (result.skills?.cursor?.copied) process.stdout.write(`skill   cursor  ${result.skills.cursor.path}\n`);
      if (result.skills?.claude?.copied) process.stdout.write(`skill   claude  ${result.skills.claude.path}\n`);
    }
    return;
  }

  if (cmd === "join") {
    const code = rest[0] || argv.code;
    const { normalizeRoomNameOpt } = await import("./store.js");
    const { projectDir, meta, created } = await joinRoom({
      code,
      name: normalizeRoomNameOpt(argv.name),
    });
    const { board } = roomPaths(projectDir);
    process.stdout.write(
      `${created ? "created" : "joined"} ${meta.id}  ${meta.name}\nboard   ${board}\n`,
    );
    return;
  }


  if (cmd === "rename") {
    const name = rest.join(" ").trim();
    if (!name) throw new Error("usage: rooms rename <name>");
    const dir = await requireRoomDir();
    const meta = await renameRoom(dir, name);
    process.stdout.write(`renamed  ${meta.id}  ${meta.name}\n`);
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
    const { authStatus } = await import("./identity.js");
    const s = await authStatus();
    const gh = s.github?.login
      ? `@${s.github.login} (verified)`
      : "— (not linked)";
    const gl = s.gitlab?.username
      ? `@${s.gitlab.username} (verified)`
      : "— (not linked)";
    process.stdout.write(
      `actor     ${a}\ntool      ${t}\ndeviceId  ${d}\nbranch    ${b || "—"}\ngithub    ${gh}\ngitlab    ${gl}\n`,
    );
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
    if (result.warnBadGithub) {
      process.stderr.write(
        `warn  ${result.warnBadGithub} event(s) claimed github login without a valid signature (imported anyway — see SECURITY.md)\n`,
      );
    }
    if (result.warnBadGitlab) {
      process.stderr.write(
        `warn  ${result.warnBadGitlab} event(s) claimed gitlab username without a valid signature (imported anyway — see SECURITY.md)\n`,
      );
    }
    return;
  }

  if (cmd === "sync-hint") {
    const { syncHint } = await import("./sync-hint.js");
    const h = syncHint();
    process.stdout.write(`${h.status}  ${h.message}\n`);
    for (const step of h.steps) process.stdout.write(`- ${step}\n`);
    return;
  }


  if (cmd === "auth") {
    const sub = rest[0] || "status";
    const {
      authGithubDeviceFlow,
      authGitlabDeviceFlow,
      authStatus,
      clearVerifiedIdentity,
      roomsHomeDir,
    } = await import("./identity.js");
    if (sub === "github") {
      const clientId = argv["client-id"] || process.env.ROOMS_GITHUB_CLIENT_ID;
      // `gh` first, because it needs nothing from anyone: the credential is already the user's,
      // no OAuth App has to exist, and nothing of ours appears in their authorised-apps list.
      // The device flow stays for machines without gh, and is used first when a client id is
      // given explicitly, since that is someone asking for it by name.
      let result;
      if (clientId && argv["device-flow"]) {
        result = await runGithubDeviceFlow(clientId);
      } else {
        try {
          const { authGithubCli } = await import("./identity.js");
          process.stdout.write("Reading your GitHub account from `gh` — local identity only.\n");
          result = await authGithubCli();
        } catch (err) {
          if (!clientId) throw err;
          process.stdout.write(`${err.message}\nFalling back to the device flow.\n`);
          result = await runGithubDeviceFlow(clientId);
        }
      }
      process.stdout.write(
        `verified github @${result.user.login}${result.via === "gh" ? "  (via gh)" : ""}\n` +
          `stored    ${roomsHomeDir()}/identity.json + device.key\n` +
          `(solo can stay unsigned; team leads opt into verified mode)\n`,
      );
      return;
    }
    if (sub === "gitlab") {
      const clientId = argv["client-id"] || process.env.ROOMS_GITLAB_CLIENT_ID;
      const host = argv.host || process.env.ROOMS_GITLAB_HOST || "https://gitlab.com";
      process.stdout.write(
        "GitLab device flow — local identity only (no room upload).\n",
      );
      const result = await authGitlabDeviceFlow({
        clientId,
        host,
        openUrl: (url) => openPath(url),
        onUserCode: ({ userCode, verificationUri }) => {
          process.stdout.write(
            `Open ${verificationUri} and enter code: ${userCode}\n`,
          );
        },
      });
      process.stdout.write(
        `verified gitlab @${result.user.username}\n` +
          `stored    ${roomsHomeDir()}/identity.json + device.key (0600)\n` +
          `(solo can stay unsigned; team leads opt into verified mode)\n`,
      );
      return;
    }
    if (sub === "status") {
      const s = await authStatus();
      process.stdout.write(
        [
          `home      ${s.home}`,
          `deviceId  ${s.deviceId}`,
          `actor     ${s.displayName}`,
          s.github?.login
            ? `github    @${s.github.login}  (verified)`
            : `github    —  (not linked)`,
          s.gitlab?.username
            ? `gitlab    @${s.gitlab.username}  (verified)`
            : `gitlab    —  (not linked)`,
          s.createdAt ? `since     ${s.createdAt}` : null,
          s.envOverride ? `note      env override → posts stamped unverified` : null,
          "",
        ]
          .filter((line) => line != null)
          .join("\n"),
      );
      return;
    }
    if (sub === "logout") {
      await clearVerifiedIdentity();
      process.stdout.write(`cleared verified identity under ${roomsHomeDir()}\n`);
      return;
    }
    throw new Error("usage: rooms auth github | rooms auth gitlab | rooms auth status | rooms auth logout");
  }

  if (cmd === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    const report = await runDoctor({
      cwd: process.cwd(),
      livePort: argv.port || undefined,
    });
    process.stdout.write(report.format());
    process.exitCode = report.exitCode;
    return;
  }

  if (cmd === "hooks") {
    const sub = rest[0] || "";
    const { installHooks, uninstallHooks } = await import("./hooks.js");
    if (sub === "install") {
      const result = await installHooks({
        cwd: process.cwd(),
        force: Boolean(argv.force),
      });
      process.stdout.write(
        `installed hooks in ${result.hooksDir}\n` +
          result.written.map((p) => `  ${p}\n`).join("") +
          `node  ${result.nodeBin}\ncli   ${result.cliPath}\n` +
          `(local opt-in only — not IDE telemetry; uninstall: rooms hooks uninstall)\n`,
      );
      return;
    }
    if (sub === "uninstall") {
      const result = await uninstallHooks({ cwd: process.cwd() });
      process.stdout.write(
        result.removed.length
          ? `removed:\n${result.removed.map((p) => `  ${p}`).join("\n")}\n`
          : "no Rooms hooks to remove\n",
      );
      return;
    }
    throw new Error("usage: rooms hooks install [--force] | rooms hooks uninstall");
  }

  if (cmd === "export-room") {
    const dir = await requireRoomDir();
    const out = rest[0] || "room-bundle";
    const dest = await exportRoomBundle(dir, out);
    process.stdout.write(`exported  ${dest}\n`);
    return;
  }

  if (cmd === "import-room") {
    const bundle = rest[0];
    if (!bundle) throw new Error("usage: rooms import-room <bundle-dir>");
    const result = await importRoomBundle(bundle, process.cwd());
    process.stdout.write(
      `imported  room ${result.meta.id}  ${result.meta.name}\nboard   ${result.projectDir}/.room/board.html\n`,
    );
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
