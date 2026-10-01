/**
 * Reading the files a setup may carry, the same way for every tool (docs/design/TEAM_SETUPS.md §7.5):
 * nothing through a link, nothing whose name says it holds secrets, nothing over a megabyte or not
 * text, and nothing that holds what looks like a secret or names a folder on the exporting machine.
 * A refused file comes back with two reasons: `refused`, for the member's own preview, which may name
 * the line; and `refusedWhy`, which may go into the team room, so it never repeats a value.
 */

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { realForm } from "./paths.js";
import { actingRefusal, frontmatter, injections, lineNaming, toolList } from "./prose.js";
import { neverRead, scanText } from "./secrets.js";

export const MAX_BYTES = 1_000_000;
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function refuse(item, detail, why) {
  return { ...item, refused: detail, refusedWhy: why };
}

export async function exists(path) {
  return lstat(path).then(() => true, () => false);
}

/**
 * The first link on the way from `root` down to `rel`, or null. Nothing is read through a link: a
 * linked folder could hold anything, from anywhere. The root itself may be one (a `~/.claude` kept in
 * a dotfiles folder is still the person's own).
 */
export async function linkOnTheWay(root, rel) {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const st = await lstat(join(root, sub)).catch(() => null);
    if (!st) return null;
    if (st.isSymbolicLink()) return sub;
  }
  return null;
}

/** Every file under `rel`, in code-unit order so every machine lists them alike; links are collected, not followed. */
export async function walk(root, rel, ext, depth, out, links) {
  let entries = [];
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const r = `${rel}/${e.name}`;
    if (e.isSymbolicLink()) links.push(r);
    else if (e.isDirectory()) {
      if (depth < 8) await walk(root, r, ext, depth + 1, out, links);
    } else if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(r);
  }
}

/** A few words on what an agent, command or skill is, for the preview. */
function proseInfo(kind, content) {
  const fm = frontmatter(content).keys;
  const parts = [];
  if (fm.model?.text) parts.push(`model ${fm.model.text}`);
  if (kind === "agent" && fm.tools) parts.push(`tools ${toolList(fm.tools).join(", ")}`);
  const allowed = toolList(fm["allowed-tools"]);
  if (allowed.length) parts.push(`runs without asking: ${allowed.join(" ")}`);
  const runs = injections(content).length;
  if (runs) parts.push(`${runs} command${runs === 1 ? "" : "s"} as it loads`);
  return parts.join(" · ");
}

/**
 * One text file as an item a member may select, or refused with why. `acts` says whether its
 * frontmatter and the commands it runs as it loads are checked too (an agent, a command, a SKILL.md).
 */
export async function readTextItem(root, rel, { tool, scope, kind, label, where, acts = false }) {
  const item = { tool, scope, kind, label, installTo: `${scope}:${rel}`, notes: [], left: [], info: "", refused: "", refusedWhy: "" };
  if (neverRead(rel)) return refuse(item, `${label} is never read: its name says it holds secrets`, "its name says it holds secrets");
  const st = await stat(join(root, rel));
  if (st.size > MAX_BYTES) return refuse(item, `${label} is larger than 1 MB`, "larger than this version exports");
  const buf = await readFile(join(root, rel));
  if (buf.subarray(0, 8000).includes(0)) return refuse(item, `${label} is not text`, "not text");
  const content = buf.toString("utf8").replace(/\r\n/g, "\n");
  const secret = scanText(content)[0];
  if (secret) return refuse(item, `${label} line ${secret.line} looks like ${secret.kind}`, "holds something that looks like a secret");
  const home = lineNaming(content, where.home) || (where.home ? lineNaming(content, realForm(where.home)) : 0);
  if (home) return refuse(item, `${label} line ${home} names a folder in your home: write it as ~/… and export again`, "names a folder on the exporting machine");
  // The project's own folder too, wherever it is: /workspace/web or /tmp/ci/web is not in the home.
  const here = where.project ? lineNaming(content, where.project) || lineNaming(content, realForm(where.project)) : 0;
  if (here) return refuse(item, `${label} line ${here} names this project's folder: write the path relative to the project and export again`, "names a folder on the exporting machine");
  if (acts) {
    const no = actingRefusal(content, where);
    if (no) return refuse(item, `${label}: ${no.detail}`, no.why);
    item.info = proseInfo(kind, content);
  }
  const executable = (process.platform !== "win32" && (st.mode & 0o111) !== 0) || content.startsWith("#!");
  return { ...item, content, bytes: buf.length, ...(executable ? { executable: true } : {}) };
}

export async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { exists: false };
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? { exists: true, data } : { exists: true, error: true };
  } catch {
    return { exists: true, error: true };
  }
}
