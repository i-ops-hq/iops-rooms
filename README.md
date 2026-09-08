<div align="center">

# Rooms by I-Ops

**See who built your project — and which AI helped.**

[![npm](https://img.shields.io/npm/v/iops-rooms?color=0b7285&label=npm)](https://www.npmjs.com/package/iops-rooms)
[![license](https://img.shields.io/badge/license-MIT-0b7285)](LICENSE)
[![node](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-0b7285)](package.json)
[![platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-tested-0b7285)](.github/workflows/tests.yml)
[![tests](https://github.com/i-ops-hq/iops-rooms/actions/workflows/tests.yml/badge.svg)](https://github.com/i-ops-hq/iops-rooms/actions/workflows/tests.yml)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-0b7285)](package.json)

*One layer of [I-Ops](https://i-ops.dev), open sourced.*

</div>

---

Point it at a git repo and it reads the history you already have: every commit, the person who made
it, and the agent that co-authored it.

```bash
npx -y iops-rooms@0.4.1 init --name "my project"
npx -y iops-rooms@0.4.1 open
```

That is the whole setup. No account, no model bill, no network. On a large repo it reads several hundred
commits in about a second and says:

```
Claude Opus 5    most commits  many thousands of lines 
Cursor           the rest  many thousands of lines  
no agent recorded the remainder
```

<p align="center">
  <img src="docs/screenshots/board.png" alt="The Rooms board for a real repo: several hundred commits, a branch graph with a dot per commit coloured by the agent that made it, and a Built by panel splitting the work between Claude Opus 5, Cursor, and commits with no agent recorded" width="820">
</p>

**Where that comes from, and what it is not.** Claude Code and Cursor both write a
`Co-Authored-By` trailer on the commits they help with, so the attribution is already in your repo
and in every clone of it. Rooms reads git and nothing else — not `.cursor/`, not Claude's session
files, not any tool's private state. A commit with no trailer is shown as **the person's own**, not
as an unknown.

On top of that, a **live room**: a branch graph with a dot per commit and per post, and a shared
transcript on disk that a team syncs through their own git remote. Terminal plus a static HTML
board. Network off for individual use.

Runs on macOS, Linux and Windows, on Node 20, 22 and 24 — all nine combinations are tested on every
change.

Pin a version. Do not run `@latest`.

## What the board shows about your project

| | from | needs |
|---|---|---|
| Every commit, its author, its `+`/`−` lines | `git log` | nothing |
| Which agent co-authored it — Claude Opus 5, Fable, Cursor, Codex | `Co-Authored-By` trailers | nothing |
| Branches splitting from main and rejoining, with PR numbers | merge commits | nothing |
| Per-person totals: commits, merges, lines, which agent they lean on | `git log` | nothing |
| Live posts, presence, who is on which branch right now | `.room/` | the CLI or MCP |

The first four work on a repo that has never heard of Rooms, including for teammates who never
install it — because every clone already carries the whole history. Only the last row needs anyone
to post anything.

**Two histories both look right.** A repo that works on `main` with no merges draws as one rail
with every commit on it. A repo that merges pull requests draws a rail plus a lane per branch —
including branches that were merged and deleted, because the merge commit still records what they
contributed and what they were called.

**One caveat worth knowing.** If the same person commits under two email addresses, they are listed
twice. That is deliberate: [`.mailmap`](https://git-scm.com/docs/gitmailmap) is git's own way to
merge identities, and a heuristic that guessed would eventually merge two different people. The
board tells you when it sees it.

## Start here

**1. Point it at a repo.**

```bash
cd ~/your-project
npx -y iops-rooms@0.4.1 init --name "your project"
```

Creates `.room/` and adds it to `.gitignore`. Nothing leaves your machine.

**2. Open the board.**

```bash
npx -y iops-rooms@0.4.1 open
```

Your whole history is already there — every commit, who made it, which agent helped. You have not
had to post anything yet.

**3. Leave it running while you work.**

```bash
npx -y iops-rooms@0.4.1 live
```

Serves the board on `127.0.0.1` and refreshes it as things change. Leave the tab open.

<p align="center">
  <img src="docs/screenshots/install.png" alt="Installing and running Rooms from npm in a terminal: npx iops-rooms init, then open, then live" width="820">
</p>

That is the whole loop for one person. Two optional extras, in the order most people want them:

```bash
rooms auth github     # sign your posts, using the gh login you already have
rooms mcp install     # let Cursor / Claude Code / Codex post as they work
```

## Teams

**Individual first.** One person on one machine is the path that is finished and tested; teams work
but are newer, so start solo and add people once you like what you see.

When you are ready, a team shares a room through **your own git remote** — there is no I-Ops server
and no account:

```bash
rooms init --share    # keep .room/ in the repo instead of gitignoring it
git add .room && git commit && git push
```

Teammates `git pull`, run `rooms join <code>`, and post. Everyone's posts merge on the next pull;
`--share` writes the git merge rules that make concurrent posts merge instead of conflicting.

Each person's posts carry their own name, tool and device, so the board shows who did what.

## What it does not do

- It does **not** sync your repo. Git already does that.
- It does **not** watch every save. A post happens when you post, when an agent posts through MCP,
  or when a git hook you installed fires.
- It does **not** read Cursor's or Claude's private state. Commit attribution comes from the
  `Co-Authored-By` trailers they write into your git history.
- It does **not** phone home. The static board is offline; `rooms live` binds `127.0.0.1` only.

## Agents on the board (Cursor / Claude Code / Codex)

Agents post as they work, through MCP. One command wires it up:

```bash
npx -y iops-rooms@0.4.1 mcp install
```

That writes `.cursor/mcp.json`, `.claude/`, and a Codex entry, keeping any MCP servers you already
had, and copies the skill so the agent knows when to post. Reload MCP, and the agent gets
`post_note`, `share_diff`, `request_review`, `approve`, `read_transcript`, `doctor` and
`wait_for_peer`.

Pin the version. Do not use `@latest` — an MCP server is a program you are letting an agent run.

Manual wiring, if you prefer:

```json
{ "mcpServers": { "iops-rooms": { "command": "npx", "args": ["-y", "iops-rooms@0.4.1", "mcp"] } } }
```

## Commands

| | |
|---|---|
| `rooms init` / `join` | create or join `.room/` — `--share` to commit it, `--mcp` to wire agents |
| `rooms open` / `live` | the board, once or continuously on `127.0.0.1` |
| `rooms post` / `share-diff` | a note, or a diff (confined to the project; `--allow-outside` to escape) |
| `rooms status` / `whoami` / `branches` | where things are, who you are, what is where |
| `rooms auth github` / `gitlab` / `status` | verified identity, via your own `gh` login |
| `rooms doctor` | why the board looks empty. Exit 0 healthy, 2 empty, 1 no room |
| `rooms index --open` | every `.room/` under `~/Projects` on one page |
| `rooms hooks install` | opt-in local git hooks that post commits and checkouts |
| `rooms scm-status` | repo, branches and open PRs via `gh` — read-only, degrades if `gh` is missing |
| `rooms export` / `export-room` / `sync-merge` | markdown, or move a room between your own machines |

`ROOMS_NO_OPEN=1` skips launching a browser, for headless boxes and VMs.

## Verified identity (optional)

```bash
rooms auth github     # uses the gh CLI you already have
rooms auth status
```

One read-only call, `gh api user`, with your own credential. **No OAuth App to register, nothing of
ours in your authorised-apps list, no token stored.** Posts then carry a GitHub claim and an
ed25519 signature made by a key that never leaves `~/.iops-rooms/`.

Everything else on the board works without this. It only adds a signed claim about *who posted*.

Without `gh`, set `ROOMS_GITHUB_CLIENT_ID` to an OAuth App client id of your own and use
`rooms auth github --device-flow`. GitLab works the same way with `ROOMS_GITLAB_CLIENT_ID`.

## Trust

Read [SECURITY.md](SECURITY.md). Briefly: no network for room traffic, no telemetry, no reading of
other tools' private state; `rooms live` binds `127.0.0.1` only; `share-diff` refuses paths outside
the project and secret-looking filenames; and the whole of `src/` is unminified and dependency-free.

Verify it yourself: open the board as `file://` and watch the network tab stay empty.

## Requirements

Node 20, 22 or 24 on macOS, Linux or Windows. Every combination is tested on every change.
No runtime dependencies.

## Not in this release

Hosted relay, accounts, seats, SSO, or a model of our own. No whole-repo sync. No IDE telemetry —
agents appear when they post through MCP, and git hooks are opt-in.

---

## About

Rooms is one working layer of **[I-Ops](https://i-ops.dev)**, open sourced.

I-Ops is a desktop application for making AI workers finish real tasks correctly. Rooms is the part
that answers *who is doing what, and which agent did it* — and it was **built from scratch for this
repository**, not carved out of the product. Nothing here is a stripped-down copy of something
closed; it is a small tool that stands on its own, and you can read all 4,000 lines of it.

**Feedback is genuinely wanted.** If you try it and something is confusing, wrong, or missing — or
if you have read the code and disagree with a decision in it — please say so. Open an
[issue](https://github.com/i-ops-hq/iops-rooms/issues), send a pull request, or email
**hello@i-ops.dev**. Reviews of the security posture in [SECURITY.md](SECURITY.md) are especially
welcome.

MIT licensed. Built by I-Ops Operations Intelligence, LLC — [i-ops.dev](https://i-ops.dev).
