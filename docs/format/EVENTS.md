# Activity events (format 1)

Local observability log: `.room/agent-activity.jsonl`. One JSON object per line. Append-only.
Rooms stamps `v` and `at` after the writer's fields so callers cannot override them.

| `kind` | Who writes it | Kept fields (besides `v`, `at`) |
|---|---|---|
| `session` | agent hooks / `rooms record session-start\|session-end` | `agent`, `session` (12-hex hash), `source`, `phase` (`start`\|`end`), optional `model`, `version`, `entry` on start |
| `edit` | agent hooks / `rooms record edit` | `agent`, `session`, `source`, `via`, `path` (repo-relative), `checkout` (12-hex) |
| `commit` | git hook via `rooms record commit` | `sha`, `madeIn`, `agentVersion`, `entry`, `model`, `editedBy`, `checkout`, `branch`, `source` |
| `package` | `rooms record packages` | `action` (`seen`\|`upgrade`\|`remove`), `name`, `version`, optional `previous`, `manager`, `source` |

**Never kept:** prompts, file bodies, patch text, tool output, transcripts, env values, absolute home paths.

Team hub projections (`status/…`, `rollups/….agents.json`, `rollups/….packages.json`) are reductions of this log: counts and package names only.
