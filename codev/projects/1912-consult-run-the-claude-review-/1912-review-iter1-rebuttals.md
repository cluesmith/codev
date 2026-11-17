# Review phase (PR #1913), iteration 1: responses to review

Codex: REQUEST_CHANGES. Claude: APPROVE, with minor notes. Fixed in commit `cfb928df4`.

## Codex: the runtime init guard accepts any subset of Read/Glob/Grep

**Accepted and fixed.** The guard checked only `tools.every(allowed.includes)`, so `[]` or `["Read"]` passed. The plan had specified a subset; the spec says the session's tools are *exactly* Read, Glob and Grep. The guard now:

- fails, as before, on any tool outside the three ("refusing a review with write or shell tools");
- fails on a missing tool, naming it ("refusing a review without Grep"), or on a repeated tool ("without each tool exactly once");
- quotes the reported list and says `expected exactly Read, Glob, Grep`.

New regression cases in `claude-cli-lane.test.ts`, each asserting that the child is killed, no `--output` is written and an exit-1 metrics row is recorded:

- one tool missing
- an empty list
- a repeat in place of a tool
- a repeat on top of all three

Every existing fixture and harness stream already reports exactly the three tools. `consult.md`, in both trees, now says the session's tool list is checked and must be exactly those three.

## Claude's notes

1. **A success result with no assistant text writes an empty `--output`.** Accepted for the claude lane. It now fails with "claude reported a successful review but wrote no review text, so there is no VERDICT", and a test covers it. The codex lane has the same shape and is left unchanged, since it is outside this spec.
2. **Untracked artifacts.** The two `.review-*.stderr` files were mine: I had redirected consult's stderr into the project dir. That also set off the #1649 tripwire on both lanes. They were moved out of the worktree, and the lesson is routed to the cold tier. `1912-phase_1-iter2-context.md` is porch's iteration scratch and stays unstaged by standing order.
3. **Parsing of the empty `--setting-sources ""` value was verified only at 2.1.326.** Accepted. The `buildClaudeReviewArgs` comment now says that flag *presence* is what was checked at 2.1.105, and that this exact argv ran live only on 2.1.326.
4. **Scenario 33 not run.** Already disclosed. The owner's standing order bars the local e2e suite.

Verification: `tsc --noEmit` is clean. The touched suites (`claude-cli-lane`, `consult`, `lane-models`, `tripwire-wiring`, `bugfix-1754-dotenv-auth`) pass: 5 files, 149 tests.
