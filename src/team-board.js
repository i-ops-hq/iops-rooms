/**
 * The team board: every member's shared status, from the member's own clone of the team room,
 * built into a page on this machine and opened in the board's own window.
 *
 * It shows what each member chose to share, as of their last sync, in the same words the project
 * board's Git card and `rooms week` use. Projects and members are in alphabetical order and nothing
 * is ranked: no row is placed above another by a number. Every value came from a teammate's machine
 * through git, so every value is escaped.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { humanizeRelative } from "./board.js";
import { trackingWords, uncommittedWords } from "./git-info.js";
import { pullRequestWords } from "./scm.js";
import { agentLabel } from "./agent-markers.js";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "team.html");

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function line(state, text) {
  return text ? `<p class="member-line" data-state="${esc(state)}">${esc(text)}</p>` : "";
}

/** One member's card: the same lines, in the same words, as their own board's Git card. */
export function memberCard(s, now = Date.now()) {
  const shared = "branch" in s;
  const u = uncommittedWords(s.uncommitted);
  const tracking = shared ? trackingWords({ upstream: s.upstream, ahead: s.ahead, behind: s.behind, remote: true }) : null;
  const pr = s.pr || { state: "unknown", why: "not shared" };
  const agents = Object.entries(s.agents7d || {})
    .map(([id, a]) => `${agentLabel(id)}: ${a.sessions} session${a.sessions === 1 ? "" : "s"}, ${a.filesEdited} file${a.filesEdited === 1 ? "" : "s"} edited`)
    .join(" · ");
  return `<li class="member">
  <div class="member-head"><b>${esc(s.member)}</b><span class="member-when">updated ${esc(humanizeRelative(now - Date.parse(s.at)))}</span></div>
  <p class="member-branch">${shared ? esc(s.branch || "detached") : "branch not shared"}</p>
  ${line(u ? "warn" : "ok", u ? `uncommitted: ${u}` : "nothing uncommitted")}
  ${tracking ? line(tracking.state, tracking.text) : ""}
  ${line({ none: "warn", closed: "warn", unknown: "none", unpushed: "none" }[pr.state] || "ok", pullRequestWords(pr))}
  <p class="member-agents">${agents ? `agents, last 7 days on their machine: ${esc(agents)}` : "no agent sessions seen on their machine in the last 7 days"}</p>
</li>`;
}

export async function renderTeamBoard({ name, id, statuses, skipped = 0, pulled = true, now = Date.now() }) {
  const members = new Set(statuses.map((s) => s.member));
  const projects = [...new Set(statuses.map((s) => s.project))];
  const newest = statuses.reduce((t, s) => Math.max(t, Date.parse(s.at)), 0);
  const summary = statuses.length
    ? `${members.size} member${members.size === 1 ? "" : "s"} sharing, across ${projects.length} project${projects.length === 1 ? "" : "s"}. The newest status was shared ${humanizeRelative(now - newest)}.`
    : "Nobody has shared a status here yet. From a project: rooms team sync.";
  const note =
    "What each member chose to share from their own machine, as of their last rooms team sync: counts " +
    "and states, never a file name or a line of code. Nothing here is ranked, and a member who has not " +
    "synced lately is shown as they were." +
    (skipped ? ` ${skipped} file${skipped === 1 ? " was" : "s were"} not a status this version reads, and ${skipped === 1 ? "is" : "are"} left out.` : "") +
    (pulled ? "" : " The team room could not be updated just now, so this is what this machine last fetched.");
  const sections = projects
    .map((project) => {
      const cards = statuses.filter((s) => s.project === project).map((s) => memberCard(s, now)).join("\n");
      return `<section class="team-project" aria-label="${esc(project)}">
  <h2>${esc(project)}</h2>
  <ul class="members">${cards}</ul>
</section>`;
    })
    .join("\n");
  const template = await readFile(TEMPLATE, "utf8");
  const values = {
    "{{TITLE}}": esc(`Rooms · ${name} · team`),
    "{{NAME}}": esc(name),
    "{{SUMMARY}}": esc(summary),
    "{{NOTE}}": esc(note),
    "{{PROJECTS}}": sections || `<p class="empty">${esc(`No statuses in ${id} yet.`)}</p>`,
  };
  return Object.entries(values).reduce((html, [token, value]) => html.replaceAll(token, value), template);
}
