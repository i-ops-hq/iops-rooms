# Rooms by I-Ops

Local rooms for agent sessions. Share a transcript **on disk**. Terminal + a static HTML board. No account. No model bill. Network off for individual use.

Pin a version. Do not run `@latest`.

## Individual vs team

| Mode | What it is | Smoke |
|---|---|---|
| **Individual** | One person. One (or more of *your*) device(s). Network off. `.room/` stays on your machine. | `npm run smoke:solo` |
| **Team (2+)** | Same checkout / shared `.room/` (e.g. `--share` + git). Each person/tool posts with their own actor + deviceId. Sync among *your* devices later — not I-Ops cloud. | `npm run smoke:two-device` |

Individual first: prove one poster can init → post → see the board. Team later: second actor/device on the same room.

## What you see / what you don't

**Teammates can see common project files** the normal way: the git checkout or shared folder. Rooms does **not** replace that.

**Rooms shows what was posted** into `.room/events.jsonl` (and the regenerated `board.html`):

- **By each user** — every event has `actor` (display name).
- **By each tool** — every event has `tool` (`cli`, `mcp`, …).
- **By each device** — every event has `deviceId`.
- **Diffs** — `share-diff` stores `path` + diff body, stamped with actor/tool/deviceId. The board header shows actor · tool · device; a `path:` line names the file.

**What does NOT auto-happen**

- Rooms does **not** magically sync the whole repo.
- It does **not** watch every save by default.
- Git commits auto-post **only** if you opt in with `rooms hooks install` (local hooks — not IDE telemetry).
- Unposted edits stay invisible to the room until someone `post`s a note, `share-diff`s a patch, or an installed hook fires.
- Network stays **off** for solo; team “own devices” sync is a later slice — still not I-Ops cloud.
- Still **not** full IDE telemetry — agents only appear when MCP is enabled and they post.



## Agents live on the board (Cursor / Claude Code / Codex)

Goal: agents **post as they work** via MCP — not only manual CLI notes.

**This repo:** `.cursor/mcp.json` already runs `node src/mcp.js`. Copy `skills/rooms/SKILL.md` into the agent skill path. Reload MCP, run `rooms live`, leave the tab open.

**Other projects (npx):**

```json
{
  "mcpServers": {
    "iops-rooms": {
      "command": "npx",
      "args": ["-y", "iops-rooms@0.1.1", "mcp"]
    }
  }
}
```

Pin the version. There is no pip package yet — Node/`npx` (or a local `node /path/to/iops-rooms/src/mcp.js`) is the install path.

Then agents use `post_note` / `share_diff` / `rename_room` while coding. Branch stamps come from local git.

```bash
rooms rename Rooms     # display name; code unchanged
Board title is `Rooms · {project name}` — display name (`meta.name`) when set and not a useless default (`untitled` / `room`), otherwise the project folder basename.
rooms live
```

## CLI vs MCP

**CLI** (Terminal):

```bash
cd ~/Projects/iops-rooms
node src/cli.js init --name "homework"
node src/cli.js post "starting"
node src/cli.js share-diff --path ./src/cli.js --note "look here"
node src/cli.js status
node src/cli.js open
```

Or: `npm run rooms -- status`


**MCP** (Cursor): this repo `.cursor/mcp.json` already points at `src/mcp.js`. Reload MCP, then:

1. `create_room` (or join) — local `.room/`
2. `post_note` — event stamped with actor/tool/deviceId
3. Optional `share_diff` with `path` + `diff`
4. Open `.room/board.html` (or CLI `open`) and confirm name, tool, device, and path on the card

After publish, pin a published package version in Cursor MCP (never `@latest`).

Copy `skills/rooms/SKILL.md` into a user skill dir if you want it globally.

## Install

Published on npm (MIT). Pin the version — do not use `@latest`.

```bash
npm i -g iops-rooms@0.1.1
# or one-shot:
npx -y iops-rooms@0.1.1 help
npx -y iops-rooms@0.1.1 init --name homework
npx -y iops-rooms@0.1.1 post "starting"
npx -y iops-rooms@0.1.1 live
```

From a git checkout of this repo you can still run `node src/cli.js …` (see CLI vs MCP above).

Teammate on the same checkout: `rooms join THECODE` (or `node src/cli.js join THECODE`).

`--share` keeps `.room/` commitable. Default is gitignore.

MCP Registry listing is a follow-up — npm is the install path for now.

## All rooms on this Mac

node src/cli.js index --open

Lists `.room/` under ~/Projects. Does not list browser chat windows.

## Commands

| Command | What |
|---|---|
| rooms init / join | Create or join .room/ |
| rooms status / whoami | Paths and actor |
| rooms open | Local HTML board |
| rooms post | Note |
| rooms share-diff | Diff on disk (stamped actor/tool/device) |
| rooms request-review / approve | Audit |
| rooms wait / export | Poll, markdown export |
| rooms doctor | Diagnose empty / unhealthy rooms |
| rooms hooks install / uninstall | Opt-in local git auto-post |



## Branch awareness (slice 2)

Posts stamp the current git branch (`git rev-parse` or `ROOMS_BRANCH` for smoke).
The board shows:

- Current branch in the hero facts
- A **Branches** panel: local branches, post counts, last poster activity
- Per-card branch chip next to actor/tool/device

```bash
node src/cli.js branches
node src/cli.js whoami
node src/cli.js live   # leave open — branch UI refreshes with posts
```

Honest limit: **local git first**. Remotes/PRs are optional via `rooms scm-status` (uses `gh` when present; degrades cleanly if missing).

## Team device sync (dogfood)

On **your** machines only — export / merge. Same room code. No I-Ops cloud.

```bash
# Device A
node src/cli.js export-room /tmp/room-bundle
# copy bundle to Device B, then:
node src/cli.js sync-merge /tmp/room-bundle
node src/cli.js live
```

Or `rooms init --share` and commit `.room/` so teammates `git pull`. See `rooms sync-hint`.

## SCM connect (GitHub first)

```bash
node src/cli.js scm-status           # gh auth → repo, remote branches sample, open PRs
node src/cli.js scm-status gitlab    # honest stub for now
```

Degrades cleanly if `gh` missing. Never uploads the room.

## Live local board

Static `file://` board is still fine for a snapshot. For auto-update without re-opening:

```bash
cd ~/Projects/iops-rooms
node src/cli.js live
# leave that terminal running; browser opens http://127.0.0.1:7840/
# other terminal:
node src/cli.js post "hello live"
```

Binds **127.0.0.1 only**. No internet. No I-Ops phone-home. Multi-poster / devices-only copy unchanged.

## Doctor (empty boards)

If the board looks empty, diagnose:

```bash
node src/cli.js doctor
# or after install:
rooms doctor
```

Checks `.room/`, event counts, identity (actor / tool / deviceId), MCP config hints (`.cursor/mcp.json`), skill path, and optionally whether `127.0.0.1:7840` is up.

- Exit **0** — healthy (has non-system posts)
- Exit **2** — room exists but board is empty (WARN + next actions)
- Exit **1** — no `.room/` (or hard failure)

Empty boards usually mean nothing was posted yet — enable MCP, `rooms post "…"`, `rooms share-diff`, or `rooms hooks install`.

## Git hooks (opt-in, local only)

Never auto-installed. Local git hooks only — **not** IDE telemetry, not I-Ops cloud.

```bash
rooms hooks install          # post-commit + post-checkout
rooms hooks install --force  # overwrite foreign hooks (backs them up)
rooms hooks uninstall
```

- **post-commit** — short note: commit subject + short hash + `git show --stat` summary (secrets-looking paths redacted)
- **post-checkout** — short note when the branch changes

Hooks call this package's `src/cli.js` via an absolute Node path baked into the hook script. Tool stamp: `git-hook`.

## Smoke

Same commands as the Individual vs team table above.

## Files

.room/room.json events.jsonl board.html
Board template: templates/board.html

## Tests

Run the package test script.

## Trust

See SECURITY.md. Source has no HTTP client.

## Not this release

Hosted relay, seats, SSO, own model. No whole-tree sync. No full IDE telemetry — hooks are opt-in git only.
