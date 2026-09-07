// Where the bytes in a shared diff are allowed to come from, and how many of them.
//
// `rooms share-diff --path <file>` used to be `readFile(opts.path, "utf8")` with no confinement, no
// size bound and no filter. On 2026-09-07 a fake secret one directory above a room was published
// into events.jsonl and onto the board in a single command; with `--share` on, that room is
// committed and pushed to the whole team. The MCP tool is unaffected — it takes the diff as a
// string and never touches the filesystem — so this is the CLI's problem to fix, and the CLI is
// what git hooks and scripts call.
//
// Three separate controls, because confinement alone fixes only one of them:
//
//   1. Escape.     `../../.ssh/id_rsa` resolves outside the project. Refused unless --allow-outside.
//   2. Secrets.    `.env` lives INSIDE the project, so confinement does nothing for it. Refused by
//                  name, with stdin as the deliberate route for anyone who means it.
//   3. Size.       The old code read a whole file into memory and then sliced to 100 KB, so a 2 GB
//                  file was a 2 GB read. Now at most the cap plus one byte is ever read, and the
//                  extra byte is what tells us truncation happened.
//
// On (2): the test is the BASENAME, not the whole path. `isSecretPathToken` matches /credentials/i
// anywhere in the string, so testing a resolved absolute path would refuse every file under any
// ancestor directory named `credentials` — and a control that over-refuses teaches people to paste
// the override reflexively, which is worse than not having it. Directory-name signals are out of
// scope on purpose.

import { open } from "node:fs/promises";
import { resolve, relative, isAbsolute, basename } from "node:path";
import { isSecretPathToken } from "./hooks.js";

/** Bytes of diff body kept on an event. Shared by the CLI and the MCP server. */
export const MAX_DIFF_BYTES = 100_000;

/** A refusal the caller should print as-is — it names the thing to do instead. */
export class ShareDiffRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ShareDiffRefused";
  }
}

/**
 * Resolve a --path against the project the room belongs to.
 * Returns the absolute path to read and the label to record on the event.
 */
export function resolveSharePath(projectDir, rawPath, { allowOutside = false } = {}) {
  const absolute = resolve(projectDir, rawPath);
  const rel = relative(projectDir, absolute);
  const outside = rel.startsWith("..") || isAbsolute(rel);

  if (outside && !allowOutside) {
    throw new ShareDiffRefused(
      `Refused: ${rawPath} is outside this room's project (${projectDir}).\n` +
        "A room is shared, and with --share it is committed and pushed. If you meant to share a\n" +
        "file from elsewhere, say so: rooms share-diff --path <file> --allow-outside",
    );
  }

  if (isSecretPathToken(basename(absolute))) {
    throw new ShareDiffRefused(
      `Refused: ${basename(absolute)} looks like a secret file (.env, *.pem, *.key, id_rsa,\n` +
        "*secret*, *credentials*), and share-diff writes file contents into the room.\n" +
        "If you have already checked what is in it, pipe it instead — that way the choice of\n" +
        `bytes is yours, not this tool's:  cat ${rawPath} | rooms share-diff --note "..."`,
    );
  }

  return { absolute, label: outside ? absolute : rel || rawPath, outside };
}

/**
 * Read at most the cap, whatever the file's size. Reading cap+1 bytes is what detects truncation
 * without a stat race or a second pass.
 */
export async function readDiffFile(absolute) {
  const handle = await open(absolute, "r");
  try {
    const buf = Buffer.alloc(MAX_DIFF_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const truncated = bytesRead > MAX_DIFF_BYTES;
    const kept = buf.subarray(0, Math.min(bytesRead, MAX_DIFF_BYTES));
    return { diff: kept.toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

/**
 * Cap a diff the caller already holds (stdin, or the MCP tool's string argument).
 *
 * `unrecorded-cap` is the second-highest-count defect class in the I-Ops ledger: a limit that
 * quietly shrinks what gets reported, so the reader sees a smaller number and no reason for it.
 * Both call sites used to do a bare `.slice(0, 100_000)` and record nothing.
 */
export function capDiff(text) {
  const s = String(text ?? "");
  if (s.length <= MAX_DIFF_BYTES) return { diff: s, truncated: false };
  return { diff: s.slice(0, MAX_DIFF_BYTES), truncated: true };
}
