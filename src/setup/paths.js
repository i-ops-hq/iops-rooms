/**
 * Paths from the exporting machine, as a setup may carry them (docs/design/TEAM_SETUPS.md §7.5).
 *
 * The exporter's home becomes `${HOME}` and the project's root `${PROJECT}`; any other absolute path
 * is refused, since paths name people, clients and projects. On adoption the two are put back as
 * the adopter's own.
 */

import { isAbsolute, relative, sep } from "node:path";

const inside = (base, path) => {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** `{ ok, value }` with the path made portable, or `{ ok: false, why }`. */
export function portablePath(path, { home, project }) {
  const p = String(path);
  if (!isAbsolute(p)) return { ok: true, value: p.split(sep).join("/") };
  if (project && inside(project, p)) return { ok: true, value: `\${PROJECT}/${relative(project, p).split(sep).join("/")}`.replace(/\/$/, "") };
  if (home && inside(home, p)) return { ok: true, value: `\${HOME}/${relative(home, p).split(sep).join("/")}`.replace(/\/$/, "") };
  return { ok: false, why: `${p} is a path on this machine outside your home and the project` };
}

/** Put a portable path back on the adopter's machine. */
export function localPath(value, { home, project }) {
  return String(value).replace(/^\$\{PROJECT\}/, project).replace(/^\$\{HOME\}/, home);
}

/** Every absolute path inside a line of text (a hook command), made portable, or the first refusal. */
export function portableText(text, where) {
  let refused = "";
  const out = String(text).replace(/(?<![\w$}])(\/(?:[\w.@+-]+\/)*[\w.@+-]+|[A-Za-z]:\\(?:[\w.@+ -]+\\)*[\w.@+-]+)/g, (m) => {
    const r = portablePath(m, where);
    if (!r.ok) refused ||= r.why;
    return r.ok ? r.value : m;
  });
  return refused ? { ok: false, why: refused } : { ok: true, value: out };
}
