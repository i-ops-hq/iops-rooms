# Rooms by I-Ops

Local rooms for agent sessions. Two people (or one person across two tools) share a transcript **on disk**. Terminal + a static HTML board. No account. No model bill. Network off.

Pin a version. Do not run `@latest`.

## Install (from this repo, before npm)

```bash
cd ~/Projects/iops-rooms
node src/cli.js init --name "homework"
node src/cli.js post "starting"
node src/cli.js status
node src/cli.js open
```

Teammate on the same git checkout:

```bash
node src/cli.js join THECODE
```

`--share` keeps `.room/` commitable so the class or feature team shares the board. Default is gitignore.

## Cursor / Claude

This repo already has `.cursor/mcp.json` pointing at `src/mcp.js`. Copy `skills/rooms/SKILL.md` into a user skill dir if you want it globally.

After publish:

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

## Commands

| Command | What |
|---|---|
| `rooms init [--name] [--code] [--share]` | Create `.room/` |
| `rooms join <code>` | Same project, matching code |
| `rooms status` / `whoami` | Paths and actor |
| `rooms open` | Local HTML board |
| `rooms post …` | Note |
| `rooms share-diff --path FILE` | Diff on disk |
| `rooms request-review` / `approve` | Audit |
| `rooms wait` | Poll for a new local event |
| `rooms export [out.md]` | Markdown |
| `rooms mcp` | Stdio MCP |

## Files

```text
.room/room.json
.room/events.jsonl
.room/board.html
```

Board template: `templates/board.html` (I-Ops tokens, no Google Fonts).

## Tests

```bash
npm test
```

## Trust

[SECURITY.md](./SECURITY.md). `src/` is short and has no HTTP client.

## Not this release

Hosted relay, seats, SSO, shipping our own model.
