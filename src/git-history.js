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
/**
 * A company's domain is not an agent — it is also where that company's PEOPLE have their email.
 *
 * This matched on domain, and `github.com` is where GitHub's Copilot lives. It is also the domain of
 * `users.noreply.github.com`, which is the DEFAULT commit address GitHub gives every human being
 * with an account. Every human co-author on a normal GitHub repo was being counted as Copilot, and
 * the board's headline "agent-assisted" figure was inflated by exactly those people. The same trap
 * was set for anyone with an @anthropic.com, @openai.com or @cursor.com address: employees.
 *
 * So the NAME decides, because the name is what the agent writes about itself, and an `address` is
 * only the specific mailbox a tool commits from — never a whole domain. A mailbox like
 * `noreply@anthropic.com` cannot belong to a person; `jane@anthropic.com` can.
 *
 * The two errors are not symmetric. Missing an agent understates a figure the board already calls a
 * floor. Claiming a person is an agent is a false statement about a named human, so the rule leans
 * that way on purpose. It leans wrong for a co-author actually named Claude or Devin, which is the
 * one case left and needs a person's name to collide with a model's.
 */
const FAMILIES = [
  { id: "claude", name: /\bclaude\b/i, address: /^no-?reply@anthropic\.com$/i, label: "Claude" },
  { id: "cursor", name: /\bcursor\b/i, address: /^cursor(agent|-agent)?@cursor\.(com|sh)$/i, label: "Cursor" },
  { id: "codex", name: /\b(codex|chatgpt)\b/i, address: /^(codex|chatgpt)[^@]*@openai\.com$/i, label: "Codex" },
  { id: "copilot", name: /\bcopilot\b/i, address: /^\d+\+copilot@users\.noreply\.github\.com$/i, label: "Copilot" },
  { id: "devin", name: /\bdevin\b/i, address: /^devin[^@]*@cognition(-?labs)?\.(ai|com)$/i, label: "Devin" },
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
  for (const fam of FAMILIES) {
    if (fam.name.test(label) || (email && fam.address.test(email))) {
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
/**
 * A shorthand window to something git understands. `7d`, `2w`, `6mo`, `1y` — or anything git already
 * parses, passed straight through, because `--since="last monday"` is a thing people type.
 */
export function sinceArg(since) {
  const raw = String(since || "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d+)\s*(d|w|mo|m|y)$/i);
  if (!m) return raw;
  const n = m[1];
  const unit = { d: "days", w: "weeks", mo: "months", m: "months", y: "years" }[m[2].toLowerCase()];
  return `${n} ${unit} ago`;
}

/**
 * Path arguments for `git log`, with exclusions.
 *
 * Without these a monorepo or one week of lockfile churn makes every figure a lie — a commit that
 * regenerated package-lock.json counts the same as a commit that wrote a feature. `:(exclude)` is
 * git's own pathspec magic, so the filtering happens in git rather than after the fact.
 */
export function pathArgs({ paths = [], exclude = [] } = {}) {
  const inc = paths.filter(Boolean);
  const exc = exclude.filter(Boolean).map((p) => `:(exclude)${p}`);
  if (!inc.length && !exc.length) return [];
  return ["--", ...(inc.length ? inc : [":(glob)**"]), ...exc];
}

export async function readCommits(
  projectDir,
  { limit = DEFAULT_COMMIT_LIMIT, since = "", paths = [], exclude = [], range = "" } = {},
) {
  const inside = (await git(projectDir, ["rev-parse", "--is-inside-work-tree"], { timeout: 4000 })).trim();
  if (inside !== "true") return { ok: false, commits: [], total: 0, truncated: 0, note: "not a git checkout" };

  const rev = String(range || "").trim() || "HEAD";
  const sinceFlag = sinceArg(since) ? [`--since=${sinceArg(since)}`] : [];
  const pathsel = pathArgs({ paths, exclude });

  // The total is counted under the SAME filters. Counting all of HEAD and then reporting a filtered
  // sample would make "38% of 104" a ratio of two different populations.
  const totalRaw = (
    await git(projectDir, ["rev-list", "--count", rev, ...sinceFlag, ...pathsel], { timeout: 8000 })
  ).trim();
  const total = Number(totalRaw) || 0;

  const fmt =
    RS +
    ["%H", "%h", "%aN", "%aE", "%aI", "%s", "%P", `%(trailers:key=Co-Authored-By,valueonly,separator=${TS})`].join(FS);

  const raw = await git(projectDir, [
    "log",
    rev,
    "--use-mailmap",
    `--max-count=${Math.max(1, limit)}`,
    "--numstat",
    `--format=${fmt}`,
    ...sinceFlag,
    ...pathsel,
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
/**
 * Every branch this checkout knows about — local and remote — as one deduplicated list.
 *
 * Reading only merge commits missed the branches that matter most on a repo that does not merge.
 * A project working on main has zero merges and can still have a dozen live branches: releases,
 * deployments, dependabot, work in progress. They exist as refs, and a board that says "no
 * branches" while `git branch -r` lists eleven of them is simply wrong.
 *
 * `main` and `origin/main` are one branch, so the remote is only kept when there is no local ref
 * for the same short name.
 */
async function listBranchRefs(projectDir) {
  const raw = await git(projectDir, [
    "for-each-ref",
    "--sort=-committerdate",
    `--format=%(refname:short)${FS}%(refname)${FS}%(committerdate:iso-strict)`,
    "refs/heads/",
    "refs/remotes/",
  ]);
  const seen = new Set();
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [shortName, fullRef, at] = line.split(FS);
    if (!shortName || shortName.endsWith("/HEAD")) continue;
    const isRemote = fullRef.startsWith("refs/remotes/");
    // origin/feature -> feature, so a branch tracked both ways is not drawn twice.
    const bare = isRemote ? shortName.replace(/^[^/]+\//, "") : shortName;
    if (seen.has(bare)) continue;
    seen.add(bare);
    out.push({ name: bare, ref: shortName, remote: isRemote, at: at || "" });
  }
  return out;
}

/** Which ref the project treats as its trunk, asked rather than assumed. */
async function resolveTrunk(projectDir, refs) {
  const head = (await git(projectDir, ["symbolic-ref", "--short", "HEAD"], { timeout: 4000 })).trim();
  const originHead = (await git(projectDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { timeout: 4000 }))
    .trim()
    .replace(/^[^/]+\//, "");
  const names = new Set(refs.map((r) => r.name));
  for (const candidate of [originHead, head, "main", "master"]) {
    if (candidate && names.has(candidate)) return candidate;
  }
  return head || "main";
}

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
  // Branches that still EXIST, merged or not. On a repo that never merges this is the only source.
  const refs = await listBranchRefs(projectDir);
  const trunkName = await resolveTrunk(projectDir, refs);
  const already = new Set(branches.map((b) => b.name));
  for (const ref of refs) {
    if (ref.name === trunkName || already.has(ref.name) || branches.length >= maxBranches) continue;
    const raw = await git(projectDir, [
      "log",
      "--use-mailmap",
      `--max-count=${maxBranches * 20}`,
      "--numstat",
      `--format=${RS}${["%H", "%h", "%aN", "%aE", "%aI", "%s", "%P", `%(trailers:key=Co-Authored-By,valueonly,separator=${TS})`].join(FS)}`,
      ref.ref,
      "--not",
      trunkName,
    ]);
    const commits = parseLog(raw);
    // A branch with nothing the trunk lacks is fully merged and already drawn, or is a duplicate.
    if (!commits.length) continue;
    branches.push({
      name: ref.name,
      pr: null,
      mergeSha: "",
      mergedAt: "",
      remote: ref.remote,
      open: true,
      commits,
    });
  }

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
