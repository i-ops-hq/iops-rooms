/**
 * What a setup may let Claude Code do without asking (docs/design/TEAM_SETUPS.md §8.2).
 *
 * Adopting a teammate's setup must never switch off Claude Code asking you. So a setup carries no
 * `bypassPermissions` or `auto` mode, anywhere, and no rule that lets any command run: `Bash`,
 * `Bash(*)`, a rule that starts with a wildcard, or one that hands everything to a shell or an
 * interpreter, such as `Bash(sh -c *)` or `Bash(python3 *)`. A person can set those for themselves;
 * a teammate's setup cannot set them for you. A guard, not a guarantee: a rule can look narrow and
 * not be (§9.6), which is why every rule is also shown as what it allows before it is adopted.
 */

/** The modes Claude Code documents (2.1.277), and the two a setup may never set. */
const MODES = new Set(["default", "manual", "acceptEdits", "plan", "dontAsk"]);
const NEVER = new Set(["bypassPermissions", "auto"]);

/** Why a permission mode cannot come from a setup, or "". */
export function modeRefusal(mode) {
  if (mode === undefined || mode === null || mode === "") return "";
  if (NEVER.has(mode)) return `permission mode ${mode} stops Claude Code asking; a setup cannot set it for someone else`;
  if (!MODES.has(mode)) return "a permission mode this version does not know";
  return "";
}

/** Programs that run whatever follows them: any rule for these with a wildcard allows anything. */
const ALWAYS_WIDE = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd", "eval", "exec", "sudo", "su",
  "doas", "xargs",
]);
/** Programs that run anything when allowed with any arguments at all: `Bash(node *)`. */
const WIDE_ALONE = new Set([
  "env", "nohup", "time", "nice", "timeout", "watch", "python", "python2", "python3", "node", "deno", "bun", "ruby",
  "perl", "php", "lua", "osascript", "npx", "bunx", "pnpx", "uvx", "uv", "docker", "npm", "pnpm", "yarn", "go",
]);
const TRAILING_WILDCARD = /(?::\*|\s\*|\*)$/;

/** Why a permission rule would let any command run without asking, or "". */
export function wideRule(rule) {
  const r = String(rule).trim();
  const m = /^(Bash|PowerShell)(?:\(([\s\S]*)\))?$/.exec(r);
  if (!m) return "";
  const inner = (m[2] ?? "").trim();
  if (!inner || /^[*:\s]*$/.test(inner)) return `${r} lets Claude run any command without asking`;
  if (inner.startsWith("*")) return `${r} matches any command`;
  if (!TRAILING_WILDCARD.test(inner)) return "";
  const prefix = inner.replace(TRAILING_WILDCARD, "").trim();
  const words = prefix.split(/\s+/);
  const first = words[0].split(/[\\/]/).pop();
  if (ALWAYS_WIDE.has(first) || (words.length === 1 && WIDE_ALONE.has(first))) return `${r} runs anything through ${first}`;
  return "";
}

/** A rule as what it allows, in words, for the preview a person approves. */
export function describeRule(list, rule) {
  const r = String(rule);
  const bash = /^(Bash|PowerShell)\(([\s\S]*)\)$/.exec(r);
  if (bash) {
    const inner = bash[2].trim();
    const any = TRAILING_WILDCARD.test(inner);
    const cmd = inner.replace(TRAILING_WILDCARD, "").trim();
    if (list === "deny") return `never runs "${cmd}"${any ? " with any arguments" : ""}`;
    return `runs "${cmd}"${any ? " with any arguments" : " exactly"}, ${list === "allow" ? "without asking" : "asking each time"}`;
  }
  if (list === "deny") return "refused";
  return list === "allow" ? "without asking" : "asking each time";
}
