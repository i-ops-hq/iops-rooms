---
name: rooms
description: >
  Local Rooms by I-Ops live session board. Use while coding in Cursor, Claude Code,
  or Codex so teammates see work as it happens — post_note / share_diff on meaningful
  steps, not only at the end. Offline. Writes only to .room/
---

# Rooms by I-Ops

You post to a **local** room on this machine. The live board (`rooms live` → http://127.0.0.1:7840/) updates for anyone with the tab open. Nothing is uploaded to I-Ops.

## Contract (do not violate)

- Do not read or print secrets, `.env`, SSH keys, or `process.env`.
- Do not run network commands for this skill.
- Write room data only via the `iops-rooms` MCP tools or `rooms` CLI.
- Prefer short notes and diffs people can read on the board.

## Setup (once per project)

1. Ensure MCP is configured (this repo already has `.cursor/mcp.json` → `src/mcp.js`).
2. Reload MCP / restart the agent host.
3. If no `.room/` yet: `create_room` with name `Rooms` (or the feature name).
4. Tell the human to run `rooms live` and leave the tab open.

For **other projects**, add MCP:

```json
{
  "mcpServers": {
    "iops-rooms": {
      "command": "npx",
      "args": ["-y", "iops-rooms@0.1.0", "mcp"]
    }
  }
}
```

Pin a version. Never `@latest`. Or point `command`/`args` at a local checkout’s `src/mcp.js`.

## Actively show live (default while working)

Do **not** wait for the human to ask every time. As you work:

1. `post_note` when you start a meaningful chunk (goal in one line).
2. `share_diff` when you change files worth reviewing (path + unified diff or excerpt).
3. `post_note` when you finish, block, or change plan.
4. `request_review` / `approve` when that matches the human’s process.

Keep notes short. Branch is stamped automatically from git (or `ROOMS_BRANCH`).

## Tools

| Tool | When |
|---|---|
| `create_room` / `join_room` | First touch / match code |
| `rename_room` | Display title only (code unchanged) |
| `post_note` | Progress, decisions, blockers |
| `share_diff` | File changes for the board |
| `request_review` / `approve` | Audit trail |
| `read_transcript` / `wait_for_peer` | Catch up / wait |

## Human companion commands

```bash
rooms live          # leave open — auto-updates on 127.0.0.1
rooms status
rooms branches
rooms rename Rooms
```
