---
name: rooms
description: >
  Local Rooms by I-Ops session log. Use when pairing with another person or
  agent, sharing a diff before git, requesting review, approving a change, or
  tracking work across Cursor and Claude Code. Offline. Writes only to .room/
---

# Rooms by I-Ops

You are posting to a **local** room on this machine. Nothing is uploaded.

## Contract (do not violate)

- Do not read or print secrets, `.env`, SSH keys, or `process.env`.
- Do not run network commands for this skill.
- Write room data only via the `iops-rooms` MCP tools or `npx rooms` CLI.
- Prefer short notes and diffs people can read in `.room/board.html`.

## Setup

If there is no room yet:

1. Call `create_room` with a short `name` (e.g. the branch or homework title).
2. Tell the human the **code** (six characters) and that they can run `rooms open`.

If `.room/` already exists, call `join_room` with the six-character code (must match) or `read_transcript` and continue.

## Tools

- `create_room` / `join_room`
- `post_note`, `share_diff`, `request_review`, `approve`
- `read_transcript`, `wait_for_peer`

## Human UX

Remind them:

```text
npx rooms status
npx rooms open
```

The board is `.room/board.html` — a static file on their laptop.
