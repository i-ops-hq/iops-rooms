// The one-time offer to link a GitHub account.
//
// Almost every test here is about NOT asking. A prompt that appears in a pipeline, in CI, or on a
// second run is worse than no prompt at all — `npx iops-rooms open | tee log` that stops dead
// waiting for a keypress nobody can see is the failure mode, and it looks like a hang, not a
// question. So the guards are the feature and the question is the easy part.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { offerGithubLink, shouldOfferGithubLink } from "../src/onboard.js";
import { identityFilePath, installFixtureIdentity, roomsHomeDir } from "../src/identity.js";

/** A stream pair readline will talk to, with isTTY forced either way. */
function tty(isTTY = true, typed = "") {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = isTTY;
  output.isTTY = isTTY;
  let written = "";
  output.on("data", (d) => (written += d));
  if (typed !== null) setImmediate(() => input.write(`${typed}\n`));
  return { input, output, seen: () => written };
}

const ghUser = (login) => async (cmd, args) => {
  assert.equal(cmd, "gh");
  assert.deepEqual(args, ["api", "user"]);
  return { stdout: JSON.stringify({ login, id: 7, email: null }) };
};

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-onboard-"));
  const prev = process.env.ROOMS_HOME;
  const prevNoOpen = process.env.ROOMS_NO_OPEN;
  process.env.ROOMS_HOME = home;
  // env-setup.js sets ROOMS_NO_OPEN for the whole suite, and that is one of the gates.
  delete process.env.ROOMS_NO_OPEN;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.ROOMS_HOME;
    else process.env.ROOMS_HOME = prev;
    if (prevNoOpen !== undefined) process.env.ROOMS_NO_OPEN = prevNoOpen;
    await rm(home, { recursive: true, force: true });
  }
}

test("a pipe is never asked a question", async () => {
  await withHome(async () => {
    const { input, output } = tty(false, null);
    const r = await offerGithubLink({ env: {}, input, output, exec: ghUser("octocat") });
    assert.equal(r.asked, false);
    assert.equal(r.reason, "not a terminal");
  });
});

test("CI and ROOMS_NO_PROMPT are never asked either", async () => {
  await withHome(async () => {
    for (const env of [{ CI: "true" }, { ROOMS_NO_PROMPT: "1" }, { ROOMS_NO_OPEN: "1" }]) {
      const { input, output } = tty(true, null);
      const r = await offerGithubLink({ env, input, output, exec: ghUser("octocat") });
      assert.equal(r.asked, false, `${Object.keys(env)[0]} must not prompt`);
      assert.equal(r.reason, "non-interactive");
    }
  });
});

test("an account already linked is not asked to link again", async () => {
  await withHome(async () => {
    await installFixtureIdentity({ login: "octocat" });
    const { input, output } = tty(true, null);
    const r = await offerGithubLink({ env: {}, input, output, exec: ghUser("octocat") });
    assert.equal(r.asked, false);
    assert.equal(r.reason, "already linked");
  });
});

test("no is remembered, so the second run is quiet", async () => {
  await withHome(async () => {
    const first = tty(true, "n");
    const a = await offerGithubLink({ env: {}, ...first, exec: ghUser("octocat") });
    assert.equal(a.asked, true);
    assert.equal(a.linked, false);
    assert.equal(a.reason, "declined");

    const second = tty(true, "y");
    const b = await offerGithubLink({ env: {}, ...second, exec: ghUser("octocat") });
    assert.equal(b.asked, false, "asking twice is nagging");
    assert.equal(b.reason, "declined before");
    assert.equal(second.seen(), "", "and it prints nothing at all");
  });
});

test("a missing gh gets no question and no remembered no", async () => {
  await withHome(async () => {
    const { input, output } = tty(true, null);
    const r = await offerGithubLink({
      env: {},
      input,
      output,
      exec: async () => {
        const e = new Error("spawn gh ENOENT");
        e.code = "ENOENT";
        throw e;
      },
    });
    assert.equal(r.asked, false);
    assert.equal(r.reason, "gh unavailable");
    assert.equal(output.read(), null, "offering and then failing is worse than not offering");

    // Nothing recorded: they may install gh tomorrow, and a decline they never made would
    // silence the offer forever.
    const { input: i2, output: o2 } = tty(true, "y");
    const r2 = await offerGithubLink({ env: {}, input: i2, output: o2, exec: ghUser("ada") });
    assert.equal(r2.asked, true, "still asked once gh works");
    assert.equal(r2.linked, true);
  });
});

test("yes links the account through gh and says so", async () => {
  await withHome(async () => {
    const { input, output, seen } = tty(true, "y");
    const r = await offerGithubLink({ env: {}, input, output, exec: ghUser("ada") });
    assert.equal(r.linked, true);
    assert.equal(r.login, "ada");
    assert.match(seen(), /github\.com\/ada/);
    assert.match(seen(), /Nothing is uploaded/, "the question says what it does before it is answered");

    const saved = JSON.parse(await readFile(identityFilePath(), "utf8"));
    assert.equal(saved.github.login, "ada");
  });
});

test("walking away is not an answer, and is not recorded as one", async () => {
  await withHome(async () => {
    const { input, output } = tty(true, null); // nothing is ever typed
    const r = await offerGithubLink({ env: {}, input, output, exec: ghUser("ada"), timeoutMs: 60 });
    assert.equal(r.asked, true);
    assert.equal(r.linked, false);
    assert.equal(r.reason, "no answer");

    const gate = await shouldOfferGithubLink({ env: {}, input: { isTTY: true }, output: { isTTY: true } });
    assert.equal(gate.ask, true, "a timeout must not silence the offer forever");
  });
});

test("a stray word is a no, not a yes", async () => {
  await withHome(async () => {
    for (const typed of ["", "later", "Y E S", "no"]) {
      await rm(join(roomsHomeDir(), "prompt.json"), { force: true });
      const { input, output } = tty(true, typed);
      const r = await offerGithubLink({ env: {}, input, output, exec: ghUser("ada") });
      assert.equal(r.linked, false, `"${typed}" must not link an account`);
    }
    // Only a real yes does.
    for (const typed of ["y", "Y", "yes", " yes "]) {
      await rm(join(roomsHomeDir(), "prompt.json"), { force: true });
      await rm(identityFilePath(), { force: true });
      const { input, output } = tty(true, typed);
      const r = await offerGithubLink({ env: {}, input, output, exec: ghUser("ada") });
      assert.equal(r.linked, true, `"${typed}" is a yes`);
    }
  });
});

test("asking about an identity does not create one", async () => {
  // The gate used to go through authStatus, which goes through loadIdentity, which writes a
  // device.json when there is not one. Merely declining the question minted the machine an
  // identity — the same defect as a board render doing it, one module over.
  await withHome(async (home) => {
    const { readdir } = await import("node:fs/promises");

    const { input, output } = tty(false, null); // not a terminal: never even asked
    await offerGithubLink({ env: {}, input, output, exec: ghUser("ada") });
    assert.deepEqual(await readdir(home), [], "a run that asks nothing writes nothing");

    const asked = tty(true, "n");
    await offerGithubLink({ env: {}, ...asked, exec: ghUser("ada") });
    assert.deepEqual(await readdir(home), ["prompt.json"], "a no leaves the remembered no, and nothing else");
    void writeFile;
  });
});
