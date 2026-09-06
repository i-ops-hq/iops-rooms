# Security

Rooms by I-Ops is local-first. Treat every MCP and skill as untrusted until you have read it — including this one. Recent scans found security issues in a large share of public MCP packages and agent skills (on the order of 1/4–1/3 with *flaws*; confirmed malware is smaller but real).

## What this package will never do

- Open sockets, `fetch`, or DNS (no telemetry, no “phone home”)
- Read `process.env` wholesale or hunt for `.env`, SSH keys, or cloud credentials
- Write outside `.room/` in the project it resolved
- Run shell commands or `eval` user/agent text
- Install other packages at runtime
- Load scripts, fonts, or pixels from the network in `board.html`

## What it does

- Read/write `.room/room.json`, `.room/events.jsonl`, `.room/board.html`
- Speak MCP over **stdio only**
- Render a static HTML file from `templates/board.html`

## How to verify

1. Read `src/` — a few hundred lines, unminified.
2. Pin a version in `mcp.json` (`npx -y iops-rooms@0.1.0 mcp`), never `@latest`.
3. Open `.room/board.html` as `file://` and confirm the network tab is empty.
4. `rooms status` prints the data directory; there is no account.

If a build starts requiring network for the core room, that is a bug. Optional relays will be explicit (`--relay`) and off by default.
