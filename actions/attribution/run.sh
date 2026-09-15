#!/usr/bin/env bash
#
# The comment.
#
# **The whole difficulty here is the audience.** Everything else this tool prints is read by somebody
# who just typed a command and can see the caveat underneath it. A comment on a pull request is read
# by people who never ran anything, did not choose to see it, and will take a percentage at face
# value — so "6% AI-attributed" landing on a colleague's branch is the misreading 0.5.4 was published
# to remove, arriving somewhere it does more damage.
#
# Three rules follow, and they are why this is longer than posting the number would be:
#
#   1. **It says nothing when nothing was attributed.** Most pull requests will be that, because
#      1.5% of commits across six well-known repositories carried a trailer. A bot commenting "0
#      agents found" on every pull request is noise that teaches people to scroll past it, and the
#      one time it matters they will.
#   2. **The floor travels with the number, in the comment**, not behind a link. A reader who has to
#      click to find out that the share is a floor will not click.
#   3. **One comment, updated.** A new one per push turns a long branch into a wall.
set -euo pipefail

report=$(mktemp)
trap 'rm -f "$report"' EXIT

base="${BASE:-$DEFAULT_BASE}"
if [ -z "$base" ]; then
  echo "::error title=rooms::no base branch to compare against — this action expects a pull_request event, or an explicit base"
  exit 1
fi

# The pinned version has to exist before npx is asked for it. Without this check npx falls through
# to looking for a local `rooms` and the runner reports `sh: 1: rooms: not found`, which explains
# nothing — it happens whenever an action tag carries a version that was never published, and the
# person reading the log has no way to get from that message to that cause.
if ! npm view "iops-rooms@${ROOMS_VERSION}" version >/dev/null 2>&1; then
  echo "::error title=rooms::iops-rooms@${ROOMS_VERSION} is not on the registry. This action is pinned to the version beside it in its own tag; if you are running it from an unreleased ref, pass \`version:\` explicitly."
  exit 1
fi

# `--json` and never the text output. Parsing prose would break the first time a sentence was
# reworded, and the sentences in this tool get reworded because that is most of what it is.
npx --yes "iops-rooms@${ROOMS_VERSION}" branch "origin/$base" --json > "$report" 2> >(tee /dev/stderr)

if [ ! -s "$report" ]; then
  echo "::error title=rooms::no output from rooms — this is a failure of the tool, not a finding about the branch"
  exit 1
fi

body=$(mktemp)
trap 'rm -f "$report" "$body"' EXIT

python3 - "$report" "$body" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)


def out(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
        handle.write(f"{name}={value}\n")


if data.get("ok") is False:
    # A refusal is a refusal, not a finding. Nothing to say and nothing wrong.
    print(f"rooms declined: {data.get('reason')}")
    for name in ("attributed", "seen"):
        out(name, 0)
    out("agents", "")
    out("declared", "")
    out("commented", "false")
    sys.exit(0)

attributed = int(data.get("attributed") or 0)
seen = int(data.get("commits", {}).get("seen") or 0)
declared = [a["label"] for a in ((data.get("declared") or {}).get("agents") or [])]
agents = [r for r in data.get("rows", []) if r.get("commits") and r["id"] not in
          ("unrecorded", "coauthor", "coauthor-bot")]

out("attributed", attributed)
out("seen", seen)
out("agents", ",".join(r["label"] for r in agents))
out("declared", ",".join(declared))

# Rule 1. Most pull requests attribute nothing, and a comment saying so every time is noise that
# trains people to scroll past the one that matters.
if attributed == 0:
    print(f"nothing attributed across {seen} commits — saying nothing")
    out("commented", "false")
    sys.exit(0)

lines = [
    "<!-- iops-rooms-attribution -->",
    f"**{attributed} of {seen} commits on this branch record an agent.**",
    "",
]
for row in agents:
    models = row.get("models") or []
    detail = ""
    if len(models) > 1:
        detail = " — " + ", ".join(f"{m['label']} ({m['commits']})" for m in models[:4])
    lines.append(f"- {row['label']} — {row['commits']}{detail}")

if data.get("multiAgentCommits"):
    n = data["multiAgentCommits"]
    lines += [
        "",
        f"{n} commit{'s' if n != 1 else ''} record{'' if n != 1 else 's'} more than one agent, so "
        "these counts overlap.",
    ]

# Rule 2. The floor travels with the number, in the comment. A reader who has to follow a link to
# learn that the share is a floor will not follow it.
lines += ["", f"> {data['floor']}"]

if declared:
    lines += [
        "",
        f"> This repository declares {', '.join(declared)} in committed config. "
        "A config file says a tool was set up here, never that it was used.",
    ]

lines += ["", "<sub>from `Co-Authored-By` trailers only, by "
          "[iops-rooms](https://github.com/i-ops-hq/iops-rooms)</sub>"]

with open(sys.argv[2], "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
out("commented", "pending")
print("\n".join(lines))
PY

# Written to the job summary either way, because it costs nothing and it is the one place this can
# be read without a token or a pull request.
if [ -s "$body" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$body" >> "$GITHUB_STEP_SUMMARY"
fi

if [ ! -s "$body" ] || [ "${POST_COMMENT}" != "true" ] || [ -z "${PR_NUMBER:-}" ]; then
  [ -s "$body" ] && echo "commented=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Rule 3. One comment, updated in place. The marker is an HTML comment in the body, which survives
# editing and is invisible to a reader.
existing=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
  --jq 'map(select(.body | contains("<!-- iops-rooms-attribution -->"))) | .[0].id // empty' 2>/dev/null || true)

if [ -n "$existing" ]; then
  gh api --method PATCH "repos/$REPO/issues/comments/$existing" -F body=@"$body" --silent
  echo "updated comment $existing"
else
  gh api --method POST "repos/$REPO/issues/$PR_NUMBER/comments" -F body=@"$body" --silent
  echo "posted a new comment"
fi
echo "commented=true" >> "$GITHUB_OUTPUT"
