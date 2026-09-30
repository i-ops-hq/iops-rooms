# Security

Rooms by I-Ops is local-first. Treat every MCP and skill as untrusted until you have read it — including this one.

## What this package will never do

- Open sockets / `fetch` for **room traffic** or telemetry (no phone-home), or send anything to I-Ops. The network is reached only through your own `git` and `gh`, for what "What it does" lists (your verified identity, a branch's pull request, the team room), and through the OAuth **device flow** of `rooms auth github` / `rooms auth gitlab` when `gh` is not there, which mints a **local** verified identity and does **not** upload `.room/` events
- Bind a listen socket to anything other than `127.0.0.1` (optional `rooms live` is localhost-only)
- Read `process.env` wholesale or hunt for `.env`, SSH keys, or cloud credentials
- Write outside `.room/` in the project it resolved without a command that says so. The exceptions are listed under "What it does", and a test fails if `rooms open` in a new repository writes anything else
- **Read** a file outside that project for `share-diff --path`, or a file whose name looks like a secret, without you saying so explicitly — see below
- Run shell commands or `eval` user/agent text
- Install other packages at runtime
- Load scripts, fonts, or pixels from the public internet in `board.html`
- `file://` board stays fully offline; `rooms live` may EventSource the same localhost origin only
- Host your room on I-Ops cloud

## What it does

- Read/write `.room/room.json`, `.room/events.jsonl`, `.room/board.html`
- Append `.room/` to the project's `.gitignore` the first time a room is made there, unless the room
  is shared (`rooms init --share`). Until 0.5.12 this list said nothing outside `.room/` was ever
  written, and the first `rooms open` has always written this line
- Write local identity under `~/.iops-rooms/`: `device.json`, `prompt.json` (the answer to the
  one-time offer to link GitHub), and optionally `identity.json` and `device.key` (mode 0600)
- Read four environment variables agents set for the commands they run, `AI_AGENT`,
  `AI_AGENT_MODEL`, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`, and no other, in `rooms record
  commit`, which the git hook from `rooms hooks install` runs after each commit. It appends one line
  per commit to `.room/agent-activity.jsonl`: the commit, and the agent, version, entrypoint and
  model those variables named. A test fails if any other variable reaches that file
- With `rooms hooks install --agent claude-code`, which shows the change and asks first: add Rooms'
  hooks to `.claude/settings.local.json` (or `~/.claude/settings.json` with `--user`), keeping every
  other hook and a copy of the file from before Rooms first changed it, and list that file in
  `.git/info/exclude`.
  `rooms hooks uninstall --agent claude-code` takes out only what Rooms added
- Read, from the JSON Claude Code's hooks pass on stdin, the event name, the session id (kept only
  as a 12-character hash), the model a session starts with, the tool's name and the edited file's
  path, and nothing else. That
  payload also carries the whole file for `Write`, the tool's output, the last message and the
  transcript's path; none of them is kept, and the transcript is never opened. A test fails if any
  of it reaches `.room/agent-activity.jsonl`. The hook prints nothing and exits 0, so it never
  speaks to the agent
- Write outside `.room/` only when a command says so: `rooms mcp install` (the MCP configs and the
  skill copies), `rooms hooks install` (`.git/hooks/`), `rooms index --open`
  (`~/.iops-rooms/index.html`), and a path you name (`badge --out`, `export`, `export-room`)
- Stamp each event with a stable `deviceId` + display name. `ROOMS_ACTOR` claims to be a person, cannot be checked, and is marked **unverified**. `ROOMS_DEVICE_ID` only labels the machine — required in VMs, where a cloned template shares one `device.json` and an ephemeral one has none — so it does not block signing; the event records `deviceAsserted`
- Optional: after `rooms auth github` / `rooms auth gitlab`, stamp posts with GitHub/GitLab claim + local ed25519 signature (public key on the event; private key stays in `~/.iops-rooms/device.key`)
- Speak MCP over **stdio only**
- Render a static HTML file from `templates/board.html`, including each agent session's model and the
  paths it edited, from `.room/agent-activity.jsonl`. A shared room's log is merged from teammates'
  commits, so every value from it is escaped as text, and a test fails if a path, model or agent
  name holding HTML reaches the page as markup
- Optional: `rooms live` serves that board on `127.0.0.1` and auto-reloads open tabs when `.room/` changes, the agent activity log included
- Optional: read local `git` for branch stamps; optional read-only `gh` for `scm-status` (never uploads the room)
- With `rooms team init`, which shows what it will write and asks first: write `room.json`,
  `README.md`, `status/.gitkeep` and `.gitattributes` into the team room's clone and make one local
  commit. It never pushes; you do
- With `rooms team join <owner/repo>`, which asks first: clone `https://github.com/<owner>/<repo>.git`
  into `~/.iops-rooms/teams/<owner>/<repo>` with your own git, and record the team room and which
  project belongs to it in `~/.iops-rooms/teams.json`. Joining from a folder clones nothing
- With `rooms team sync`: pull the team room (fast-forward only), write your status to
  `status/<login>/<project>.json`, commit that one path, and push it with your own git. The first
  push to a team room shows the whole file and asks. A status holds only the project, optionally the
  branch and its upstream, ahead and behind, the pull request's state, what is not committed as
  counts, and agent sessions and files edited as counts; never a file name, a line of code, a
  commit message or a prompt, and a test fails if anything else reaches it. An unchanged status is
  not pushed. Every sync asks GitHub, through your own `gh repo view`, whether the team room is
  private, and refuses a public one unless `--public` is given; where it cannot ask, it needs
  `--confirm-private`
- With `rooms team board`: pull the team room, read each status field by field (anything else is
  left out and counted), and write `~/.iops-rooms/teams/<team>.board.html`, with every value
  escaped. Anyone with write access to the team room can write any file in it, so a status is as
  trustworthy as that access
- With `rooms team live`: serve the team board on `127.0.0.1` only, answering only a request that
  asked for this machine by name (the same check as `rooms live`, in the one file that opens a
  socket). Every interval, thirty seconds at the least, fetch the team room with git and, only if
  you already said yes to sharing with this team, push your status for this project when it
  changed, after asking GitHub again whether the team room is private. It stops when you stop it,
  and a check already running finishes first
- With `rooms shortcut`, which shows what it will write and asks first: write one launcher, an
  AppleScript application on macOS (built with `osacompile`), a `.cmd` on Windows or a `.desktop`
  entry on Linux, to the Desktop, the Linux applications menu, or the folder named with `--to`. It
  runs only this Node, this install of Rooms and `open`, in this project, with every path quoted for
  its format; a test runs each format against a folder whose name is a shell attack. A path holding
  a control character is refused, and so is a Rooms running from npx's cache. It replaces or removes
  only a launcher it wrote
- Ask GitHub whether the checked-out branch has a pull request, for `rooms week`, the board and the
  live board: one `gh pr view <branch>` through your own `gh`, which sends the repository and the
  branch name to the GitHub your remote already points at. Only for a branch that remote already
  has (it tracks an upstream, or origin has a branch of that name), so a local branch's name is
  never sent. At most once a minute per branch, never on the default branch, and never when `gh`
  is missing or `ROOMS_NO_GH=1` is set. What is not committed is counted from local `git` and shown
  as counts; which files is never kept
- Optional: export/import a `.room/` folder for git-friendly handoff (still offline)

## What `share-diff` will read (P0)

`rooms share-diff --path <file>` writes file contents into the room, and a shared room is
committed and pushed when `--share` is on. Until 2026-09-07 it read whatever path it was handed —
`--path ../fake-secret.env` published a secret from outside the project in one command. Three
independent controls now apply, because confinement alone fixes only the first:

- **Outside the project is refused.** The path resolves against the directory holding `.room/`.
  `--allow-outside` is the deliberate way through, and it is per-invocation.
- **Secret-looking names are refused**, inside the project too — `.env`, `*.pem`, `*.key`,
  `id_rsa`, `id_ed25519`, `*secret*`, `*credentials*`. `--allow-outside` does not lift this; the
  two are independent. The test is the **basename**, not the whole path, so a project under a
  directory named `credentials` is not refused wholesale.
- **The read is bounded.** At most 100 KB plus one byte is ever read, so file size no longer
  decides memory. Previously the whole file was read and then sliced — on a file past Node's
  maximum string length that was not a slow read but an outright `Invalid string length` crash.
  Truncation is recorded on the event and shown on the board rather than applied silently.

**Piped content is capped but not filtered.** `cat file | rooms share-diff` is the escape hatch on
purpose: `--path` means *this tool reads a file for you*, and stdin means *these are bytes you
chose*. The responsibility moves with the choice.

**The MCP `share_diff` tool is different, and the difference is worth understanding.** It takes the
diff as a string and never touches the filesystem, so none of the above can apply — an agent hands
over bytes it already has. The only lever there is the skill's instruction not to send secrets,
which is guidance to a model, not a control. If that distinction matters to you, the CLI is the
enforced path.

## Sync story

Network is **off** by default. When sync exists later, it is among **your team's own devices** (peer / LAN / machines you control) — not I-Ops reading or hosting the room.

## How to verify

1. Read `src/` — unminified.
2. Pin a version in `mcp.json` (`npx -y iops-rooms@0.6.1 mcp`), never `@latest`.
3. Open `.room/board.html` as `file://` and confirm the network tab is empty.
4. Optional `rooms live` — confirm it binds `127.0.0.1` only; DevTools should show only same-origin `/stream`.
5. `rooms status` / `rooms whoami` print local paths and identity; there is no account.

If a build starts requiring network for the core room, that is a bug. Optional relays will be explicit (`--relay`) and off by default.

## Import / sync-merge hardening (P0)

`rooms import-room` and `rooms sync-merge` copy **only** allowlisted regular files (`room.json`, `events.jsonl`). They:

- Refuse **symlinks** (`lstat` + open with `O_NOFOLLOW` when the platform supports it)
- Never opaque `fs.cp` / tree copy of a bundle (so a malicious `board.html` symlink cannot escape `.room/`)
- Always **regenerate** `board.html` locally via `writeBoard` after import/merge

`appendEvent` stamps reserved fields (`id`, `at`) **after** spreading caller input so payloads cannot override them.

Corrupt JSONL lines are **soft-skipped** when reading events — one bad line must not brick doctor / live / board.

### Residual risk

- A teammate (or compromised export) can still put **arbitrary text** in notes/diffs; treat room content like any shared file.
- Export/import is still **trust-the-peer**: we validate file *shape* (regular files, allowlist), not cryptographic signatures.
- Soft-skip means a silently corrupt line is dropped; check `[rooms] skipped N corrupt JSONL line(s)` on stderr if events look missing.
- Device identity under `~/.iops-rooms/device.json` is still a local writable file (by design).

## Verified GitHub / GitLab identity (P2 spike)

Team leads may opt into **verified mode**. Solo can stay unsigned.

```
~/.iops-rooms/
  device.json      # deviceId + displayName
  identity.json    # github and/or gitlab claim, publicKey, createdAt (after auth)
  device.key       # ed25519 private key, mode 0600 on macOS/Linux (shared)
```

identity.json shape (either or both providers):

```json
{
  "github": { "login": "alice", "id": 1, "email": null },
  "gitlab": { "username": "alice", "id": 2, "email": null },
  "deviceId": "abcd1234",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "createdAt": "2026-09-07T00:00:00.000Z"
}
```

- **On Windows the key is not mode 0600.** POSIX permission bits do not exist there, so `chmod`
  is a no-op and the key is protected by the NTFS ACL on your user profile instead. That is a
  weaker, different guarantee than a 0600 file, and it is stated rather than assumed.
- **`rooms live` serves localhost only, and checks the name it was asked for.** Binding to
  127.0.0.1 stops another machine reaching the socket; it does not stop a page the user is visiting
  from reaching it by DNS rebinding, because the browser then treats the attacker's origin as
  same-origin and CORS never applies. The `Host` header is validated against `localhost`,
  `127.0.0.1` and `[::1]` on the port actually bound, and anything else is refused with 403 before
  the board is read. There are no CORS headers, and no route takes a path from the request.
- `rooms auth github` reads your account from the **`gh` CLI** — a single `gh api user`, with your
  own credential, requesting no scopes and storing no token. Nothing is registered on our side and
  no application of ours appears in your GitHub authorised-apps list. `--device-flow` with
  `ROOMS_GITHUB_CLIENT_ID` remains for machines without `gh`.
- **The first `rooms open` in a project may offer to link your GitHub account.** It reads nothing
  until you answer yes, and then only the one `gh api user` above. It is skipped entirely when
  stdin or stdout is not a terminal (so it can never stall a pipe or a script), when `CI` or
  `ROOMS_NO_PROMPT` is set, when an account is already linked, when `gh` cannot answer, and on
  every run after a no — the answer is remembered in `prompt.json` beside the device file. It runs
  after the board has been written and opened, so ignoring it costs nothing.
- `rooms auth github --device-flow` uses GitHub **device flow**. Set `ROOMS_GITHUB_CLIENT_ID` to an OAuth App client id.
- `rooms auth gitlab` uses GitLab **device authorization grant**. Set `ROOMS_GITLAB_CLIENT_ID` (Application ID). Optional `ROOMS_GITLAB_HOST` (default `https://gitlab.com`) for self-managed.
- Auth only mints a **local** identity; it does not upload room events to I-Ops, GitHub, or GitLab. Access tokens are discarded after reading `/user`.
- Posts/MCP attach `github.login` and/or `gitlab.username` + `publicKey` + `sig` over a canonical payload (actor, deviceId, id, type, text hash, provider claim) when a verified identity is present. GitHub-only payload stays backward-compatible.
- `ROOMS_ACTOR` is stamped **unverified**: it claims to be a person and nothing can check it.
- `ROOMS_DEVICE_ID` is **not** an identity claim, so a verified identity still signs normally. The
  signature covers the device id, so the person is checked and the machine label is asserted —
  the event carries `identity.deviceAsserted: true` to say which half was which. Without this,
  running in a VM and being verified were mutually exclusive.
- Board badges: **verified** (sig ok) · **unverified** amber only for a `ROOMS_ACTOR` claim or a claimed GitHub/GitLab login without a valid sig · **quiet/none** for unsigned solo (no amber by default).

### sync-merge / import — warn-only

If an imported event **claims** a GitHub login or GitLab username but the ed25519 signature is missing or invalid, Rooms **warns on stderr** and still imports the event. Hard-reject is out of scope for this spike.

### Still spoofable (honest)

- Anyone who can write `events.jsonl` can invent an `actor` string (unsigned).
- A stolen `device.key` can mint valid signatures for that local identity until logout/re-auth.
- Board badges verify the event's embedded public key + sig — they do **not** re-check GitHub or GitLab live. Binding is "I authenticated once and keep this keypair."
- Warn-only merge means a forged `github.login` / `gitlab.username` without a valid sig still lands on the board (marked unverified).
