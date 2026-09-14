<!--
One change per PR. If this is a good first issue, "Closes #15" plus a sentence is a fine description.
-->

## What this changes, and why

<!-- The "why" survives; name the case that made it necessary. -->

## What you ran

```
$ npm test
```

<!-- Paste the output if it is short. A report of a green test is not a green test. -->

## The counterfactual

<!--
If this adds or changes a test: revert the fix, confirm the test fails, restore it. Say so here and
say which input you used.

Not ceremony. Two tests in the last round passed with their fix reverted, because a different guard
was catching the case — one of them only discriminates once the odd file is moved into the middle of
the series. A test that cannot fail is documentation, which is fine, but it is not a guard.
-->

- [ ] Reverted the fix and watched the test fail, then restored it
- [ ] Added a `CHANGELOG.md` entry, written as what a reader will notice
- [ ] Bumped the patch version if behaviour changed — `test/docs-version.test.js` will then name every file that pins it
- [ ] Ran it against a repository the fixtures do not contain, if this touches attribution

## If this touches what the output says

<!--
Every share this tool prints is a floor, and the sentence saying so travels with it. If you added a
number, say which caveat goes with it and where it appears. A figure that gains its caveat in a
later commit was misleading until then.
-->

## Anything you are unsure about

<!-- Worth more than a confident summary, and it will not hold the PR up. -->
