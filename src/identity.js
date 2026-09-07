import { mkdir, readFile, writeFile, unlink, chmod, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  randomBytes,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  createHash,
} from "node:crypto";

/** Override for tests: points at a temp ~/.iops-rooms equivalent. */
export function roomsHomeDir() {
  return process.env.ROOMS_HOME || join(homedir(), ".iops-rooms");
}

export function deviceFilePath() {
  return join(roomsHomeDir(), "device.json");
}

export function identityFilePath() {
  return join(roomsHomeDir(), "identity.json");
}

export function privateKeyPath() {
  return join(roomsHomeDir(), "device.key");
}

function newDeviceId() {
  return randomBytes(4).toString("hex");
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Stable device identity for this machine. Env overrides for smoke / second poster. */
export async function loadIdentity() {
  const envId = process.env.ROOMS_DEVICE_ID;
  const envName =
    process.env.ROOMS_DISPLAY_NAME || process.env.ROOMS_ACTOR || null;
  const envTool = process.env.ROOMS_TOOL || null;

  let stored = null;
  try {
    stored = JSON.parse(await readFile(deviceFilePath(), "utf8"));
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

  // Env actor/device overrides are convenient for smoke — always marked unverified.
  const envOverride = Boolean(envId || envName);

  if (!envId && (!stored || stored.deviceId !== deviceId || stored.displayName !== displayName)) {
    await mkdir(roomsHomeDir(), { recursive: true });
    await writeFile(
      deviceFilePath(),
      `${JSON.stringify({ deviceId, displayName }, null, 2)}\n`,
      "utf8",
    );
  }

  const verified = await loadVerifiedIdentity().catch(() => null);

  return {
    deviceId,
    displayName,
    tool,
    actor: displayName,
    envOverride,
    verified: verified || null,
  };
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

/**
 * Verified GitHub identity (local only). Does not upload room events.
 * Layout under ~/.iops-rooms/ (or $ROOMS_HOME):
 *   identity.json  — login, id, email, createdAt, publicKey, deviceId
 *   device.key     — ed25519 private key (mode 0600)
 */
export async function loadVerifiedIdentity() {
  try {
    const raw = await readFile(identityFilePath(), "utf8");
    const data = JSON.parse(raw);
    if (!data?.github?.login || !data?.publicKey) return null;
    return data;
  } catch {
    return null;
  }
}

export async function clearVerifiedIdentity() {
  const paths = [identityFilePath(), privateKeyPath()];
  for (const p of paths) {
    try {
      await unlink(p);
    } catch {
      /* ignore missing */
    }
  }
}

function generateEd25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function writePrivateKey(pem) {
  await mkdir(roomsHomeDir(), { recursive: true });
  await writeFile(privateKeyPath(), pem, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(privateKeyPath(), 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}

/**
 * Install a local verified identity (used by device-flow success + test fixtures).
 * Does not hit the network.
 */
export async function saveVerifiedIdentity({
  login,
  id,
  email = null,
  deviceId = null,
  createdAt = null,
} = {}) {
  if (!login) throw new Error("verified identity needs github login");
  const idn = await loadIdentity();
  const pair = generateEd25519Pair();
  await writePrivateKey(pair.privateKeyPem);
  const record = {
    github: {
      login: String(login),
      id: id != null ? Number(id) || String(id) : null,
      email: email || null,
    },
    deviceId: deviceId || idn.deviceId,
    publicKey: pair.publicKeyPem,
    createdAt: createdAt || new Date().toISOString(),
  };
  await mkdir(roomsHomeDir(), { recursive: true });
  await writeFile(identityFilePath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** Test helper: mint a signed-ready fixture identity without GitHub. */
export async function installFixtureIdentity(opts = {}) {
  return saveVerifiedIdentity({
    login: opts.login || "fixture-user",
    id: opts.id ?? 4242,
    email: opts.email ?? "fixture@example.com",
    deviceId: opts.deviceId,
    createdAt: opts.createdAt,
  });
}

export async function readPrivateKeyPem() {
  return readFile(privateKeyPath(), "utf8");
}

/** Canonical bytes for signing: stable field order, text hashed. */
export function canonicalSignPayload({
  actor,
  deviceId,
  id,
  type,
  text,
  githubLogin,
}) {
  const textHash = createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex");
  return [
    "v1",
    String(actor || ""),
    String(deviceId || ""),
    String(id || ""),
    String(type || ""),
    textHash,
    String(githubLogin || ""),
  ].join("\n");
}

export function signCanonical(privateKeyPem, payload) {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(payload, "utf8"), key);
  return sig.toString("base64");
}

export function verifyCanonical(publicKeyPem, payload, sigBase64) {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(sigBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Attach verified stamp + ed25519 signature to an event record (mutates/returns).
 * Env actor/device overrides stay allowed but marked unverified.
 */
export async function stampEventIdentity(record, idn) {
  const out = { ...record };
  const envOverride = Boolean(idn?.envOverride);

  if (envOverride) {
    out.identity = { mode: "unverified", reason: "env_override" };
  }

  const verified = idn?.verified || (await loadVerifiedIdentity());
  if (!verified?.github?.login || !verified?.publicKey) {
    // Solo / unsigned: stay quiet on the board — do not stamp amber "unverified".
    if (!out.identity) out.identity = { mode: "unsigned", reason: "solo" };
    return out;
  }

  // Env override wins for actor/device smoke — do not pretend verified.
  if (envOverride) {
    return out;
  }

  let privatePem;
  try {
    privatePem = await readPrivateKeyPem();
  } catch {
    out.identity = { mode: "unverified", reason: "missing_device_key" };
    return out;
  }

  const githubLogin = verified.github.login;
  out.github = {
    login: githubLogin,
    id: verified.github.id,
  };
  out.publicKey = verified.publicKey;
  const payload = canonicalSignPayload({
    actor: out.actor,
    deviceId: out.deviceId,
    id: out.id,
    type: out.type,
    text: out.text,
    githubLogin,
  });
  out.sig = signCanonical(privatePem, payload);
  out.identity = { mode: "verified", github: githubLogin };
  return out;
}

/**
 * Verify an event's github claim + signature.
 * Returns { ok, reason, login }.
 */
export function verifyEventIdentity(ev) {
  const login = ev?.github?.login || ev?.githubLogin || null;
  if (!login) {
    return { ok: false, reason: "no_github_claim", login: null };
  }
  if (!ev?.sig || !ev?.publicKey) {
    return { ok: false, reason: "missing_sig", login };
  }
  const payload = canonicalSignPayload({
    actor: ev.actor,
    deviceId: ev.deviceId,
    id: ev.id,
    type: ev.type,
    text: ev.text,
    githubLogin: login,
  });
  const ok = verifyCanonical(ev.publicKey, payload, ev.sig);
  return { ok, reason: ok ? "ok" : "bad_sig", login };
}

export function eventVerifiedBadge(ev) {
  const v = verifyEventIdentity(ev);
  if (v.ok) return { kind: "verified", login: v.login, label: "verified" };
  // Amber only when the event claims a GitHub login without a valid sig.
  if (v.login) return { kind: "unverified", login: v.login, label: "unverified" };
  // Env override (and failed local key) are warn-worthy without a github claim.
  const reason = ev?.identity?.reason;
  if (reason === "env_override" || reason === "missing_device_key") {
    return { kind: "unverified", login: null, label: "unverified" };
  }
  // Solo / unsigned / no claim → quiet (no badge).
  return { kind: "none", login: null, label: null };
}

export async function authStatus() {
  const idn = await loadIdentity();
  const verified = idn.verified;
  return {
    deviceId: idn.deviceId,
    displayName: idn.displayName,
    tool: idn.tool,
    envOverride: idn.envOverride,
    verified: Boolean(verified?.github?.login),
    github: verified?.github || null,
    createdAt: verified?.createdAt || null,
    publicKeyPresent: Boolean(verified?.publicKey),
    privateKeyPresent: await exists(privateKeyPath()),
    home: roomsHomeDir(),
  };
}

/**
 * GitHub OAuth device flow (CLI). Requires ROOMS_GITHUB_CLIENT_ID (OAuth App).
 * fetchImpl injectable for tests. Never uploads room events — only mints local identity.
 *
 * Docs: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */
export async function authGithubDeviceFlow({
  clientId = process.env.ROOMS_GITHUB_CLIENT_ID,
  fetchImpl = globalThis.fetch,
  openUrl = null,
  pollIntervalMs = null,
  onUserCode = null,
  signal = null,
} = {}) {
  if (!clientId) {
    throw new Error(
      "Set ROOMS_GITHUB_CLIENT_ID to your GitHub OAuth App client id (device flow). " +
        "Auth only mints a local verified identity — it does not upload room events.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required for GitHub device flow");
  }

  const codeRes = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId }),
    signal,
  });
  if (!codeRes.ok) {
    const body = await codeRes.text().catch(() => "");
    throw new Error(`GitHub device code failed (${codeRes.status}): ${body.slice(0, 200)}`);
  }
  const codeJson = await codeRes.json();
  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    interval = 5,
    expires_in: expiresIn = 900,
  } = codeJson;
  if (!deviceCode || !userCode) {
    throw new Error("GitHub device code response missing device_code/user_code");
  }

  if (typeof onUserCode === "function") {
    await onUserCode({ userCode, verificationUri, expiresIn });
  }
  if (typeof openUrl === "function" && verificationUri) {
    try {
      openUrl(verificationUri);
    } catch {
      /* ignore */
    }
  }

  const started = Date.now();
  const intervalMs = (pollIntervalMs ?? Number(interval) * 1000) || 5000;
  let wait = intervalMs;

  while (Date.now() - started < expiresIn * 1000) {
    if (signal?.aborted) throw new Error("GitHub device flow aborted");
    await new Promise((r) => setTimeout(r, wait));
    const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.error === "authorization_pending") continue;
    if (tokenJson.error === "slow_down") {
      wait += 5000;
      continue;
    }
    if (tokenJson.error) {
      throw new Error(`GitHub device flow: ${tokenJson.error_description || tokenJson.error}`);
    }
    const accessToken = tokenJson.access_token;
    if (!accessToken) throw new Error("GitHub device flow: no access_token");

    const userRes = await fetchImpl("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "iops-rooms",
      },
      signal,
    });
    if (!userRes.ok) {
      throw new Error(`GitHub /user failed (${userRes.status})`);
    }
    const user = await userRes.json();
    // Drop the token — we only keep a local signed identity, not cloud session.
    const identity = await saveVerifiedIdentity({
      login: user.login,
      id: user.id,
      email: user.email || null,
    });
    return { identity, user: { login: user.login, id: user.id, email: user.email || null } };
  }
  throw new Error("GitHub device flow timed out — run `rooms auth github` again");
}
