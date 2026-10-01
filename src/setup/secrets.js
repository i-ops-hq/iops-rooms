/**
 * What a setup may never carry (docs/design/TEAM_SETUPS.md §7.5). Two checks, because two kinds of
 * file need different ones.
 *
 * Some files are never read at all, by name: an `.env`, a key, a credentials store. Every other file
 * a member chooses to export is scanned line by line, and a match refuses the whole file. The refusal
 * names the file, the line and the kind of secret, never the value, and the member fixes the source:
 * a setup's files are somebody's words, and Rooms does not edit them quietly.
 *
 * A guard, not a guarantee. A secret in a format no pattern here knows gets through, and the README
 * says so. Structured config (an MCP server's `env`, a settings `env`) is scrubbed by structure
 * instead, in the tool readers, since that is where credentials live.
 */

import { basename } from "node:path";

/** Files a setup never reads, by name. The list `share-diff` refuses, and the credential stores. */
const NEVER_READ = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /secret/i,
  /credential/i,
  /^auth\.json$/i,
  /^\.claude\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
];

export function neverRead(path) {
  const name = basename(String(path));
  return NEVER_READ.some((re) => re.test(name));
}

/**
 * The kinds a line can hold, most specific first: an Anthropic key starts `sk-ant-` and would also
 * read as an OpenAI one.
 */
const KINDS = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/],
  ["a GitHub token", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}/],
  ["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["a bearer token", /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
];

/** Every line that holds something that looks like a secret: its number and kind, never its text. */
export function scanText(text) {
  const found = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const hit = KINDS.find(([, re]) => re.test(lines[i]));
    if (hit) found.push({ line: i + 1, kind: hit[0] });
  }
  return found;
}

/** Why a file cannot go into a setup, or "". */
export function refusalFor(path, text) {
  if (neverRead(path)) return `${path} is never read: its name says it holds secrets`;
  const [first, ...rest] = scanText(text);
  if (!first) return "";
  const more = rest.length ? `, and ${rest.length} more line${rest.length === 1 ? "" : "s"}` : "";
  return `${path} line ${first.line} looks like ${first.kind}${more}`;
}
