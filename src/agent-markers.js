/**
 * Which agent a process runs inside, from the variables agents set for the commands they run.
 *
 * Claude Code gives every command it runs `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT` (`cli`,
 * `claude-desktop`, …) and `AI_AGENT=claude-code_<version>_agent`. A git hook fired by a commit made
 * inside the session inherits them, and the same commit made from a person's own terminal has none:
 * checked on 2026-09-28 both ways. `AI_AGENT` names no vendor, so any agent, a custom one included,
 * can set it, and `AI_AGENT_MODEL`, when set, names the model.
 *
 * Only these four names are read. The environment is never read whole: an agent's shell carries
 * credentials (a Claude Code shell has a messaging token in it), and SECURITY.md promises as much.
 *
 * What this establishes is where a commit was made, never who wrote its contents. A person can
 * commit from inside an agent's shell, and an agent's edits can be committed from anywhere.
 */

export const MARKER_NAMES = ["AI_AGENT", "AI_AGENT_MODEL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/** A value safe to keep in a log that may be shared: short, and nothing that could be markup. */
function clean(value, max = 60) {
  const s = String(value || "").trim().replace(/[^A-Za-z0-9._:/@+-]/g, "").slice(0, max);
  return s || null;
}

/** `{ agent, version, entry, model }` for the agent this environment belongs to, or null. */
export function agentFromEnv(env = process.env) {
  let agent = null;
  let version = null;
  const raw = String(env.AI_AGENT || "").trim();
  if (raw) {
    // claude-code_2-1-281_agent: the name, then the version with dashes for dots.
    const shaped = raw.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,40})_(\d[\d-]{0,20})_agent$/);
    if (shaped) {
      agent = shaped[1].toLowerCase();
      version = shaped[2].replace(/-/g, ".");
    } else {
      // A custom agent may set any name. It is kept, cleaned, and reported as the agent's own claim.
      agent = clean(raw.replace(/_agent$/i, ""), 40)?.toLowerCase() ?? null;
    }
  }
  if (!agent && env.CLAUDECODE === "1") agent = "claude-code";
  if (!agent) return null;
  return {
    agent,
    version,
    entry: agent === "claude-code" ? clean(env.CLAUDE_CODE_ENTRYPOINT, 30) : null,
    model: clean(env.AI_AGENT_MODEL),
  };
}

const LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  opencode: "opencode",
};

/** The name to show for an agent id. An id nobody here knows is shown as the agent gave it. */
export function agentLabel(id) {
  return LABELS[id] || id;
}
