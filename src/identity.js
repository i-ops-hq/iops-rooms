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
  // 16 bytes, not 4. Four bytes is 32 bits: two devices share an id at ~1% odds by 9,300
  // devices and ~50% by 77,000. A fleet of ephemeral VMs counts RUNS, not machines — 1,000
  // VMs spun 20x a day for a month is 600,000 ids and a certain collision. Two devices
  // sharing an id merge into one actor on the board, which fails as a wrong picture rather
  // than an error. Ids already in device.json are kept as-is; only new ones are longer.
  return randomBytes(16).toString("hex");
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

  // ROOMS_ACTOR claims to be a PERSON. Nothing can check that, so it stays unverified.
  //
  // ROOMS_DEVICE_ID names a MACHINE, which is not a claim about identity at all — and in a VM
  // it is mandatory: a cloned template hands every clone the same device.json, and an ephemeral
  // VM loses it on each spin-up. Treating it as an identity override made "runs in a VM" and
  // "verified by GitHub or GitLab" mutually exclusive, which is the exact combination office
  // deployments need. A signed event stays signed; the signature covers the device id, so the
  // person is verified and the device label is asserted. `deviceAsserted` records that.
  const actorOverride = Boolean(envName);
  const deviceOverride = Boolean(envId);
  const envOverride = actorOverride || deviceOverride;

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
    actorOverride,
    deviceOverride,
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
 * Verified SCM identity (local only). Does not upload room events.
 * Layout under ~/.iops-rooms/ (or $ROOMS_HOME):
 *   identity.json  — github and/or gitlab claim, createdAt, publicKey, deviceId
 *   device.key     — ed25519 private key (mode 0600)
 */
export async function loadVerifiedIdentity() {
  try {
    const raw = await readFile(identityFilePath(), "utf8");
    const data = JSON.parse(raw);
    if (!data?.publicKey) return null;
    const hasGithub = Boolean(data?.github?.login);
    const hasGitlab = Boolean(data?.gitlab?.username);
    if (!hasGithub && !hasGitlab) return null;
    return data;
  } catch {
    return null;
  }
}

async function loadVerifiedIdentityRaw() {
  try {
    const raw = await readFile(identityFilePath(), "utf8");
    return JSON.parse(raw);
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
 * Does not hit the network. Preserves the other provider when adding github/gitlab.
 * Reuses existing ed25519 keypair when present so dual-provider stamps stay coherent.
 */
export async function saveVerifiedIdentity({
  login = null,
  gitlabUsername = null,
  id,
  email = null,
  deviceId = null,
  createdAt = null,
  provider = null,
} = {}) {
  const prov =
    provider ||
    (gitlabUsername && !login ? "gitlab" : login ? "github" : null);
  if (prov === "github" && !login) throw new Error("verified identity needs github login");
  if (prov === "gitlab" && !gitlabUsername && !login) {
    throw new Error("verified identity needs gitlab username");
  }
  if (!prov) throw new Error("verified identity needs github login or gitlab username");

  const idn = await loadIdentity();
  const existing = await loadVerifiedIdentityRaw();
  let publicKeyPem;
  let privateKeyPem;
  if (existing?.publicKey && (await exists(privateKeyPath()))) {
    publicKeyPem = existing.publicKey;
    privateKeyPem = await readPrivateKeyPem();
  } else {
    const pair = generateEd25519Pair();
    publicKeyPem = pair.publicKeyPem;
    privateKeyPem = pair.privateKeyPem;
    await writePrivateKey(privateKeyPem);
  }

  const record = {
    deviceId: deviceId || existing?.deviceId || idn.deviceId,
    publicKey: publicKeyPem,
    createdAt: createdAt || existing?.createdAt || new Date().toISOString(),
  };
  if (existing?.github?.login) record.github = { ...existing.github };
  if (existing?.gitlab?.username) record.gitlab = { ...existing.gitlab };

  if (prov === "github") {
    record.github = {
      login: String(login),
      id: id != null ? Number(id) || String(id) : null,
      email: email || null,
    };
  } else {
    const username = String(gitlabUsername || login);
    record.gitlab = {
      username,
      id: id != null ? Number(id) || String(id) : null,
      email: email || null,
    };
  }

  await mkdir(roomsHomeDir(), { recursive: true });
  await writeFile(identityFilePath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** Test helper: mint a signed-ready fixture identity without GitHub. */
export async function installFixtureIdentity(opts = {}) {
  if (opts.provider === "gitlab" || opts.gitlabUsername) {
    return saveVerifiedIdentity({
      provider: "gitlab",
      gitlabUsername: opts.gitlabUsername || opts.login || "fixture-gitlab",
      id: opts.id ?? 4242,
      email: opts.email ?? "fixture@example.com",
      deviceId: opts.deviceId,
      createdAt: opts.createdAt,
    });
  }
  return saveVerifiedIdentity({
    provider: "github",
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

/**
 * Canonical bytes for signing: stable field order, text hashed.
 * GitHub-only stays 7 lines (legacy). GitLab-only uses gitlab:<username>.
 * Dual-provider stamps append both.
 */
export function canonicalSignPayload({
  actor,
  deviceId,
  id,
  type,
  text,
  githubLogin,
  gitlabUsername,
}) {
  const textHash = createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex");
  const base = [
    "v1",
    String(actor || ""),
    String(deviceId || ""),
    String(id || ""),
    String(type || ""),
    textHash,
  ];
  const gh = githubLogin ? String(githubLogin) : "";
  const gl = gitlabUsername ? String(gitlabUsername) : "";
  if (gh && !gl) return [...base, gh].join("\n");
  if (gl && !gh) return [...base, `gitlab:${gl}`].join("\n");
  if (gh && gl) return [...base, gh, `gitlab:${gl}`].join("\n");
  return base.join("\n");
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
 * A ROOMS_ACTOR override is an uncheckable claim to be a person and stays unverified.
 * A ROOMS_DEVICE_ID override only labels the machine and does not block signing — see
 * loadIdentity for why VMs cannot work any other way.
 */
export async function stampEventIdentity(record, idn) {
  const out = { ...record };
  // Older callers may hand us an identity from before the split; fall back to the coarse flag.
  const actorOverride = Boolean(
    idn?.actorOverride ?? (idn?.deviceOverride ? false : idn?.envOverride),
  );
  const deviceAsserted = Boolean(idn?.deviceOverride);

  if (actorOverride) {
    out.identity = { mode: "unverified", reason: "env_override" };
  }

  const verified = idn?.verified || (await loadVerifiedIdentity());
  const githubLogin = verified?.github?.login || null;
  const gitlabUsername = verified?.gitlab?.username || null;
  if (!verified?.publicKey || (!githubLogin && !gitlabUsername)) {
    // Solo / unsigned: stay quiet on the board — do not stamp amber "unverified".
    if (!out.identity) out.identity = { mode: "unsigned", reason: "solo" };
    return out;
  }

  // An unverifiable person claim wins — do not pretend verified.
  if (actorOverride) {
    return out;
  }

  let privatePem;
  try {
    privatePem = await readPrivateKeyPem();
  } catch {
    out.identity = { mode: "unverified", reason: "missing_device_key" };
    return out;
  }

  if (githubLogin) {
    out.github = {
      login: githubLogin,
      id: verified.github.id,
    };
  }
  if (gitlabUsername) {
    out.gitlab = {
      username: gitlabUsername,
      id: verified.gitlab.id,
    };
  }
  out.publicKey = verified.publicKey;
  const payload = canonicalSignPayload({
    actor: out.actor,
    deviceId: out.deviceId,
    id: out.id,
    type: out.type,
    text: out.text,
    githubLogin,
    gitlabUsername,
  });
  out.sig = signCanonical(privatePem, payload);
  out.identity = {
    mode: "verified",
    ...(githubLogin ? { github: githubLogin } : {}),
    ...(gitlabUsername ? { gitlab: gitlabUsername } : {}),
    // The signature covers deviceId, so this is not a hole — but the id was supplied by the
    // environment rather than minted on the machine, and a board that will one day answer
    // "which machine ran this" should be able to say which half was checked.
    ...(deviceAsserted ? { deviceAsserted: true } : {}),
  };
  return out;
}

/**
 * Verify an event's github/gitlab claim + signature.
 * Returns { ok, reason, login, provider, githubLogin, gitlabUsername }.
 */
export function verifyEventIdentity(ev) {
  const githubLogin = ev?.github?.login || ev?.githubLogin || null;
  const gitlabUsername = ev?.gitlab?.username || ev?.gitlabUsername || null;
  if (!githubLogin && !gitlabUsername) {
    return {
      ok: false,
      reason: "no_github_claim",
      login: null,
      provider: null,
      githubLogin: null,
      gitlabUsername: null,
    };
  }
  if (!ev?.sig || !ev?.publicKey) {
    return {
      ok: false,
      reason: "missing_sig",
      login: githubLogin || gitlabUsername,
      provider: githubLogin ? "github" : "gitlab",
      githubLogin,
      gitlabUsername,
    };
  }
  const payload = canonicalSignPayload({
    actor: ev.actor,
    deviceId: ev.deviceId,
    id: ev.id,
    type: ev.type,
    text: ev.text,
    githubLogin,
    gitlabUsername,
  });
  const ok = verifyCanonical(ev.publicKey, payload, ev.sig);
  const provider =
    githubLogin && gitlabUsername ? "both" : githubLogin ? "github" : "gitlab";
  return {
    ok,
    reason: ok ? "ok" : "bad_sig",
    login: githubLogin || gitlabUsername,
    provider,
    githubLogin,
    gitlabUsername,
  };
}

export function eventVerifiedBadge(ev) {
  const v = verifyEventIdentity(ev);
  if (v.ok) {
    return {
      kind: "verified",
      login: v.login,
      label: "verified",
      provider: v.provider,
    };
  }
  // Amber only when the event claims a GitHub/GitLab login without a valid sig.
  if (v.login) {
    return {
      kind: "unverified",
      login: v.login,
      label: "unverified",
      provider: v.provider,
    };
  }
  // Env override (and failed local key) are warn-worthy without a github claim.
  const reason = ev?.identity?.reason;
  if (reason === "env_override" || reason === "missing_device_key") {
    return { kind: "unverified", login: null, label: "unverified", provider: null };
  }
  // Solo / unsigned / no claim → quiet (no badge).
  return { kind: "none", login: null, label: null, provider: null };
}

export async function authStatus() {
  const idn = await loadIdentity();
  const verified = idn.verified;
  const hasGithub = Boolean(verified?.github?.login);
  const hasGitlab = Boolean(verified?.gitlab?.username);
  return {
    deviceId: idn.deviceId,
    displayName: idn.displayName,
    tool: idn.tool,
    envOverride: idn.envOverride,
    verified: hasGithub || hasGitlab,
    github: verified?.github || null,
    gitlab: verified?.gitlab || null,
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
      provider: "github",
      login: user.login,
      id: user.id,
      email: user.email || null,
    });
    return { identity, user: { login: user.login, id: user.id, email: user.email || null } };
  }
  throw new Error("GitHub device flow timed out — run `rooms auth github` again");
}

/**
 * GitLab OAuth device flow (CLI). Requires ROOMS_GITLAB_CLIENT_ID (OAuth App).
 * Optional ROOMS_GITLAB_HOST (default https://gitlab.com) for self-managed.
 * fetchImpl injectable for tests. Never uploads room events — only mints local identity.
 *
 * Docs: https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow
 */
export async function authGitlabDeviceFlow({
  clientId = process.env.ROOMS_GITLAB_CLIENT_ID,
  host = process.env.ROOMS_GITLAB_HOST || "https://gitlab.com",
  scope = "read_user",
  fetchImpl = globalThis.fetch,
  openUrl = null,
  pollIntervalMs = null,
  onUserCode = null,
  signal = null,
} = {}) {
  if (!clientId) {
    throw new Error(
      "Set ROOMS_GITLAB_CLIENT_ID to your GitLab OAuth App application id (device flow). " +
        "Auth only mints a local verified identity — it does not upload room events.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required for GitLab device flow");
  }

  const base = String(host).replace(/\/$/, "");
  const formHeaders = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const codeRes = await fetchImpl(`${base}/oauth/authorize_device`, {
    method: "POST",
    headers: formHeaders,
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    signal,
  });
  if (!codeRes.ok) {
    const body = await codeRes.text().catch(() => "");
    throw new Error(`GitLab device code failed (${codeRes.status}): ${body.slice(0, 200)}`);
  }
  const codeJson = await codeRes.json();
  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    interval = 5,
    expires_in: expiresIn = 300,
  } = codeJson;
  if (!deviceCode || !userCode) {
    throw new Error("GitLab device code response missing device_code/user_code");
  }

  const openTarget = verificationUriComplete || verificationUri;
  if (typeof onUserCode === "function") {
    await onUserCode({
      userCode,
      verificationUri: verificationUri || openTarget,
      verificationUriComplete,
      expiresIn,
    });
  }
  if (typeof openUrl === "function" && openTarget) {
    try {
      openUrl(openTarget);
    } catch {
      /* ignore */
    }
  }

  const started = Date.now();
  const intervalMs = (pollIntervalMs ?? Number(interval) * 1000) || 5000;
  let wait = intervalMs;

  while (Date.now() - started < expiresIn * 1000) {
    if (signal?.aborted) throw new Error("GitLab device flow aborted");
    await new Promise((r) => setTimeout(r, wait));
    const tokenRes = await fetchImpl(`${base}/oauth/token`, {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      signal,
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.error === "authorization_pending") continue;
    if (tokenJson.error === "slow_down") {
      wait += 5000;
      continue;
    }
    if (tokenJson.error) {
      throw new Error(`GitLab device flow: ${tokenJson.error_description || tokenJson.error}`);
    }
    const accessToken = tokenJson.access_token;
    if (!accessToken) throw new Error("GitLab device flow: no access_token");

    const userRes = await fetchImpl(`${base}/api/v4/user`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "iops-rooms",
      },
      signal,
    });
    if (!userRes.ok) {
      throw new Error(`GitLab /api/v4/user failed (${userRes.status})`);
    }
    const user = await userRes.json();
    const username = user.username || user.login;
    if (!username) throw new Error("GitLab /api/v4/user missing username");
    // Drop the token — local signed identity only.
    const identity = await saveVerifiedIdentity({
      provider: "gitlab",
      gitlabUsername: username,
      id: user.id,
      email: user.email || null,
    });
    return {
      identity,
      user: { username, id: user.id, email: user.email || null },
    };
  }
  throw new Error("GitLab device flow timed out — run `rooms auth gitlab` again");
}
