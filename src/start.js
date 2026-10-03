/**
 * What bare `rooms` says: where it was run, and the few commands that fit there, rather than every
 * command at once, which `rooms help` lists. It reads git and this machine's team-room links, and
 * writes nothing.
 */
import { basename, relative } from "node:path";

const row = (command, what) => `  ${command.padEnd(17)} ${what}\n`;
/** A folder name as a shell reads it: quoted only when it has to be. */
const shellWord = (name) => (/^[\w./-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`);
const UNREADABLE = new Set(["git-missing", "git-refused", "git-failed"]);

export async function startScreen(cwd) {
  const g = await import("./git-info.js");
  const dir = await g.resolveProjectRoot(cwd);
  const snap = await g.readGitSnapshot(dir);
  const out = [];

  if (!snap.ok && UNREADABLE.has(snap.reason)) {
    // A repository git would not read is not a folder without one: say what git said.
    out.push(`Rooms · ${basename(dir)}\n\n${snap.note}\n`);
  } else if (!snap.ok) {
    out.push(`Rooms · ${await g.projectName(dir)}, not a git repository\n\n`);
    out.push("Who built a project, and which AI helped, comes from its git history, and this folder has none.\n");
    const below = await g.repositoriesBelow(dir, { depth: 2, limit: 8 });
    if (below.length) {
      // A folder of projects: the answer is inside one of them, never a history or a room here.
      const names = below.map((p) => relative(dir, p) || basename(p));
      out.push(`It holds git repositories: ${names.join(", ")}${below.length >= 8 ? ", and more" : ""}. Run rooms inside one of them:\n\n`);
      out.push(`  cd ${shellWord(names[0])}\n  rooms\n`);
    } else {
      out.push("\n");
      out.push(row("git init", "start a history here; Rooms reads it from the first commit"));
      out.push(row("rooms open", "a board for posts from you and your agents, without git"));
    }
  } else {
    const name = await g.projectName(dir, { snap });
    const hist = await g.projectHistory(dir, snap);
    const where = snap.current === "HEAD" ? "a detached HEAD" : snap.current || "no branch yet";
    if (hist.away) {
      const n = await g.commitsNotIn(dir, hist.ref);
      out.push(`Rooms · ${name}, on ${where} (${n} commit${n === 1 ? "" : "s"} not in ${hist.base} yet)\n\n`);
    } else {
      out.push(`Rooms · ${name}, on ${where}\n\n`);
    }
    out.push(row("rooms week", hist.away ? `who built it this week, and which AI helped, read from ${hist.base}` : "who built it this week, and which AI helped"));
    if (hist.away) out.push(row("rooms branch", "what this branch adds, and which AI helped"));
    out.push(row("rooms open", "the board: commits, people, agents and branches"));
    const { teamForProject } = await import("./team.js");
    const linked = await teamForProject(dir).catch(() => ({ team: null }));
    if (linked.team) {
      out.push(row("rooms team board", `your team's status, from ${linked.id}`));
      out.push(row("rooms setup show", "the AI setups your team shares"));
    } else {
      out.push(row("rooms team join", "share your status with your team, through a private GitHub repository"));
    }
  }
  out.push("\nEvery command: rooms help\n");
  return out.join("");
}
