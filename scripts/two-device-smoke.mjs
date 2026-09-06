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

console.log("== Device A whoami ==");
console.log(await run(["whoami"], A));
await run(["init", "--name", "two-device-smoke"], A).catch(() => {});
console.log(await run(["post", "hello from device A"], A));
console.log(await run(["status"], A));
const board = join(room, ".room", "board.html");
console.log("Board: " + board);
console.log("");
console.log("== Tom / Device B (run in another terminal) ==");
console.log("  cd " + room);
console.log("  ROOMS_ACTOR=Tom ROOMS_TOOL=cli ROOMS_DEVICE_ID=smoke-b \\");
console.log("    node " + cli + " post \"hello from device B\"");
console.log("  open " + board);
console.log("");
console.log("Expect posters chip >= 2 and both Ada + Tom on event cards.");
