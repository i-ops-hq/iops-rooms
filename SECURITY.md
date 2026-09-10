# Security

Rooms by I-Ops is local-first. Treat every MCP and skill as untrusted until you have read it — including this one.

## What this package will never do

- Open sockets / `fetch` for **room traffic** or telemetry (no phone-home). Optional `rooms auth github` / `rooms auth gitlab` are the sole exceptions: OAuth **device flow** only, to mint a **local** verified identity — they do **not** upload `.room/` events
- Bind a listen socket to anything other than `127.0.0.1` (optional `rooms live` is localhost-only)
- Read `process.env` wholesale or hunt for `.env`, SSH keys, or cloud credentials
- Write outside `.room/` in the project it resolved (except local identity under `~/.iops-rooms/`: `device.json`, optional `identity.json` + `device.key` mode 0600)
- **Read** a file outside that project for `share-diff --path`, or a file whose name looks like a secret, without you saying so explicitly — see below
- Run shell commands or `eval` user/agent text
- Install other packages at runtime
- Load scripts, fonts, or pixels from the public internet in `board.html`
- `file://` board stays fully offline; `rooms live` may EventSource the same localhost origin only
- Host your room on I-Ops cloud

## What it does

- Read/write `.room/room.json`, `.room/events.jsonl`, `.room/board.html`
- Stamp each event with a stable `deviceId` + display name. `ROOMS_ACTOR` claims to be a person, cannot be checked, and is marked **unverified**. `ROOMS_DEVICE_ID` only labels the machine — required in VMs, where a cloned template shares one `device.json` and an ephemeral one has none — so it does not block signing; the event records `deviceAsserted`
- Optional: after `rooms auth github` / `rooms auth gitlab`, stamp posts with GitHub/GitLab claim + local ed25519 signature (public key on the event; private key stays in `~/.iops-rooms/device.key`)
- Speak MCP over **stdio only**
- Render a static HTML file from `templates/board.html`
- Optional: `rooms live` serves that board on `127.0.0.1` and auto-reloads open tabs when `.room/` changes
- Optional: read local `git` for branch stamps; optional read-only `gh` for `scm-status` (never uploads the room)
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
2. Pin a version in `mcp.json` (`npx -y iops-rooms@0.5.3 mcp`), never `@latest`.
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
