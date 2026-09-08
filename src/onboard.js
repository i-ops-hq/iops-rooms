// The one-time offer to link a GitHub account.
//
// Verified identity is worth having and nobody was ever told how to get it: the board said
// "unverified — rooms auth github" and that was the whole onboarding. But an offer is only an
// improvement if it can never get in the way, so every guard here is about NOT asking:
//
//   · never without a terminal on both ends — a prompt in `npx … | tee log` is a hang
//   · never in CI, and never when ROOMS_NO_PROMPT is set
//   · never when the account is already linked
//   · never twice — a "no" is remembered
//   · never when `gh` cannot answer, because then the answer would be a lecture, not a question
//
// And it runs AFTER the board has been written and opened. Someone who ignores it still got the
// thing they asked for; the prompt is an afterthought they can walk away from.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { authGithubCli, loadVerifiedIdentity, roomsHomeDir } from "./identity.js";

const promptFile = () => join(roomsHomeDir(), "prompt.json");

async function readPromptState() {
  try {
    return JSON.parse(await readFile(promptFile(), "utf8"));
  } catch {
    return {};
  }
}

/** A "no" is remembered so the second run is quiet. Kept out of device.json, which is rewritten. */
async function rememberDeclined(at) {
  const state = await readPromptState();
  await mkdir(roomsHomeDir(), { recursive: true });
  await writeFile(
    promptFile(),
    `${JSON.stringify({ ...state, githubDeclinedAt: at }, null, 2)}\n`,
    "utf8",
  );
}

/** Whether asking is appropriate at all. Returns a reason rather than a bare false, so the CLI can
 *  say the useful half of it — "gh is installed but logged out" is worth one line; a pipe is not. */
export async function shouldOfferGithubLink({ env = process.env, input, output, status } = {}) {
  if (env.ROOMS_NO_PROMPT || env.CI || env.ROOMS_NO_OPEN) return { ask: false, reason: "non-interactive" };
  if (!input?.isTTY || !output?.isTTY) return { ask: false, reason: "not a terminal" };
  // loadVerifiedIdentity, not authStatus: the latter goes through loadIdentity, which WRITES a
  // device.json when there is not one. Asking whether someone wants an identity must not be the
  // thing that gives them one.
  const s = status || (await loadVerifiedIdentity());
  if (s?.github?.login || s?.gitlab?.username) return { ask: false, reason: "already linked" };
  if ((await readPromptState()).githubDeclinedAt) return { ask: false, reason: "declined before" };
  return { ask: true, reason: "" };
}

/**
 * Ask once, link if they say yes.
 *
 * `gh` is checked BEFORE the question rather than after: offering to link an account and then
 * failing because the CLI is missing turns a yes into an error message, which is worse than never
 * having asked. A missing `gh` gets one line and no prompt, and no decline is recorded — they may
 * install it tomorrow.
 */
export async function offerGithubLink({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  exec,
  timeoutMs = 30_000,
  now = () => new Date().toISOString(),
} = {}) {
  const gate = await shouldOfferGithubLink({ env, input, output });
  if (!gate.ask) return { asked: false, linked: false, reason: gate.reason };

  let login = "";
  try {
    const probe = await (exec
      ? exec("gh", ["api", "user"])
      : import("node:child_process").then(({ execFile }) =>
          import("node:util").then(({ promisify }) => promisify(execFile)("gh", ["api", "user"])),
        ));
    login = JSON.parse(String(probe.stdout || "")).login || "";
  } catch {
    return { asked: false, linked: false, reason: "gh unavailable" };
  }
  if (!login) return { asked: false, linked: false, reason: "gh unavailable" };

  const rl = createInterface({ input, output });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let answer = "";
  try {
    answer = await rl.question(
      `\nLink this device to github.com/${login}? Your posts would carry a verified name.\n` +
        `Reads your account through the gh CLI you are already signed in to. Nothing is uploaded. [y/N] `,
      { signal: ac.signal },
    );
  } catch {
    // Walked away, or the terminal went. Not an answer, so nothing is remembered.
    return { asked: true, linked: false, reason: "no answer" };
  } finally {
    clearTimeout(timer);
    rl.close();
  }

  if (!/^y(es)?$/i.test(String(answer).trim())) {
    await rememberDeclined(now());
    return { asked: true, linked: false, reason: "declined" };
  }

  try {
    const r = await authGithubCli(exec ? { exec } : {});
    output.write(`linked github.com/${r.user.login}\n`);
    return { asked: true, linked: true, login: r.user.login, reason: "" };
  } catch (err) {
    output.write(`could not link: ${err.message}\n`);
    return { asked: true, linked: false, reason: "failed" };
  }
}
