/**
 * Whether something a setup would run names an exact version (docs/design/TEAM_SETUPS.md §7.4).
 *
 * Adopting a setup runs other people's code as you, so a package runner must name one exact version:
 * `npx -y pkg@1.2.3`, never `npx pkg`, `@latest` or `@^1.2`, since the code can change under the
 * same text. Other programs (git, jq, a script the setup ships) are not packages to pin; they are
 * listed as what the command needs, and a reviewer reads the command itself.
 */

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** docker run's flags that take a value, so the value is not read as the image. */
const DOCKER_VALUE_FLAGS = new Set([
  "-v", "--volume", "-e", "--env", "--env-file", "-p", "--publish", "--name", "-w", "--workdir", "--network",
  "--entrypoint", "-u", "--user", "--mount", "--platform", "-l", "--label", "--add-host", "--cpus", "-m", "--memory",
  "--pull", "--hostname", "-h", "--device", "--cap-add", "--cap-drop", "--security-opt", "--ulimit", "--tmpfs",
]);

/** Package runners: a word that fetches code by name, wherever it stands in a command. */
const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);

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
  if (name === "docker" && (argv[0] === "run" || (argv[0] === "container" && argv[1] === "run"))) {
    // The image is the first word that is neither a flag nor a flag's value: `-v /a:/b` is a volume.
    const image = firstPlain(argv.slice(argv[0] === "run" ? 1 : 2), DOCKER_VALUE_FLAGS).value || "";
    return /@sha256:[0-9a-f]{64}$/.test(image) ? { ok: true, pinned: image } : { ok: false, why: `docker image ${image || "(none)"} has no digest: pin it, as image@sha256:…` };
  }
  return { ok: true, pinned: null, needs: name };
}

/**
 * The words of one simple command, joined the way a shell joins them: `"$DIR"/check.sh` is one
 * word, with its quotes taken off. Enough for the commands hooks hold; it expands nothing.
 */
export function shellWords(line) {
  const words = [];
  for (const m of String(line).matchAll(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\])+/g)) {
    words.push(m[0].replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g, (_, dq, sq, esc) => dq ?? sq ?? esc));
  }
  return words;
}

/**
 * A command line cut into its simple commands, at `;`, `&&`, `||`, `|`, `&`, a new line and a
 * subshell's parentheses, and where a command substitution starts and ends (`$(…)`, backticks).
 * Quotes are respected; a substitution starts unquoted even inside double quotes, as in a shell,
 * and the quoting outside it resumes where it closes.
 */
export function simpleCommands(line) {
  const out = [];
  let cur = "";
  let quote = null;
  const open = [];
  const s = String(line);
  const cut = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      cur += c + (s[i + 1] ?? "");
      i += 1;
      continue;
    }
    const inner = open[open.length - 1];
    if (inner && quote === null && ((inner.closer === "`" && c === "`") || (inner.closer === ")" && c === ")" && inner.depth === 0))) {
      cut();
      quote = open.pop().quote;
      continue;
    }
    if (c === "`" || (c === "$" && s[i + 1] === "(")) {
      cut();
      open.push({ quote, closer: c === "`" ? "`" : ")", depth: 0 });
      quote = null;
      if (c === "$") i += 1;
      continue;
    }
    if (quote === '"') {
      cur += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (inner && c === "(") inner.depth += 1;
    if (inner && c === ")") inner.depth -= 1;
    if (";|&\n()".includes(c)) {
      cut();
      continue;
    }
    cur += c;
  }
  cut();
  return out;
}

/** Shell words that are not programs: what a hook's command needs is never one of these. */
const NOT_PROGRAMS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "!", "{", "}",
  "[", "[[", "]]", "test", "true", "false", "exit", "return", "echo", "printf", "cd", "export", "set", "unset",
  "read", "local", "source", ".", "eval", "exec", "command", "builtin", "shift", "wait", "trap", "time",
]);

/** A single simple command, split the way a shell would, and checked. */
export function checkCommandLine(line) {
  const words = shellWords(line);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const [cmd, ...args] = words;
  return checkRun(cmd, args);
}

/**
 * Every package a whole command line would fetch, and every program it needs, or why it cannot go
 * into a setup. A runner is looked for anywhere in each simple command, not only first, so
 * `sudo npx pkg` and `timeout 5 npx pkg` are checked like `npx pkg`.
 */
export function checkShellLine(line) {
  const pinned = [];
  const needs = [];
  for (const command of simpleCommands(line)) {
    const words = shellWords(command);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    while (words.length && NOT_PROGRAMS.has(words[0])) words.shift();
    if (!words.length) continue;
    if (/^(\/|[A-Za-z]:\\)/.test(words[0])) return { ok: false, why: checkRun(words[0]).why };
    for (let i = 0; i < words.length; i++) {
      const w = words[i].split(/[\\/]/).pop();
      const next = words[i + 1];
      const runner = RUNNERS.has(w) || (w === "pnpm" && next === "dlx") || (w === "uv" && next === "tool") || (w === "go" && next === "run") || (w === "docker" && (next === "run" || next === "container"));
      if (!runner) continue;
      const r = checkRun(words[i], words.slice(i + 1));
      if (!r.ok) return { ok: false, why: r.why };
      if (r.pinned && !pinned.includes(r.pinned)) pinned.push(r.pinned);
    }
    const first = words[0];
    if (/^[A-Za-z][\w.+-]*$/.test(first) && !NOT_PROGRAMS.has(first) && !needs.includes(first)) needs.push(first);
  }
  return { ok: true, pinned, needs };
}
