import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_KEY = "iops-rooms";
const PINNED_VERSION = "0.3.1";

async function exists(path) { try { await access(path, constants.F_OK); return true; } catch { return false; } }

export async function resolvePinnedVersion() { try { const pkg = JSON.parse(await readFile(join(PKG_ROOT, "package.json"), "utf8")); if (pkg?.version) return String(pkg.version); } catch {} return PINNED_VERSION; }

export function mcpServerEntry(version = PINNED_VERSION) { return { command: "npx", args: ["-y", "iops-rooms@" + version, "mcp"] }; }

export function mergeMcpConfig(existing, entry, { serverKey = SERVER_KEY } = {}) { const base = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {}; if (!base.mcpServers || typeof base.mcpServers !== "object" || Array.isArray(base.mcpServers)) base.mcpServers = {}; const had = Object.prototype.hasOwnProperty.call(base.mcpServers, serverKey); base.mcpServers[serverKey] = entry; return { config: base, created: !had, updated: true }; }

function tomlQuote(s) {
  return "\"" + String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
}

export function codexMcpTomlBlock(entry, { serverKey = SERVER_KEY } = {}) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  const lines = [
    "[mcp_servers." + serverKey + "]",
    "command = " + tomlQuote(entry?.command || "npx"),
    "args = [" + args.map(tomlQuote).join(", ") + "]",
  ];
  return lines.join("\n") + "\n";
}

export function mergeCodexConfigToml(existingText, entry, { serverKey = SERVER_KEY } = {}) {
  const block = codexMcpTomlBlock(entry, { serverKey });
  const raw = existingText == null ? "" : String(existingText);
  const header = "[mcp_servers." + serverKey + "]";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let removed = false;
  while (i < lines.length) {
    if (lines[i].trim() === header) {
      removed = true;
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i += 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  const body = out.join("\n");
  const merged = body ? body + "\n\n" + block : block;
  return { text: merged.endsWith("\n") ? merged : merged + "\n", created: !removed, updated: true };
}

async function writeJsonMcpFile(mcpPath, entry, { serverKey = SERVER_KEY } = {}) {
  await mkdir(dirname(mcpPath), { recursive: true });
  let existing = null;
  let fileExisted = false;
  if (await exists(mcpPath)) {
    fileExisted = true;
    const raw = await readFile(mcpPath, "utf8");
    try { existing = JSON.parse(raw); }
    catch (err) { throw new Error(mcpPath + " exists but is not valid JSON (" + err.message + "). Fix or remove it, then re-run."); }
  }
  const { config, created } = mergeMcpConfig(existing, entry, { serverKey });
  await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { path: mcpPath, fileExisted, serverCreated: created };
}

async function writeCodexToml(tomlPath, entry, { serverKey = SERVER_KEY } = {}) {
  await mkdir(dirname(tomlPath), { recursive: true });
  let existingText = "";
  let fileExisted = false;
  if (await exists(tomlPath)) { fileExisted = true; existingText = await readFile(tomlPath, "utf8"); }
  const { text, created } = mergeCodexConfigToml(existingText, entry, { serverKey });
  await writeFile(tomlPath, text, "utf8");
  return { path: tomlPath, fileExisted, serverCreated: created };
}

async function copySkillTo(destDir) {
  const source = join(PKG_ROOT, "skills", "rooms", "SKILL.md");
  const dest = join(destDir, "SKILL.md");
  if (!(await exists(source))) return { copied: false, path: null, source, note: "package skill missing at " + source };
  await mkdir(destDir, { recursive: true });
  await copyFile(source, dest);
  return { copied: true, path: dest, source };
}

export async function installMcp({ cwd = process.cwd(), version, serverKey = SERVER_KEY, copySkill = true } = {}) {
  const ver = version || (await resolvePinnedVersion());
  const entry = mcpServerEntry(ver);
  const cursor = await writeJsonMcpFile(join(cwd, ".cursor", "mcp.json"), entry, { serverKey });
  const claude = await writeJsonMcpFile(join(cwd, ".mcp.json"), entry, { serverKey });
  const codex = await writeCodexToml(join(cwd, ".codex", "config.toml"), entry, { serverKey });
  const skills = {
    cursor: { copied: false, path: null },
    claude: { copied: false, path: null },
    codex: { copied: false, path: null, note: "Codex has no SKILL.md layout — use MCP tools (post_note / share_diff / …)." },
  };
  if (copySkill) {
    skills.cursor = await copySkillTo(join(cwd, ".cursor", "skills", "rooms"));
    skills.claude = await copySkillTo(join(cwd, ".claude", "skills", "rooms"));
  }
  const skill = skills.cursor.copied ? skills.cursor : skills.claude.copied ? skills.claude : { copied: false, path: null, note: skills.cursor.note || skills.claude.note };
  return {
    mcpPath: cursor.path,
    clients: {
      cursor: { ...cursor, skill: skills.cursor },
      claude: { ...claude, skill: skills.claude },
      codex: { ...codex, skill: skills.codex },
    },
    skills,
    serverKey,
    version: ver,
    entry,
    fileExisted: cursor.fileExisted,
    serverCreated: cursor.serverCreated,
    skill,
    note: "Reload MCP in each host (Cursor / Claude Code / Codex). Logs stay local in .room/ — nothing was uploaded.",
  };
}

export { PKG_ROOT, SERVER_KEY, PINNED_VERSION };
