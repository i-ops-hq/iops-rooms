// Attribution as a number you can read in a terminal.
//
// The board is the poster. This is the habit: `rooms week` after a long session, `rooms branch`
// before a PR, `rooms file` when something looks like an agent dump. None of them needs a room, a
// server, a browser or an account — they read git and print.
//
// One rule runs through all of it: **"no agent recorded" is a first-class number, not a leftover
// slice.** A plain commit is not evidence that no agent was used; Cursor and Copilot often write no
// trailer at all. Every figure here is a floor, and the output says so rather than letting a reader
// mistake it for a measurement of how much AI wrote their code.

import { readCommits, rollUpAgents, rollUpContributors, sinceArg } from "./git-history.js";
import { readGitSnapshot } from "./git-info.js";

/** k/M once the digits stop being readable. Shared with the board's own shortener by shape, not code
 *  — this one is for a fixed-width terminal column and never returns more than five characters. */
export function compact(n) {
  const v = Math.abs(Number(n) || 0);
  const sign = Number(n) < 0 ? "-" : "";
  if (v >= 1_000_000) return `${sign}${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${sign}${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `${sign}${(v / 1000).toFixed(1)}k`;
  return `${sign}${v}`;
}

/**
 * The numbers every surface here shares.
 *
 * `seen` is the denominator for every percentage: the commits this window actually read. Dividing by
 * the repo total instead would report "38% of 104" where the 38 came from a filtered set.
 */
export async function buildReport(projectDir, opts = {}) {
  const { since = "", paths = [], exclude = [], range = "", limit = 500 } = opts;
  const r = await readCommits(projectDir, { since, paths, exclude, range, limit });
  if (!r.ok) return { ok: false, note: r.note || "not a git checkout" };

  const agents = rollUpAgents(r.commits);
  const contributors = rollUpContributors(r.commits);
  const insertions = r.commits.reduce((n, c) => n + c.insertions, 0);
  const deletions = r.commits.reduce((n, c) => n + c.deletions, 0);
  const seen = r.commits.length;

  // One row per agent plus one for the commits that recorded none, so callers never have to
  // remember to add the unrecorded slice back in. It is the same kind of row as the others.
  const rows = [
    ...agents.agents.map((a) => ({ id: a.id, label: a.label, commits: a.commits })),
    { id: "unrecorded", label: "no agent recorded", commits: agents.plain },
  ]
    .filter((row) => row.commits > 0)
    .map((row) => ({ ...row, pct: seen ? Math.round((row.commits / seen) * 100) : 0 }));

  return {
    ok: true,
    seen,
    total: r.total,
    truncated: r.truncated,
    insertions,
    deletions,
    commits: r.commits,
    rows,
    agents,
    contributors,
    since: sinceArg(since),
    range,
    paths,
    exclude,
  };
}

/** The sentence that has to travel with every percentage on every surface. */
export const FLOOR_NOTE =
  '"no agent recorded" is not "no agent used". Cursor and Copilot often write no ' +
  "Co-Authored-By trailer, so a plain commit only means none was recorded. Every share here is a floor.";

const BAR_W = 22;
function bar(pct) {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * BAR_W));
  return "█".repeat(Math.min(BAR_W, filled)) + "░".repeat(Math.max(0, BAR_W - filled));
}

/** The mix, as the block every command shares. `delta` is an optional id -> change in commits. */
export function formatMix(report, { delta = null } = {}) {
  if (!report.rows.length) return "  no commits in this window\n";
  const w = Math.max(...report.rows.map((r) => r.label.length));
  const cw = Math.max(...report.rows.map((r) => String(r.commits).length));
  return report.rows
    .map((r) => {
      const d = delta && delta[r.id] != null && delta[r.id] !== 0
        ? `  ${delta[r.id] > 0 ? "+" : "−"}${Math.abs(delta[r.id])}`
        : "";
      return `  ${r.label.padEnd(w)}  ${String(r.commits).padStart(cw)}  ${bar(r.pct)} ${String(r.pct).padStart(3)}%${d}`;
    })
    .join("\n") + "\n";
}

function header(name, window, report) {
  const bits = [`${report.seen} commit${report.seen === 1 ? "" : "s"}`];
  if (report.insertions || report.deletions) {
    bits.push(`+${compact(report.insertions)} −${compact(report.deletions)}`);
  }
  const people = report.contributors.length;
  if (people) bits.push(`${people} ${people === 1 ? "person" : "people"}`);
  return `${name}${window ? ` · ${window}` : ""}\n${bits.join(" · ")}\n`;
}

/** Wrapped to a terminal width, so the honesty note never becomes one 190-column line. */
export function wrap(text, width = 76, indent = "") {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

export function formatWeek(report, { name = "", window = "last 7 days", delta = null } = {}) {
  const out = [header(name, window, report), "\n", formatMix(report, { delta })];
  if (report.truncated) {
    out.push(`\nReading the newest ${report.seen} of ${report.total} commits in this window.\n`);
  }
  out.push(`\n${wrap(FLOOR_NOTE)}\n`);
  return out.join("");
}

export function formatBranch(report, { branch = "HEAD", base = "" } = {}) {
  const out = [header(`${branch}`, base ? `not in ${base}` : "", report), "\n", formatMix(report)];
  const who = report.contributors.map((c) => c.name).join(", ");
  if (who) out.push(`\nby ${who}\n`);
  out.push(`\n${wrap(FLOOR_NOTE)}\n`);
  return out.join("");
}

export function formatFile(report, { path = "", window = "" } = {}) {
  const out = [header(path, window, report), "\n", formatMix(report), "\n"];
  for (const c of report.commits.slice(0, 12)) {
    const agent = c.agents[0]?.label || "no agent recorded";
    const when = c.at ? c.at.slice(0, 10) : "";
    const stat = c.isMerge ? "merge" : `+${compact(c.insertions)} −${compact(c.deletions)}`;
    out.push(
      `  ${c.shortSha}  ${when}  ${c.author.name.slice(0, 18).padEnd(18)}  ${agent.slice(0, 20).padEnd(20)}  ${stat}\n`,
    );
  }
  if (report.commits.length > 12) {
    out.push(`  … and ${report.commits.length - 12} older commit(s) touching this path\n`);
  }
  out.push(`\n${wrap(FLOOR_NOTE)}\n`);
  return out.join("");
}

// ------------------------------------------------------------------------------- the badge

/** Verdana 11px is what shields.info measures against; this approximation is within a pixel or two
 *  per character, which is close enough for a badge and needs no font metrics table. */
function textWidth(s) {
  return Math.ceil(String(s).length * 6.2);
}
const BADGE_COLOURS = {
  claude: "#8b5cf6",
  cursor: "#2f6fed",
  codex: "#1e9e5a",
  copilot: "#d98324",
  devin: "#e5484d",
  unrecorded: "#8a8f99",
};

/**
 * A README badge, rendered locally into an SVG file.
 *
 * A badge gets copied; a board has to be opened. It is a stacked bar rather than a single number,
 * because a single "48% AI" number is the claim this tool cannot support — the unrecorded segment
 * has to be visible in the same picture, at the same size, as the ones it is being compared with.
 */
export function renderBadgeSvg(report, { label = "agents" } = {}) {
  const rows = report.rows.length ? report.rows : [{ id: "unrecorded", label: "no commits", commits: 0, pct: 100 }];
  const value = rows.map((r) => `${r.label === "no agent recorded" ? "unrecorded" : r.label} ${r.pct}%`).join(" · ");
  const lw = textWidth(label) + 12;
  const vw = textWidth(value) + 14;
  const w = lw + vw;
  const h = 20;

  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let x = lw;
  const segs = rows
    .map((r) => {
      const seg = (r.pct / 100) * vw;
      // Named so the segments are distinguishable from the badge's own chrome — by a reader
      // opening the file, and by the test that counts them.
      const rect = `<rect class="seg" data-agent="${esc(r.id)}" x="${x.toFixed(1)}" y="0" width="${Math.max(0, seg).toFixed(1)}" height="${h}" fill="${BADGE_COLOURS[r.id] || "#8a8f99"}"/>`;
      x += seg;
      return rect;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${esc(`${label}: ${value}`)}">
  <title>${esc(`${label}: ${value}`)} — from Co-Authored-By trailers only; unrecorded is not "no agent used"</title>
  <rect width="${w}" height="${h}" rx="3" fill="#2b2f38"/>
  <rect x="0" y="0" width="${lw}" height="${h}" fill="#40454f"/>
  ${segs}
  <rect width="${w}" height="${h}" rx="3" fill="none" stroke="rgba(0,0,0,0.15)"/>
  <g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" fill="#fff">
    <text x="6" y="14">${esc(label)}</text>
    <text x="${lw + 7}" y="14">${esc(value)}</text>
  </g>
</svg>
`;
}

/** The default branch to compare a feature branch against, without asking the user to name it. */
export async function defaultBase(projectDir) {
  const snap = await readGitSnapshot(projectDir);
  return snap.ok ? snap.defaultBranch || "" : "";
}
