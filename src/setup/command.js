/**
 * `rooms setup …`: export a Claude Code setup into the team room, show one, adopt one, roll an
 * adoption back, and see where adoptions stand (docs/design/TEAM_SETUPS.md §8).
 *
 * None of these is an MCP tool. Export shares somebody's prompts and adopt runs code as them, so
 * both belong to a person at a terminal: export asks before it commits (or takes `--yes`), and
 * adopt asks at a terminal or takes `--approve` with the digest of the exact plan a preview printed.
 * `--yes` alone never adopts anything.
 */

import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { repositoryTop } from "../git-info.js";
import { authStatus, roomsHomeDir } from "../identity.js";
import { PKG_ROOT } from "../mcp-install.js";
import { shWord } from "../shortcut.js";
import { checkPrivate, pullTeamRoom, readRegistry, teamForProject } from "../team.js";
import { CHECKED_AGAINST, claudeDirs, readClaudeCode, selectItems } from "./claude-code.js";
import { CODEX_CHECKED_AGAINST, codexDirs, readCodex } from "./codex.js";
import { buildManifest, checkSetup, filePathFor, parseCost, renderReadme, SLUG } from "./manifest.js";
import { branchFor, commitSetup, dirFor, lastChange, listSetups, readSetupAt, resolveCommit, whoAdded } from "./room.js";
import { applyAdoption, changedSince, planAdoption, readAdoptions, rollBack } from "./adopt.js";
import { describeRule } from "./permissions.js";
import { frontmatter, toolList } from "./prose.js";

const USAGE = [
  "usage: rooms setup export --role <role> --name <name> [--summary <text>] [--cost \"100 what it pays for\"]",
  "                          [--tool claude-code|codex] [--user] [--only <a,b>] [--skip <a,b>] [--team <owner/repo>] [--dry-run] [--yes]",
  "       rooms setup show [<role/name>] [--ref <commit or branch>] [--team <owner/repo>]",
  "       rooms setup adopt <role/name> [--user] [--skip <a,b>] [--ref <commit or branch>] [--approve <digest>]",
  "       rooms setup rollback [<id>] [--force] [--yes]",
  "       rooms setup status",
].join("\n");

const out = (s) => process.stdout.write(`${s}\n`);
const list = (v) => (v === undefined || v === true ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const shown = (v) => (Array.isArray(v) ? v.join(" ") : String(v));
const day = (iso) => String(iso || "").slice(0, 16).replace("T", " ");
const backupsDir = () => join(roomsHomeDir(), "backups");

/** The team room a setup command works with: `--team`, the one this project is linked to, or the only one. */
async function teamRoom(argv) {
  const reg = await readRegistry();
  const linked = await teamForProject(process.cwd());
  const ids = Object.keys(reg.teams);
  const id = argv.team ? String(argv.team) : linked.id || (ids.length === 1 ? ids[0] : null);
  if (!id || !reg.teams[id]) {
    throw new Error(ids.length ? `Which team room? Add --team <one of: ${ids.join(", ")}>` : "No team room yet: rooms team join <owner/repo>");
  }
  return { id, room: reg.teams[id] };
}

const remoteOf = (room) => (room.remote ? { host: room.remote.split("/")[0], path: room.remote.split("/").slice(1).join("/") } : null);

function parseTarget(target) {
  const m = /^([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,39})$/.exec(String(target || ""));
  if (!m) throw new Error(`Name a setup as <role>/<name>, as rooms setup show lists them.\n${USAGE}`);
  return { role: m[1], name: m[2] };
}

/** Where a setup's file goes, as a person reads it: `.claude/agents/r.md`, `~/.codex/prompts/x.md`. */
const placeLabel = (installTo, tool) =>
  String(installTo).replace(/^project:/, "").replace(/^home:/, "~/").replace(/^user:/, tool === "codex" ? "~/.codex/" : "~/.claude/");

function runLine(r) {
  const codex = r.tool === "codex" ? "codex " : "";
  const where = r.surface === "hook" ? `hook ${r.event}${r.matcher ? ` (${r.matcher})` : ""}` : r.surface === "mcp" ? `${codex}mcp ${r.name}` : r.surface === "loads" ? "as it loads" : r.surface === "notify" ? "codex notify" : `${codex}script`;
  const what = r.shown ?? r.command ?? r.url ?? placeLabel(r.file, r.tool);
  const file = r.surface === "loads" ? `  (${placeLabel(r.file, r.tool)})` : "";
  return `  ${where.padEnd(22)} ${what}${r.pinned ? `   pinned ${r.pinned.join(", ")}` : ""}${file}`;
}

function requireLine(q) {
  return q.env ? `env ${q.env} (${q.for})` : `program ${q.program} (${q.for})`;
}

/** Who added each thing a setup runs, and in which commit, as git records it. */
async function provenance(clone, commit, dir, runs) {
  for (const r of runs) {
    if (r.surface === "hook" || r.surface === "mcp" || r.surface === "notify") {
      // Found through setup.json's own list of what it runs, which spells out each command whole.
      r.added = await whoAdded(clone, commit, `${dir}/setup.json`, JSON.stringify(r.command ?? r.url).slice(1, -1));
    } else if (r.surface === "loads") {
      r.added = await whoAdded(clone, commit, `${dir}/${filePathFor(r.file, r.tool)}`, r.command);
    } else {
      r.added = await whoAdded(clone, commit, `${dir}/${filePathFor(r.file, r.tool)}`);
      const last = await lastChange(clone, commit, `${dir}/${filePathFor(r.file, r.tool)}`);
      if (last && r.added && last.commit !== r.added.commit) r.changed = last;
    }
  }
}

const addedWords = (r) =>
  `${r.added ? `      added in ${r.added.short} by ${r.added.author}` : "      not found in the team room's history"}${r.changed ? `, last changed in ${r.changed.short} by ${r.changed.author}` : ""}`;

/** A setup read at a commit and checked, or why it cannot be shown. */
async function loadSetup(clone, commit, role, name) {
  const read = await readSetupAt(clone, commit, role, name);
  if (!read.found) return { found: false };
  const problems = read.problems.length ? read.problems : checkSetup(read.manifest, read.files, { role, name });
  return { found: true, manifest: read.manifest, files: read.files, problems };
}

// ---- export ---------------------------------------------------------------------------------------

async function exportSetup(argv, h) {
  const role = String(argv.role ?? "");
  const name = String(argv.name ?? "");
  if (!SLUG.test(role) || !SLUG.test(name)) throw new Error(`--role and --name are lowercase letters, digits and dashes.\n${USAGE}`);
  const login = (await authStatus()).github?.login;
  if (!login) throw new Error("A setup is filed under your GitHub login, and this machine has none linked: rooms auth github");
  const { id, room } = await teamRoom(argv);
  const priv = await checkPrivate(remoteOf(room), { confirmPrivate: Boolean(room.confirmedPrivate), allowPublic: Boolean(room.allowPublic) });
  if (!priv.ok) throw new Error(`Nothing was exported: ${priv.why}. To go ahead: ${priv.fix}.`);
  const pulled = await pullTeamRoom(room.path);
  const top = await repositoryTop(process.cwd());
  const project = top ? await realpath(top) : null;
  const bundledSkill = await readFile(join(PKG_ROOT, "skills", "rooms", "SKILL.md"), "utf8").catch(() => null);
  const tools = argv.tool ? list(argv.tool) : ["claude-code", "codex"];
  for (const t of tools) if (t !== "claude-code" && t !== "codex") throw new Error(`--tool is claude-code or codex, not ${t}`);
  const reads = [];
  if (tools.includes("claude-code")) reads.push(await readClaudeCode({ project, bundledSkill }));
  if (tools.includes("codex")) reads.push(await readCodex({ project }));
  const read = { items: reads.flatMap((r) => r.items), left: reads.flatMap((r) => r.left) };
  const items = selectItems(read.items, { user: Boolean(argv.user), only: list(argv.only), skip: list(argv.skip) });

  const branch = branchFor(role, name);
  const prevAt = (await resolveCommit(room.path, `refs/heads/${branch}`)) || (await resolveCommit(room.path, "HEAD"));
  const prev = prevAt ? await readSetupAt(room.path, prevAt, role, name) : { found: false };
  const prevOwner = prev.manifest?.owner;
  if (prevOwner && prevOwner !== login && !argv.force) {
    throw new Error(`${role}/${name} in ${id} is ${prevOwner}'s. Export under another name, or pass --force to propose replacing it; the pull request will show that.`);
  }
  const summary = argv.summary !== undefined ? String(argv.summary).slice(0, 300) : prev.manifest?.summary;
  const cost = argv.cost !== undefined ? parseCost(argv.cost) : prev.manifest?.cost;

  const refusedMeant = items.filter((i) => i.meant && i.refused);
  const notExported = [
    ...read.left.filter((l) => !l.local),
    ...items.filter((i) => i.selected).flatMap((i) => i.left),
    ...refusedMeant.map((i) => ({ what: i.label, why: i.refusedWhy })),
  ];
  const { manifest, files } = buildManifest({ role, name, owner: login, summary, cost, version: h.version, items, notExported });
  // Fields a newer Rooms added to the last revision are kept, not dropped by an older one re-exporting.
  const known = new Set(["format", "formatVersion", "name", "role", "owner", "summary", "cost", "exportedWith", "tools", "runs", "requires", "notExported"]);
  if (prev.manifest?.formatVersion === manifest.formatVersion) {
    for (const [k, v] of Object.entries(prev.manifest)) if (!known.has(k)) manifest[k] = v;
  }
  // Export never commits what adopt would refuse: the same check, on the same bytes, first.
  const problems = checkSetup(JSON.parse(JSON.stringify(manifest)), files, { role, name });
  if (problems.length) throw new Error(`This setup would not pass the check adopting runs, so nothing was written:\n  ${problems.join("\n  ")}`);

  out(`Setup  ${role}/${name}, as ${login}, into ${room.name} (${id}; ${priv.how})`);
  if (!pulled.ok) out(`       the team room could not be brought up to date (${pulled.why}); building on what this machine has`);
  const names = tools.map((t) => (t === "claude-code" ? `Claude Code (checked against ${CHECKED_AGAINST})` : `Codex (checked against ${CODEX_CHECKED_AGAINST})`));
  out(`Read from the files ${names.join(" and ")} keeps for ${project ? "this project and " : ""}for you.`);
  out("Nothing is written until you confirm, and nothing leaves this machine: you push.\n");
  for (const i of items) {
    const where = i.scope === "project" ? "project" : "yours";
    if (i.refused) {
      out(`  REFUSED  ${i.refused}`);
      continue;
    }
    const size = i.content !== undefined ? kb(i.bytes) : "";
    const hint = !i.selected && !i.empty && i.scope !== "project" && !argv.user && !list(argv.only).length ? "--user to include" : "";
    out(`  [${i.selected ? "x" : " "}] ${i.label.padEnd(44)} ${where.padEnd(8)} ${size.padEnd(8)} ${[i.info, hint].filter(Boolean).join(" · ")}`.trimEnd());
    if (i.selected) for (const n of i.notes) out(`        ${n}`);
  }
  const leftShown = [...read.left, ...items.filter((i) => i.selected).flatMap((i) => i.left)];
  if (leftShown.length) {
    out("\nLeft out");
    for (const l of leftShown) out(`  ${l.what.padEnd(48)} ${l.why}${l.detail ? ` (${l.detail})` : ""}`);
  }
  if (manifest.runs.length) {
    out("\nIt would run, as whoever adopts it");
    for (const r of manifest.runs) out(runLine(r));
  }
  if (manifest.requires.length) out(`\nIt needs\n  ${manifest.requires.map(requireLine).join("\n  ")}`);
  const count = Object.values(manifest.tools).reduce((n, t) => n + t.files.length, 0);
  if (!items.some((i) => i.selected)) throw new Error("Nothing is selected, so there is nothing to export.");
  out(`\nCommit  setups/${role}/${name}/ on branch ${branch}`);
  out(`        in ${room.path}: setup.json, README.md and ${count} file${count === 1 ? "" : "s"}. Rooms does not push it; you do.`);
  if (argv["dry-run"]) {
    out(`\nsetups/${role}/${name}/setup.json would hold:\n${JSON.stringify(manifest, null, 2)}`);
    return;
  }
  if (!(await h.confirmOrStop(argv, "Commit it?"))) return;
  const all = new Map([
    ["setup.json", { content: `${JSON.stringify(manifest, null, 2)}\n` }],
    ["README.md", { content: renderReadme(manifest) }],
    ...Object.values(manifest.tools).flatMap((t) => t.files.map((f) => [f.path, { content: files.get(f.path), executable: Boolean(f.executable) }])),
  ]);
  const done = await commitSetup({ clone: room.path, role, name, files: all, message: `setup: ${role}/${name}, from ${login}` });
  if (!done.ok) throw new Error(`Nothing was exported: ${done.why}`);
  if (done.unchanged) {
    out(`Nothing changed since the last export of ${role}/${name}; nothing was committed.`);
    return;
  }
  out(`committed ${done.commit.slice(0, 7)} on ${branch}. Nothing was pushed.`);
  out(`  look at it  git -C ${shWord(room.path)} show --stat ${branch}`);
  out(`  share it    git -C ${shWord(room.path)} push -u origin ${branch}`);
  out(`              then open a pull request from ${branch}${room.remote?.startsWith("github.com/") ? `: gh pr create --repo ${room.remote.slice(11)} --head ${branch} --fill` : ""}`);
}

// ---- show -----------------------------------------------------------------------------------------

async function show(target, argv) {
  const { id, room } = await teamRoom(argv);
  const pulled = await pullTeamRoom(room.path);
  const commit = await resolveCommit(room.path, argv.ref ? String(argv.ref) : "HEAD");
  if (!commit) throw new Error(`${argv.ref ? `--ref ${argv.ref}` : "The team room"} is not a commit this clone has.`);
  const stale = pulled.ok ? "" : `, as this machine last fetched it (${pulled.why})`;
  if (!target) {
    const setups = await listSetups(room.path, commit);
    if (!setups.length) {
      out(`No setups in ${room.name} (${id}) yet${stale}. Share yours: rooms setup export --role <role> --name <name>`);
      return;
    }
    out(`Setups in ${room.name} (${id}) at ${commit.slice(0, 7)}${stale}`);
    for (const { role, name } of setups) {
      const s = await readSetupAt(room.path, commit, role, name);
      const m = s.manifest || {};
      out(`  ${`${role}/${name}`.padEnd(32)} ${typeof m.owner === "string" ? m.owner.slice(0, 39) : "?"}${typeof m.summary === "string" ? `  ${m.summary.slice(0, 120)}` : ""}`);
    }
    return;
  }
  const { role, name } = parseTarget(target);
  const s = await loadSetup(room.path, commit, role, name);
  if (!s.found) throw new Error(`There is no ${role}/${name} in ${id} at ${commit.slice(0, 7)}${stale}.`);
  if (s.problems.length) {
    out(`${role}/${name} at ${commit.slice(0, 7)} cannot be shown or adopted as it is:\n  ${s.problems.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  const m = s.manifest;
  out(`${role}/${name}  by ${m.owner}, in ${room.name} at ${commit.slice(0, 7)}${stale}`);
  if (m.summary) out(`  ${m.summary}`);
  if (m.cost) out(`  cost  $${m.cost.usdPerMonth} a month${m.cost.what ? `, ${m.cost.what}` : ""} (declared by ${m.owner}; not measured)`);
  const against = Object.values(m.tools).map((t) => t.checkedAgainst).filter(Boolean).join(" and ");
  out(`  made with ${m.exportedWith}, read against ${against || "an unnamed version"}`);
  for (const [tool, part] of Object.entries(m.tools)) {
    out(`\n${tool === "codex" ? "Codex" : "Claude Code"} files`);
    for (const f of part.files || []) {
      const text = s.files.get(f.path);
      const fm = frontmatter(text).keys;
      const bits = [];
      if (f.kind === "agent") {
        bits.push(fm.model?.text ? `model ${fm.model.text}` : "model as the session's");
        bits.push(fm.tools ? `tools ${toolList(fm.tools).join(", ")}` : "all tools");
      }
      if (fm["allowed-tools"]) bits.push(`runs without asking while it runs: ${toolList(fm["allowed-tools"]).join(" ")}`);
      if (f.executable) bits.push("runs as a program");
      out(`  ${placeLabel(f.installTo, tool).padEnd(44)} ${f.kind.padEnd(13)} ${kb(Buffer.byteLength(text))}${bits.length ? `  ${bits.join(" · ")}` : ""}`);
    }
    if (!(part.files || []).length) out("  none");
  }
  const cc = m.tools["claude-code"] || {};
  for (const scope of ["project", "user"]) {
    const st = cc[scope]?.settings;
    if (!st) continue;
    out(`\nClaude Code settings for ${scope === "project" ? "the project (into .claude/settings.local.json)" : "every project (into ~/.claude/settings.json, with --user)"}`);
    for (const list of ["allow", "ask", "deny"]) for (const rule of st.permissions?.[list] || []) out(`  ${list.padEnd(6)} ${rule.padEnd(36)} ${describeRule(list, rule)}`);
    if (st.permissions?.defaultMode) out(`  mode   ${st.permissions.defaultMode}`);
    if (st.model) out(`  model  ${st.model}`);
    if (st.env) out(`  env    ${Object.keys(st.env).join(", ")} (names only: each person sets their own)`);
  }
  const cxs = m.tools.codex?.user?.settings;
  if (cxs) {
    out("\nCodex settings for every project (into ~/.codex/config.toml, with --user)");
    for (const [k, v] of Object.entries(cxs)) {
      const says = k === "approval_policy" ? { never: "never asks; what needs more than the sandbox fails", "on-request": "asks when a command needs more than the sandbox", untrusted: "asks before a command it does not know to be safe", "on-failure": "asks when a command fails in the sandbox" }[v] : k === "sandbox_mode" ? (v === "workspace-write" ? "commands may write in the project, and nowhere else" : "commands may read, and write nothing") : "";
      out(`  ${k.padEnd(22)} ${Array.isArray(v) ? v.join(" ") : v}${says ? `   ${says}` : ""}`);
    }
  }
  const runs = m.runs.map((r) => ({ ...r }));
  await provenance(room.path, commit, dirFor(role, name), runs);
  out(`\nIt runs on the machine of whoever adopts it, as them${runs.length ? "" : ": nothing"}`);
  for (const r of runs) out(`${runLine(r)}\n${addedWords(r)}`);
  if (m.requires.length) out(`\nIt needs\n  ${m.requires.map(requireLine).join("\n  ")}`);
  if (m.notExported.length) {
    out(`\nLeft out by ${m.owner}`);
    for (const n of m.notExported) out(`  ${n.what.padEnd(48)} ${n.why}`);
  }
  out(`\nAdopt it: rooms setup adopt ${role}/${name}   (shows the plan first)`);
}

// ---- adopt ----------------------------------------------------------------------------------------

async function adopt(target, argv, h) {
  const { role, name } = parseTarget(target);
  if (argv.yes && !argv.approve) {
    process.stderr.write(
      "Adopting runs a teammate's code as you, so --yes is not enough. Approve the plan at a terminal,\n" +
        "or pass --approve with the digest its preview printed.\n",
    );
    process.exitCode = 2;
    return;
  }
  const top = await repositoryTop(process.cwd());
  if (!top) throw new Error("Run this inside the project to adopt the setup into.");
  const project = await realpath(top);
  const { id, room } = await teamRoom(argv);
  const pulled = await pullTeamRoom(room.path);
  const commit = await resolveCommit(room.path, argv.ref ? String(argv.ref) : "HEAD");
  if (!commit) throw new Error(`${argv.ref ? `--ref ${argv.ref}` : "The team room"} is not a commit this clone has.`);
  const s = await loadSetup(room.path, commit, role, name);
  if (!s.found) throw new Error(`There is no ${role}/${name} in ${id} at ${commit.slice(0, 7)}.`);
  if (s.problems.length) {
    out(`${role}/${name} at ${commit.slice(0, 7)} cannot be adopted as it is, so nothing was changed:\n  ${s.problems.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  const revision = (await lastChange(room.path, commit, dirFor(role, name)))?.commit || commit;
  const { config } = claudeDirs();
  const codexConfig = codexDirs().config;
  const plan = await planAdoption({
    setup: { manifest: s.manifest, files: s.files, commit, revision, team: id },
    project,
    config,
    codexConfig,
    home: homedir(),
    user: Boolean(argv.user),
    skip: list(argv.skip),
  });
  await provenance(room.path, commit, dirFor(role, name), plan.runs);

  out(`Plan for ${role}/${name} by ${plan.owner}, at ${commit.slice(0, 7)} in ${room.name}${pulled.ok ? "" : ` (as last fetched: ${pulled.why})`}. Nothing has changed yet.`);
  for (const w of plan.writes) {
    if (w.action === "same") {
      out(`  same     ${w.label}`);
      continue;
    }
    const what =
      w.action === "new" && !(w.changes || []).length ? "new file" :
      w.action === "replace" ? `replaces yours: +${w.change.added} −${w.change.removed} lines${w.tracked ? "; git tracks it, so it shows in git status" : ""}` :
      (w.changes || []).map((c) => (c.kind === "rule" ? `+ ${c.list} ${c.rule}` : c.kind === "hook" ? `+ hooks.${c.event}` : c.kind === "server" ? `+ ${c.name}` : c.kind === "model" ? `model ${c.now} (was ${c.was ?? "unset"})` : c.kind === "mode" ? `mode ${c.now} (was ${c.was ?? "unset"})` : c.kind === "setting" ? `${c.key} ${shown(c.now)} (was ${c.was === null || c.was === undefined ? "unset" : shown(c.was)})` : "+ .claude/settings.local.json, so git leaves it out")).join(" · ");
    out(`  ${(w.action === "merge" ? "merge" : "write").padEnd(8)} ${w.label.padEnd(36)} ${w.action === "new" && (w.changes || []).length ? `new file: ${what}` : what}`);
    if (w.shared) out(`           ${"".padEnd(36)} shared with the project: commit it only if everyone should have it`);
    if (w.note) out(`           ${"".padEnd(36)} ${w.note}`);
    for (const k of w.kept || []) out(`           ${"".padEnd(36)} kept yours: ${k} (you already have a server by that name)`);
  }
  for (const k of plan.skipped) out(`  skip     ${k.label.padEnd(36)} ${k.why}`);
  if (plan.runs.length) {
    out("\nThese will run on this machine, as you:");
    for (const r of plan.runs) out(`${runLine(r)}\n${addedWords(r)}`);
  }
  if (plan.grants.length) {
    out("\nWhat Claude may then do without asking:");
    for (const g of plan.grants) {
      if (g.mode) out(`  mode ${g.mode} (was ${g.was ?? "unset"})   in ${g.where}`);
      else if (g.setting) out(`  ${g.setting} ${g.value} (was ${g.was ?? "unset"})   ${g.says}   (${g.where})`);
      else out(`  ${g.list.padEnd(14)} ${g.rule.padEnd(30)} ${g.says}   (${g.where})`);
    }
  }
  if (s.manifest.requires.length) out(`\nThe setup needs\n  ${s.manifest.requires.map(requireLine).join("\n  ")}`);
  if (plan.userServers.length) {
    out("\nServers for every project are kept in ~/.claude.json with your account, so Rooms does not write them.\nAfter adopting, add the ones you want yourself:");
    for (const sv of plan.userServers) out(`  claude mcp add-json ${shWord(sv.name)} ${shWord(sv.json)} --scope user`);
  }
  if (plan.refused.length) {
    out(`\nRefused, so nothing was changed:\n  ${plan.refused.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  const todo = plan.writes.filter((w) => w.action !== "same");
  if (!todo.length) {
    out("\nEverything in it is already here; there is nothing to change.");
    return;
  }
  out(`\nBackup  ${join(backupsDir(), "<this adoption>")}\nUndo    rooms setup rollback\nPlan ${plan.digest}.`);
  if (argv.approve) {
    if (String(argv.approve) !== plan.digest) {
      process.stderr.write(`That digest is not this plan's (it is ${plan.digest} now): the setup or your files changed since it was printed. Nothing was changed; read the plan above.\n`);
      process.exitCode = 2;
      return;
    }
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`Not a terminal, so nothing was changed. To apply exactly this plan: rooms setup adopt ${role}/${name}${argv.user ? " --user" : ""}${argv.skip ? ` --skip ${list(argv.skip).join(",")}` : ""} --approve ${plan.digest}\n`);
    process.exitCode = 2;
    return;
  } else if (!(await h.confirmOrStop({ ...argv, yes: false }, "Apply?"))) {
    return;
  }
  const done = await applyAdoption(plan, { backupsDir: backupsDir() });
  out(`adopted ${role}/${name}: ${done.written} file${done.written === 1 ? "" : "s"} written. Backup: ${done.dir}\nUndo: rooms setup rollback`);
}

// ---- rollback and status --------------------------------------------------------------------------

async function rollback(id, argv, h) {
  const records = await readAdoptions(backupsDir());
  const top = await repositoryTop(process.cwd());
  const project = top ? await realpath(top) : null;
  const record = id ? records.find((r) => r.id === id) : records.find((r) => r.state === "applied" && r.project === project);
  if (!record) throw new Error(id ? `There is no adoption ${id}: rooms setup status lists this project's.` : "Nothing adopted in this project to roll back. rooms setup status lists adoptions.");
  if (record.state !== "applied") throw new Error(`${record.id} is ${record.state}; there is nothing to roll back.`);
  out(`Roll back ${record.setup}, adopted ${day(record.adoptedAt)} from ${String(record.commit).slice(0, 7)}`);
  for (const e of record.entries) out(`  ${e.existed ? "restore" : "remove "}  ${e.label.padEnd(40)} ${e.existed ? "as it was before" : "it did not exist before"}`);
  const changed = await changedSince(record);
  if (changed.length && !argv.force) {
    out(`\nChanged since the adoption, so nothing was rolled back:\n  ${changed.map((c) => `${c.label}  ${c.how}`).join("\n  ")}`);
    out(`rooms setup rollback --force puts every file back anyway; the versions you have now are kept in ${join(record.dir, "at-rollback")}.`);
    process.exitCode = 2;
    return;
  }
  if (!(await h.confirmOrStop(argv, "Roll it back?"))) return;
  const done = await rollBack(record, { force: Boolean(argv.force) });
  out(`rolled back ${record.setup}: every file is as it was before.${done.changed.length ? ` Your later versions are in ${join(record.dir, "at-rollback")}.` : ""}`);
}

async function status() {
  const top = await repositoryTop(process.cwd());
  const project = top ? await realpath(top) : null;
  const records = (await readAdoptions(backupsDir())).filter((r) => r.state === "applied" && r.project === project);
  if (!records.length) {
    out("No setup is adopted in this project. The team's: rooms setup show");
    return;
  }
  const reg = await readRegistry();
  const pulled = new Map();
  for (const r of records) {
    const changed = await changedSince(r);
    out(`${r.setup}, adopted ${day(r.adoptedAt)} from ${String(r.commit).slice(0, 7)} (${r.team})`);
    out(`  here       ${changed.length ? `changed since: ${changed.map((c) => c.label).join(", ")}` : "as adopted"}`);
    const room = reg.teams[r.team];
    if (!room) {
      out("  team room  not linked on this machine any more");
      continue;
    }
    if (!pulled.has(r.team)) pulled.set(r.team, await pullTeamRoom(room.path));
    const last = await lastChange(room.path, "HEAD", dirFor(r.role, r.name));
    const fetched = pulled.get(r.team).ok ? "" : " (as last fetched)";
    if (!last) out(`  team room  no longer has it${fetched}`);
    else if (last.commit !== r.revision) out(`  team room  a newer revision, ${last.short} by ${last.author}, ${day(last.at)}${fetched}: rooms setup show ${r.setup}`);
    else out(`  team room  nothing newer${fetched}`);
  }
}

export async function setupCommand(rest, argv, h) {
  const sub = rest[0] || "";
  if (sub === "export") return exportSetup(argv, h);
  if (sub === "show") return show(rest[1], argv);
  if (sub === "adopt") return adopt(rest[1], argv, h);
  if (sub === "rollback") return rollback(rest[1], argv, h);
  if (sub === "status") return status();
  throw new Error(USAGE);
}
