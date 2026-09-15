/**
 * Which agents a repository DECLARES, read from the config files it commits.
 *
 * The trailer signal this tool was built on is far sparser than the design assumed. Measured over
 * the newest 500 commits of six well-known repositories — 3,000 commits — **45 of them, 1.5%,
 * carried a `Co-Authored-By` trailer that could be attributed to an agent.** Five of those six
 * repositories declare their agents in a committed file. On a repository picked at random the
 * entire output was one row: `no agent recorded 100%`.
 *
 * So the dense signal was sitting in the same working tree as the sparse one, and nothing opened
 * it. This module opens it, and answers a DIFFERENT question: not "which commits recorded an
 * agent" but "which agents is this project set up for".
 *
 * **Two rules, both load-bearing.**
 *
 * Only the NAME is read, never the contents. What is inside `CLAUDE.md` is somebody's prompt —
 * their standards, their architecture, sometimes their business. This tool reads `git log` and
 * filenames, and adding "and the text of your instructions file" to that list is a different
 * product with a different threat model. `git ls-files`, never `readFile`.
 *
 * And it asks GIT, not the filesystem. An untracked `.claude/` that somebody's own session left in
 * the working tree is not a declaration by the project, and reporting it as one would tell a reader
 * this repository is set up for Claude Code on the evidence of their own scratch directory.
 *
 * Configured is not used. A `CLAUDE.md` committed once and never opened since looks identical to
 * one driving every commit. This is evidence of intent, and the caller must present it apart from
 * the commit counts rather than blended into them — a single number combining "6% attributed" and
 * "configured for Claude Code" would mean nothing, and would be the same defect as the 47% row
 * that 0.5.4 removed.
 */

import { git } from "./git-history.js";

/**
 * What a committed file or directory says about the agent a project is set up for.
 *
 * `family` matches the ids in `FAMILIES` in git-history.js where there is a real correspondence,
 * so a caller can line the two sources up. `AGENTS.md` deliberately has none: it is the
 * cross-vendor file and naming a vendor for it would be inventing one.
 *
 * `kind` is "file" or "dir" and is checked rather than assumed — `.cursor` is a directory and
 * `.cursorrules` is a file, and a repository with a file called `.claude` is telling us something
 * other than what we would conclude.
 */
const MARKERS = [
  { path: "AGENTS.md", kind: "file", family: "", label: "a cross-vendor AGENTS.md" },
  { path: "CLAUDE.md", kind: "file", family: "claude", label: "CLAUDE.md" },
  { path: ".claude", kind: "dir", family: "claude", label: ".claude/" },
  { path: ".cursor", kind: "dir", family: "cursor", label: ".cursor/" },
  { path: ".cursorrules", kind: "file", family: "cursor", label: ".cursorrules" },
  { path: ".windsurfrules", kind: "file", family: "windsurf", label: ".windsurfrules" },
  { path: ".github/copilot-instructions.md", kind: "file", family: "copilot", label: "copilot-instructions.md" },
  { path: ".github/instructions", kind: "dir", family: "copilot", label: ".github/instructions/" },
  { path: ".aider.conf.yml", kind: "file", family: "aider", label: ".aider.conf.yml" },
  { path: ".gemini", kind: "dir", family: "gemini", label: ".gemini/" },
  { path: ".codex", kind: "dir", family: "codex", label: ".codex/" },
];

/** The display name for a family id, matching the labels `FAMILIES` uses. */
const FAMILY_LABEL = {
  claude: "Claude Code",
  cursor: "Cursor",
  copilot: "Copilot",
  windsurf: "Windsurf",
  aider: "aider",
  gemini: "Gemini",
  codex: "Codex",
};

/**
 * Which of the marker paths this repository has COMMITTED, and what kind each one is.
 *
 * Asked of git rather than of the filesystem, and the difference is the whole point. An untracked
 * `.claude/` left in a working tree by somebody's own session is not a declaration by the project
 * — reporting it as one would tell a reader this repository is set up for Claude Code on the
 * evidence of their own scratch directory. `git ls-files` answers what was committed, which is
 * what "the repository declares" means.
 *
 * One call, not one per marker: `ls-files` takes all the pathspecs at once, and eleven `stat`
 * calls replaced by one process is the difference between free and noticeable on a large tree.
 */
async function committedPaths(projectDir) {
  const res = await git(projectDir, ["ls-files", "-z", "--", ...MARKERS.map((m) => m.path)]);
  if (!res.ok) return null;
  // A tracked directory has no entry of its own — git tracks files — so `.claude/settings.json`
  // arrives and `.claude` does not. Both the exact path and anything beneath it count.
  return res.out.split("\0").filter(Boolean);
}

/**
 * What this repository declares about the agents it is set up for.
 *
 * Returns `{ ok, markers, agents, crossVendor }`. `ok` is false only when the directory cannot be
 * read at all, which is a different answer from "read it and found nothing" — the second is a
 * finding and the first is a failure, and folding them together is how a gap becomes invisible.
 */
export async function readAgentConfig(projectDir) {
  const tracked = await committedPaths(projectDir);
  if (tracked === null) {
    return { ok: false, note: "git could not list the tracked files here", markers: [], agents: [], crossVendor: false };
  }

  const markers = MARKERS.filter((marker) =>
    marker.kind === "dir"
      ? tracked.some((p) => p.startsWith(`${marker.path}/`))
      : tracked.includes(marker.path),
  );

  // One entry per agent, with the files that named it — the same shape as the commit rows, where
  // the agent is the row and the detail sits under it.
  const byFamily = new Map();
  for (const marker of markers) {
    if (!marker.family) continue;
    const row = byFamily.get(marker.family) || {
      id: marker.family,
      label: FAMILY_LABEL[marker.family] || marker.family,
      files: [],
    };
    row.files.push(marker.label);
    byFamily.set(marker.family, row);
  }

  return {
    ok: true,
    note: "",
    markers,
    agents: [...byFamily.values()].sort((a, b) => a.label.localeCompare(b.label)),
    // `AGENTS.md` names no vendor by design, so it is reported as its own fact rather than
    // attributed to whichever agent happens to read it.
    crossVendor: markers.some((m) => m.path === "AGENTS.md"),
  };
}

/**
 * Whether an agent writes the trailer on its own, by family id.
 *
 * `true` means the tool attests to its own commits without being asked, so a repository configured
 * for it and recording nothing is a discrepancy worth a sentence. `false` means it does not write
 * one at all, so an empty result is the expected outcome and there is nothing for anybody to fix.
 *
 * Stated as a flat fact per family and nothing finer. The exact setting that controls it is a
 * vendor's to change and we would be wrong about it within a release — naming a settings key here
 * would be the same mistake as the one that produced this function, which was asserting that
 * `rooms hooks install` writes a trailer. It writes a board post. Attribution comes from the agent,
 * and this tool cannot and must not manufacture it.
 */
const WRITES_ITS_OWN_TRAILER = {
  claude: true,
  aider: true,
  jules: true,
  gemini: true,
  cursor: false,
  copilot: false,
  windsurf: false,
  codex: false,
};

/**
 * Why nothing was attributed, for a window where nothing was — or "" when something was.
 *
 * Three different situations produce the same empty row, and a reader cannot tell them apart:
 * their setup is broken, their setup never did this, or nothing used an agent. Saying which is the
 * whole value here, and in two of the three cases the honest answer is that nothing is wrong.
 */
export function whyNothingRecorded(config) {
  if (!config || !config.ok) return "";
  const declared = config.agents || [];
  if (!declared.length) {
    return config.crossVendor
      ? "An AGENTS.md is committed here but it names no vendor, so there is nothing to compare " +
        "these commits against. If an agent was used and wrote no trailer, nothing here can tell."
      : "Nothing here declares an agent either, so if none was used this is simply the answer.";
  }

  const attesting = declared.filter((a) => WRITES_ITS_OWN_TRAILER[a.id]);
  const quiet = declared.filter((a) => WRITES_ITS_OWN_TRAILER[a.id] === false);
  const names = (list) => list.map((a) => a.label).join(" and ");

  if (attesting.length) {
    return (
      `${names(attesting)} writes this trailer itself, and none of these commits carries one — ` +
      "so either it was turned off, or this window predates it. " +
      "Rooms cannot add one: a trailer it wrote would be a claim about authorship made by " +
      "something that was not there."
    );
  }
  if (quiet.length) {
    return (
      `${names(quiet)} does not write a Co-Authored-By trailer, so an empty result here is the ` +
      "expected one rather than a fault. There is nothing to switch on."
    );
  }
  return "";
}

/**
 * The sentence that must travel with any configuration claim, for the same reason `FLOOR_NOTE`
 * travels with any percentage.
 */
export const CONFIG_NOTE =
  "A config file says a tool was set up here, never that it was used — and never how much. " +
  "These are not commits and do not belong in the percentages above.";
