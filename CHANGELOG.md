# Changelog

## 0.5.1

### The live board answered to any hostname (DNS rebinding)

`rooms live` binds 127.0.0.1, which stops another *machine* reaching the socket. It does not stop a
*page* the user is visiting. An attacker points `evil.example.com` at 127.0.0.1 with a short TTL,
the browser then treats `http://evil.example.com:7840/` as same-origin with the attacker's page —
and same-origin means CORS never applies. The board is the project's entire git history, so the
reply is every contributor name and address, every branch, every commit subject, and any room posts.

Nothing was reading the `Host` header, which is the only thing separating that from a real visit.
Verified against the running server before and after: a request claiming `Host: evil.example.com`
was served 178 KB including the repo identity, and is now refused with 403 before anything is read.
`localhost`, `127.0.0.1` and `[::1]` are served as before; a correct name on the wrong port is not.

Anyone who has run `rooms live` on an untrusted network, or while browsing, should take 0.5.1.

**A git pathspec uses forward slashes on every platform.** `relative()` returns
`src\api\thing.js` on Windows, and while git tolerates that for a bare path, pathspec magic —
which `--not` produces as `:(exclude)…` — is specified with `/`. 0.5.0 left that to chance, so
`rooms file` and `rooms week --not` could behave differently on Windows than everywhere else. It is
also what the report prints, so a path now reads the same way on every platform.

No other shipped code changed. The README gained a section answering "can't I just use `git log`?"
with this repository's own numbers, and the screenshots were refreshed.

## 0.5.0

### A repository is one project, from any directory inside it

`rooms open` in `src/api/` created `src/api/.room/` and called the project "api". Two people in the
same repo working from different subdirectories got two different rooms; the `.gitignore` and the
union merge driver landed where git would not apply them to the events log at the root; and every
board and report was titled after a folder.

Everything now anchors to the repository root, so a command typed in `packages/web/src` is about the
whole project. A path you type stays the file you meant — `rooms file app.ts` in that directory is
`packages/web/src/app.ts`, rebased onto the root rather than reinterpreted there.

The answer is also spelled the way you spelled it. `git rev-parse --show-toplevel` resolves
symlinks, so a workspace under a symlinked home was told its project lives at a path its owner has
never typed.

### It offers, once, to link your GitHub account

Verified identity was worth having and nobody was ever told how to get it: the board said
"unverified — rooms auth github" and that was the whole of the onboarding. The first `rooms open` in
a project now offers to link the account your `gh` CLI is already signed in to.

Almost all of this feature is the refusal to ask. There is no prompt when stdin or stdout is not a
terminal — a question in `npx … | tee log` is not a question, it is a hang — nor in CI, nor with
`ROOMS_NO_PROMPT`, nor when an account is already linked, nor when `gh` cannot answer (offering and
then failing is worse than never offering), nor ever again after a no. Walking away is not an answer
and is not recorded as one.

It runs after the board has been written and opened, so someone who ignores it still got what they
asked for. And asking does not create an identity: the check reads the verified-identity file
directly rather than going through the call that writes a device file when one is missing.

### A Windows clone reported its drive letter as the remote

`C:\Users\me\origin.git` matches the scp-style remote shape — `host:path` — with a host of `C`. A
Windows user cloning from a local directory saw a remote of `C/Users/...`, which is not a forge and
not a place anybody can visit. Found by the Windows matrix on the run that shipped this release, on
a test written for a completely different reason. An ssh alias has no dot in it either and *is* a
real remote, so the guard is the drive letter, not the dot.

### `approve` recorded a row and said "approved"

An agent reads a tool's description to decide what it does, and hears its reply as the outcome.
`approve` was described as "record an approval in the local audit trail" and answered `approved` —
both of which read like a gate that opened. Nothing here permits anything: there is no policy, no
check, no merge. Rooms answers who acted and which agent signed it. Whether an action is *allowed*
is a different question with a different answer, and a tool that blurs the two lets an agent believe
it has cleared itself to proceed.

Both tools now say what they do, in the description, in the reply, in the CLI and in the skill: a
row in a log. `approve` "does NOT grant permission, authorise an action, or merge anything, and is
not a substitute for a human approving the work". `request_review` notifies nobody. Tests fail if
either description drifts back toward "audit trail".

### Four commands that answer the question without opening anything

The board is the poster. These are the habit — all read-only, all reading git, none of which needs a
room, a server, an account or a browser. They work on a repo that has never heard of this tool.

```
rooms week [--since 7d] [--path src/] [--not vendor,dist]
rooms branch [<base>]
rooms file src/auth.ts
rooms badge --out agents.svg
```

`rooms week` prints the mix with a bar per agent and, when there is a previous week to compare to,
the change against it. `rooms branch` reports only the commits on this branch, which is the number
worth reading before opening a PR. `rooms file` answers "was this an agent dump" with the commits
that touched one path. `rooms badge` writes an SVG you can paste into a README.

**`--since`, `--path` and `--not` filter the denominator, not just the sample.** A monorepo or a
week of lockfile churn otherwise makes every percentage a ratio of two different populations.

**"no agent recorded" is a row, not a remainder.** It has the same label, the same bar and the same
weight as every agent, on every surface including the badge — because a plain commit is not evidence
that no agent was used. Cursor and Copilot often write no `Co-Authored-By` trailer, so every share
is a floor and each of these commands says so in as many words. That sentence is why the number is
worth more than a vendor dashboard's, and it travels with it.

The README now leads with `npx iops-rooms week` and a section saying what this will **not** tell
you: which lines an agent wrote, how much of a codebase is AI-written, or anything about a person
you could not already read in `git log`.

### A human co-author was being counted as Copilot

`attributeAgent` matched on the email DOMAIN, and `github.com` is not only where Copilot lives — it
is the domain of `users.noreply.github.com`, the address GitHub gives every human with an account and
sets as the commit email by default. On a normal GitHub repo **every human co-author was attributed
to Copilot**, and the board's headline "agent-assisted" figure was inflated by exactly those people.
The same trap was set for anyone with an `@anthropic.com`, `@openai.com` or `@cursor.com` address:
their employees.

The trailer NAME decides now, because the name is what an agent writes about itself. A domain can no
longer match; only a specific mailbox a tool commits from, like `noreply@anthropic.com`, which no
person holds. The two errors are not symmetric: missing an agent understates a figure the board
already calls a floor, while calling a person an agent is a false statement about a named human.

The old test used `ben@example.com` — a domain nothing matched — so it proved the matcher rejects
unrelated addresses, not that it rejects a human at a matched one.

### `rooms open` opened a tab; `rooms live` opened a window

Same flag, same session, two different results. `--app=` takes a URL and a board is a filesystem
path, so the guard — which only accepted `http(s)` — rejected every `rooms open` and fell through to
the system opener, producing the browser tab app mode exists to avoid. `rooms live` worked because it
already had a URL. Paths are converted now, and `open` prints which mode it got.

### A slider under the graph

The graph is wider than its window as soon as a history runs past about sixty commits, and nothing
said so. Two things were wrong underneath: `flex-direction: row-reverse`, the usual CSS-only way to
open a scroller at its right edge, reported `scrollLeft: 0` with the OLDEST commits in view — so the
board opened on the wrong end of history; and `scrollbar-width: thin` makes Chrome ignore
`::-webkit-scrollbar` entirely, leaving a macOS overlay bar that is invisible until you already knew
to scroll and occupies no layout space.

There is now a visible slider, keyboard-operable, that hides itself when the graph fits. The scroll
position is set explicitly, which is also the only version that can be measured and tested.

### Who posted where, instead of a second timeline

Under the graph was a lane per branch, each with a rail and avatars positioned by **time** — beneath
a graph on a **commit-order** axis. Two x-axes that could never agree, drawn as though they did. And
a branch nobody had posted on still got a full-width row saying "no posters yet".

It is a compact row per branch that somebody actually posted on: name, count, faces, with the same
hover detail as before. One line says how many other branches are on the graph with no posts.

### Doctor was a version behind the product

A repo with a hundred commits and nobody posting renders a full board — commits, contributors, agent
split, branch graph — and `rooms doctor` called it empty and exited 2. Telling someone their working
tool is broken is worse than saying nothing. A board is empty when it has neither git history nor
posts; posts on their own are optional, which is what they are.

### CI costs about a fifth of what it did

The matrix was 3 OS x 3 Node on every push and PR. GitHub bills macOS at 10x minutes and Windows at
2x, so three macOS jobs were roughly three quarters of every run — for the one platform that gets
tested by hand every day. macOS moved to a weekly run and `workflow_dispatch`; Windows stays on
every run, because four of the bugs it found were real. Roughly 124 billed minutes a run to 26.

**The push trigger said `master`.** After the rename to `main` nothing matched it, so from that day a
push ran no checks at all — silently, with a green repo behind it. Fixed, and the matrix had to
shrink first so turning it back on did not cost a full run per push. A test now fails if the trigger
and the branch drift apart again, or if macOS creeps back onto the every-push list.

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
