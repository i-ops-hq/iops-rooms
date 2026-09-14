# Contributing

## The two rules that are not negotiable

**No number may read as more than it is.** Every share this tool prints is a *floor*, because an
agent that writes no `Co-Authored-By` trailer is invisible to it, and the output says so every time.
If you add a figure, add the sentence that makes it true in the same commit — not in a follow-up,
because a report that gains its caveat later was misleading until then.

The cost of getting this wrong is not theoretical. Until 0.5.4 the row `co-author, not a known
agent` sat at 47% on `astral-sh/uv` directly above `no agent recorded`, and it read as *half this
repository is agent-written*. Inside it were the project's own maintainers. The label was true and
the number was not, which is worse than being plainly wrong.

**Attribution comes from the repository, never from a service.** No account, no network call, no
vendor's private state. `git log` is the whole input, and anybody can re-derive the answer by hand.

## Setup

Node 20 or later. There are no runtime dependencies and there will not be any — CI asserts it on
every run, and `npm ls` staying empty is one of the few things a reader can verify in five seconds.

```bash
git clone https://github.com/i-ops-hq/iops-rooms.git
cd iops-rooms
npm install          # dev only; the shipped package depends on nothing
npm test             # 266 tests, about sixteen seconds
```

Run the CLI from the working tree without installing it:

```bash
node src/cli.js week
node src/cli.js week --since 3650d      # point it at any repo you have locally
```

The smoke tests run the real thing end to end, and CI runs both:

```bash
npm run smoke:solo
npm run smoke:two-device
```

### Test it against a repository that has never heard of it

This matters more here than the unit suite does, and it is how most of what has been fixed was
found. `npm test` only covers what the fixtures contain; a stranger's history contains shapes nobody
thought to write down — a hook that leaked `${CLAUDE_PROJECT_DIR}` into a trailer, a release bot
that does not mark itself, five different model strings for one agent.

```bash
git clone --depth 500 https://github.com/astral-sh/uv /tmp/uv
cd /tmp/uv && node ~/path/to/iops-rooms/src/cli.js week --since 3650d
```

Expect most repositories to come back mostly `no agent recorded`. Across six well-known projects,
1.5% of 3,000 commits carried a trailer this could attribute. That is the normal result.

## Adding an agent family

`FAMILIES` in [`src/git-history.js`](src/git-history.js) is the list, and each row matches on a name
pattern **and** an address pattern. Both halves exist because either alone is wrong:

- Matching only the name turns a person called Zaider into a robot. `aider`'s row is anchored
  `^aider\b` for exactly that reason.
- Matching only the address is worse. Read the note in that file before you assume otherwise.

A new row needs a **real trailer you have seen in a real repository**, quoted in the PR. Not the
vendor's documentation — what the tool actually writes, which is often different. A row matching a
trailer nobody emits is a signature that covers nothing, behind a test that proves nothing.

## Check your test's counterfactual

**Revert the fix, confirm the test fails, restore it.** Every round this was applied to found a test
that proved nothing.

Two real examples from this repository, both of which passed before they were rewritten:

- A test for "a folder of two shapes is not a series" put the odd file at the end, where a *range*
  check already rejected it — so deleting the guard the test was named after changed nothing. Moving
  the odd file into the middle made it discriminate: without the guard, the output becomes
  "4 of 4 **days**" for monthly filenames.
- A test asserting only the *names* in a variant list missed a tally that double-counted them.
  Assert the counts.

If you cannot construct an input where the test fails without your change, say so in the docstring
rather than letting it look like a guard.

## Style

Comments explain **why**, and name the case that made the rule necessary. `// increment the counter`
is noise; *"a commit carrying both `Claude` and `Claude Opus 4.7` is one commit, not two"* is the
reason a line cannot be simplified away. Match the density of the file you are in.

Output is prose a person reads. Say what was counted, what it was counted over, and what was not
looked at.

## Opening a pull request

- One change per PR, on a branch off `main`.
- Say what you ran and paste the output if it is short. A report of a green test is not a green
  test — we verify by executing.
- New behaviour needs a test whose counterfactual you have checked. Say in the PR that you did.
- Add a `CHANGELOG.md` entry written as what a reader will notice, not as what you edited.
- Bump the patch version in `package.json` if you changed behaviour. `test/docs-version.test.js`
  will then tell you every other file that pins a version — README, SECURITY.md, the skill files,
  `examples/mcp.json` and `src/mcp.js` all mirror it, and a mirror nothing checks is one that
  drifts.

CI runs the suite on Node 20/22/24 across Ubuntu and Windows on every PR (macOS joins on the nightly
schedule), plus a coverage floor, a no-dependencies assertion, and a job that packs the tarball,
installs it into a clean directory and runs the CLI out of it.

## Good first issues

Issues labelled [`good first issue`](https://github.com/i-ops-hq/iops-rooms/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are scoped so the hard part — deciding what the right behaviour is — is settled in the issue text.
If one is not, say so on the issue; that is useful feedback.

**"I ran this on my own repository and the answer looked wrong" is a first-class issue** and needs
no fix attached. Paste the output and what you expected. That is how the two defects in 0.5.4 were
found.

## Code of conduct

Be decent. Disagree about the work, not about the person. Anything that would make a reasonable
contributor stop wanting to contribute is out of bounds, and maintainers will say so plainly.

The long form is [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1, verbatim,
because a project this small has no business writing its own and a familiar document is easier to
rely on than a bespoke one. Reports go to **hello@i-ops.dev**, which is a private mailbox and not
the security advisory channel.

## Security

Do not open a public issue for a vulnerability. [`SECURITY.md`](SECURITY.md) has the reporting
address and what is in scope.
