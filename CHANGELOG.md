# Changelog

## 0.4.1

**`rooms auth github` works with no setup.** It reads your account from the `gh` CLI you already
have — one read-only `gh api user`, with your own credential. No OAuth App to register, nothing of
ours in your GitHub authorised-apps list, no token stored. `--device-flow` with
`ROOMS_GITHUB_CLIENT_ID` remains for machines without `gh`.

Before this, `rooms auth github` threw unless you had registered an OAuth App and exported its
client id — so the first thing a new user hit was a wall.

**A shorter README.** 371 lines to 191. It now opens with what the tool does, gives one plain
three-step flow for a single person, and says honestly that individual is the finished path and
teams are newer. The reference material that made the front page hard to read is gone or collapsed.

## 0.4.0

The board stopped being only about the room and started being about the project.

### It reads your git history

Point it at a repo and it shows every commit, who made it, and **which AI helped** — from the
`Co-Authored-By` trailers Claude Code and Cursor already write. A few hundred commits are read in
about a second and split by agent — how much each one wrote, and how much carries no attribution
at all.

No MCP, no network, no vendor's private state — `.cursor/` holds configuration, not a commit
ledger, and reading another tool's session database is not something this package will do. A commit
with no trailer is shown as the person's own, not as an unknown.

- **Built by panel** — per-person commits, merges, `+`/`−` lines, and which agent each person leans
  on. An agent's share is of that person's *attributed* commits, because a plain commit is not
  evidence that no agent was used, only that none was recorded.
- **Merges are counted separately.** git records no line changes for a merge, so a maintainer who
  merges every PR was showing as `+0 −0` — as if they had written nothing.
- **Split identities are flagged, never merged.** One person committing under two addresses is
  listed twice, with a pointer to `.mailmap`. Guessing would eventually merge two different people.

### A branch graph

Main is a rail across the whole span; every other branch splits off at its first event and rejoins
at its last, with a dot per commit and per post and a light travelling each wire. Branches that were
merged and deleted still appear, reconstructed from their merge commits with PR numbers.

Hovering a commit gives the whole answer:

```
85d970d · AshPlayer-1415 · Claude Opus 5 · +750 −1 · 9/7/2026, 4:22:28 PM
```

A repo that works on `main` with no merges draws as one rail. A repo that merges PRs draws a rail
plus a lane per branch. Both are normal and both are handled.

### Windows

Now tested on Windows, macOS and Linux across Node 20, 22 and 24 — every combination, on every
change. Four bugs this found, three of which affect real users:

- **`fs.watch` aborted the process.** On a path containing an 8.3 short name (`C:\Users\RUNNER~1\…`,
  or any shortened Windows profile) libuv fails an internal assertion and *aborts* rather than
  throwing. `rooms live` died the instant anything touched `.room/`. Now watches the resolved path
  and degrades to polling if watching is unavailable.
- **`rooms live --port 0` bound 7840** instead of picking a free port, because the CLI passes a
  string and `Number("0") || 7840` falls through on a falsy zero. Two boards on one machine
  collided.
- **`npm test` was broken on Node 20 + Windows** — `node --test test/*.test.js` needs a shell or
  Node 22+ to expand the glob, and `cmd.exe` does neither.
- **The MCP server did not exit when its pipe closed**, only on a clean `end`, leaving orphaned
  processes.

`device.key` cannot be mode 0600 on Windows — POSIX permission bits do not exist there, so it is
protected by the NTFS profile ACL instead. That is a weaker and different guarantee, and
`SECURITY.md` now says so rather than implying otherwise.

### Team rooms through git actually work

`rooms init --share` now writes a `.gitattributes` setting `merge=union` on `events.jsonl` and a
`.gitignore` excluding the generated `board.html`.

Before this, the documented team workflow **conflicted on every concurrent post** — an append-only
log where two people append between pulls conflicts every time, which for a shared room is the
normal case rather than an edge case. Verified with three machines, three device ids and one shared
remote: all three post, all three push, and every machine ends with the same events and all three
actors.

Duplicate ids are dropped when the log is read, so a union merge can never render a post twice.

### `share-diff` no longer reads whatever it is pointed at

Three independent controls, because confinement alone fixes only the first:

- Outside the project is refused; `--allow-outside` is the deliberate way through.
- Secret-looking names are refused **inside** the project too — `.env` lives in the project, so
  confinement does nothing for it. The two are independent.
- The read is bounded to the cap. Previously the whole file was read and then sliced, which on a
  file past Node's maximum string length was not a slow read but an `Invalid string length` crash.

Truncation is recorded on the event and shown on the board instead of being applied silently.

### Identity in a VM

A cloned VM template hands every clone the same `device.json`, and an ephemeral VM loses it on each
spin-up, so the machine must set `ROOMS_DEVICE_ID` — which used to stamp every event `unverified`
regardless of a valid signature. Running in a VM and being verified were mutually exclusive.

`ROOMS_ACTOR` claims to be a *person* and nothing can check it, so it stays unverified.
`ROOMS_DEVICE_ID` names a *machine*, which is not an identity claim, so it signs normally and the
event records `deviceAsserted`. `deviceId` is now 16 bytes rather than 4 — 32 bits collide at
roughly 1% by 9,300 devices, and a fleet of ephemeral VMs counts runs, not machines.

### Also

- `ROOMS_NO_OPEN=1` skips launching a browser, for headless boxes and VMs.
- CI: the suite, both smokes, a coverage floor, and a job that installs the packed tarball and runs
  the CLI from it — because `npm publish` packs the working tree while git records what you added.
- The two-device smoke now verifies two devices instead of printing instructions for a human.
- Documentation corrected where it had drifted, and gated so it cannot drift again.

## 0.3.1 and earlier

Local rooms for agent sessions: CLI, MCP server, offline board, live board, branch awareness,
device sync, opt-in git hooks, and optional verified GitHub/GitLab identity.
