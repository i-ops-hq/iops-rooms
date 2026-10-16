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

Org room projection: `rollup/org.json` (`kind: org_rollup`) — per-team floors and package-name hits only.

Share metadata on the team hub: `shares/<id>.json` (`kind: share_meta`) — who, type, ref, optional pointer/issue/note. Never ciphertext contents inside the JSON (optional age blobs live under `shares/blobs/`).

Episode view (`rooms episode`): join of `session` + `edit` + overlapping `package` + linked `commit` rows for one agent session. Local only; not a hub projection.

Team package surface (`rooms team packages`): join of hub `package_rollup` files across members — names/versions and member counts only.

Setup catalog (`rooms setup catalog`): allowlisted fields from each `setups/.../setup.json` — never file bodies.
