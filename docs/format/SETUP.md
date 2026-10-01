# Setup format 1

A setup is one person's Claude Code setup, as files a teammate can read, review and adopt. It lives
in a team room (see the README), in a folder of its own:

```
setups/<role>/<name>/
├── setup.json                          the manifest, described below
├── README.md                           generated from setup.json; the next export replaces it
└── files/claude-code/
    ├── project/CLAUDE.md               files that go into the adopter's project
    ├── project/.claude/agents/…
    └── user/agents/…                   files that go into the adopter's Claude Code folder
```

`<role>` and `<name>` are lowercase letters, digits and dashes, 40 at most. `rooms setup export`
writes a setup; `rooms setup show` and `rooms setup adopt` read it. Readers read a setup at a git
commit, never from a working tree, and check it with the rules below before showing or adopting
anything: a setup may have been edited in the team room since it was exported.

## setup.json

```json
{
  "format": "iops-rooms/setup",
  "formatVersion": 1,
  "name": "go-claude",
  "role": "backend",
  "owner": "alice",
  "summary": "Claude Code for Go services",
  "cost": { "usdPerMonth": 20, "what": "Claude Pro" },
  "exportedWith": "iops-rooms@0.7.0",
  "tools": {
    "claude-code": {
      "checkedAgainst": "Claude Code 2.1.277",
      "files": [
        { "kind": "instructions", "path": "files/claude-code/project/CLAUDE.md", "installTo": "project:CLAUDE.md", "sha256": "…" }
      ],
      "project": {
        "settings": {
          "permissions": { "allow": ["Bash(go test *)"], "deny": ["Read(./.env)"] },
          "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "uvx --offline assurance@0.1.11 audit --hook" }] }] },
          "env": { "API_TOKEN": { "fromEnv": "API_TOKEN" } },
          "model": "sonnet"
        },
        "mcpServers": {
          "issues": { "command": "npx", "args": ["-y", "@example/issues-mcp@1.4.2"], "env": { "ISSUES_API_TOKEN": { "fromEnv": "ISSUES_API_TOKEN" } } },
          "docs": { "type": "http", "url": "https://docs.example.com/mcp", "headers": { "Authorization": { "fromEnv": "DOCS_TOKEN", "prefix": "Bearer " } } }
        }
      },
      "user": { "settings": { }, "mcpServers": { } }
    }
  },
  "runs": [ … ],
  "requires": [ … ],
  "notExported": [ { "what": ".claude/settings.json statusLine", "why": "runs a command; not in this version's setups" } ]
}
```

| field | |
|---|---|
| `format`, `formatVersion` | always `"iops-rooms/setup"` and an integer. A reader refuses a newer `formatVersion` by name ("update Rooms"), and ignores top-level fields it does not know; an export keeps them from the last revision |
| `role`, `name` | must match the folder the setup is filed in |
| `owner` | the exporter's GitHub login, as Rooms has it linked. Export will not replace another owner's setup without `--force`; the pull request shows that |
| `summary` | optional, 300 characters at most |
| `cost` | optional: what the owner says the setup costs, in US dollars a month, and for what. Shown as declared, never measured |
| `exportedWith` | the Rooms that wrote it |
| `tools` | `claude-code` only, in format 1. A reader refuses a setup holding a tool it cannot read |
| `runs`, `requires` | derived from the rest, never written by hand. A reader derives both again and refuses a setup whose lists differ |
| `notExported` | what the owner's export left out of the files they chose, and why. Never a value |

### Files

Each entry is `{ kind, path, installTo, sha256 }`, with `executable: true` for a file that runs as a
program. `installTo` is a scope and a path: `project:` is relative to the adopter's project, and
`user:` to their Claude Code folder (`~/.claude`, or `CLAUDE_CONFIG_DIR` when set). `path` is always
`files/claude-code/<scope>/<path in installTo>`, so the two cannot disagree. `sha256` is of the
file's text with CRLF line ends read as LF, so checkouts on any system agree.

A file may go only to these places, and only as its kind:

| kind | `project:` | `user:` |
|---|---|---|
| `instructions` | `CLAUDE.md`, `.claude/CLAUDE.md` | `CLAUDE.md` |
| `rule` | `.claude/rules/**/*.md` | `rules/**/*.md` |
| `agent` | `.claude/agents/**/*.md` | `agents/**/*.md` |
| `command` | `.claude/commands/**/*.md` | `commands/**/*.md` |
| `skill` | `.claude/skills/<skill>/**` | `skills/<skill>/**` |
| `script` | `.claude/hooks/**` | `hooks/**` |

Every name on the way must be one every system can hold: not `.` or `..`, not `.git`, no `\ : * ? "
< > |` or control character, not ending in a dot or a space, not a name Windows reserves (`CON`,
`NUL`, `COM1`…), 120 characters at most.

### Settings

`project.settings` merge into the adopter's `.claude/settings.local.json`, never the shared
`.claude/settings.json`; `user.settings` into their `~/.claude/settings.json`, only with `--user`.
They may hold only:

- `permissions`: `allow`, `ask` and `deny` lists of rules, and a `defaultMode` of `default`,
  `manual`, `acceptEdits`, `plan` or `dontAsk`. Never `bypassPermissions` or `auto`, and no `allow`
  rule that lets any command run: `Bash`, `Bash(*)`, a rule starting with a wildcard, or one that
  hands a shell or an interpreter any arguments, such as `Bash(sh -c *)` or `Bash(node *)`. No rule
  naming an absolute path (`//…`).
- `hooks`: per event, groups of `{ matcher?, hooks }`, each hook `{ type: "command", command,
  args?, timeout?, statusMessage?, async?, shell?, if?, once? }`. Command hooks only.
- `env`: the names of variables the setup relied on, as `{ "fromEnv": "<NAME>" }`. Adopting writes
  none of them; each person sets their own.
- `model`: a model name.

### MCP servers

`project.mcpServers` merge into the adopter's `.mcp.json`; a server they already have by the same
name is kept as theirs. `user.mcpServers` are never written, because `~/.claude.json` also holds the
account: adopt prints a `claude mcp add-json … --scope user` line for each.

A local server is `{ type?: "stdio", command, args?, env? }`. A remote one is `{ type: "http" |
"sse" | "ws", url, headers? }`, whose address carries no login and no parameter that reads like a
credential. Every `env` value is `{ "fromEnv": "<NAME>" }` and every header `{ "fromEnv": "<NAME>",
"prefix"?: "Bearer " | "Basic " | "Token " }`; adopting writes `${NAME}`, which Claude Code fills from
the adopter's environment.

### Paths and placeholders

The exporter's project becomes `${PROJECT}` and their home `${HOME}`, in hook commands and server
commands and arguments; any other absolute path is refused, except under `/dev` and `/tmp`, which
name no one. A setting for every project may not name `${PROJECT}`. Adopting puts the adopter's own
paths in their place; in a command a shell will read, with forward slashes, and refused rather than
quoted into someone else's command if the path holds a character a shell would split.

### What runs

`runs` lists everything the setup would run on an adopter's machine, in a fixed order:

| `surface` | fields | what it is |
|---|---|---|
| `hook` | `event`, `matcher?`, `command`, `pinned?` | a command hook |
| `mcp` | `name`, and `command` and `pinned?`, or `url` | an MCP server |
| `loads` | `file`, `command`, `pinned?` | a shell command an agent, command or skill runs as it loads (`` !`…` `` or a ```` ```! ```` block) |
| `script` | `file` | a hook script, or a skill file that runs as a program |

Every entry also has `tool` and `scope`. `pinned` names the exact packages a command fetches. Any
package a command runs through `npx`, `bunx`, `pnpx`, `pnpm dlx`, `uvx`, `uv tool run`, `go run` or
`docker run` must name one exact version, or an image digest, wherever it stands in the command
(`sudo npx pkg` is checked like `npx pkg`); `@latest`, ranges and tags are refused.

`requires` lists `{ env, for }` for each variable an adopter sets, and `{ program, for }` for each
program a command needs on their PATH.

### Files that act

An agent, command or skill (its `SKILL.md`) is refused if its frontmatter defines `hooks` or
`mcpServers`, sets `permissionMode` to `bypassPermissions` or `auto`, or pre-approves a rule in
`allowed-tools` that lets any command run; if it runs a command as it loads that names no exact
version or names a path on someone's machine; or if its frontmatter holds one of those keys in a form
Rooms cannot read. Any file is refused if a line looks like a secret: a private key, or a token with
a known prefix from GitHub, Anthropic, OpenAI, AWS, Slack, Stripe, Google or npm, a JSON Web Token,
or `Authorization: Bearer` with a long value. That is a guard, not a guarantee: a secret in a format
nobody listed gets through.

## Adopting

`rooms setup adopt` builds a plan from a checked setup: each file it would write (new, or replacing
the adopter's, with how many lines change), each settings change, what would run and who added it in
which commit, and a digest of exactly that plan. Nothing is written until a person approves it at a
terminal, or passes `--approve <digest>`; `--yes` alone never adopts. Before writing, every file is
checked again, and one that changed since the plan was made stops it. Every file it changes is
copied first to `~/.iops-rooms/backups/<id>/`, with `backup.json` naming each one, its mode, and the
hash of what was written. `rooms setup rollback` puts each back byte for byte and removes what the
adoption created, folders included, or stops if any changed since, unless `--force`, which keeps the
changed versions in the backup's `at-rollback/`.
