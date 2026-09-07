// Identity has to survive a VM.
//
// A cloned VM template hands every clone the same ~/.iops-rooms/device.json, and an ephemeral VM
// loses it on each spin-up. Either way the machine must set ROOMS_DEVICE_ID from instance metadata.
// That used to stamp every event { mode: "unverified", reason: "env_override" } regardless of a
// valid GitHub or GitLab signature — so "runs in a VM" and "verified by GitHub" were mutually
// exclusive, which is the exact combination an office deployment needs.
//
// The split: ROOMS_ACTOR claims to be a PERSON and nothing can check it, so it stays unverified.
// ROOMS_DEVICE_ID names a MACHINE, which is not an identity claim, so it signs normally and the
// event records deviceAsserted so the board can distinguish the checked half from the asserted one.

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  installFixtureIdentity,
  loadIdentity,
  stampEventIdentity,
  verifyEventIdentity,
  deviceFilePath,
  roomsHomeDir,
} from "../src/identity.js";

async function withRoomsHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-vm-"));
  const prev = { ...process.env };
  process.env.ROOMS_HOME = home;
  delete process.env.ROOMS_ACTOR;
  delete process.env.ROOMS_DEVICE_ID;
  delete process.env.ROOMS_DISPLAY_NAME;
  try {
    await fn(home);
  } finally {
    for (const k of ["ROOMS_HOME", "ROOMS_ACTOR", "ROOMS_DEVICE_ID", "ROOMS_DISPLAY_NAME"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function stamp(idn, id) {
  return stampEventIdentity(
    { actor: idn.displayName, deviceId: idn.deviceId, id, type: "note", text: "vm" },
    idn,
  );
}

test("a VM with ROOMS_DEVICE_ID and a GitHub identity still posts VERIFIED", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "alice" });
    process.env.ROOMS_DEVICE_ID = "vm-instance-i-0abc123";

    const idn = await loadIdentity();
    assert.equal(idn.deviceOverride, true, "device override should be flagged");
    assert.equal(idn.actorOverride, false, "no actor was claimed");

    const stamped = await stamp(idn, "vm1");
    assert.equal(stamped.identity.mode, "verified", "a VM must be able to verify");
    assert.equal(stamped.identity.github, "alice");
    assert.equal(stamped.identity.deviceAsserted, true, "the device label was asserted, not minted");
    assert.equal(stamped.deviceId, "vm-instance-i-0abc123");
    assert.equal(verifyEventIdentity(stamped).ok, true, "signature must verify over the env device id");
  });
});

test("ROOMS_ACTOR alone is still an uncheckable claim and stays unverified", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "alice" });
    process.env.ROOMS_ACTOR = "not-alice";

    const idn = await loadIdentity();
    assert.equal(idn.actorOverride, true);

    const stamped = await stamp(idn, "a1");
    assert.equal(stamped.identity.mode, "unverified");
    assert.equal(stamped.identity.reason, "env_override");
    assert.equal(stamped.sig, undefined, "an unverifiable actor claim must not be signed");
  });
});

test("an actor claim beats a device label — both set stays unverified", async () => {
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "alice" });
    process.env.ROOMS_ACTOR = "not-alice";
    process.env.ROOMS_DEVICE_ID = "vm-9";

    const stamped = await stamp(await loadIdentity(), "b1");
    assert.equal(stamped.identity.mode, "unverified");
    assert.equal(stamped.identity.reason, "env_override");
  });
});

test("a pre-split identity object still refuses to sign an actor override", async () => {
  // Callers that built an identity before actorOverride existed hand us only envOverride.
  await withRoomsHome(async () => {
    await installFixtureIdentity({ login: "alice" });
    const idn = await loadIdentity();
    const legacy = { ...idn, envOverride: true };
    delete legacy.actorOverride;
    delete legacy.deviceOverride;

    const stamped = await stamp(legacy, "c1");
    assert.equal(stamped.identity.mode, "unverified", "coarse flag must still fail closed");
  });
});

test("a new deviceId is 16 bytes, and an existing one is left alone", async () => {
  await withRoomsHome(async () => {
    const fresh = await loadIdentity();
    assert.match(fresh.deviceId, /^[0-9a-f]{32}$/, "new ids are 16 bytes of hex");

    // Anyone already running Rooms keeps the id their history is stamped with.
    await mkdir(roomsHomeDir(), { recursive: true });
    await writeFile(
      deviceFilePath(),
      `${JSON.stringify({ deviceId: "abcd1234", displayName: "old" }, null, 2)}\n`,
      "utf8",
    );
    const grandfathered = await loadIdentity();
    assert.equal(grandfathered.deviceId, "abcd1234", "an existing id must not be regenerated");
  });
});

test("two fresh installs do not collide", async () => {
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    await withRoomsHome(async () => {
      seen.add((await loadIdentity()).deviceId);
    });
  }
  assert.equal(seen.size, 12, "every fresh install should mint a distinct id");
});
