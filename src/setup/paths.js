/**
 * Paths from the exporting machine, as a setup may carry them (docs/design/TEAM_SETUPS.md §7.5).
 *
 * The exporter's home becomes `${HOME}` and the project's root `${PROJECT}`; any other absolute path
 * is refused, since paths name people, clients and projects. On adoption the two are put back as
 * the adopter's own.
 */

import { existsSync, realpathSync } from "node:fs";
import nodePath, { basename, dirname, join, sep, win32 } from "node:path";

/** A drive-letter path is read by Windows' rules on every system, so it is never taken for a relative one. */
const rulesFor = (p) => (/^[A-Za-z]:[\\/]/.test(p) ? win32 : nodePath);

const inside = (base, p) => {
  const P = rulesFor(p);
  if (P !== rulesFor(base)) return false;
  const rel = P.relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
};

/**
 * The path with the links in its existing part resolved, as the system sees it: on macOS `/var/x` is
 * `/private/var/x`, and a project reached through a link is still the project.
 */
export function realForm(path) {
  let head = String(path);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return String(path);
    tail.unshift(basename(head));
    head = up;
  }
  try {
    return join(realpathSync.native(head), ...tail);
  } catch {
    return String(path);
  }
}

/** `{ ok, value }` with the path made portable, or `{ ok: false, why }`. */
export function portablePath(path, { home, project }) {
  const p = String(path);
  const P = rulesFor(p);
  if (!P.isAbsolute(p)) return { ok: true, value: p.split(sep).join("/") };
  // Compared as written, then resolved, so a link on the way does not make the project look foreign.
  const forms = [...new Set([p, realForm(p)])];
  for (const [base, name] of [[project, "PROJECT"], [home, "HOME"]]) {
    if (!base) continue;
    for (const b of new Set([base, realForm(base)])) {
      for (const f of forms) {
        if (inside(b, f)) return { ok: true, value: `\${${name}}/${rulesFor(f).relative(b, f).split(/[\\/]/).join("/")}`.replace(/\/$/, "") };
      }
    }
  }
  // The same on every machine and naming no one: /dev/null, a scratch file in /tmp. Checked after
  // the project, which may itself be in /tmp, as it is on Linux CI.
  if (/^\/(dev|tmp)(\/|$)/.test(p)) return { ok: true, value: p };
  return { ok: false, why: `${p} is a path on this machine outside your home and the project` };
}

/** Put a portable path back on the adopter's machine. */
export function localPath(value, { home, project }) {
  return String(value).replace(/^\$\{PROJECT\}/, project).replace(/^\$\{HOME\}/, home);
}

/** Every absolute path inside a line of text (a hook command), made portable, or the first refusal. */
export function portableText(text, where) {
  let refused = "";
  // Not a path of its own: the rest of `"$DIR"/x`, `./x`, `~/x`, `${HOME}/x`, or a URL's `//host/x`.
  // A Windows path may hold a short name (RUNNER~1) and mix both separators.
  const out = String(text).replace(/(?<![\w$}/:.~-])(?<![\w}]["'])(\/(?:[\w.@+~-]+\/)*[\w.@+~-]+|[A-Za-z]:[\\/](?:[\w.@+~ -]+[\\/])*[\w.@+~-]+)/g, (m) => {
    const r = portablePath(m, where);
    if (!r.ok) refused ||= r.why;
    return r.ok ? r.value : m;
  });
  return refused ? { ok: false, why: refused } : { ok: true, value: out };
}
