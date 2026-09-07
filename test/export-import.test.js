import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { initRoom, postNote } from "../src/store.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "cli.js");

function run(cwd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out || `exit ${code}`)),
    );
  });
}

test("cli export-room and import-room work", async () => {
  const a = await mkdtemp(join(tmpdir(), "rooms-exp-a-"));
  const b = await mkdtemp(join(tmpdir(), "rooms-exp-b-"));
  const bundle = join(a, "bundle");
  try {
    await initRoom({ cwd: a, name: "exp", code: "EXPORT" });
    await postNote(a, { text: "bundle me" });
    const out = await run(a, ["export-room", bundle]);
    assert.match(out, /exported/);
    await access(join(bundle, "room.json"));
    const imp = await run(b, ["import-room", bundle]);
    assert.match(imp, /imported/);
    await access(join(b, ".room", "board.html"));
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});
