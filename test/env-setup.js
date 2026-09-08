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
// No test wants a browser window, and a headless CI box has nothing to open one with.
process.env.ROOMS_NO_OPEN = process.env.ROOMS_NO_OPEN || "1";
