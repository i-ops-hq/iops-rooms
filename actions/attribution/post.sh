#!/usr/bin/env bash
#
# Posting the comment, split out of run.sh so it can be tested without a pull request.
#
# **A pull request from a fork cannot be commented on by its own workflow.** GitHub gives a
# `pull_request` run from a fork a read-only token whatever `permissions:` says, so the POST comes
# back 403. Until this file existed that 403 failed the check, on exactly the outside contributions
# whose trailers the action exists to read, and a contributor saw a red cross that said nothing
# about their code. A comment the action was not allowed to post is not a failure of the pull
# request: it says why in a notice, the body is already in the job summary, and it exits 0.
#
# Anything else that goes wrong still fails. A 500, a bad repository name or a missing `gh` is a
# fault somebody should see, and swallowing it would be the silent pass this tool refuses elsewhere.
set -euo pipefail

body="$1"
marker='<!-- iops-rooms-attribution -->'

skip() {
  echo "::notice title=rooms::$1 The attribution is in this run's job summary instead."
  echo "commented=false" >> "$GITHUB_OUTPUT"
  exit 0
}

# Known before any call, so a fork costs no request and no error in the log.
if [ -n "${HEAD_REPO:-}" ] && [ -n "${REPO:-}" ] && [ "$HEAD_REPO" != "$REPO" ]; then
  skip "This pull request comes from a fork ($HEAD_REPO), and GitHub gives its workflow a read-only token, so it cannot be commented on."
fi

# The same refusal from any other cause: a workflow whose `permissions:` leave out
# `pull-requests: write`, or an organisation that defaults tokens to read-only.
write() {
  local out
  if out=$("$@" 2>&1); then
    return 0
  fi
  case "$out" in
    *"HTTP 403"*|*"Resource not accessible"*)
      skip "This token cannot write to the pull request. Grant \`pull-requests: write\` to comment."
      ;;
  esac
  printf '%s\n' "$out" >&2
  exit 1
}

# One comment, updated in place. The marker is an HTML comment in the body, which survives editing
# and is invisible to a reader. Reading is allowed on a read-only token, so a failure here is only
# "no earlier comment found".
existing=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
  --jq "map(select(.body | contains(\"$marker\"))) | .[0].id // empty" 2>/dev/null || true)

if [ -n "$existing" ]; then
  write gh api --method PATCH "repos/$REPO/issues/comments/$existing" -F body=@"$body" --silent
  echo "updated comment $existing"
else
  write gh api --method POST "repos/$REPO/issues/$PR_NUMBER/comments" -F body=@"$body" --silent
  echo "posted a new comment"
fi
echo "commented=true" >> "$GITHUB_OUTPUT"
