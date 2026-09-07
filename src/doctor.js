import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import {
  findRoomDir,
  readEvents,
  readMeta,
  roomPaths,
  actor,
  tool,
  deviceId,
} from "./store.js";
import { LIVE_DEFAULT_PORT, LIVE_HOST } from "./live.js";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function probePort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

async function checkMcpHint(cwd) {
  const candidates = [
    join(cwd, ".cursor", "mcp.json"),
    join(cwd, ".vscode", "mcp.json"),
  ];
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    try {
      const body = await readFile(path, "utf8");
      if (/rooms|iops-rooms/i.test(body)) {
        return { ok: true, path, detail: `mentions rooms / iops-rooms` };
      }
      return { ok: false, path, detail: "found but does not mention rooms" };
    } catch {
      return { ok: false, path, detail: "unreadable" };
    }
  }
  return { ok: false, path: null, detail: "no .cursor/mcp.json (or .vscode) found" };
}

async function checkSkillHint(cwd) {
  const candidates = [
    join(cwd, ".cursor", "skills", "rooms", "SKILL.md"),
    join(PKG_ROOT, "skills", "rooms", "SKILL.md"),
    join(cwd, "skills", "rooms", "SKILL.md"),
  ];
  for (const path of candidates) {
    if (await exists(path)) return { ok: true, path };
  }
  return { ok: false, path: null };
}

/**
 * Diagnose a local room. Pure module — used by CLI and MCP.
 *
 * Exit semantics (CLI):
 *   0 — healthy (initialized + at least one non-system post)
 *   1 — unhealthy hard fail (no .room/)
 *   2 — warn / empty board (room exists but nothing meaningful posted)
 */
export async function runDoctor({
  cwd = process.cwd(),
  livePort = LIVE_DEFAULT_PORT,
  liveHost = LIVE_HOST,
} = {}) {
  const checks = [];
  const nextActions = [];
  let severity = "ok"; // ok | warn | fail

  const projectDir = await findRoomDir(cwd);
  const roomOk = Boolean(projectDir);
  checks.push({
    id: "room",
    ok: roomOk,
    hard: true,
    detail: roomOk
      ? `.room/ at ${roomPaths(projectDir).root}`
      : "No .room/ in this directory (or parents). Run `rooms init`.",
  });

  if (!roomOk) {
    severity = "fail";
    nextActions.push('rooms init --name "…"');
    nextActions.push("rooms mcp install   # one-command MCP + skill into .cursor/");
    nextActions.push('rooms post "…"');
    return summarize({ checks, severity, nextActions, projectDir: null, meta: null, events: [] });
  }

  const meta = await readMeta(projectDir);
  const events = await readEvents(projectDir);
  const nonSystem = events.filter((e) => e.type !== "system");
  const empty = nonSystem.length === 0;

  checks.push({
    id: "events",
    ok: !empty,
    hard: false,
    detail: empty
      ? `${events.length} event(s) total, 0 non-system posts — board is empty because nothing was posted`
      : `${events.length} event(s) (${nonSystem.length} non-system)`,
  });

  let identityDetail = "";
  try {
    const a = await actor();
    const t = await tool();
    const d = await deviceId();
    const { authStatus } = await import("./identity.js");
    const s = await authStatus();
    const gh = s.verified
      ? `github=@${s.github.login} (verified)`
      : "github=— (unverified; optional: rooms auth github)";
    identityDetail = `actor=${a}  tool=${t}  deviceId=${d}  ${gh}`;
    checks.push({ id: "identity", ok: true, hard: false, detail: identityDetail });
  } catch (err) {
    checks.push({
      id: "identity",
      ok: false,
      hard: false,
      detail: err.message || String(err),
    });
  }

  const mcp = await checkMcpHint(projectDir);
  checks.push({
    id: "mcp",
    ok: mcp.ok,
    hard: false,
    detail: mcp.path ? `${mcp.path}: ${mcp.detail}` : mcp.detail,
  });

  const skill = await checkSkillHint(projectDir);
  checks.push({
    id: "skill",
    ok: skill.ok,
    hard: false,
    detail: skill.ok ? skill.path : "skills/rooms/SKILL.md not found in package or cwd",
  });

  const liveOk = await probePort(liveHost, Number(livePort) || LIVE_DEFAULT_PORT);
  checks.push({
    id: "live",
    ok: liveOk,
    hard: false,
    soft: true,
    detail: liveOk
      ? `${liveHost}:${livePort} reachable`
      : `${liveHost}:${livePort} not reachable (optional — run \`rooms live\` when you want the auto-updating board)`,
  });

  if (empty) {
    severity = "warn";
    if (!mcp.ok) {
      nextActions.push("rooms mcp install   # enable MCP so Cursor/Claude can post_note / share_diff");
    }
    nextActions.push('rooms post "…"');
    nextActions.push("rooms share-diff --path <file> --note \"…\"");
    nextActions.push("rooms hooks install   # opt-in local git auto-post (not IDE telemetry)");
    if (!liveOk) nextActions.push("rooms live   # optional live board on 127.0.0.1");
  } else {
    severity = "ok";
    if (!mcp.ok) {
      nextActions.push("Optional: rooms mcp install so agents post without the CLI");
    }
    if (!liveOk) {
      nextActions.push("Optional: rooms live for auto-updating board");
    }
  }

  return summarize({
    checks,
    severity,
    nextActions,
    projectDir,
    meta,
    events,
    nonSystemCount: nonSystem.length,
  });
}

function summarize({
  checks,
  severity,
  nextActions,
  projectDir,
  meta,
  events,
  nonSystemCount = 0,
}) {
  const exitCode = severity === "ok" ? 0 : severity === "warn" ? 2 : 1;
  const healthy = severity === "ok";
  return {
    ok: healthy,
    severity,
    exitCode,
    checks,
    nextActions,
    projectDir,
    meta,
    eventsCount: events?.length ?? 0,
    nonSystemCount,
    format() {
      return formatDoctorReport({
        checks,
        severity,
        nextActions,
        projectDir,
        meta,
        eventsCount: events?.length ?? 0,
        nonSystemCount,
      });
    },
  };
}

export function formatDoctorReport({
  checks,
  severity,
  nextActions,
  projectDir,
  meta,
  eventsCount,
  nonSystemCount,
}) {
  const lines = ["Rooms doctor", ""];
  if (meta) {
    lines.push(`room     ${meta.id}  ${meta.name}`);
    lines.push(`dir      ${projectDir}`);
    lines.push(`events   ${eventsCount} total · ${nonSystemCount} non-system`);
    lines.push("");
  }
  for (const c of checks) {
    let label = "OK  ";
    if (!c.ok) label = c.hard ? "FAIL" : "WARN";
    lines.push(`${label}  ${c.id.padEnd(10)} ${c.detail}`);
  }
  lines.push("");
  if (severity === "warn") {
    lines.push("Board looks empty — nothing meaningful was posted yet.");
  } else if (severity === "fail") {
    lines.push("Unhealthy — fix the FAIL items above.");
  } else {
    lines.push("Healthy — room has posts.");
  }
  if (nextActions.length) {
    lines.push("");
    lines.push("Next:");
    for (const a of nextActions) lines.push(`  · ${a}`);
  }
  lines.push("");
  return lines.join("\n");
}

export { probePort, checkMcpHint, checkSkillHint };
