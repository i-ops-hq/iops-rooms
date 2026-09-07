import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(PKG_ROOT, "src", "cli.js");
const MARKER = "# rooms-by-iops-hook";

/** Paths / names we never want echoed into room posts from hook summaries. */
function isSecretPathToken(tok) {
  const t = String(tok || "");
  if (!t) return false;
  if (/(^|[/\\])\.env(\.[^/\\]*)?$/i.test(t)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(t)) return true;
  if (/(^|[/\\])(id_rsa|id_ed25519)$/i.test(t)) return true;
  if (/credentials/i.test(t)) return true;
  if (/(^|[/\\])[^/\\]*secret[^/\\]*$/i.test(t)) return true;
  return false;
}

export function redactSecretPaths(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/(\s+)/)
        .map((part) => (part.match(/^\s+$/) ? part : isSecretPathToken(part) ? "[redacted-secret-path]" : part))
        .join(""),
    )
    .join("\n");
}


async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitRoot(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 4000,
    });
    return String(stdout || "").trim();
  } catch {
    return null;
  }
}

function resolveNodeBin() {
  return process.execPath;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Generate post-commit hook body. Exported for tests. */
export function generatePostCommitHook({ nodeBin, cliPath } = {}) {
  const node = nodeBin || resolveNodeBin();
  const cli = cliPath || CLI_PATH;
  return `#!/bin/sh
${MARKER}
# Local opt-in only — not IDE telemetry. Uninstall: rooms hooks uninstall
set -e
NODE=${shellQuote(node)}
CLI=${shellQuote(cli)}
export ROOMS_TOOL=git-hook
SUBJECT=$(git log -1 --pretty=%s 2>/dev/null || echo "")
HASH=$(git log -1 --pretty=%h 2>/dev/null || echo "")
# Prefer --stat summary over full diff; redact secret-looking paths
STAT=$(git show --stat --pretty=format: HEAD 2>/dev/null | head -c 4000 || true)
STAT=$(printf '%s' "$STAT" | sed -E 's#(^|[[:space:]/])(\\.env(\\.[^[:space:]]*)?|[^[:space:]]*\\.pem|[^[:space:]]*\\.key|id_rsa|id_ed25519|[^[:space:]]*credentials[^[:space:]]*|[^[:space:]]*secret[^[:space:]]*)#\\1[redacted-secret-path]#gI')
MSG=$(printf 'commit %s: %s\\n%s' "$HASH" "$SUBJECT" "$STAT")
"$NODE" "$CLI" post "$MSG" >/dev/null 2>&1 || true
`;
}

/** Generate post-checkout hook body. Exported for tests. */
export function generatePostCheckoutHook({ nodeBin, cliPath } = {}) {
  const node = nodeBin || resolveNodeBin();
  const cli = cliPath || CLI_PATH;
  return `#!/bin/sh
${MARKER}
# Local opt-in only — not IDE telemetry. Uninstall: rooms hooks uninstall
# Args: $1 prev HEAD, $2 new HEAD, $3 flag (1 = branch checkout)
set -e
NODE=${shellQuote(node)}
CLI=${shellQuote(cli)}
export ROOMS_TOOL=git-hook
if [ "$3" = "1" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ -n "$BRANCH" ]; then
    "$NODE" "$CLI" post "checked out branch $BRANCH" >/dev/null 2>&1 || true
  fi
fi
`;
}

function isOurs(body) {
  return String(body || "").includes(MARKER);
}

async function writeHook(path, body, { force = false } = {}) {
  if (await exists(path)) {
    const prev = await readFile(path, "utf8");
    if (!isOurs(prev) && !force) {
      throw new Error(
        `Refusing to overwrite existing hook ${path} (not a Rooms hook). Pass --force to overwrite.`,
      );
    }
    if (!isOurs(prev) && force) {
      await writeFile(`${path}.rooms-backup`, prev, "utf8");
    }
  }
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

/**
 * Install opt-in git hooks into the current repo's .git/hooks/.
 * Never auto-installs — caller must invoke `rooms hooks install`.
 */
export async function installHooks({
  cwd = process.cwd(),
  force = false,
  postCommit = true,
  postCheckout = true,
  nodeBin,
  cliPath,
} = {}) {
  const root = await gitRoot(cwd);
  if (!root) {
    throw new Error("Not a git repository. `rooms hooks install` needs git.");
  }
  const hooksDir = join(root, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const written = [];
  const opts = { nodeBin: nodeBin || resolveNodeBin(), cliPath: cliPath || CLI_PATH };
  if (postCommit) {
    const path = join(hooksDir, "post-commit");
    await writeHook(path, generatePostCommitHook(opts), { force });
    written.push(path);
  }
  if (postCheckout) {
    const path = join(hooksDir, "post-checkout");
    await writeHook(path, generatePostCheckoutHook(opts), { force });
    written.push(path);
  }
  return { root, hooksDir, written, nodeBin: opts.nodeBin, cliPath: opts.cliPath };
}

/** Remove Rooms-managed hooks (leaves foreign hooks alone). */
export async function uninstallHooks({ cwd = process.cwd() } = {}) {
  const root = await gitRoot(cwd);
  if (!root) {
    throw new Error("Not a git repository.");
  }
  const hooksDir = join(root, ".git", "hooks");
  const removed = [];
  for (const name of ["post-commit", "post-checkout"]) {
    const path = join(hooksDir, name);
    if (!(await exists(path))) continue;
    const body = await readFile(path, "utf8");
    if (!isOurs(body)) continue;
    await unlink(path);
    removed.push(path);
    const backup = `${path}.rooms-backup`;
    if (await exists(backup)) {
      await rename(backup, path);
    }
  }
  return { root, removed };
}

export { MARKER, CLI_PATH, PKG_ROOT, isSecretPathToken };
