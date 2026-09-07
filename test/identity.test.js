import { mkdtemp, rm, readFile, stat, appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  installFixtureIdentity,
  clearVerifiedIdentity,
  authStatus,
  roomsHomeDir,
  identityFilePath,
  privateKeyPath,
  stampEventIdentity,
  verifyEventIdentity,
  eventVerifiedBadge,
  canonicalSignPayload,
  signCanonical,
  verifyCanonical,
  readPrivateKeyPem,
  loadIdentity,
  authGithubDeviceFlow,
  authGitlabDeviceFlow,
} from "../src/identity.js";
import { initRoom, postNote, mergeRoomBundle, roomPaths, readEvents } from "../src/store.js";
import { writeBoard } from "../src/board.js";

async function withRoomsHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-id-"));
  const prev = process.env.ROOMS_HOME;
  const prevActor = process.env.ROOMS_ACTOR;
  const prevDevice = process.env.ROOMS_DEVICE_ID;
  process.env.ROOMS_HOME = home;
  delete process.env.ROOMS_ACTOR;
  delete process.env.ROOMS_DEVICE_ID;
  delete process.env.ROOMS_DISPLAY_NAME;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.ROOMS_HOME;
    else process.env.ROOMS_HOME = prev;
    if (prevActor === undefined) delete process.env.ROOMS_ACTOR;
    else process.env.ROOMS_ACTOR = prevActor;
    if (prevDevice === undefined) delete process.env.ROOMS_DEVICE_ID;
    else process.env.ROOMS_DEVICE_ID = prevDevice;
    await rm(home, { recursive: true, force: true });
  }
}

test("fixture identity store + private key mode 0600", async () => {
  await withRoomsHome(async () => {
    const id = await installFixtureIdentity({ login: "ashwinth", id: 99, email: "a@example.com" });
    assert.equal(id.github.login, "ashwinth");
    assert.ok(id.publicKey.includes("BEGIN PUBLIC KEY"));
    const raw = JSON.parse(await readFile(identityFilePath(), "utf8"));
    assert.equal(raw.github.login, "ashwinth");
    const st = await stat(privateKeyPath());
    // mode bits: expect owner read/write only when platform supports it
    assert.equal(st.mode & 0o777, 0o600);
    const status = await authStatus();
    assert.equal(status.verified, true);
    assert.equal(status.github.login, "ashwinth");
    await clearVerifiedIdentity();
    const after = await authStatus();
    assert.equal(after.verified, false);
  });
});

test("signature round-trip over canonical payload", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "signer" });
    const pem = await readPrivateKeyPem();
    const payload = canonicalSignPayload({
      actor: "signer",
      deviceId: "abcd",
      id: "evt1",
      type: "note",
      text: "hello",
      githubLogin: "signer",
    });
    const sig = signCanonical(pem, payload);
    const id = JSON.parse(await readFile(identityFilePath(), "utf8"));
    assert.equal(verifyCanonical(id.publicKey, payload, sig), true);
    assert.equal(verifyCanonical(id.publicKey, payload + "x", sig), false);
  });
});

test("stampEventIdentity + verifyEventIdentity", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "poster" });
    const idn = await loadIdentity();
    const stamped = await stampEventIdentity(
      {
        actor: idn.displayName,
        deviceId: idn.deviceId,
        id: "e1",
        type: "note",
        text: "hi",
        at: new Date().toISOString(),
      },
      idn,
    );
    assert.equal(stamped.identity.mode, "verified");
    assert.equal(stamped.github.login, "poster");
    assert.ok(stamped.sig);
    assert.equal(verifyEventIdentity(stamped).ok, true);

    const forged = { ...stamped, text: "tampered" };
    assert.equal(verifyEventIdentity(forged).ok, false);
  });
});

test("env override posts are unmarked verified", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "real" });
    process.env.ROOMS_ACTOR = "smoke-actor";
    process.env.ROOMS_DEVICE_ID = "smoke-dev";
    const idn = await loadIdentity();
    assert.equal(idn.envOverride, true);
    const stamped = await stampEventIdentity(
      {
        actor: idn.displayName,
        deviceId: idn.deviceId,
        id: "e2",
        type: "note",
        text: "smoke",
      },
      idn,
    );
    assert.equal(stamped.identity.mode, "unverified");
    assert.equal(stamped.identity.reason, "env_override");
    assert.equal(stamped.github, undefined);
  });
});

test("board shows verified badge when stamped", async () => {
  await withRoomsHome(async (home) => {
    await installFixtureIdentity({ login: "badge-user" });
    const dir = await mkdtemp(join(tmpdir(), "iops-rooms-badge-"));
    try {
      await initRoom({ cwd: dir, name: "badge-room" });
      await postNote(dir, { text: "verified post" });
      const html = await readFile(roomPaths(dir).board, "utf8");
      assert.match(html, /data-verify="verified"/);
      assert.match(html, />verified(?: · (?:github|gitlab|gh\+gl))?</);
      const events = await readEvents(dir);
      const note = events.find((e) => e.type === "note");
      assert.equal(note.github.login, "badge-user");
      assert.equal(verifyEventIdentity(note).ok, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("sync-merge warns on claimed github without valid sig (warn-only)", async () => {
  await withRoomsHome(async () => {
    const a = await mkdtemp(join(tmpdir(), "iops-rooms-ma-"));
    const b = await mkdtemp(join(tmpdir(), "iops-rooms-mb-"));
    const bundle = await mkdtemp(join(tmpdir(), "iops-rooms-mbundle-"));
    try {
      await initRoom({ cwd: a, name: "ma", code: "VRIFY1" });
      // Craft a forged event claiming github without sig into A's log, then export.
      const forged = {
        id: "forged-github-1",
        at: new Date().toISOString(),
        type: "note",
        text: "spoof",
        actor: "attacker",
        deviceId: "evil",
        tool: "cli",
        branch: "",
        github: { login: "not-really", id: 1 },
      };
      await appendFile(roomPaths(a).events, `${JSON.stringify(forged)}\n`, "utf8");
      const { exportRoomBundle } = await import("../src/store.js");
      await exportRoomBundle(a, bundle);

      await initRoom({ cwd: b, name: "mb", code: "VRIFY1" });
      const errs = [];
      const orig = console.error;
      console.error = (...args) => errs.push(args.join(" "));
      let result;
      try {
        result = await mergeRoomBundle(bundle, b);
      } finally {
        console.error = orig;
      }
      assert.ok(result.added >= 1);
      assert.ok(result.warnBadGithub >= 1);
      assert.ok(errs.some((e) => /claims github/.test(e)));
      const events = await readEvents(b);
      assert.ok(events.some((e) => e.id === "forged-github-1"));
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
      await rm(bundle, { recursive: true, force: true });
    }
  });
});

test("device flow uses injectable fetch; no network in tests", async () => {
  await withRoomsHome(async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || "GET" });
      if (String(url).includes("/login/device/code")) {
        return {
          ok: true,
          async json() {
            return {
              device_code: "dc",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              interval: 0.01,
              expires_in: 60,
            };
          },
          async text() {
            return "";
          },
        };
      }
      if (String(url).includes("/login/oauth/access_token")) {
        return {
          ok: true,
          async json() {
            return { access_token: "tok", token_type: "bearer", scope: "read:user" };
          },
        };
      }
      if (String(url).includes("api.github.com/user")) {
        return {
          ok: true,
          async json() {
            return { login: "flow-user", id: 7, email: null };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const seen = [];
    const result = await authGithubDeviceFlow({
      clientId: "test-client",
      fetchImpl,
      pollIntervalMs: 1,
      onUserCode: (info) => seen.push(info.userCode),
    });
    assert.equal(result.user.login, "flow-user");
    assert.deepEqual(seen, ["ABCD-1234"]);
    assert.ok(calls.some((c) => c.url.includes("device/code")));
    const status = await authStatus();
    assert.equal(status.verified, true);
    assert.equal(status.github.login, "flow-user");
  });
});

test("auth github without client id fails honestly", async () => {
  await withRoomsHome(async () => {
    delete process.env.ROOMS_GITHUB_CLIENT_ID;
    await assert.rejects(
      () => authGithubDeviceFlow({ clientId: "", fetchImpl: async () => ({}) }),
      /ROOMS_GITHUB_CLIENT_ID/,
    );
  });
});


test("solo unsigned stamps quiet — no amber unverified badge", async () => {
  await withRoomsHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), "iops-rooms-solo-badge-"));
    try {
      await initRoom({ cwd: dir, name: "solo-room" });
      await postNote(dir, { text: "plain solo post" });
      const events = await readEvents(dir);
      const note = events.find((e) => e.type === "note");
      assert.ok(note);
      assert.equal(note.identity?.mode, "unsigned");
      assert.equal(note.identity?.reason, "solo");
      assert.equal(eventVerifiedBadge(note).kind, "none");
      const html = await readFile(roomPaths(dir).board, "utf8");
      // CSS still mentions unverified selectors — assert on event/chip markup only.
      assert.match(html, /class="event"[^>]*data-verify="none"/);
      assert.doesNotMatch(html, /class="event"[^>]*data-verify="unverified"/);
      assert.doesNotMatch(html, /class="verify-badge"[^>]*data-verify="unverified"/);
      assert.doesNotMatch(html, /class="verify-badge"[^>]*>unverified</);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("claimed github without sig shows amber unverified", async () => {
  await withRoomsHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), "iops-rooms-claim-badge-"));
    try {
      await initRoom({ cwd: dir, name: "claim-room" });
      const forged = {
        id: "claim-no-sig-1",
        at: new Date().toISOString(),
        type: "note",
        text: "spoof claim",
        actor: "attacker",
        deviceId: "evil",
        tool: "cli",
        branch: "main",
        github: { login: "not-really", id: 1 },
      };
      assert.equal(eventVerifiedBadge(forged).kind, "unverified");
      await appendFile(roomPaths(dir).events, `${JSON.stringify(forged)}\n`, "utf8");
      const events = await readEvents(dir);
      const meta = JSON.parse(await readFile(roomPaths(dir).meta, "utf8"));
      await writeBoard(roomPaths(dir).board, meta, events, { projectDir: dir });
      const html = await readFile(roomPaths(dir).board, "utf8");
      assert.match(html, /data-verify="unverified"/);
      assert.match(html, />unverified</);
      assert.match(html, /Signed locally as @|claims @not-really without a valid signature/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("verified hover tip is honest about local-only check", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "tip-user" });
    const dir = await mkdtemp(join(tmpdir(), "iops-rooms-tip-"));
    try {
      await initRoom({ cwd: dir, name: "tip-room" });
      await postNote(dir, { text: "signed tip" });
      const html = await readFile(roomPaths(dir).board, "utf8");
      assert.match(html, /Signed locally as @tip-user \(GitHub\) — not a live check\./);
      assert.match(html, />verified · github</);
      assert.doesNotMatch(html, /local ed25519 signature ok/);
      // timeline ✓ chip must not use native title (double-tip)
      assert.doesNotMatch(html, /class="tl-verify"[^>]*title=/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("env override still amber unverified on board", async () => {
  await withRoomsHome(async () => {
    process.env.ROOMS_ACTOR = "smoke-actor";
    process.env.ROOMS_DEVICE_ID = "smoke-dev";
    const dir = await mkdtemp(join(tmpdir(), "iops-rooms-env-badge-"));
    try {
      await initRoom({ cwd: dir, name: "env-room" });
      await postNote(dir, { text: "env smoke" });
      const events = await readEvents(dir);
      const note = events.find((e) => e.type === "note");
      assert.equal(note.identity.mode, "unverified");
      assert.equal(note.identity.reason, "env_override");
      assert.equal(eventVerifiedBadge(note).kind, "unverified");
      const html = await readFile(roomPaths(dir).board, "utf8");
      assert.match(html, /data-verify="unverified"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("gitlab fixture identity + stamp + verify", async () => {
  await withRoomsHome(async () => {
    const id = await installFixtureIdentity({
      provider: "gitlab",
      gitlabUsername: "gl-user",
      id: 55,
    });
    assert.equal(id.gitlab.username, "gl-user");
    assert.equal(id.github, undefined);
    assert.ok(id.publicKey.includes("BEGIN PUBLIC KEY"));
    const status = await authStatus();
    assert.equal(status.verified, true);
    assert.equal(status.gitlab.username, "gl-user");
    assert.equal(status.github, null);

    const idn = await loadIdentity();
    const stamped = await stampEventIdentity(
      {
        actor: idn.displayName,
        deviceId: idn.deviceId,
        id: "gl1",
        type: "note",
        text: "from gitlab",
      },
      idn,
    );
    assert.equal(stamped.identity.mode, "verified");
    assert.equal(stamped.identity.gitlab, "gl-user");
    assert.equal(stamped.gitlab.username, "gl-user");
    assert.equal(stamped.github, undefined);
    assert.equal(verifyEventIdentity(stamped).ok, true);
    assert.equal(eventVerifiedBadge(stamped).kind, "verified");
    assert.equal(eventVerifiedBadge(stamped).provider, "gitlab");
  });
});

test("gitlab auth preserves existing github claim + shared key", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "gh-first", id: 1 });
    const before = JSON.parse(await readFile(identityFilePath(), "utf8"));
    const pemBefore = await readPrivateKeyPem();
    await installFixtureIdentity({ provider: "gitlab", gitlabUsername: "gl-second", id: 2 });
    const after = JSON.parse(await readFile(identityFilePath(), "utf8"));
    assert.equal(after.github.login, "gh-first");
    assert.equal(after.gitlab.username, "gl-second");
    assert.equal(after.publicKey, before.publicKey);
    assert.equal(await readPrivateKeyPem(), pemBefore);
    const idn = await loadIdentity();
    const stamped = await stampEventIdentity(
      {
        actor: idn.displayName,
        deviceId: idn.deviceId,
        id: "both1",
        type: "note",
        text: "dual",
      },
      idn,
    );
    assert.equal(stamped.github.login, "gh-first");
    assert.equal(stamped.gitlab.username, "gl-second");
    assert.equal(verifyEventIdentity(stamped).ok, true);
  });
});

test("gitlab device flow uses injectable fetch; no network in tests", async () => {
  await withRoomsHome(async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || "GET" });
      if (String(url).includes("/oauth/authorize_device")) {
        return {
          ok: true,
          async json() {
            return {
              device_code: "dc-gl",
              user_code: "WLCM-GITL",
              verification_uri: "https://gitlab.com/oauth/device",
              interval: 0.01,
              expires_in: 60,
            };
          },
          async text() {
            return "";
          },
        };
      }
      if (String(url).endsWith("/oauth/token")) {
        return {
          ok: true,
          async json() {
            return { access_token: "gl-tok", token_type: "Bearer", scope: "read_user" };
          },
        };
      }
      if (String(url).includes("/api/v4/user")) {
        return {
          ok: true,
          async json() {
            return { username: "flow-gl", id: 9, email: null };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const seen = [];
    const result = await authGitlabDeviceFlow({
      clientId: "test-gl-client",
      fetchImpl,
      pollIntervalMs: 1,
      onUserCode: (info) => seen.push(info.userCode),
    });
    assert.equal(result.user.username, "flow-gl");
    assert.deepEqual(seen, ["WLCM-GITL"]);
    assert.ok(calls.some((c) => c.url.includes("authorize_device")));
    const status = await authStatus();
    assert.equal(status.verified, true);
    assert.equal(status.gitlab.username, "flow-gl");
  });
});

test("auth gitlab without client id fails honestly", async () => {
  await withRoomsHome(async () => {
    delete process.env.ROOMS_GITLAB_CLIENT_ID;
    await assert.rejects(
      () => authGitlabDeviceFlow({ clientId: "", fetchImpl: async () => ({}) }),
      /ROOMS_GITLAB_CLIENT_ID/,
    );
  });
});

test("claimed gitlab without sig shows amber unverified", async () => {
  await withRoomsHome(async () => {
    const forged = {
      id: "claim-gl-1",
      at: new Date().toISOString(),
      type: "note",
      text: "spoof gl",
      actor: "attacker",
      deviceId: "evil",
      tool: "cli",
      branch: "main",
      gitlab: { username: "not-really-gl", id: 1 },
    };
    assert.equal(eventVerifiedBadge(forged).kind, "unverified");
    assert.equal(eventVerifiedBadge(forged).provider, "gitlab");
  });
});

test("board shows verified badge for gitlab stamp", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ provider: "gitlab", gitlabUsername: "badge-gl" });
    const dir = await mkdtemp(join(tmpdir(), "iops-rooms-gl-badge-"));
    try {
      await initRoom({ cwd: dir, name: "gl-badge-room" });
      await postNote(dir, { text: "verified gitlab post" });
      const html = await readFile(roomPaths(dir).board, "utf8");
      assert.match(html, /data-verify="verified"/);
      assert.match(html, /Signed locally as @badge-gl \(GitLab\) — not a live check\./);
      assert.match(html, />verified · gitlab</);
      const events = await readEvents(dir);
      const note = events.find((e) => e.type === "note");
      assert.equal(note.gitlab.username, "badge-gl");
      assert.equal(verifyEventIdentity(note).ok, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("sync-merge warns on claimed gitlab without valid sig (warn-only)", async () => {
  await withRoomsHome(async () => {
    const a = await mkdtemp(join(tmpdir(), "iops-rooms-gla-"));
    const b = await mkdtemp(join(tmpdir(), "iops-rooms-glb-"));
    const bundle = await mkdtemp(join(tmpdir(), "iops-rooms-glbundle-"));
    try {
      await initRoom({ cwd: a, name: "gla", code: "VRIFY2" });
      const forged = {
        id: "forged-gitlab-1",
        at: new Date().toISOString(),
        type: "note",
        text: "spoof gl",
        actor: "attacker",
        deviceId: "evil",
        tool: "cli",
        branch: "",
        gitlab: { username: "not-really-gl", id: 1 },
      };
      await appendFile(roomPaths(a).events, `${JSON.stringify(forged)}\n`, "utf8");
      const { exportRoomBundle } = await import("../src/store.js");
      await exportRoomBundle(a, bundle);

      await initRoom({ cwd: b, name: "glb", code: "VRIFY2" });
      const errs = [];
      const orig = console.error;
      console.error = (...args) => errs.push(args.join(" "));
      let result;
      try {
        result = await mergeRoomBundle(bundle, b);
      } finally {
        console.error = orig;
      }
      assert.ok(result.added >= 1);
      assert.ok(result.warnBadGitlab >= 1);
      assert.ok(errs.some((e) => /claims gitlab/.test(e)));
      const events = await readEvents(b);
      assert.ok(events.some((e) => e.id === "forged-gitlab-1"));
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
      await rm(bundle, { recursive: true, force: true });
    }
  });
});
