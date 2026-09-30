/**
 * Whether something a setup would run names an exact version (docs/design/TEAM_SETUPS.md §7.4).
 *
 * Adopting a setup runs other people's code as you, so a package runner must name one exact version:
 * `npx -y pkg@1.2.3`, never `npx pkg`, `@latest` or `@^1.2`, since the code can change under the
 * same text. Other programs (git, jq, a script the setup ships) are not packages to pin; they are
 * listed as what the command needs, and a reviewer reads the command itself.
 */

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `pkg@1.2.3` or `@scope/pkg@1.2.3`: the version, or null. */
function npmVersion(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const version = spec.slice(at + 1);
  return SEMVER.test(version) ? version : null;
}

/** The first argument that is not a flag, skipping a flag's value where it takes one. */
function firstPlain(args, takesValue = new Set()) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (takesValue.has(a)) {
      i += 1;
      continue;
    }
    if (!a.startsWith("-")) return { value: a, index: i };
  }
  return { value: null, index: -1 };
}

/**
 * Check a command and its arguments. `{ ok, pinned, needs, why }`: `pinned` is the package and
 * version a runner would fetch; `needs` is a program that must already be on the machine.
 */
export function checkRun(command, args = []) {
  const cmd = String(command || "").trim();
  const argv = (args || []).map(String);
  const name = cmd.split(/[\\/]/).pop();
  if (!cmd) return { ok: false, why: "no command" };
  if (/^(\/|[A-Za-z]:\\)/.test(cmd)) {
    return { ok: false, why: `${cmd} is a path on the exporting machine; list the program as a requirement instead` };
  }
  const exact = (spec, runner) =>
    spec && npmVersion(spec)
      ? { ok: true, pinned: spec }
      : { ok: false, why: `${runner} ${spec || "(no package)"} names no exact version: pin it, as ${runner} pkg@1.2.3` };
  if (name === "npx" || name === "bunx" || name === "pnpx") {
    const p = argv.findIndex((a) => a === "-p" || a === "--package");
    const spec = p >= 0 ? argv[p + 1] : (argv.find((a) => a.startsWith("--package=")) || "").slice(10) || firstPlain(argv).value;
    return exact(spec, name);
  }
  if (name === "pnpm" && argv[0] === "dlx") return exact(firstPlain(argv.slice(1)).value, "pnpm dlx");
  if (name === "uvx" || (name === "uv" && argv[0] === "tool" && argv[1] === "run")) {
    const rest = name === "uvx" ? argv : argv.slice(2);
    const from = rest.findIndex((a) => a === "--from");
    const spec = from >= 0 ? rest[from + 1] : firstPlain(rest, new Set(["--with", "--python", "--index-url"])).value;
    if (spec && (/^[A-Za-z0-9._-]+==\d[\w.+-]*$/.test(spec) || /^[A-Za-z0-9._-]+@\d[\w.+-]*$/.test(spec))) return { ok: true, pinned: spec };
    return { ok: false, why: `uvx ${spec || "(no package)"} names no exact version: pin it, as uvx pkg@1.2.3 or --from pkg==1.2.3` };
  }
  if (name === "go" && argv[0] === "run") {
    const spec = firstPlain(argv.slice(1)).value || "";
    return /@v\d+\.\d+\.\d+/.test(spec) ? { ok: true, pinned: spec } : { ok: false, why: `go run ${spec} names no exact version: pin it, as pkg@v1.2.3` };
  }
  if (name === "docker" && (argv[0] === "run" || argv[0] === "container")) {
    const image = argv.find((a) => /[/:@]/.test(a) && !a.startsWith("-")) || "";
    return /@sha256:[0-9a-f]{64}$/.test(image) ? { ok: true, pinned: image } : { ok: false, why: `docker image ${image || "(none)"} has no digest: pin it, as image@sha256:…` };
  }
  return { ok: true, pinned: null, needs: name };
}

/** A single command line, split the way a shell would for simple cases, and checked. */
export function checkCommandLine(line) {
  const words = String(line).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const [cmd, ...args] = words.map((w) => w.replace(/^["']|["']$/g, ""));
  return checkRun(cmd, args);
}
