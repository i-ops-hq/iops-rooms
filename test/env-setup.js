// Runs before any test file, in the test process, via `node --import`.
//
// Every command in this package keeps its identity in ROOMS_HOME, defaulting to `~/.iops-rooms`.
// A dozen test files spawn the real CLI with `{ ...process.env }`, so without this the suite wrote
// a device.json — and, through the identity tests' fixtures, a VERIFIED GitHub identity — into the
// developer's own store. Running `npm test` renamed the machine to "cmd-test" and left it claiming
// to be `octocat`.
//
// Setting it here rather than in each test fixes it at the layer every path flows through:
// spawned children inherit it, and a file that forgets its own temp home still cannot reach the
// real one. `no-home-pollution.test.js` is the guard that this stayed wired up.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ROOMS_HOME) {
  process.env.ROOMS_HOME = mkdtempSync(join(tmpdir(), "iops-rooms-suite-"));
}
// Claude Code's own folder, which `rooms setup` reads from and, with --user, writes to. Set every time,
// even when the developer has their own CLAUDE_CONFIG_DIR: a test that adopts a setup with --user must
// land in a scratch folder, never in the ~/.claude of whoever runs the suite. It also holds the
// .claude.json the reader would otherwise find in the real home.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "iops-rooms-claude-"));
// Codex's folder, for the same reason: `rooms setup export --user` reads it and `adopt --user` writes it.
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "iops-rooms-codex-"));
// No test wants a browser window, and a headless CI box has nothing to open one with.
process.env.ROOMS_NO_OPEN = process.env.ROOMS_NO_OPEN || "1";
// No test asks GitHub anything: a pull request's state would depend on the network and on whoever
// runs the suite. The reader is tested with its `gh` replaced (test/right-now.test.js).
process.env.ROOMS_NO_GH = "1";

// The suite also runs inside agents' shells (this repository is built in one), and those set the
// variables Rooms reads to tell where a commit was made. Left in, a test of a commit made by hand
// passes in CI and fails inside Claude Code. A test that wants a marker sets it itself.
import { MARKER_NAMES } from "../src/agent-markers.js";
for (const name of MARKER_NAMES) delete process.env[name];
