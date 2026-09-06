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

- Do not read or print secrets, `.env`, SSH keys, or cloud credentials.
- Do not run network commands for this skill.
- Write room data only via the `iops-rooms` MCP tools or `node src/cli.js`.
- Prefer short notes and diffs people can read in `.room/board.html`.

## Setup

If there is no room yet, call `create_room` with a short name. Tell the human the six-character code and `node src/cli.js open`.

If `.room/` exists, `join_room` / `read_transcript` and continue.

## Tools

- `post_note`, `share_diff`, `request_review`, `approve`, `read_transcript`, `wait_for_peer`
