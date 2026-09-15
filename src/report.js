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
import { CONFIG_NOTE, readAgentConfig, whyNothingRecorded } from "./agent-config.js";
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
 * Whole percentages that sum to exactly 100.
 *
 * Rounding each row on its own does not: three rows of one third round to 33 and sum to 99, and the
 * badge is a stacked bar whose segments are drawn from these numbers, so a missing point is a
 * visible gap and a spare point runs off the end. Largest remainder hands the leftover points to
 * the rows that lost the most in rounding, which is the standard fix and is stable for a given
 * input. A row with any share at all keeps at least 1%, because a segment of width zero reads as
 * "not present" rather than "small".
 */
export function allocatePercent(rows, seen) {
  if (!seen || !rows.length) return rows.map((row) => ({ ...row, pct: 0 }));
  const exact = rows.map((row) => (row.share / seen) * 100);
  const out = rows.map((row, i) => ({ ...row, pct: Math.max(exact[i] > 0 ? 1 : 0, Math.floor(exact[i])) }));
  let left = 100 - out.reduce((n, row) => n + row.pct, 0);
  const order = rows
    .map((_, i) => i)
    .sort((a, b) => (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a])));
  for (let k = 0; left > 0 && k < order.length * 2; k++) {
    out[order[k % order.length]].pct += 1;
    left -= 1;
  }
  // Over 100 only when the 1% floor was applied to more rows than there were spare points.
  for (let k = order.length - 1; left < 0 && k >= 0; k--) {
    if (out[order[k]].pct > 1) {
      out[order[k]].pct -= 1;
      left += 1;
    }
  }
  return out;
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
  // The second evidence source, and a different question: not which commits recorded an agent, but
  // which agents this repository is set up for. Read on the same pass as the commits so no caller
  // can print one without having the other — the first source is a floor and saying so is only
  // half an answer when the second one is sitting in the same checkout.
  const config = await readAgentConfig(projectDir);
  const insertions = r.commits.reduce((n, c) => n + c.insertions, 0);
  const deletions = r.commits.reduce((n, c) => n + c.deletions, 0);
  const seen = r.commits.length;

  // One row per agent, then the co-authored commits no family claims, then the commits that
  // recorded nothing at all — so callers never have to remember to add a slice back in.
  //
  // **The co-authored rows are two, not one, and neither says "agent".** As one row labelled
  // "co-author, not a known agent" it read 47% on astral-sh/uv with a long bar directly above
  // "no agent recorded", and the eye took it for half the repository being agent-written. Inside
  // it were Zanie Blue with 157 commits, Charlie Marsh with 14, and release bots — not one AI
  // agent in the top twelve. A number that reads as more than it is, which is the thing this tool
  // exists to refuse.
  const rows = allocatePercent(
    [
      ...agents.agents.map((a) => ({
        id: a.id, label: a.label, commits: a.commits, share: a.share, variants: a.variants || [],
      })),
      {
        id: "coauthor-bot",
        label: "co-author that says it is a bot",
        commits: agents.coauthoredByBot,
        share: agents.coauthoredByBot,
      },
      {
        id: "coauthor",
        label: "co-author, no bot marker — usually a person",
        commits: agents.coauthoredByPerson,
        share: agents.coauthoredByPerson,
      },
      { id: "unrecorded", label: "no agent recorded", commits: agents.plain, share: agents.plain },
    ].filter((row) => row.commits > 0),
    seen,
  );

  return {
    ok: true,
    seen,
    total: r.total,
    // How many commits carry more than one agent, so every surface can say the rows overlap
    // rather than leaving a reader to discover the counts sum past the header.
    multi: agents.multi,
    truncated: r.truncated,
    insertions,
    deletions,
    commits: r.commits,
    rows,
    agents,
    contributors,
    config,
    since: sinceArg(since),
    range,
    paths,
    exclude,
  };
}

/**
 * Why nothing was attributed, printed only when nothing was.
 *
 * A window where every commit is `no agent recorded` looks identical whether the setup is broken,
 * the tool in use never wrote trailers, or no agent was involved at all — and a reader cannot tell
 * which, so they cannot tell whether to go looking. Two of those three answers are "nothing is
 * wrong", which the output has never said.
 *
 * **Silent the moment anything is attributed.** Not a threshold: at 1% the reader has evidence the
 * mechanism works and does not need telling how it works. And **no command is offered**, because
 * the one this was first scoped around — `rooms hooks install` — writes a board post and not a
 * trailer. Attribution comes from the agent; this tool measures it and must not manufacture it.
 */
export function formatWhyEmpty(report) {
  if (!report || !report.agents) return "";
  if (report.agents.attributed > 0) return "";
  if (!report.seen) return "";
  const why = whyNothingRecorded(report.config);
  return why ? `\n${wrap(why)}\n` : "";
}

/**
 * What the repository declares, as its own block beneath the mix.
 *
 * Deliberately prose and not a second bar chart. A chart invites comparison with the one above it,
 * and these two things do not compare: the rows above are commits and these are files. Putting a
 * percentage on a config file would be inventing a denominator out of nothing.
 *
 * Absence is stated rather than omitted. A repository that declares nothing is a finding — it is
 * the reason the trailer count is the only evidence there is — and leaving the block out entirely
 * would make "nothing declared" and "not looked at" identical to a reader.
 */
export function formatConfig(report) {
  const config = report.config;
  if (!config) return "";
  if (!config.ok) return `\nAgent config: ${config.note}.\n`;

  const named = config.agents.map((a) => `${a.label} (${a.files.join(", ")})`);
  if (!named.length && !config.crossVendor) {
    return "\n" + wrap(
      "This repository commits no agent config file — no AGENTS.md, CLAUDE.md, .claude/, " +
      ".cursor/ or the rest — so the trailers above are the only evidence there is.",
    ) + "\n";
  }

  const parts = [...named];
  if (config.crossVendor) parts.push("a cross-vendor AGENTS.md");
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `\n${wrap(`Configured for: ${list}.`)}\n${wrap(CONFIG_NOTE)}\n`;
}

/**
 * The report as data, for anything downstream of a person reading it.
 *
 * **Every caveat the text carries is a field here.** A consumer that gets `{"claude": 6}` and
 * nothing else will publish "6% AI-written" as a fact, which is the exact misuse the prose spends
 * four sentences refusing — and a caveat that only exists in the terminal is a caveat that does not
 * survive contact with the thing most likely to misquote it.
 *
 * So `floor`, `multi`, `truncated`, the model variants, the two co-author buckets kept apart, what
 * the repository declares, and why nothing was recorded are all carried. They are not decoration:
 * each one exists because a number was once read as more than it was.
 */
export function reportToJson(report, { name = "", window = "" } = {}) {
  const config = report.config || null;
  return {
    project: name,
    window,
    commits: { seen: report.seen, total: report.total, truncated: Boolean(report.truncated) },
    lines: { added: report.insertions, removed: report.deletions },
    people: report.contributors.length,
    rows: report.rows.map((r) => ({
      id: r.id,
      label: r.label,
      commits: r.commits,
      percent: r.pct,
      // The models under an agent, when the trailers named more than one. Flattening these would
      // put Claude Code back to appearing five times, which 0.5.4 removed.
      models: (r.variants || []).map((v) => ({ label: v.label, commits: v.commits })),
    })),
    attributed: report.agents.attributed,
    // Kept apart in the data for the same reason they are kept apart in the rows: one of these is
    // mostly people, and merging them produced a 47% bar that read as agent work.
    coAuthored: {
      byBot: report.agents.coauthoredByBot,
      byPersonOrUnmarked: report.agents.coauthoredByPerson,
    },
    unrecorded: report.agents.plain,
    // How many commits carry more than one agent, so a consumer knows the rows overlap rather than
    // discovering it when they sum past the commit count.
    multiAgentCommits: report.multi,
    declared: config && config.ok
      ? {
          agents: config.agents.map((a) => ({ id: a.id, label: a.label, files: a.files })),
          crossVendorAgentsMd: config.crossVendor,
          note: CONFIG_NOTE,
        }
      : null,
    whyNothingRecorded: report.agents.attributed === 0 ? whyNothingRecorded(config) || null : null,
    floor: FLOOR_NOTE,
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

/**
 * The models beneath their agent, when the trailers named more than one.
 *
 * The agent is the row and the model is a detail of it. Only shown when there is something to
 * choose between: a single model adds a line that repeats what the row above already said.
 */
function modelLines(row, width, countWidth) {
  const variants = row.variants || [];
  if (variants.length < 2) return [];
  const shown = variants.slice(0, MODELS_SHOWN);
  const rest = variants.length - shown.length;
  const lines = shown.map(
    (v) => `    ${v.label}`.padEnd(width + 2) + `  ${String(v.commits).padStart(countWidth)}`,
  );
  if (rest > 0) {
    const more = variants.slice(MODELS_SHOWN).reduce((n, v) => n + v.commits, 0);
    lines.push(`    and ${rest} more`.padEnd(width + 2) + `  ${String(more).padStart(countWidth)}`);
  }
  return lines;
}

//: Enough to show the mix without turning one agent into a page.
const MODELS_SHOWN = 4;

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
      const line = `  ${r.label.padEnd(w)}  ${String(r.commits).padStart(cw)}  ${bar(r.pct)} ${String(r.pct).padStart(3)}%${d}`;
      return [line, ...modelLines(r, w, cw)].join("\n");
    })
    .join("\n") + "\n" + splitNote(report);
}

/**
 * Said out loud, because the count column and the percentage column answer different questions
 * once a commit has two agents on it: the counts are "commits this agent appears on" and can
 * overlap, the percentages are that commit split between them and always total 100.
 */
function splitNote(report) {
  const n = Number(report.multi) || 0;
  if (!n) return "";
  const text =
    `${n} commit${n === 1 ? "" : "s"} record${n === 1 ? "s" : ""} more than one agent. ` +
    "The counts are commits an agent appears on, so they overlap. The percentages split each " +
    "such commit evenly, so they still total 100.";
  return `\n${wrap(text, 74, "  ")}\n`;
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
  out.push(formatConfig(report));
  out.push(formatWhyEmpty(report));
  return out.join("");
}

export function formatBranch(report, { branch = "HEAD", base = "" } = {}) {
  const out = [header(`${branch}`, base ? `not in ${base}` : "", report), "\n", formatMix(report)];
  const who = report.contributors.map((c) => c.name).join(", ");
  if (who) out.push(`\nby ${who}\n`);
  out.push(`\n${wrap(FLOOR_NOTE)}\n`);
  out.push(formatConfig(report));
  out.push(formatWhyEmpty(report));
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
  gemini: "#4285f4",
  jules: "#a142f4",
  aider: "#00897b",
  amazonq: "#ff9900",
  windsurf: "#0ea5a4",
  // Two greys, deliberately close: neither is a claim about a tool, and a reader should see them
  // as the same kind of thing — a commit whose agent this table cannot name.
  coauthor: "#6f7480",
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
