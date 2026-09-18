# rooms attribution

Comment the agent mix for a pull request's commits — **and say nothing when there is nothing to
say.**

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }     # it compares a branch against a base
  - uses: i-ops-hq/iops-rooms/actions/attribution@attribution-action-v1.0.0
```

```
**3 of 10 commits on this branch record an agent.**

- Claude — 3 — Claude Opus 5 (2), Claude Opus 4.7 (1)

> "no agent recorded" is not "no agent used". Cursor and Copilot often write no
> Co-Authored-By trailer, so a plain commit only means none was recorded. Every
> share here is a floor.
```

## Most of the design is about who reads it

Everything else this tool prints is read by somebody who just typed a command and can see the caveat
underneath it. **A comment on a pull request is read by people who never ran anything**, did not
choose to see it, and will take a number at face value.

Three rules follow.

**It says nothing when nothing was attributed.** Most pull requests will be that — 1.5% of commits
across six well-known repositories carried a trailer this can attribute. A bot posting "0 agents
found" on every pull request is noise that teaches people to scroll past it, and the one time it
matters they will.

**It prints counts, never a bare percentage.** `3 of 10 commits` is harder to misquote than `30%`,
and the number that gets repeated in a meeting is the one to be careful about.

**The floor note is in the comment, not behind a link.** A reader who has to click to discover that
the share is a floor will not click.

And one comment, edited in place. A new one per push turns a long branch into a wall.

## Inputs

| | |
|---|---|
| `base` | What to compare against. Defaults to the pull request's own base branch. |
| `token` | Needs `pull-requests: write`. Defaults to `github.token`. |
| `comment` | `false` to compute the outputs and post nothing. |
| `version` | Which `iops-rooms` to run. Defaults to the one this action shipped with. |
| `node-version` | Default `22`. |

## Outputs

| | |
|---|---|
| `attributed` | Commits carrying a trailer this could attribute. |
| `seen` | Commits read in the range. |
| `agents` | The agents found, comma separated. Empty when none were. |
| `declared` | Agents the repository declares in committed config. |
| `commented` | `true` when a comment was posted or updated. |

The outputs are filled even when no comment is posted, so you can put the number in a job summary or
a check of your own with `comment: false`.

## What it will not tell you

- **How much of the branch an AI wrote.** It counts commits that *recorded* an agent. Every share is
  a floor, and on most repositories a very low one.
- **Anything about a commit with no trailer.** Cursor and Copilot generally write none, so their
  work is invisible here and the comment says so.
- **Whether the code is any good.** It reads `git log`.

## The version is pinned, not floated

It runs the `iops-rooms` that shipped beside it in the same tag and **refuses to run** if it cannot
work out which. An action that falls back to latest changes what a comment said without anybody
editing a workflow.

Pin to the action's own tag rather than a branch, for the same reason. There is no floating `@v1`.

## Forks

A pull request from a fork gets a read-only token, so the action cannot comment on it. **It notices,
says so in a notice, leaves the attribution in the job summary, and passes.** A contributor does not
get a failed check for something their code did not do. The same happens when a workflow's
`permissions:` leave out `pull-requests: write`.

To comment on forks as well, run it on `pull_request_target`. **Read the GitHub guidance first: that
event runs with your repository's token against someone else's code.**
