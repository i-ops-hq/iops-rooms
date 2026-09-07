# Security

Rooms by I-Ops is local-first. Treat every MCP and skill as untrusted until you have read it — including this one.

## What this package will never do

- Open sockets / `fetch` for **room traffic** or telemetry (no phone-home). Optional `rooms auth github` / `rooms auth gitlab` are the sole exceptions: OAuth **device flow** only, to mint a **local** verified identity — they do **not** upload `.room/` events
- Bind a listen socket to anything other than `127.0.0.1` (optional `rooms live` is localhost-only)
- Read `process.env` wholesale or hunt for `.env`, SSH keys, or cloud credentials
- Write outside `.room/` in the project it resolved (except local identity under `~/.iops-rooms/`: `device.json`, optional `identity.json` + `device.key` mode 0600)
- Run shell commands or `eval` user/agent text
- Install other packages at runtime
- Load scripts, fonts, or pixels from the public internet in `board.html`
- `file://` board stays fully offline; `rooms live` may EventSource the same localhost origin only
- Host your room on I-Ops cloud

## What it does

- Read/write `.room/room.json`, `.room/events.jsonl`, `.room/board.html`
- Stamp each event with a stable `deviceId` + display name (override with `ROOMS_DEVICE_ID` / `ROOMS_ACTOR`; env overrides are marked **unverified**)
- Optional: after `rooms auth github` / `rooms auth gitlab`, stamp posts with GitHub/GitLab claim + local ed25519 signature (public key on the event; private key stays in `~/.iops-rooms/device.key`)
- Speak MCP over **stdio only**
- Render a static HTML file from `templates/board.html`
- Optional: `rooms live` serves that board on `127.0.0.1` and auto-reloads open tabs when `.room/` changes
- Optional: read local `git` for branch stamps; optional read-only `gh` for `scm-status` (never uploads the room)
- Optional: export/import a `.room/` folder for git-friendly handoff (still offline)

## Sync story

Network is **off** by default. When sync exists later, it is among **your team's own devices** (peer / LAN / machines you control) — not I-Ops reading or hosting the room.

## How to verify

1. Read `src/` — unminified.
2. Pin a version in `mcp.json` (`npx -y iops-rooms@0.3.1 mcp`), never `@latest`.
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
  device.key       # ed25519 private key, mode 0600 (shared)
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

- `rooms auth github` uses GitHub **device flow**. Set `ROOMS_GITHUB_CLIENT_ID` to an OAuth App client id.
- `rooms auth gitlab` uses GitLab **device authorization grant**. Set `ROOMS_GITLAB_CLIENT_ID` (Application ID). Optional `ROOMS_GITLAB_HOST` (default `https://gitlab.com`) for self-managed.
- Auth only mints a **local** identity; it does not upload room events to I-Ops, GitHub, or GitLab. Access tokens are discarded after reading `/user`.
- Posts/MCP attach `github.login` and/or `gitlab.username` + `publicKey` + `sig` over a canonical payload (actor, deviceId, id, type, text hash, provider claim) when a verified identity is present. GitHub-only payload stays backward-compatible.
- Env overrides (`ROOMS_ACTOR` / `ROOMS_DEVICE_ID`) still work for smoke and are stamped **unverified**.
- Board badges: **verified** (sig ok) · **unverified** amber only for env override or a claimed GitHub/GitLab login without a valid sig · **quiet/none** for unsigned solo (no amber by default).

### sync-merge / import — warn-only

If an imported event **claims** a GitHub login or GitLab username but the ed25519 signature is missing or invalid, Rooms **warns on stderr** and still imports the event. Hard-reject is out of scope for this spike.

### Still spoofable (honest)

- Anyone who can write `events.jsonl` can invent an `actor` string (unsigned).
- A stolen `device.key` can mint valid signatures for that local identity until logout/re-auth.
- Board badges verify the event's embedded public key + sig — they do **not** re-check GitHub or GitLab live. Binding is "I authenticated once and keep this keypair."
- Warn-only merge means a forged `github.login` / `gitlab.username` without a valid sig still lands on the board (marked unverified).
