import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_KEY = "iops-rooms";
const PINNED_VERSION = "0.2.0";

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read package version; fall back to published pin. */
export async function resolvePinnedVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, "package.json"), "utf8"));
    if (pkg?.version) return String(pkg.version);
  } catch {
    /* ignore */
  }
  return PINNED_VERSION;
}

/** Default MCP server entry for other projects (npx pin). */
export function mcpServerEntry(version = PINNED_VERSION) {
  return {
    command: "npx",
    args: ["-y", `iops-rooms@${version}`, "mcp"],
  };
}

/**
 * Merge iops-rooms into an existing mcp.json object without wiping other servers.
 * Returns { config, created, updated }.
 */
export function mergeMcpConfig(existing, entry, { serverKey = SERVER_KEY } = {}) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? structuredClone(existing)
      : {};
  if (!base.mcpServers || typeof base.mcpServers !== "object" || Array.isArray(base.mcpServers)) {
    base.mcpServers = {};
  }
  const had = Object.prototype.hasOwnProperty.call(base.mcpServers, serverKey);
  base.mcpServers[serverKey] = entry;
  return { config: base, created: !had, updated: true };
}

/**
 * Install / merge `.cursor/mcp.json` and copy the Rooms skill into
 * `.cursor/skills/rooms/SKILL.md` (project-local Cursor skills layout).
 *
 * Honest limits:
 * - Cursor discovers project MCP via `.cursor/mcp.json` after reload.
 * - `.cursor/skills/` is the project skill dir Cursor uses when enabled;
 *   Claude Code / Codex may need a user/global skill path instead — see README.
 * - Does not upload anything; writes only under the project cwd.
 */
export async function installMcp({
  cwd = process.cwd(),
  version,
  serverKey = SERVER_KEY,
  copySkill = true,
} = {}) {
  const ver = version || (await resolvePinnedVersion());
  const entry = mcpServerEntry(ver);
  const cursorDir = join(cwd, ".cursor");
  const mcpPath = join(cursorDir, "mcp.json");

  await mkdir(cursorDir, { recursive: true });

  let existing = null;
  let fileExisted = false;
  if (await exists(mcpPath)) {
    fileExisted = true;
    const raw = await readFile(mcpPath, "utf8");
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `.cursor/mcp.json exists but is not valid JSON (${err.message}). Fix or remove it, then re-run.`,
      );
    }
  }

  const { config, created } = mergeMcpConfig(existing, entry, { serverKey });
  await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const skillResult = { copied: false, path: null, source: null };
  if (copySkill) {
    const source = join(PKG_ROOT, "skills", "rooms", "SKILL.md");
    const destDir = join(cwd, ".cursor", "skills", "rooms");
    const dest = join(destDir, "SKILL.md");
    if (!(await exists(source))) {
      skillResult.note = `package skill missing at ${source}`;
    } else {
      await mkdir(destDir, { recursive: true });
      await copyFile(source, dest);
      skillResult.copied = true;
      skillResult.path = dest;
      skillResult.source = source;
    }
  }

  return {
    mcpPath,
    serverKey,
    version: ver,
    entry,
    fileExisted,
    serverCreated: created,
    skill: skillResult,
    note:
      "Reload MCP in Cursor (or restart the agent host). Logs stay local in .room/ — nothing was uploaded.",
  };
}

export { PKG_ROOT, SERVER_KEY, PINNED_VERSION };
