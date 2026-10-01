/**
 * Adopting a setup from the team room, and undoing it (docs/design/TEAM_SETUPS.md §8.2).
 *
 * Adopting runs a teammate's code as you, so it is a plan first: every file it would write, every
 * change to a settings file, everything that would run, and a digest of exactly that. Nothing is
 * written until a person approves that plan, at a terminal or by its digest. Settings merge into the
 * project's personal file, `.claude/settings.local.json`, never the shared one. The person's own
 * Claude Code folder is written only with `--user`, and `~/.claude.json`, which holds the account,
 * never: its servers are printed as `claude mcp add-json` lines for the person to run.
 *
 * Every file the adoption changes is copied to `~/.iops-rooms/backups/<id>/` first. Rollback puts
 * each one back byte for byte and removes what the adoption created, or stops, naming what changed
 * since, unless told `--force`, in which case the changed copies are kept beside the backup.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { gitIn } from "../team.js";
import { CODEX, installPlace, normalizeText, TOOL, TOOLS } from "./manifest.js";
import { mergeCodexToml } from "./toml.js";
import { describeRule } from "./permissions.js";
import { frontmatter, toolList } from "./prose.js";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** What is at a path now: its bytes and mode, or that it is missing, a link, or not a file. */
async function current(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return { exists: true, link: true };
    if (!st.isFile()) return { exists: true, notFile: true };
    return { exists: true, bytes: await readFile(path), mode: st.mode & 0o777 };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { exists: false, bytes: null };
    throw e;
  }
}

/** `rel` under `root`, or null if it would leave it. A checked manifest never asks; this is the second lock. */
function under(root, rel) {
  const target = join(root, ...rel.split("/"));
  const back = relative(root, target);
  return back && !back.startsWith("..") && !isAbsolute(back) ? target : null;
}

function lineChange(before, after) {
  const a = normalizeText(before.toString("utf8")).split("\n");
  const b = normalizeText(after.toString("utf8")).split("\n");
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  let added = 0;
  let removed = 0;
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) || 0));
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) || 0));
  return { added, removed };
}

// ---- the setup's text, made this machine's ------------------------------------------------------

const SHELL_SAFE = /^[A-Za-z0-9._/@+~:=,-]+$/;

/**
 * `${HOME}` and `${PROJECT}` as this machine's paths. In a command a shell will read, the path is
 * written with forward slashes, and refused if a shell would split it, rather than quoted into a
 * command someone else wrote.
 */
function placed(text, { home, project }, { shell }) {
  let why = "";
  const value = String(text).replace(/\$\{(HOME|PROJECT)\}/g, (m, which) => {
    const base = which === "HOME" ? home : project;
    if (!base) {
      why ||= `it names \${${which}}, and there is none here`;
      return m;
    }
    const path = shell ? base.split(sep).join("/") : base;
    if (shell && !SHELL_SAFE.test(path)) why ||= `${which === "HOME" ? "your home folder's" : "this project's"} path has characters a shell would split, so add it by hand`;
    return path;
  });
  return why ? { ok: false, why } : { ok: true, value };
}

function placedSettings(settings, where) {
  const problems = [];
  const value = {};
  if (settings.permissions) value.permissions = structuredClone(settings.permissions);
  if (settings.model) value.model = settings.model;
  if (settings.hooks) {
    value.hooks = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      value.hooks[event] = groups.map((g) => ({
        ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
        hooks: g.hooks.map((h) => {
          const command = placed(h.command, where, { shell: !h.args });
          const args = (h.args || []).map((a) => placed(a, where, { shell: false }));
          for (const p of [command, ...args]) if (!p.ok) problems.push(`a ${event} hook: ${p.why}`);
          return { ...h, command: command.value ?? h.command, ...(h.args ? { args: args.map((a) => a.value ?? "") } : {}) };
        }),
      }));
    }
  }
  return { value, problems };
}

/** A server as Claude Code reads it: placeholders become `${NAME}`, which Claude Code fills from the environment. */
function placedServer(server, where) {
  const problems = [];
  const out = {};
  if (server.type) out.type = server.type;
  if (server.command !== undefined) {
    const c = placed(server.command, where, { shell: false });
    if (!c.ok) problems.push(c.why);
    out.command = c.value ?? server.command;
  }
  if (server.args) {
    out.args = server.args.map((a) => {
      const p = placed(a, where, { shell: false });
      if (!p.ok) problems.push(p.why);
      return p.value ?? a;
    });
  }
  if (server.env) out.env = Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, `\${${v.fromEnv}}`]));
  if (server.url) out.url = server.url;
  if (server.headers) out.headers = Object.fromEntries(Object.entries(server.headers).map(([h, v]) => [h, `${v.prefix || ""}\${${v.fromEnv}}`]));
  return { value: out, problems };
}

/**
 * A setup's Codex server as Codex's config holds it. Codex does not read `${VAR}`, so the variables a
 * server needs are named in `env_vars`, which Codex passes through from the adopter's environment.
 */
function codexServer(server, where) {
  const problems = [];
  const put = (v) => {
    const p = placed(v, where, { shell: false });
    if (!p.ok) problems.push(p.why);
    return p.value ?? v;
  };
  const out = {};
  if (server.command !== undefined) {
    out.command = put(server.command);
    if (server.args) out.args = server.args.map(put);
    const names = [...new Set([...Object.keys(server.env || {}), ...(server.env_vars || [])])];
    if (names.length) out.env_vars = names;
    if (server.cwd !== undefined) out.cwd = put(server.cwd);
  } else {
    out.url = server.url;
    if (server.bearer_token_env_var) out.bearer_token_env_var = server.bearer_token_env_var;
    if (server.env_http_headers) out.env_http_headers = { ...server.env_http_headers };
  }
  for (const k of ["enabled", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "disabled_tools"]) if (server[k] !== undefined) out[k] = server[k];
  return { value: out, problems };
}

/** A Codex setting as what it lets Codex do, for the plan a person approves. */
function codexSays(key, value) {
  if (key === "approval_policy") {
    return {
      never: "Codex never asks; a command that needs more than its sandbox allows fails instead",
      "on-request": "Codex asks when a command needs more than its sandbox allows",
      untrusted: "Codex asks before a command it does not know to be safe",
      "on-failure": "Codex asks when a command fails in its sandbox",
    }[value];
  }
  if (key === "sandbox_mode") return value === "workspace-write" ? "commands may write in the project, and nowhere else" : "commands may read, and write nothing";
  return "";
}

// ---- merging into what is there -----------------------------------------------------------------

const sameHook = (a, b) => JSON.stringify([a.type, a.command, a.args || null]) === JSON.stringify([b.type, b.command, b.args || null]);

/** Settings with the setup's added: rules and hooks appended where missing, mode and model set. Pure. */
export function mergeSettings(existing, incoming) {
  const after = structuredClone(isObj(existing) ? existing : {});
  const changes = [];
  if (incoming.permissions) {
    const p = isObj(after.permissions) ? after.permissions : {};
    for (const list of ["allow", "ask", "deny"]) {
      for (const rule of incoming.permissions[list] || []) {
        if (!Array.isArray(p[list])) p[list] = [];
        if (!p[list].includes(rule)) {
          p[list].push(rule);
          changes.push({ kind: "rule", list, rule });
        }
      }
    }
    const mode = incoming.permissions.defaultMode;
    if (mode && p.defaultMode !== mode) {
      changes.push({ kind: "mode", was: p.defaultMode ?? null, now: mode });
      p.defaultMode = mode;
    }
    if (Object.keys(p).length) after.permissions = p;
  }
  if (incoming.hooks) {
    const hooks = isObj(after.hooks) ? after.hooks : {};
    for (const [event, groups] of Object.entries(incoming.hooks)) {
      const have = Array.isArray(hooks[event]) ? hooks[event] : [];
      for (const g of groups) {
        const fresh = g.hooks.filter((h) => !have.some((hg) => (hg?.matcher ?? "") === (g.matcher ?? "") && Array.isArray(hg?.hooks) && hg.hooks.some((x) => sameHook(x, h))));
        if (!fresh.length) continue;
        have.push({ ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), hooks: fresh });
        for (const h of fresh) changes.push({ kind: "hook", event, command: [h.command, ...(h.args || [])].join(" ") });
      }
      if (have.length) hooks[event] = have;
    }
    if (Object.keys(hooks).length) after.hooks = hooks;
  }
  if (incoming.model && after.model !== incoming.model) {
    changes.push({ kind: "model", was: after.model ?? null, now: incoming.model });
    after.model = incoming.model;
  }
  return { after, changes };
}

/** `.mcp.json` with the setup's servers added. A server you already have by that name is kept as yours. */
export function mergeServers(existing, servers) {
  const after = structuredClone(isObj(existing) ? existing : {});
  const have = isObj(after.mcpServers) ? after.mcpServers : {};
  const changes = [];
  const kept = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!(name in have)) {
      have[name] = server;
      changes.push({ kind: "server", name });
    } else if (JSON.stringify(have[name]) !== JSON.stringify(server)) kept.push(name);
  }
  after.mcpServers = have;
  return { after, changes, kept };
}

// ---- the plan -------------------------------------------------------------------------------------

/**
 * Everything adopting `setup` would do here, without doing any of it. `setup` is a checked setup:
 * `{ manifest, files, commit, revision, team }`. `skip` takes names as the plan shows them.
 */
export async function planAdoption({ setup, project, config, codexConfig = null, home, user = false, skip = [] }) {
  const { manifest, files } = setup;
  const cc = manifest.tools[TOOL] || {};
  const cx = manifest.tools[CODEX] || {};
  const plan = {
    setup: `${manifest.role}/${manifest.name}`,
    role: manifest.role,
    name: manifest.name,
    owner: manifest.owner,
    team: setup.team,
    commit: setup.commit,
    revision: setup.revision,
    project,
    config,
    codexConfig,
    user,
    writes: [],
    skipped: [],
    userServers: [],
    refused: [],
    runs: [],
    grants: [],
  };
  const where = { home, project };
  const skipping = (label) => skip.some((p) => label === p || (p.endsWith("/") && label.startsWith(p)));
  const rootsFor = { [TOOL]: { project, user: config }, [CODEX]: { project, user: codexConfig, home } };
  const labelFor = (tool, scope, rel) => (scope === "project" ? rel : scope === "home" ? `~/${rel}` : tool === TOOL ? `~/.claude/${rel}` : `~/.codex/${rel}`);

  const mergeInto = async ({ label, target, scope, shared = false, merge }) => {
    const cur = await current(target);
    if (cur.link || cur.notFile) return plan.refused.push(`${label} is ${cur.link ? "a link" : "not a file"} here; Rooms does not write through it`);
    let existing = {};
    if (cur.exists) {
      try {
        existing = JSON.parse(cur.bytes.toString("utf8"));
      } catch {
        return plan.refused.push(`${label} is not valid JSON here; fix it first`);
      }
      if (!isObj(existing)) return plan.refused.push(`${label} here is not a JSON object; fix it first`);
    }
    const { after, changes, kept = [] } = merge(existing);
    const w = { label, target, scope, shared, changes, kept, created: !cur.exists };
    if (!changes.length) return plan.writes.push({ ...w, action: "same" });
    return plan.writes.push({ ...w, action: "merge", before: cur.bytes, after: Buffer.from(`${JSON.stringify(after, null, 2)}\n`, "utf8") });
  };

  for (const tool of TOOLS) {
    for (const f of manifest.tools[tool]?.files || []) {
      const place = installPlace(f.installTo, f.kind, tool);
      if (!place) {
        plan.refused.push(`${String(f.installTo).slice(0, 120)} is not a place a setup may write`);
        continue;
      }
      const { scope, rel } = place;
      const label = labelFor(tool, scope, rel);
      if (scope !== "project" && !user) {
        plan.skipped.push({ label, why: "yours, for every project: add --user to adopt it too" });
        continue;
      }
      if (skipping(label)) {
        plan.skipped.push({ label, why: "you said --skip" });
        continue;
      }
      const root = rootsFor[tool][scope];
      const target = root ? under(root, rel) : null;
      if (!target) {
        plan.refused.push(`${label} has nowhere to go here`);
        continue;
      }
      const after = Buffer.from(normalizeText(files.get(f.path)), "utf8");
      const cur = await current(target);
      if (cur.link || cur.notFile) {
        plan.refused.push(`${label} is ${cur.link ? "a link" : "not a file"} here; Rooms does not write through it`);
        continue;
      }
      const runnable = f.executable && process.platform !== "win32";
      if (cur.exists && cur.bytes.equals(after) && (!runnable || cur.mode & 0o100)) {
        plan.writes.push({ label, target, scope, tool, action: "same", file: f });
        continue;
      }
      const tracked = scope === "project" && cur.exists && (await gitIn(project, ["ls-files", "--error-unmatch", "--", rel])).ok;
      plan.writes.push({ label, target, scope, tool, file: f, action: cur.exists ? "replace" : "new", before: cur.bytes, after, mode: f.executable ? 0o755 : null, tracked, change: cur.exists ? lineChange(cur.bytes, after) : null });
    }
  }

  for (const scope of ["project", "user"]) {
    const part = cc[scope];
    if (!part) continue;
    const s = part.settings;
    if (s && (s.permissions || s.hooks || s.model)) {
      const label = scope === "project" ? ".claude/settings.local.json" : "~/.claude/settings.json";
      if (scope === "user" && !user) plan.skipped.push({ label, why: "your settings for every project: add --user to adopt them too" });
      else if (skipping(label)) plan.skipped.push({ label, why: "you said --skip" });
      else {
        const r = placedSettings(s, scope === "user" ? { home, project: null } : where);
        if (r.problems.length) plan.refused.push(...r.problems.map((p) => `${label}: ${p}`));
        else {
          const target = scope === "project" ? join(project, ".claude", "settings.local.json") : join(config, "settings.json");
          await mergeInto({ label, target, scope, merge: (existing) => mergeSettings(existing, r.value) });
        }
      }
    }
    const servers = part.mcpServers || {};
    if (!Object.keys(servers).length) continue;
    if (scope === "user") {
      for (const [name, server] of Object.entries(servers)) {
        const r = placedServer(server, { home, project: null });
        if (r.problems.length) plan.refused.push(...r.problems.map((p) => `user MCP server ${name}: ${p}`));
        else plan.userServers.push({ name, json: JSON.stringify(r.value) });
      }
    } else if (skipping(".mcp.json")) plan.skipped.push({ label: ".mcp.json", why: "you said --skip" });
    else {
      const placedAll = {};
      for (const [name, server] of Object.entries(servers)) {
        const r = placedServer(server, where);
        if (r.problems.length) plan.refused.push(...r.problems.map((p) => `.mcp.json ${name}: ${p}`));
        placedAll[name] = r.value;
      }
      await mergeInto({ label: ".mcp.json", target: join(project, ".mcp.json"), scope: "project", shared: true, merge: (existing) => mergeServers(existing, placedAll) });
    }
  }

  // Codex: a project's servers into its .codex/config.toml; with --user, the person's settings and
  // servers into Codex's own config.toml. The text is added to, never rewritten.
  const tomlInto = async ({ label, target, scope, shared = false, note = "", top = {}, servers = {} }) => {
    const cur = await current(target);
    if (cur.link || cur.notFile) return plan.refused.push(`${label} is ${cur.link ? "a link" : "not a file"} here; Rooms does not write through it`);
    let merged;
    try {
      merged = mergeCodexToml(cur.exists ? cur.bytes.toString("utf8") : "", { top, servers });
    } catch (e) {
      return plan.refused.push(`${label} here: ${e.message}`);
    }
    const w = { label, target, scope, tool: CODEX, shared, note, changes: merged.changes, kept: merged.kept, created: !cur.exists };
    if (!merged.changes.length) return plan.writes.push({ ...w, action: "same" });
    return plan.writes.push({ ...w, action: cur.exists ? "merge" : "new", before: cur.bytes, after: Buffer.from(merged.text, "utf8") });
  };
  const codexServers = (servers, at, label) => {
    const out = {};
    for (const [name, server] of Object.entries(servers)) {
      const r = codexServer(server, at);
      if (r.problems.length) plan.refused.push(...r.problems.map((p) => `${label} ${name}: ${p}`));
      out[name] = r.value;
    }
    return out;
  };
  if (Object.keys(cx.project?.mcpServers || {}).length) {
    const label = ".codex/config.toml";
    if (skipping(label)) plan.skipped.push({ label, why: "you said --skip" });
    else {
      const servers = codexServers(cx.project.mcpServers, where, label);
      await tomlInto({ label, target: join(project, ".codex", "config.toml"), scope: "project", shared: true, note: "Codex reads it only in a project you trust", servers });
    }
  }
  if (cx.user?.settings || Object.keys(cx.user?.mcpServers || {}).length) {
    const label = "~/.codex/config.toml";
    if (!user) plan.skipped.push({ label, why: "your Codex settings for every project: add --user to adopt them too" });
    else if (skipping(label)) plan.skipped.push({ label, why: "you said --skip" });
    else if (!codexConfig) plan.refused.push(`${label} has nowhere to go here`);
    else {
      const top = { ...(cx.user.settings || {}) };
      if (top.notify) {
        top.notify = top.notify.map((a) => {
          const p = placed(a, { home, project: null }, { shell: false });
          if (!p.ok) plan.refused.push(`${label} notify: ${p.why}`);
          return p.value ?? a;
        });
      }
      const servers = codexServers(cx.user.mcpServers || {}, { home, project: null }, label);
      await tomlInto({ label, target: join(codexConfig, "config.toml"), scope: "user", top, servers });
    }
  }

  // A personal settings file this adoption creates stays out of git, as Claude Code keeps its own.
  const local = plan.writes.find((w) => w.label === ".claude/settings.local.json" && w.created && w.action !== "same");
  if (local && !(await gitIn(project, ["check-ignore", "-q", "--", ".claude/settings.local.json"])).ok) {
    const at = await gitIn(project, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    if (at.ok) {
      const cur = await current(at.out);
      const text = cur.bytes ? cur.bytes.toString("utf8") : "";
      if (!cur.link && !text.split(/\r?\n/).includes(".claude/settings.local.json")) {
        const after = Buffer.from(`${text}${text && !text.endsWith("\n") ? "\n" : ""}.claude/settings.local.json\n`, "utf8");
        plan.writes.push({ label: ".git/info/exclude", target: at.out, scope: "project", action: cur.exists ? "merge" : "new", before: cur.bytes, after, changes: [{ kind: "exclude" }] });
      }
    }
  }

  // What will run here: only what this adoption actually puts in place.
  const placedLabels = new Set(plan.writes.map((w) => w.label));
  const placedFiles = new Set(plan.writes.filter((w) => w.file).map((w) => `${w.tool}|${w.file.installTo}`));
  const settingsIn = (scope) => placedLabels.has(scope === "project" ? ".claude/settings.local.json" : "~/.claude/settings.json");
  const mcp = plan.writes.find((w) => w.label === ".mcp.json");
  const codexIn = { project: plan.writes.find((w) => w.tool === CODEX && w.label === ".codex/config.toml"), user: plan.writes.find((w) => w.tool === CODEX && w.label === "~/.codex/config.toml") };
  for (const r of manifest.runs) {
    if (r.tool === CODEX) {
      const into = codexIn[r.scope];
      if (r.surface === "notify" && into) plan.runs.push({ ...r, shown: placed(r.command, { home, project: null }, { shell: false }).value || r.command });
      else if (r.surface === "mcp" && into && !into.kept.includes(r.name)) plan.runs.push({ ...r, shown: r.url || placed(r.command, r.scope === "user" ? { home, project: null } : where, { shell: false }).value || r.command });
      else if (r.surface === "script" && placedFiles.has(`${CODEX}|${r.file}`)) plan.runs.push({ ...r, shown: r.file.replace(/^project:/, "").replace(/^home:/, "~/") });
      continue;
    }
    if (r.surface === "hook" && settingsIn(r.scope)) {
      const shown = placed(r.command, r.scope === "user" ? { home, project: null } : where, { shell: true });
      plan.runs.push({ ...r, shown: shown.value ?? r.command });
    } else if (r.surface === "mcp" && r.scope === "project" && mcp && !mcp.kept.includes(r.name)) {
      plan.runs.push({ ...r, shown: r.url || placed(r.command, where, { shell: false }).value || r.command });
    } else if ((r.surface === "loads" || r.surface === "script") && placedFiles.has(`${TOOL}|${r.file}`)) {
      plan.runs.push({ ...r, shown: r.command || r.file.replace(/^project:/, "").replace(/^user:/, "~/.claude/") });
    }
  }

  // What it would let Claude do without asking: rules merged into settings, and the tools commands
  // and skills pre-approve while they run.
  for (const w of plan.writes) {
    for (const c of w.changes || []) {
      if (c.kind === "rule") plan.grants.push({ where: w.label, list: c.list, rule: c.rule, says: describeRule(c.list, c.rule) });
      if (c.kind === "mode") plan.grants.push({ where: w.label, mode: c.now, was: c.was });
      if (c.kind === "setting" && (c.key === "approval_policy" || c.key === "sandbox_mode")) plan.grants.push({ where: w.label, setting: c.key, value: c.now, was: c.was, says: codexSays(c.key, c.now) });
    }
    const f = w.file;
    if (f && w.tool === TOOL && (f.kind === "command" || (f.kind === "skill" && f.installTo.endsWith("/SKILL.md")))) {
      for (const rule of toolList(frontmatter(files.get(f.path)).keys["allowed-tools"])) {
        plan.grants.push({ where: w.label, list: "while it runs", rule, says: describeRule("allow", rule) });
      }
    }
  }

  plan.digest = planDigest(plan);
  return plan;
}

/** The digest a preview prints, of exactly what would be written and run, so an approval names one plan. */
export function planDigest(plan) {
  const canonical = JSON.stringify({
    setup: plan.setup,
    commit: plan.commit,
    project: plan.project,
    config: plan.config,
    codexConfig: plan.codexConfig,
    writes: plan.writes.filter((w) => w.action !== "same").map((w) => [w.target, w.action, sha256(w.after)]),
    userServers: plan.userServers.map((s) => [s.name, s.json]),
    runs: plan.runs.map((r) => [r.surface, r.shown]),
    refused: plan.refused,
  });
  return sha256(canonical).slice(0, 16);
}

// ---- applying it, with a backup -----------------------------------------------------------------

async function makeParents(dir) {
  const missing = [];
  for (let d = dir; !(await current(d)).exists; d = dirname(d)) {
    missing.unshift(d);
    if (dirname(d) === d) break;
  }
  if (missing.length) await mkdir(dir, { recursive: true });
  return missing;
}

const writeRecord = (dir, record) => writeFile(join(dir, "backup.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

async function putBack(dir, record, indexes) {
  for (const i of [...indexes].reverse()) {
    const e = record.entries[i];
    const now = await current(e.target);
    if (now.link) await unlink(e.target);
    if (e.existed) {
      await writeFile(e.target, await readFile(join(dir, e.saved)));
      if (e.mode !== null && process.platform !== "win32") await chmod(e.target, e.mode);
    } else {
      await unlink(e.target).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    for (const d of [...(e.dirs || [])].reverse()) await rmdir(d).catch(() => {});
  }
}

/**
 * Write the plan, after copying everything it changes. Every file is checked again first: one that
 * changed since the plan was made means this is not the plan that was approved, and nothing is
 * written. A failure partway puts back what was already written.
 */
export async function applyAdoption(plan, { backupsDir, now = new Date() }) {
  if (plan.refused.length) throw new Error("This plan has refusals; nothing was changed.");
  const todo = plan.writes.filter((w) => w.action !== "same");
  if (!todo.length) return { id: null, written: 0 };
  for (const w of todo) {
    const cur = await current(w.target);
    const same = w.before ? cur.exists && !cur.link && !cur.notFile && cur.bytes.equals(w.before) : !cur.exists;
    if (!same) throw new Error(`${w.label} changed since the plan was made. Nothing was changed; run it again to see the plan as it is now.`);
  }
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${plan.role}-${plan.name}-${randomBytes(3).toString("hex")}`;
  const dir = join(backupsDir, id);
  await mkdir(join(dir, "files"), { recursive: true, mode: 0o700 });
  const record = {
    v: 1,
    id,
    setup: plan.setup,
    role: plan.role,
    name: plan.name,
    team: plan.team,
    commit: plan.commit,
    revision: plan.revision,
    project: plan.project,
    config: plan.config,
    adoptedAt: now.toISOString(),
    state: "applying",
    entries: [],
  };
  for (const [i, w] of todo.entries()) {
    const cur = await current(w.target);
    const saved = cur.exists ? `files/${i}` : null;
    if (saved) await writeFile(join(dir, saved), cur.bytes, { mode: 0o600 });
    record.entries.push({ target: w.target, label: w.label, existed: cur.exists, mode: cur.exists ? cur.mode : null, saved, after: sha256(w.after), dirs: [] });
  }
  await writeRecord(dir, record);
  const done = [];
  try {
    for (const [i, w] of todo.entries()) {
      record.entries[i].dirs = await makeParents(dirname(w.target));
      await writeFile(w.target, w.after, w.mode ? { mode: w.mode } : undefined);
      if (w.mode && process.platform !== "win32") await chmod(w.target, w.mode);
      done.push(i);
    }
  } catch (e) {
    await putBack(dir, record, done);
    record.state = "failed";
    await writeRecord(dir, record);
    throw new Error(`Adopting stopped at ${todo[done.length]?.label}: ${e.message}. What it had written was put back.`);
  }
  record.state = "applied";
  await writeRecord(dir, record);
  return { id, dir, written: todo.length };
}

// ---- undoing it -----------------------------------------------------------------------------------

/** Every adoption this machine has a backup of, newest first. */
export async function readAdoptions(backupsDir) {
  let names = [];
  try {
    names = await readdir(backupsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(await readFile(join(backupsDir, n, "backup.json"), "utf8"));
      if (r?.v === 1 && Array.isArray(r.entries)) out.push({ ...r, dir: join(backupsDir, n) });
    } catch {
      // not a backup this version wrote
    }
  }
  return out.sort((a, b) => (a.adoptedAt < b.adoptedAt ? 1 : a.adoptedAt > b.adoptedAt ? -1 : 0));
}

/** The files an adoption wrote that are no longer what it wrote. */
export async function changedSince(record) {
  const changed = [];
  for (const e of record.entries) {
    const cur = await current(e.target);
    if (!cur.exists) changed.push({ label: e.label, how: "removed since" });
    else if (cur.link || cur.notFile || sha256(cur.bytes) !== e.after) changed.push({ label: e.label, how: "changed since" });
  }
  return changed;
}

/**
 * Put every file back as it was before the adoption, and remove what it created. Stops, naming
 * what changed since, unless `force`; then the changed versions are kept in the backup's
 * `at-rollback/` first, so nothing is lost either way.
 */
export async function rollBack(record, { force = false, now = new Date() } = {}) {
  const changed = await changedSince(record);
  if (changed.length && !force) return { ok: false, changed };
  if (changed.length) {
    await mkdir(join(record.dir, "at-rollback"), { recursive: true, mode: 0o700 });
    for (const [i, e] of record.entries.entries()) {
      const cur = await current(e.target);
      if (cur.bytes) await writeFile(join(record.dir, "at-rollback", String(i)), cur.bytes, { mode: 0o600 });
    }
  }
  const { dir, ...stored } = record;
  await putBack(dir, stored, stored.entries.map((_, i) => i));
  stored.state = "rolled back";
  stored.rolledBackAt = now.toISOString();
  await writeRecord(dir, stored);
  return { ok: true, changed };
}
