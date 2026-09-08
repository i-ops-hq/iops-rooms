// Who actually built this project, read from git and nothing else.
//
// The question "which AI made this commit" has an honest answer already sitting in the repo:
// Claude Code and Cursor both write a `Co-Authored-By` trailer, so on a repo built with either of
// them the majority of commits already carry one. That signal is portable, it is in every clone,
// and reading it needs no MCP, no network and no vendor's private state.
//
// The tempting alternative does not work and would be wrong anyway. `.cursor/` holds mcp.json,
// rules and ide_state.json — configuration, not a commit ledger. Cursor's session history lives in
// an undocumented local SQLite database, and reading another tool's private state is the
// "scraping third-party agent UIs" this product's anti-goals rule out.
//
// A commit with no trailer is not a mystery: it is a person's commit, and it is shown as theirs.
//
// Identity is resolved with `--use-mailmap` and %aN/%aE, which is git's own mechanism for the
// problem rather than a heuristic of ours. It matters here: a repo working on main has one human appearing as three
// authors, because 277 commits carry a malformed email (`…kondapalli.com`, missing the @gmail)
// beside 233 with the correct one and 22 more under a different name. A `.mailmap` merges them;
// guessing which addresses are the same person would sometimes merge two people, which is worse
// than showing one person twice.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default number of commits read. History is unbounded; a board is not. */
export const DEFAULT_COMMIT_LIMIT = 500;

const RS = "\x1e"; // record separator between commits
const FS = "\x1f"; // field separator inside one commit
const TS = "\x1d"; // separator between several trailers on one commit

/**
 * Known agent families, matched on the trailer's email domain first and its name second.
 * The FAMILY drives colour and icon; the LABEL is whatever the trailer actually said, so a board
 * shows "Claude Opus 5" and "Claude Fable 5.1" as the distinct things they are rather than
 * flattening both to "Claude".
 */
const FAMILIES = [
  { id: "claude", domain: /(^|[@.])anthropic\.com$/i, name: /\bclaude\b/i, label: "Claude" },
  { id: "cursor", domain: /(^|[@.])cursor\.(com|sh)$/i, name: /\bcursor\b/i, label: "Cursor" },
  { id: "codex", domain: /(^|[@.])openai\.com$/i, name: /\b(codex|chatgpt|openai)\b/i, label: "Codex" },
  { id: "copilot", domain: /(^|[@.])github\.com$/i, name: /\bcopilot\b/i, label: "Copilot" },
  { id: "devin", domain: /(^|[@.])cognition(-?labs)?\.(ai|com)$/i, name: /\bdevin\b/i, label: "Devin" },
];

/**
 * Split a `Name <email>` trailer into an agent, or null when it names a person.
 * A co-author with no recognised domain or name is a human collaborator, not an unknown robot.
 */
export function attributeAgent(trailer) {
  const raw = String(trailer || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(.*?)\s*<([^>]*)>\s*$/);
  const label = (m ? m[1] : raw).trim();
  const email = (m ? m[2] : "").trim();
  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
  for (const fam of FAMILIES) {
    if ((domain && fam.domain.test(domain)) || fam.name.test(label)) {
      return { id: fam.id, family: fam.label, label: label || fam.label, email };
    }
  }
  return null;
}

async function git(cwd, args, { timeout = 20_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout, maxBuffer });
    return String(stdout || "");
  } catch {
    return "";
  }
}

/**
 * Every commit reachable from HEAD, newest first, with its author, its agents and its line counts.
 *
 * `truncated` and `total` are returned rather than silently capping: a board that draws the newest
 * 500 of a longer history and says nothing has quietly changed the answer to "how much of this did
 * Cursor build".
 */
export async function readCommits(projectDir, { limit = DEFAULT_COMMIT_LIMIT } = {}) {
  const inside = (await git(projectDir, ["rev-parse", "--is-inside-work-tree"], { timeout: 4000 })).trim();
  if (inside !== "true") return { ok: false, commits: [], total: 0, truncated: 0, note: "not a git checkout" };

  const totalRaw = (await git(projectDir, ["rev-list", "--count", "HEAD"], { timeout: 8000 })).trim();
  const total = Number(totalRaw) || 0;

  const fmt =
    RS +
    ["%H", "%h", "%aN", "%aE", "%aI", "%s", "%P", `%(trailers:key=Co-Authored-By,valueonly,separator=${TS})`].join(FS);

  const raw = await git(projectDir, [
    "log",
    "--use-mailmap",
    `--max-count=${Math.max(1, limit)}`,
    "--numstat",
    `--format=${fmt}`,
  ]);

  const commits = parseLog(raw);

  return {
    ok: true,
    commits,
    total,
    truncated: Math.max(0, total - commits.length),
    note: "",
  };
}

/** One `git log --numstat` stream to commit records. Shared so the two readers cannot diverge. */
function parseLog(raw) {
  const commits = [];
  for (const chunk of String(raw || "").split(RS)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const head = nl === -1 ? chunk : chunk.slice(0, nl);
    const body = nl === -1 ? "" : chunk.slice(nl + 1);
    const [sha, shortSha, name, email, at, subject, parents, trailers] = head.split(FS);
    if (!sha) continue;

    let insertions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split("\t");
      if (parts.length < 3) continue;
      files += 1;
      // "-" means a binary file: counted as a touched file, never as lines.
      if (parts[0] !== "-") insertions += Number(parts[0]) || 0;
      if (parts[1] !== "-") deletions += Number(parts[1]) || 0;
    }

    const agents = String(trailers || "")
      .split(TS)
      .map((t) => attributeAgent(t))
      .filter(Boolean);

    commits.push({
      sha,
      shortSha,
      author: { name: name || "unknown", email: email || "" },
      at: at || "",
      t: at ? Date.parse(at) : null,
      subject: subject || "",
      // git emits no numstat for a merge, so a merge always reads as +0 -0. Counting those as
      // authored work made a maintainer who merges 26 PRs look like they had written nothing.
      isMerge: String(parents || "").trim().split(/\s+/).filter(Boolean).length > 1,
      agents,
      // The commit belongs to the person either way; agents say who helped.
      byAgent: agents.length > 0,
      insertions,
      deletions,
      files,
    });
  }
  return commits;
}

/**
 * Which commits belong to which branch.
 *
 * A commit is reachable from many branches at once, so "the branch of a commit" is not a fact git
 * stores. What IS a fact is what a branch adds that the trunk does not have — `<branch> --not
 * <main>` — and that is what a reader means when they point at a lane and ask what happened on it.
 * Commits on the trunk itself are read with --first-parent, so a merged branch contributes its
 * merge point to the trunk rather than replaying all of its commits there as well.
 */
export async function readBranchCommits(projectDir, { branches = [], main = "", limit = 200 } = {}) {
  const out = new Map();
  const trunk = main || "";
  for (const name of branches) {
    if (!name) continue;
    const isTrunk = name === trunk;
    const args = [
      "log",
      "--use-mailmap",
      `--max-count=${Math.max(1, limit)}`,
      "--numstat",
      `--format=${RS}${["%H", "%h", "%aN", "%aE", "%aI", "%s", "%P", `%(trailers:key=Co-Authored-By,valueonly,separator=${TS})`].join(FS)}`,
    ];
    if (isTrunk) args.push("--first-parent", name);
    else if (trunk) args.push(name, `^${trunk}`);
    else args.push(name);

    const raw = await git(projectDir, args);
    out.set(name, parseLog(raw));
  }
  return out;
}

/** A merge subject usually names the branch it brought in. Fall back to the short sha. */
function branchNameFromMerge(subject, shortSha) {
  const s = String(subject || "");
  const pr = s.match(/Merge pull request #(\d+) from [^/\s]+\/(\S+)/i);
  if (pr) return { name: pr[2], pr: Number(pr[1]) };
  const plain = s.match(/Merge branch '([^']+)'/i);
  if (plain) return { name: plain[1], pr: null };
  const remote = s.match(/Merge remote-tracking branch '[^/]+\/([^']+)'/i);
  if (remote) return { name: remote[1], pr: null };
  return { name: shortSha, pr: null };
}

/**
 * The whole project as a graph: a trunk, and the branches that merged into it.
 *
 * Two histories look completely different and both are normal. A repo whose rule is to work on
 * main has no merges at all, so it is one rail. A repo that merges pull requests is a rail with a
 * branch hanging off it per merge. Reading merge commits is what makes the second drawable at all:
 * a branch that was merged and deleted adds nothing to `<branch> --not main`, but
 * `<merge>^2 --not <merge>^1` is exactly what it contributed.
 */
export async function readHistoryGraph(projectDir, { limit = DEFAULT_COMMIT_LIMIT, maxBranches = 12 } = {}) {
  const all = await readCommits(projectDir, { limit });
  if (!all.ok) return { ok: false, trunk: [], branches: [], ...all };

  const mergeRaw = await git(projectDir, [
    "log",
    "--first-parent",
    "--merges",
    `--max-count=${maxBranches}`,
    `--format=%H${FS}%h${FS}%aI${FS}%s`,
  ]);

  const branches = [];
  for (const line of mergeRaw.split("\n")) {
    if (!line.trim()) continue;
    const [sha, shortSha, at, subject] = line.split(FS);
    if (!sha) continue;
    const { name, pr } = branchNameFromMerge(subject, shortSha);
    const raw = await git(projectDir, [
      "log",
      "--use-mailmap",
      "--numstat",
      `--format=${RS}${["%H", "%h", "%aN", "%aE", "%aI", "%s", "%P", `%(trailers:key=Co-Authored-By,valueonly,separator=${TS})`].join(FS)}`,
      `${sha}^2`,
      `--not`,
      `${sha}^1`,
    ]);
    const commits = parseLog(raw);
    if (!commits.length) continue;
    branches.push({ name, pr, mergeSha: shortSha, mergedAt: at || "", commits });
  }

  // The trunk is what first-parent walks: a merged branch shows as its merge point rather than
  // replaying its commits on the rail as well.
  const branchShas = new Set(branches.flatMap((b) => b.commits.map((c) => c.sha)));
  const trunk = all.commits.filter((c) => !branchShas.has(c.sha));

  const identities = new Map();
  for (const c of all.commits) {
    const byName = identities.get(c.author.name) || new Set();
    byName.add(c.author.email);
    identities.set(c.author.name, byName);
  }
  const split = [...identities.entries()].filter(([, emails]) => emails.size > 1);

  return {
    ok: true,
    trunk,
    branches,
    total: all.total,
    truncated: all.truncated,
    agents: rollUpAgents(all.commits),
    contributors: rollUpContributors(all.commits),
    // Flagged, never merged on a guess: two addresses under one name are usually one person, and
    // sometimes are not. `.mailmap` is git's answer and the reader should be the one to write it.
    splitIdentities: split.map(([name, emails]) => ({ name, emails: [...emails] })),
  };
}

/**
 * One row per person, with the agents they worked through.
 *
 * Percentages are of that person's ATTRIBUTED commits, not of all their commits — a plain commit
 * is not evidence that no agent was used, only that none was recorded, and dividing by it would
 * understate every agent by a different amount depending on how the person commits.
 */
export function rollUpContributors(commits) {
  const people = new Map();
  for (const c of commits || []) {
    const key = (c.author.email || c.author.name || "unknown").toLowerCase();
    let p = people.get(key);
    if (!p) {
      p = {
        key,
        name: c.author.name,
        email: c.author.email,
        commits: 0,
        merges: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
        attributed: 0,
        plain: 0,
        agents: new Map(),
        firstAt: c.at,
        lastAt: c.at,
      };
      people.set(key, p);
    }
    p.commits += 1;
    if (c.isMerge) p.merges += 1;
    p.insertions += c.insertions;
    p.deletions += c.deletions;
    p.files += c.files;
    if (c.agents.length) p.attributed += 1;
    else p.plain += 1;
    for (const a of c.agents) {
      const row = p.agents.get(a.label) || { label: a.label, id: a.id, family: a.family, commits: 0 };
      row.commits += 1;
      p.agents.set(a.label, row);
    }
    if (c.at && (!p.firstAt || c.at < p.firstAt)) p.firstAt = c.at;
    if (c.at && (!p.lastAt || c.at > p.lastAt)) p.lastAt = c.at;
  }

  return [...people.values()]
    .map((p) => {
      const agents = [...p.agents.values()].sort((a, b) => b.commits - a.commits);
      const top = agents[0] || null;
      return {
        ...p,
        agents,
        topAgent: top,
        topAgentPct: top && p.attributed ? Math.round((top.commits / p.attributed) * 100) : 0,
      };
    })
    .sort((a, b) => b.commits - a.commits);
}

/** Project-wide agent totals, for the "who built this" line. */
export function rollUpAgents(commits) {
  const agents = new Map();
  let attributed = 0;
  for (const c of commits || []) {
    if (c.agents.length) attributed += 1;
    for (const a of c.agents) {
      const row = agents.get(a.label) || { label: a.label, id: a.id, family: a.family, commits: 0, insertions: 0, deletions: 0 };
      row.commits += 1;
      row.insertions += c.insertions;
      row.deletions += c.deletions;
      agents.set(a.label, row);
    }
  }
  return {
    agents: [...agents.values()].sort((a, b) => b.commits - a.commits),
    attributed,
    plain: (commits || []).length - attributed,
  };
}
