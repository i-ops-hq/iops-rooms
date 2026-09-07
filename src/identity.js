import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const DEVICE_DIR = join(homedir(), ".iops-rooms");
const DEVICE_FILE = join(DEVICE_DIR, "device.json");

function newDeviceId() {
  return randomBytes(4).toString("hex");
}

/** Stable device identity for this machine. Env overrides for smoke / second poster. */
export async function loadIdentity() {
  const envId = process.env.ROOMS_DEVICE_ID;
  const envName =
    process.env.ROOMS_DISPLAY_NAME || process.env.ROOMS_ACTOR || null;
  const envTool = process.env.ROOMS_TOOL || null;

  let stored = null;
  try {
    stored = JSON.parse(await readFile(DEVICE_FILE, "utf8"));
  } catch {
    stored = null;
  }

  const deviceId = (envId || stored?.deviceId || newDeviceId()).trim();
  const displayName = (
    envName ||
    stored?.displayName ||
    process.env.USER ||
    process.env.USERNAME ||
    "local"
  ).trim();
  const tool = (envTool || "cli").trim();

  if (!envId && (!stored || stored.deviceId !== deviceId || stored.displayName !== displayName)) {
    await mkdir(DEVICE_DIR, { recursive: true });
    await writeFile(
      DEVICE_FILE,
      `${JSON.stringify({ deviceId, displayName }, null, 2)}\n`,
      "utf8",
    );
  }

  return { deviceId, displayName, tool, actor: displayName };
}

export function identitySync() {
  // Sync fallback for call sites that cannot await (rare). Prefer loadIdentity.
  return {
    deviceId: process.env.ROOMS_DEVICE_ID || "pending",
    displayName:
      process.env.ROOMS_DISPLAY_NAME ||
      process.env.ROOMS_ACTOR ||
      process.env.USER ||
      process.env.USERNAME ||
      "local",
    tool: process.env.ROOMS_TOOL || "cli",
  };
}
