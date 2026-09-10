#!/usr/bin/env node
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, relative, resolve, sep } from "node:path";
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
  findRoomDir,
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

const HELP = `Rooms by I-Ops — who is doing what on this repo, and which agent did it

Usage:

Read your git history — no room, no server, no account:
  rooms week [--since 7d] [--path src/] [--not vendor,dist]
  rooms branch [<base>]        the mix for commits on this branch only
  rooms file <path>            who and which agent last touched it
  rooms badge [--out <file>]   an SVG for your README

The board and the room:
  rooms init [--name <n>] [--code <id>] [--share] [--mcp]
             (name defaults to folder / git repo when omitted)
  rooms join <code> [--name <n>]
  rooms status
  rooms doctor
  rooms rename <name>
  rooms open
  rooms live [--port N] [--tab]   own app window; --tab for a browser tab
  rooms branches
  rooms scm-status
  rooms sync-hint
  rooms sync-merge <bundle-dir>
  rooms post <message>
  rooms share-diff [--path <file>] [--note <text>] [--allow-outside]
  rooms request-review [note]   writes a row in the log; notifies nobody
  rooms approve [note]          writes a row in the log; permits nothing
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

Run any of these from anywhere inside the project — a repository is one project, so
a command typed in packages/web/src is about the whole repo, and the room lives at
its root.

Attribution comes from the Co-Authored-By trailers agents write themselves.
"no agent recorded" is not "no agent used" — Cursor and Copilot often write
no trailer, so every share is a floor, never a measurement.

One .room/ per project. Other AI windows are not scanned.
Cursor/Claude Code only show up if the Rooms MCP is installed and they post.
Hooks are local opt-in only — never auto-installed; not IDE telemetry.
Auth mints a local verified GitHub/GitLab identity only — does not upload room events.
`;

/**
 * Flags that take a value, and flags that do not.
 *
 * The parser used to need neither: any token after a flag became its value unless it started with
 * `-`. That is wrong in both directions. `rooms week --since` silently became `--since=true`, which
 * git accepts as a date it cannot parse and answers with nothing — "0 commits" for a window nobody
 * asked for. And `--since -5d` lost its value to the same rule, because a value is allowed to look
 * like a flag. Knowing which flags take values is what separates the two cases.
 */
const VALUE_FLAGS = new Set([
  "since", "path", "not", "out", "label", "port", "timeout", "name", "note",
  "code", "provider", "host", "client-id", "window-size",
]);
const BOOL_FLAGS = new Set([
  "app", "tab", "open", "force", "mcp", "share", "device-flow", "new-window", "allow-outside", "help",
]);

/**
 * argv into a flag bag, with the two silent failures made loud.
 *
 * `_bad` is fatal (a value flag with nothing after it); `_unknown` is a warning, because refusing an
 * unrecognised flag outright would break anyone who passes a flag a newer version added.
 */
function args(argv) {
  const out = { _: [], _bad: [], _unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) {
        // --since=2w — unambiguous, and the only form that can carry a value starting with "--".
        const value = a.slice(eq + 1);
        if (!value && VALUE_FLAGS.has(key)) out._bad.push(`--${key} needs a value`);
        else out[key] = value;
        if (!VALUE_FLAGS.has(key) && !BOOL_FLAGS.has(key)) out._unknown.push(`--${key}`);
        continue;
      }
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key)) {
        // A value may look like a flag (--since -5d) but never like a long one (--since --json).
        if (next === undefined || next.startsWith("--")) out._bad.push(`--${key} needs a value`);
        else {
          out[key] = next;
          i++;
        }
      } else {
        if (!BOOL_FLAGS.has(key)) out._unknown.push(`--${key}`);
        if (next && !next.startsWith("-")) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * Chromium browsers that can open a URL as its own window rather than a tab.
 * First one present wins; the order is "most likely to be installed" on each platform.
 */
const APP_BROWSERS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"],
};

function findAppBrowser() {
  for (const bin of APP_BROWSERS[platform()] || []) {
    try {
      if (statSync(bin).isFile()) return bin;
    } catch {
      /* not installed */
    }
  }
  return null;
}

/**
 * Open a path or URL.
 *
 * With `app: true` and a Chromium browser present, the board gets its OWN WINDOW — no address bar,
 * no tab strip, its own icon in the dock or taskbar, and the usual minimise/maximise/close. That is
 * what a project board should feel like; a tab among thirty others is not.
 *
 * It is deliberately not Electron. A real desktop shell would mean per-OS binaries, code signing
 * and a hundred megabytes, which would cost the thirty-second `npx` install and the zero-dependency
 * claim — the two things this package is actually good at. When no Chromium browser is found it
 * falls back to the default browser, which still works.
 *
 * ROOMS_NO_OPEN skips launching anything: headless boxes, CI, and office VMs with no browser at all.
 */
export function openPath(target, { app = false, findBin = findAppBrowser, launch = spawn } = {}) {
  if (process.env.ROOMS_NO_OPEN) return { launched: false, mode: "suppressed" };

  if (app) {
    // `--app=` takes a URL, and a board is a filesystem path. Without this the test below the
    // condition failed for every `rooms open`, so it fell through and produced a browser TAB —
    // the exact thing app mode exists to avoid — while `rooms live`, which already had a URL,
    // worked. Two commands, one flag, two different windows.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : pathToFileURL(target).href;
    const bin = findBin();
    if (bin) {
      const child = launch(
        bin,
        [`--app=${url}`, "--window-size=1280,900", "--new-window"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      return { launched: true, mode: "app", bin, url };
    }
  }

  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const child =
    platform() === "win32"
      ? spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" })
      : spawn(cmd, [target], { detached: true, stdio: "ignore" });
  child.unref();
  return { launched: true, mode: "browser" };
}

/**
 * All four git commands fail the same way — but not always for the same reason.
 *
 * The hint below is only true for the case it was written for. Once git's own failures started
 * being reported instead of swallowed, "run them inside a repository" began appearing under
 * `fatal: ambiguous argument 'nonexistent-base'`, where the reader is already in one.
 */
function failNotGit(r) {
  const note = r.note || "not a git checkout";
  const notACheckout = note === "not a git checkout";
  process.stderr.write(
    `${note}\n` +
      (notACheckout ? "These commands read git history — run them inside a repository.\n" : ""),
  );
  process.exitCode = 1;
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

/**
 * The room a command needs, created if this is the first run.
 *
 * `rooms open` used to fail with "No room in this directory. Run `rooms init`", which made getting
 * started a three-command ritual — init, then open, then live — where two of the three exist only
 * because the first one had not happened yet. Opening a board in a project that has no room yet has
 * exactly one sensible meaning, so it does that and says so.
 *
 * `rooms init` stays, for naming a room or passing --share / --mcp deliberately.
 */
async function roomDirOrCreate() {
  const existing = await findRoomDir();
  if (existing) return existing;
  const { meta, projectDir } = await initRoom({});
  process.stdout.write(`created room ${meta.id} for ${meta.name}\n`);
  return projectDir;
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

  // A flag that was accepted and then ignored is the failure this tool exists to argue against.
  if (argv._bad.length) {
    process.stderr.write(`${argv._bad.join("\n")}\n`);
    process.exitCode = 2;
    return;
  }
  if (argv._unknown.length) {
    process.stderr.write(`unknown flag ${argv._unknown.join(", ")} — ignored. \`rooms help\` lists them.\n`);
  }

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
    const dir = await roomDirOrCreate();
    const { startLiveBoard } = await import("./live.js");
    const live = await startLiveBoard(dir, { port: argv.port });
    const opened = openPath(live.url, { app: argv.app !== false && !argv.tab });
    process.stdout.write(
      `live  ${live.url}\n` +
        `${opened.mode === "app" ? "window  its own app window (--tab for a browser tab instead)\n" : ""}` +
        `(bind ${live.host} only — Ctrl+C to stop)\n`,
    );
    await new Promise(() => {});
    return;
  }

  if (cmd === "open") {
    const dir = await roomDirOrCreate();
    const board = await refreshBoard(dir);
    const opened = openPath(board, { app: argv.app !== false && !argv.tab });
    process.stdout.write(
      `opened ${board}\n` +
        (opened.mode === "app" ? "window  its own app window (--tab for a browser tab instead)\n" : ""),
    );
    // After the board, never before it. Someone who ignores this still got what they asked for.
    const { offerGithubLink } = await import("./onboard.js");
    await offerGithubLink();
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
    process.stdout.write("recorded: review requested — a row in the log. Nobody was notified.\n");
    return;
  }

  if (cmd === "approve") {
    const dir = await requireRoomDir();
    await postNote(dir, { type: "approved", text: rest.join(" ") || "approved" });
    process.stdout.write("recorded: approved — a row in the log. This permits nothing.\n");
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

  // ------------------------------------------------------------------ git, with no room needed
  //
  // None of these calls requireRoomDir() or roomDirOrCreate(). Reading who built a repo works on a
  // checkout that has never heard of this tool, and making someone create a room first would put a
  // write in front of a read.
  if (cmd === "week" || cmd === "branch" || cmd === "file" || cmd === "badge") {
    const { resolveProjectRoot } = await import("./git-info.js");
    // Run from the repository root, whichever subdirectory the command was typed in. `git log` was
    // already reading the whole history from a subdirectory, but the report was titled after the
    // folder — `api · last 7d` for a repo called something else entirely.
    const here = process.cwd();
    const dir = await resolveProjectRoot(here);
    const { buildReport, formatWeek, formatBranch, formatFile, renderBadgeSvg, defaultBase } =
      await import("./report.js");
    // A pathspec the user typed is relative to where they typed it, so it is rebased onto the root
    // rather than reinterpreted there: `rooms file thing.js` inside src/api/ means that file.
    const fromHere = (p) => {
      const abs = resolve(here, String(p));
      const rel = relative(dir, abs);
      // Forward slashes: a git pathspec uses them on every platform, and `relative` hands back
      // `src\api\thing.js` on Windows. Git tolerates that for a bare path but pathspec magic —
      // which `--not` produces as `:(exclude)…` — is specified with `/`, so this is not left to
      // chance. It is also what the report prints, and a path is easier to read one way everywhere.
      return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : String(p);
    };
    const paths = argv.path ? [fromHere(argv.path)] : [];
    const exclude = argv.not
      ? String(argv.not).split(",").map((x) => x.trim()).filter(Boolean).map(fromHere)
      : [];
    const name = basename(dir);

    if (cmd === "week") {
      const since = argv.since ? String(argv.since) : "7d";
      const r = await buildReport(dir, { since, paths, exclude });
      if (!r.ok) return failNotGit(r);
      // Week over week, because "am I leaning harder on one model" is the question a weekly
      // report is actually asked. Only for the default window — a delta against an arbitrary
      // --since would be comparing this window to a window nobody chose.
      let delta = null;
      if (!argv.since) {
        const prior = await buildReport(dir, { since: "14d", paths, exclude });
        // Only when there IS a previous week. On a repo two days old every row read "+39", which
        // is arithmetically true and says nothing — a comparison against a window with no commits
        // in it is just the current number with a plus sign.
        if (prior.ok && prior.seen > r.seen) {
          const before = new Map(prior.rows.map((row) => [row.id, row.commits]));
          delta = {};
          for (const row of r.rows) {
            const priorHalf = (before.get(row.id) || 0) - row.commits;
            delta[row.id] = row.commits - priorHalf;
          }
        }
      }
      process.stdout.write(formatWeek(r, { name, window: `last ${since}`, delta }));
      return;
    }

    if (cmd === "branch") {
      const base = rest[0] || (await defaultBase(dir));
      if (!base) {
        process.stderr.write("no default branch to compare against — name one: rooms branch main\n");
        process.exitCode = 1;
        return;
      }
      const { readGitSnapshot } = await import("./git-info.js");
      const snap = await readGitSnapshot(dir);
      const head = snap.current || "HEAD";
      if (head === base) {
        process.stdout.write(`on ${base} already — rooms branch compares a branch against it\n`);
        return;
      }
      const r = await buildReport(dir, { range: `${base}..HEAD`, paths, exclude });
      if (!r.ok) return failNotGit(r);
      process.stdout.write(formatBranch(r, { branch: head, base }));
      return;
    }

    if (cmd === "file") {
      const target = rest[0] || argv.path;
      if (!target) {
        process.stderr.write("which file? rooms file src/auth.ts\n");
        process.exitCode = 1;
        return;
      }
      const r = await buildReport(dir, { paths: [fromHere(target)], exclude, since: argv.since || "" });
      if (!r.ok) return failNotGit(r);
      if (!r.seen) {
        process.stdout.write(`no commits touch ${target} in this window\n`);
        return;
      }
      process.stdout.write(
        formatFile(r, { path: fromHere(target), window: argv.since ? `last ${argv.since}` : "" }),
      );
      return;
    }

    // badge
    const r = await buildReport(dir, { since: argv.since ? String(argv.since) : "", paths, exclude });
    if (!r.ok) return failNotGit(r);
    const svg = renderBadgeSvg(r, { label: argv.label ? String(argv.label) : "agents" });
    const out = argv.out ? String(argv.out) : "";
    if (!out) {
      process.stdout.write(svg);
      return;
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, svg, "utf8");
    process.stdout.write(`wrote ${out}\n  ![agents](${out})\n`);
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
