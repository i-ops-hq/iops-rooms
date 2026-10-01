/**
 * What Codex keeps that a setup may carry, read from an allowlist of files and keys and from nowhere
 * else (docs/design/TEAM_SETUPS.md §7.3 and §15). Checked against Codex CLI 0.159.0 and its
 * documentation on 2026-10-01.
 *
 * From a project: `AGENTS.md`, the skills in `.agents/skills/`, and the MCP servers in
 * `.codex/config.toml`, which Codex reads only in a project the person trusts. From the person, with
 * `--user`: `AGENTS.md` and `AGENTS.override.md` in Codex's folder (`~/.codex`, or `CODEX_HOME`), its
 * `prompts/`, the skills in `~/.agents/skills/`, and from its `config.toml` the model, reasoning
 * effort, approval policy, sandbox mode, `notify`, and MCP servers.
 *
 * Never `auth.json`, sessions, history or memories; never `[projects]`, whose names are folders on
 * this machine; never the values of `[shell_environment_policy]`. Nothing that lets commands run
 * without asking: not rules files (an `allow` runs outside the sandbox), not per-tool approvals, not a
 * header helper (it runs a command), and never `sandbox_mode = "danger-full-access"`. Codex does not
 * read `${VAR}` in its config, so a server's environment values become the names it passes through.
 */

import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ENV_NAME, MODEL, SERVER_NAME, urlRefusal } from "./claude-code.js";
import { exists, linkOnTheWay, readTextItem, refuse, walk } from "./files.js";
import { checkRun } from "./pins.js";
import { portableText } from "./paths.js";
import { scanText } from "./secrets.js";
import { parseToml } from "./toml.js";

export const CODEX_CHECKED_AGAINST = "Codex CLI 0.159.0";
export const CODEX = "codex";
const MAX_FILES = 500;

/** Codex's folder, as Codex finds it, and the home that holds `~/.agents/skills/`. */
export function codexDirs({ env = process.env, home = homedir() } = {}) {
  return { config: env.CODEX_HOME ? resolve(String(env.CODEX_HOME)) : join(home, ".codex"), home };
}

export const CODEX_SETTINGS = ["model", "model_reasoning_effort", "approval_policy", "sandbox_mode", "notify"];
export const CODEX_APPROVALS = new Set(["on-request", "never", "untrusted", "on-failure"]);
export const CODEX_SANDBOXES = new Set(["read-only", "workspace-write"]);
export const CODEX_STDIO_KEYS = ["command", "args", "env", "env_vars", "cwd", "enabled", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "disabled_tools"];
export const CODEX_HTTP_KEYS = ["url", "bearer_token_env_var", "env_http_headers", "enabled", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "disabled_tools"];
const EFFORT = /^[a-z]{1,20}$/;
const upperSnake = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const words = (v, max = 100) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 500);

/** Why a sandbox mode cannot come from a setup, or "". */
export function sandboxRefusal(mode) {
  if (mode === "danger-full-access") return "sandbox_mode danger-full-access lets commands reach anything on the machine; a setup cannot set it for someone else";
  return CODEX_SANDBOXES.has(mode) ? "" : "a sandbox mode this version does not know";
}

/** Why an approval policy cannot come from a setup, or "". */
export function approvalRefusal(policy) {
  if (typeof policy !== "string") return "a granular approval policy; not in this version's setups";
  return CODEX_APPROVALS.has(policy) ? "" : "an approval policy this version does not know";
}

/** A command in exec form, `[program, ...args]`, made portable and checked, or why it cannot go. */
function scrubArgv(argv, where) {
  if (!words(argv, 50) || !argv.length || !argv[0].trim()) return { why: "not a command this version reads" };
  const secret = argv.map((a) => scanText(a)[0]).find(Boolean);
  if (secret) return { why: "holds something that looks like a secret", detail: `it looks like it holds ${secret.kind}` };
  const portable = argv.map((a) => portableText(a, where));
  const bad = portable.find((p) => !p.ok);
  if (bad) return { why: "names a path on the exporting machine", detail: bad.why };
  const [command, ...args] = portable.map((p) => p.value);
  const check = checkRun(command, args);
  if (!check.ok) return { why: "runs something a setup cannot carry", detail: check.why };
  return { value: [command, ...args] };
}

/**
 * The part of a Codex config a setup may carry, by key. `servers` says whether to take its MCP
 * servers; `settings`, whether the model, approvals, sandbox and notify too (only the person's own
 * config: a project's carries its servers alone). Everything else is listed in `left`, by key.
 */
export function scrubCodexConfig(cfg, { label, where, settings = true }) {
  const value = {};
  const notes = [];
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  const kept = {};
  for (const [key, v] of Object.entries(cfg)) {
    if (key === "mcp_servers") continue;
    if (settings && CODEX_SETTINGS.includes(key)) {
      if (key === "model") {
        if (typeof v === "string" && MODEL.test(v)) kept.model = v;
        else leave(key, "not a model name this version reads");
      } else if (key === "model_reasoning_effort") {
        if (typeof v === "string" && EFFORT.test(v)) kept.model_reasoning_effort = v;
        else leave(key, "not a reasoning effort this version reads");
      } else if (key === "approval_policy") {
        const why = approvalRefusal(v);
        if (why) leave(key, why);
        else kept.approval_policy = v;
      } else if (key === "sandbox_mode") {
        const why = sandboxRefusal(v);
        if (why) leave(key, why);
        else kept.sandbox_mode = v;
      } else if (key === "notify") {
        const r = scrubArgv(v, where);
        if (r.value) kept.notify = r.value;
        else leave(key, r.why, r.detail);
      }
    } else if (key === "projects") leave("[projects]", "names folders on this machine; never exported");
    else if (key === "shell_environment_policy") leave("[shell_environment_policy]", "may hold environment values; never exported");
    else if (key === "plugins" || key === "marketplaces") leave(`[${key}]`, "plugins are not in this version's setups");
    else if (key === "permissions") leave("[permissions]", "permission profiles are not in this version's setups");
    else if (key === "profile" || key === "profiles") leave(key, "profiles are not in this version's setups");
    else leave(key, settings ? "not a key this version exports" : "a project's Codex config carries only its MCP servers in a setup");
  }
  if (Object.keys(kept).length) value.settings = kept;
  if (cfg.mcp_servers !== undefined) {
    const r = scrubCodexServers(cfg.mcp_servers, { label, where });
    if (Object.keys(r.value).length) value.mcpServers = r.value;
    notes.push(...r.notes);
    left.push(...r.left);
  }
  return { value, notes, left };
}

/**
 * Codex's MCP servers, as a setup may carry them. A local one keeps its command, arguments and
 * folder, made portable and pinned; its environment values become names Codex passes through
 * (`env_vars`). A remote one keeps its address, and its headers become the names of variables
 * holding them (`env_http_headers`). Keys that run a command or approve tools stay out.
 */
export function scrubCodexServers(servers, { label, where }) {
  const value = {};
  const notes = [];
  const left = [];
  const leave = (what, why, detail) => left.push({ what: `${label} ${what}`, why, ...(detail ? { detail } : {}) });
  if (!isObj(servers)) return { value, notes, left };
  for (const [name, s] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      leave("mcp_servers", "a server name this version does not read");
      continue;
    }
    const at = `mcp_servers.${name}`;
    if (!isObj(s)) {
      leave(at, "not a server this version reads");
      continue;
    }
    if (name === "iops-rooms" && Array.isArray(s.args) && s.args.some((a) => /^iops-rooms@/.test(String(a)))) {
      leave(at, "Rooms' own server; rooms mcp install adds it");
      continue;
    }
    const out = {};
    let why = "";
    let detail = "";
    if (typeof s.command === "string") {
      const r = scrubArgv([s.command, ...(Array.isArray(s.args) ? s.args : [])], where);
      if (s.args !== undefined && !words(s.args)) why = "a server whose args are not a list of words";
      else if (!r.value) ({ why, detail } = r);
      else {
        out.command = r.value[0];
        if (s.args !== undefined) out.args = r.value.slice(1);
      }
      if (!why && s.cwd !== undefined) {
        const cwd = typeof s.cwd === "string" ? portableText(s.cwd, where) : { ok: false, why: "not a folder" };
        if (!cwd.ok) ({ why, detail } = { why: "names a path on the exporting machine", detail: cwd.why });
        else out.cwd = cwd.value;
      }
      const env = [];
      if (!why && s.env !== undefined) {
        if (!isObj(s.env) || Object.keys(s.env).some((k) => !ENV_NAME.test(k))) why = "an env this version does not read";
        else {
          out.env = Object.fromEntries(Object.keys(s.env).map((k) => [k, { fromEnv: k }]));
          for (const k of Object.keys(s.env)) {
            env.push(k);
            notes.push(`${name}: env ${k} becomes a name Codex passes through; its value stays here`);
          }
        }
      }
      if (!why && s.env_vars !== undefined) {
        const names = Array.isArray(s.env_vars) ? s.env_vars.map((e) => (typeof e === "string" ? e : isObj(e) && (e.source ?? "local") === "local" ? e.name : null)) : null;
        if (!names || names.some((n) => typeof n !== "string" || !ENV_NAME.test(n))) why = "env_vars this version does not read";
        else {
          const rest = names.filter((n) => !env.includes(n));
          if (rest.length) out.env_vars = rest;
        }
      }
    } else if (typeof s.url === "string") {
      why = urlRefusal(s.url);
      if (!why) out.url = s.url;
      if (!why && s.bearer_token_env_var !== undefined) {
        if (typeof s.bearer_token_env_var === "string" && ENV_NAME.test(s.bearer_token_env_var)) out.bearer_token_env_var = s.bearer_token_env_var;
        else why = "a bearer token variable this version does not read";
      }
      const headers = {};
      if (!why && s.env_http_headers !== undefined) {
        if (!isObj(s.env_http_headers) || Object.entries(s.env_http_headers).some(([h, n]) => !/^[A-Za-z0-9-]{1,100}$/.test(h) || typeof n !== "string" || !ENV_NAME.test(n))) {
          why = "header variables this version does not read";
        } else Object.assign(headers, s.env_http_headers);
      }
      if (!why && s.http_headers !== undefined) {
        if (!isObj(s.http_headers) || Object.keys(s.http_headers).some((h) => !/^[A-Za-z0-9-]{1,100}$/.test(h))) why = "headers this version does not read";
        else {
          for (const h of Object.keys(s.http_headers)) {
            headers[h] = `${upperSnake(name)}_${upperSnake(h)}`;
            notes.push(`${name}: header ${h} becomes the variable ${headers[h]}; its value stays here`);
          }
        }
      }
      if (!why && Object.keys(headers).length) out.env_http_headers = headers;
    } else {
      why = "a server without a command or an address";
    }
    if (why) {
      leave(at, why, detail);
      continue;
    }
    if (s.enabled !== undefined) {
      if (typeof s.enabled === "boolean") out.enabled = s.enabled;
      else leave(`${at}.enabled`, "not true or false");
    }
    for (const k of ["startup_timeout_sec", "tool_timeout_sec"]) {
      if (s[k] === undefined) continue;
      if (typeof s[k] === "number" && s[k] > 0 && s[k] < 86_400) out[k] = s[k];
      else leave(`${at}.${k}`, "not a number of seconds this version reads");
    }
    for (const k of ["enabled_tools", "disabled_tools"]) {
      if (s[k] === undefined) continue;
      if (words(s[k], 500)) out[k] = s[k];
      else leave(`${at}.${k}`, "not a list of tool names");
    }
    const known = new Set([...CODEX_STDIO_KEYS, ...CODEX_HTTP_KEYS, "http_headers"]);
    for (const k of Object.keys(s)) {
      if (known.has(k)) continue;
      if (k === "http_headers_helper") leave(`${at}.${k}`, "runs a command to make headers; not in this version's setups");
      else if (k === "tools") leave(`${at}.tools`, "per-tool approvals are not in this version's setups");
      else leave(`${at}.${k}`, "not a key this version exports");
    }
    value[name] = out;
  }
  return { value, notes, left };
}

const labelOf = (scope, rel) => (scope === "user" ? `~/.codex/${rel}` : scope === "home" ? `~/${rel}` : rel);

/** A skill's `agents/openai.yaml` may declare MCP servers it depends on: not exported yet. */
const DEPENDS = /^\s*["']?dependencies["']?\s*:/m;

/**
 * Everything Codex keeps for this project and for this person that a setup could carry, as items a
 * member selects from, and what was left out and why.
 */
export async function readCodex({ project = null, env = process.env, home = homedir() } = {}) {
  const { config } = codexDirs({ env, home });
  const items = [];
  const left = [];
  let count = 0;
  const places = [];
  if (project) places.push({ scope: "project", root: project, files: [["instructions", "AGENTS.md"]], skills: ".agents/skills", prompts: null, config: ".codex/config.toml", rules: ".codex/rules" });
  places.push({ scope: "user", root: config, files: [["instructions", "AGENTS.md"], ["instructions", "AGENTS.override.md"]], skills: null, prompts: "prompts", config: "config.toml", rules: "rules" });
  places.push({ scope: "home", root: home, files: [], skills: ".agents/skills", prompts: null, config: null, rules: null });

  for (const place of places) {
    const { scope, root } = place;
    const where = scope === "project" ? { home, project } : { home, project: null };
    const linked = new Set();
    const noteLink = (rel) => {
      if (linked.has(rel)) return;
      linked.add(rel);
      left.push({ what: labelOf(scope, rel), why: "a link; Rooms does not follow links", local: scope !== "project" });
    };
    const reachable = async (rel) => {
      const link = await linkOnTheWay(root, rel);
      if (link) noteLink(link);
      return !link;
    };
    const files = [];
    for (const [kind, rel] of place.files) {
      if (!(await reachable(rel))) continue;
      if ((await lstat(join(root, rel)).catch(() => null))?.isFile()) files.push({ kind, rel });
    }
    for (const [kind, dir, ext] of [["skill", place.skills, null], ["prompt", place.prompts, ".md"]]) {
      if (!dir || !(await reachable(dir))) continue;
      const found = [];
      const links = [];
      await walk(root, dir, ext, 0, found, links);
      for (const rel of links) noteLink(rel);
      for (const rel of found) {
        if (kind === "prompt" && rel.split("/").length !== 2) continue;
        files.push({ kind, rel });
      }
    }
    const read = [];
    for (const f of files) {
      if (++count > MAX_FILES) {
        left.push({ what: labelOf(scope, f.rel), why: `more than ${MAX_FILES} files; this version stops there`, local: scope !== "project" });
        continue;
      }
      const acts = f.kind === "skill" && f.rel.endsWith("/SKILL.md");
      read.push(await readTextItem(root, f.rel, { tool: CODEX, scope, kind: f.kind, label: labelOf(scope, f.rel), where, acts }));
    }
    // A skill is its folder: one refused file refuses the skill, and so does declaring dependencies.
    const groups = new Map();
    for (const item of read) {
      if (item.kind !== "skill") continue;
      const dir = item.installTo.slice(scope.length + 1).split("/").slice(0, 3).join("/");
      groups.set(dir, [...(groups.get(dir) || []), item]);
    }
    for (const [dir, members] of groups) {
      const group = `${labelOf(scope, dir)}/`;
      const yaml = members.find((m) => m.installTo.endsWith(`${dir}/agents/openai.yaml`));
      const depends = yaml && yaml.content !== undefined && DEPENDS.test(yaml.content);
      const bad = members.find((m) => m.refused);
      for (const m of members) {
        m.group = group;
        if (depends) Object.assign(m, { refused: `${group}: agents/openai.yaml declares dependencies, which this version does not export yet`, refusedWhy: "declares dependencies in agents/openai.yaml" });
        else if (bad && !m.refused) Object.assign(m, { refused: `${group}: ${bad.refused}`, refusedWhy: bad.refusedWhy });
      }
    }
    items.push(...read);

    if (place.config && (await reachable(place.config))) {
      let text = null;
      try {
        text = await readFile(join(root, place.config), "utf8");
      } catch {
        text = null;
      }
      if (text !== null) {
        const label = labelOf(scope, place.config);
        const item = { tool: CODEX, scope, kind: "config", label, notes: [], left: [], info: "", refused: "", refusedWhy: "" };
        const parsed = parseToml(text);
        if (!parsed.ok) items.push(refuse(item, `${label} line ${parsed.line}: ${parsed.why}; this version reads it strictly`, "a config this version cannot read"));
        else {
          const r = scrubCodexConfig(parsed.value, { label, where, settings: scope === "user" });
          const parts = [];
          if (r.value.settings) parts.push(Object.keys(r.value.settings).join(", "));
          const n = Object.keys(r.value.mcpServers || {}).length;
          if (n) parts.push(`${n} server${n === 1 ? "" : "s"}`);
          items.push({ ...item, value: r.value, notes: r.notes, left: r.left, info: parts.join(" · ") || "nothing a setup carries", empty: !Object.keys(r.value).length });
        }
      }
    }
    if (place.rules && (await exists(join(root, place.rules)))) {
      left.push({ what: `${labelOf(scope, place.rules)}/`, why: "rules let commands run outside the sandbox without asking; not in this version's setups", local: scope !== "project" });
    }
  }
  return { items, left, config };
}
