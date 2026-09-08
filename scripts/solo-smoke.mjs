import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const room = process.argv[2] || root;
const cli = join(root, "src", "cli.js");

// Identity lives in ROOMS_HOME, defaulting to ~/.iops-rooms. A smoke is a throwaway run, so it gets
// a throwaway home — otherwise `npm run smoke:solo` on a developer's machine renames their device.
const SMOKE_HOME = mkdtempSync(join(tmpdir(), "iops-rooms-smoke-"));

const ENV = {
  ROOMS_HOME: process.env.ROOMS_HOME || SMOKE_HOME,
  ROOMS_ACTOR: process.env.ROOMS_ACTOR || "Solo",
  ROOMS_TOOL: process.env.ROOMS_TOOL || "cli",
  ROOMS_DEVICE_ID: process.env.ROOMS_DEVICE_ID || "smoke-solo",
};

function run(argv, env = ENV) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd: room,
      env: { ...process.env, ...env },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out || "exit " + code)),
    );
  });
}

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

console.log("== solo / individual smoke ==");
console.log(await run(["whoami"]));
await run(["init", "--name", "solo-smoke"]).catch(() => {});
console.log((await run(["post", "hello from solo smoke"])).trim());
console.log((await run(["status"])).trim());

// Optional share-diff attribution check (temp file in room)
const sample = join(room, ".room", "_solo-smoke-sample.txt");
await import("node:fs/promises").then(({ writeFile }) =>
  writeFile(sample, "line one\n", "utf8"),
);
console.log(
  (
    await run([
      "share-diff",
      "--path",
      sample,
      "--note",
      "solo sample diff",
    ])
  ).trim(),
);

const board = join(room, ".room", "board.html");
const eventsPath = join(room, ".room", "events.jsonl");
await access(board).catch(() => fail("board.html missing"));
await access(eventsPath).catch(() => fail("events.jsonl missing"));

const events = (await readFile(eventsPath, "utf8"))
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const stamped = events.filter((e) => e.type !== "system");
if (!stamped.length) fail("no non-system event");
for (const ev of stamped.slice(-2)) {
  if (!ev.deviceId) fail(`${ev.type} missing deviceId`);
  if (!ev.actor) fail(`${ev.type} missing actor`);
  if (!ev.tool) fail(`${ev.type} missing tool`);
}

const lastNote = [...stamped].reverse().find((e) => e.type === "note");
const lastDiff = [...stamped].reverse().find((e) => e.type === "diff");
if (!lastNote) fail("missing note event");
if (!lastDiff) fail("missing diff event");
if (!lastDiff.path) fail("diff missing path");

const html = await readFile(board, "utf8");
if (!html.includes(lastNote.deviceId) && !html.includes(String(lastNote.deviceId).slice(0, 12))) {
  fail("board does not show note deviceId");
}
if (!html.includes(lastNote.actor) && !html.includes("Solo")) {
  fail("board does not show actor");
}
if (!html.includes(lastNote.tool) && !html.includes("cli")) {
  fail("board does not show tool");
}
if (!html.includes("path:") && !html.includes("file:")) {
  fail("board missing path line for diff");
}
if (!/1 poster|posters/.test(html)) fail("board missing posters copy");

console.log("Board: " + board);
console.log(
  "PASS solo: room ok; note+diff stamped actor/tool/deviceId; path on diff; board regenerated",
);
console.log("");
console.log("Open (optional): open " + board);
