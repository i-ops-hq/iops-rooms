# Changelog

## Unreleased

### One command, and a real window

`rooms open` in a folder with no room creates one and opens it, instead of failing with
instructions to run `rooms init` first. Install and start is now two commands with nothing
between them.

The board opens in an application window — Chrome, Brave, Edge or Chromium in `--app` mode, whichever
is installed — rather than as a tab in whatever the browser had open. `--tab` forces the old
behaviour, and a machine with none of those falls back to the system opener.

### Branches that were never merged are branches too

The graph reconstructed branches from merge commits, which meant a branch you are still working on,
or one that was deployed and never merged back, did not exist as far as the board was concerned. On
one repo that was the difference between drawing zero branches and drawing ten. Every ref is now
read, and anything holding commits the trunk does not have is drawn and marked open.

### A graph you can read

Branches curve above and below main instead of stacking downward from it, six at a time with a `+`
for the rest, and the axis is commit order rather than elapsed time.

The last of those is what made the rest work. On a time axis a branch that lived forty minutes
inside a two-day history has no width, so its route degenerated into a vertical spike as tall as its
lane was far from main — seventeen branches drew as a comb. Every commit now takes the same step,
which is what `git log --graph` does. The cost is that a quiet month and a busy hour are the same
width; the axis says so, and the real timestamp is still on every dot and at both ends.

The drawing is as wide as the history is long, in its own scroller, opening at the newest end.
Branches outside the collapsed view are hidden rather than merely cropped — cropping alone left
their risers crossing the visible band as lines to nowhere.

### The top of the board is about the project

The cards were facts about the tool: posters, events, network off, `.room` on disk. They now read
**commits · people · agent-assisted · branches · since the last change**, all from git history the
repo already has, so they are full on the first run before anyone has posted. Each carries a line
saying what the number means.

The agent share is of the commits actually read, and it is a floor: an agent that writes no trailer
leaves no trace, so the true share can only be higher.

A rail says who you are — verified, unverified, or a name asserted through `ROOMS_ACTOR` that
nothing can check — and what this checkout is connected to: the remote, the branch and SHA, whether
the tree is clean, and how far it is from its upstream. Three things came out of building it:

- **A remote URL can carry a credential.** `https://x-access-token:ghp_…@github.com/o/r` is what a
  shared box or a CI checkout configures, and a board is a file people screenshot into issues. It is
  stripped where the URL is read.
- **Verified elsewhere is not verified here.** A restored `identity.json`, a copied home directory or
  a VM template leaves an account linked to a different device. That now says so rather than showing
  a check this machine has not earned.
- **Rendering must not mint an identity.** `loadIdentity` writes `device.json` when it is missing, so
  a renderer that called it would make opening a board the thing that gives the machine an identity.

### The Branches panel says what is still happening

It listed every local ref as an equal row — twenty-four on this repo, twenty of which read "0 posts
· —" and "no room posts yet". The default, the branch you have checked out, anything holding commits
the default does not have, and anything anyone posted about keep their own row; the rest collapse
into one line and a disclosure.

A row now says which of three different things its silence means: `merged in #24`, `nothing on it
that main does not have`, or `not a branch in this checkout` — a name that only ever appeared as a
post stamp. All three used to render as "0 posts".

**Exactly one branch is badged default, and git decides which.** The badge matched
`/^(main|master)$/`, so a repo part-way through a rename had two of them — and a page that names two
defaults has told the reader it does not know. It now comes from `origin/HEAD`, falling back to
whichever of main/master/trunk/develop the repo actually has.

The local branch list was also silently cut at sixteen refs, which is how a real branch ended up
described as "not a branch in this checkout".

### The test suite was writing into your real identity store

`npm test` resolved `ROOMS_HOME` to `~/.iops-rooms` in every file that did not set its own, which was
most of them. On the machine this was found on it had left a display name of `cmd-test` and a
verified GitHub login of `octocat` — and the board rendered that fixture back as "verified". Nothing
failed; the suite passed while replacing the identity the developer's own posts are signed with.

Fixed for every file at once with a `--import` hook that points `ROOMS_HOME` at a temp directory, and
guarded by a test that fails if the hook is ever dropped. The smoke scripts got the same treatment.

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
