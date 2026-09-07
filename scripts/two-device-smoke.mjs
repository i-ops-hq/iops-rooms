import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const room = process.argv[2] || root;
const cli = join(root, "src", "cli.js");

function run(argv, env = {}) {
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

const A = {
  ROOMS_ACTOR: process.env.ROOMS_ACTOR_A || "Ada",
  ROOMS_TOOL: "cli",
  ROOMS_DEVICE_ID: process.env.ROOMS_DEVICE_A || "smoke-a",
};

const B = {
  ROOMS_ACTOR: process.env.ROOMS_ACTOR_B || "Tom",
  ROOMS_TOOL: "cli",
  ROOMS_DEVICE_ID: process.env.ROOMS_DEVICE_B || "smoke-b",
};

function fail(msg) {
  console.error("FAIL two-device: " + msg);
  process.exit(1);
}

console.log("== Device A ==");
console.log(await run(["whoami"], A));
await run(["init", "--name", "two-device-smoke"], A).catch(() => {});
console.log(await run(["post", "hello from device A"], A));

console.log("== Device B ==");
console.log(await run(["post", "hello from device B"], B));
console.log(await run(["status"], A));

// This used to stop here and PRINT the device-B steps for a human to run in another terminal,
// which meant the script asserted nothing and could not fail — and it was wired into CI as a
// check. A green check that cannot go red is worse than no check, so device B now runs here and
// the outcome is verified rather than described.
const { readFile } = await import("node:fs/promises");
const board = join(room, ".room", "board.html");
const eventsPath = join(room, ".room", "events.jsonl");

const events = (await readFile(eventsPath, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((e) => e.type !== "system");

const fromA = events.filter((e) => e.actor === A.ROOMS_ACTOR);
const fromB = events.filter((e) => e.actor === B.ROOMS_ACTOR);
if (!fromA.length) fail(`no events from ${A.ROOMS_ACTOR}`);
if (!fromB.length) fail(`no events from ${B.ROOMS_ACTOR}`);

const devices = new Set(events.map((e) => e.deviceId).filter(Boolean));
if (devices.size < 2) {
  fail(`expected two device ids, saw ${devices.size}: ${[...devices].join(", ")}`);
}

const html = await readFile(board, "utf8");
for (const who of [A.ROOMS_ACTOR, B.ROOMS_ACTOR]) {
  if (!html.includes(who)) fail(`${who} is in events.jsonl but not on the rendered board`);
}

console.log("Board: " + board);
console.log(
  `PASS two-device: ${A.ROOMS_ACTOR} + ${B.ROOMS_ACTOR} on one room, ` +
    `${devices.size} device ids, both rendered on the board`,
);
