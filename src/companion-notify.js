/**
 * OS notifications for `rooms companion`. Best-effort; never throws to the loop.
 * macOS: osascript · Linux: notify-send if present · Windows: PowerShell balloon · else stderr.
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function notify({ title, body, run = execFileAsync, os = platform(), log = process.stderr } = {}) {
  const t = String(title || "Rooms").slice(0, 80);
  const b = String(body || "").slice(0, 200);
  try {
    if (os === "darwin") {
      await run(
        "osascript",
        ["-e", `display notification ${apple(b)} with title ${apple(t)}`],
        { timeout: 8000 },
      );
      return { ok: true, via: "osascript" };
    }
    if (os === "linux") {
      try {
        await run("notify-send", ["--app-name=Rooms", t, b], { timeout: 8000 });
        return { ok: true, via: "notify-send" };
      } catch {
        log.write(`rooms: ${t}: ${b}\n`);
        return { ok: true, via: "stderr" };
      }
    }
    if (os === "win32") {
      const ps =
        `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null;` +
        `$n=New-Object System.Windows.Forms.NotifyIcon;` +
        `$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true;` +
        `$n.ShowBalloonTip(5000,${psStr(t)},${psStr(b)},[System.Windows.Forms.ToolTipIcon]::Info);` +
        `Start-Sleep -Seconds 1; $n.Dispose()`;
      try {
        await run("powershell", ["-NoProfile", "-Command", ps], { timeout: 15000 });
        return { ok: true, via: "powershell" };
      } catch {
        log.write(`rooms: ${t}: ${b}\n`);
        return { ok: true, via: "stderr" };
      }
    }
    log.write(`rooms: ${t}: ${b}\n`);
    return { ok: true, via: "stderr" };
  } catch (e) {
    log.write(`rooms: notify failed: ${e.message || e}\n`);
    return { ok: false, why: String(e.message || e) };
  }
}

function apple(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function psStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
