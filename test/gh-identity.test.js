// Verified GitHub identity from the `gh` CLI the user already has.
//
// The device flow needs an OAuth App registered by whoever ships this package, with its client id
// compiled in — so every user would authorise an I-Ops application against their GitHub account and
// see it in their authorised-apps list forever. That sits badly beside a product whose whole claim
// is not being in the middle of anything.
//
// `gh` needs nothing from us: the developer audience for this tool already has it logged in, the
// credential is theirs, and they can revoke it without asking anyone. It is the same binary
// `scm-status` already shells out to.
//
// `exec` is injected throughout, so these never depend on whether the machine running them has gh
// installed or is logged in — which would make them a test of the runner rather than of this code.

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { authGithubCli, authStatus, identityFilePath } from "../src/identity.js";

async function withRoomsHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "iops-rooms-gh-"));
  const prev = process.env.ROOMS_HOME;
  process.env.ROOMS_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.ROOMS_HOME;
    else process.env.ROOMS_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

const ghReturning = (user) => async (cmd, args) => {
  assert.equal(cmd, "gh");
  assert.deepEqual(args, ["api", "user"], "the only call made is a read of your own account");
  return { stdout: JSON.stringify(user) };
};

test("a logged-in gh mints the same verified identity the device flow would", async () => {
  await withRoomsHome(async () => {
    const r = await authGithubCli({
      exec: ghReturning({ login: "octocat", id: 583231, email: "octo@example.com" }),
    });
    assert.equal(r.via, "gh");
    assert.equal(r.user.login, "octocat");

    // Written to the same store, so nothing downstream can tell which route minted it.
    const saved = JSON.parse(await readFile(identityFilePath(), "utf8"));
    assert.equal(saved.github.login, "octocat");
    assert.equal(saved.github.id, 583231);
    assert.ok(saved.publicKey, "and a signing key exists");

    const status = await authStatus();
    assert.equal(status.github?.login, "octocat");
  });
});

test("it asks gh for nothing but the account — no repo, no token, no scopes", async () => {
  await withRoomsHome(async () => {
    const calls = [];
    await authGithubCli({
      exec: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return { stdout: JSON.stringify({ login: "ada", id: 1 }) };
      },
    });
    assert.deepEqual(calls, ["gh api user"], "one read-only call, and it is the whole integration");
  });
});

test("no gh installed says how to fix it, and names the other route", async () => {
  await withRoomsHome(async () => {
    await assert.rejects(
      () =>
        authGithubCli({
          exec: async () => {
            const err = new Error("spawn gh ENOENT");
            err.code = "ENOENT";
            throw err;
          },
        }),
      (err) => {
        assert.match(err.message, /gh is not installed/);
        assert.match(err.message, /gh auth login/, "the fix is named");
        assert.match(err.message, /ROOMS_GITHUB_CLIENT_ID/, "and so is the alternative");
        return true;
      },
    );
  });
});

test("gh installed but logged out is a different message from gh missing", async () => {
  await withRoomsHome(async () => {
    await assert.rejects(
      () =>
        authGithubCli({
          exec: async () => {
            const err = new Error("exit 1");
            err.stderr = "gh: To get started with GitHub CLI, please run: gh auth login";
            throw err;
          },
        }),
      (err) => {
        assert.match(err.message, /could not read your GitHub account/);
        assert.doesNotMatch(err.message, /not installed/, "a logged-out gh is installed");
        return true;
      },
    );
  });
});

test("a reply that is not JSON, or has no login, is refused rather than half-stored", async () => {
  await withRoomsHome(async () => {
    await assert.rejects(
      () => authGithubCli({ exec: async () => ({ stdout: "not json at all" }) }),
      /did not return JSON/,
    );
    await assert.rejects(
      () => authGithubCli({ exec: async () => ({ stdout: JSON.stringify({ id: 7 }) }) }),
      /no login/,
    );
    // Nothing should have been written on either failure.
    await assert.rejects(() => readFile(identityFilePath(), "utf8"), "no partial identity on disk");
  });
});

test("an account with a private email still verifies", async () => {
  // GitHub returns email: null when the user keeps it private, which is common and not an error.
  await withRoomsHome(async () => {
    const r = await authGithubCli({ exec: ghReturning({ login: "quiet", id: 9, email: null }) });
    assert.equal(r.user.login, "quiet");
    assert.equal(r.user.email, null);
    const saved = JSON.parse(await readFile(identityFilePath(), "utf8"));
    assert.equal(saved.github.login, "quiet");
  });
});
