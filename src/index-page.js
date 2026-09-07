import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { listRooms } from "./scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "templates", "index.html");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rows(rooms) {
  if (!rooms.length) {
    return `<p class="empty">No .room/ folders found under ~/Projects (and a few other roots). Init a room in a project, then run rooms index again. ChatGPT, Grok, and Claude in the browser are not watched.</p>`;
  }
  return rooms
    .map((r) => {
      return `<a class="event" href="${escapeHtml(r.boardUrl)}">
  <header>
    <span class="kind">${escapeHtml(r.id)}</span>
    <span class="actor">${escapeHtml(r.name)}</span>
    <span class="tool">${escapeHtml(r.lastTool)}</span>
    <time>${escapeHtml(r.lastAt || "")}</time>
  </header>
  <p class="body">${escapeHtml(r.events)} events · ${escapeHtml(r.projectDir)}</p>
</a>`;
    })
    .join("\n");
}

export function indexPath() {
  return join(homedir(), ".iops-rooms", "index.html");
}

export async function writeIndex(rooms) {
  let template = await readFile(TEMPLATE, "utf8");
  template = template
    .replaceAll("{{COUNT}}", String(rooms.length))
    .replaceAll("{{ROWS}}", rows(rooms));
  const out = indexPath();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, template, "utf8");
  return out;
}

export { listRooms };
