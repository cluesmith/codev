# Rebuttal — Spec 1470, Phase 4 (afx self-refresh command) iteration 3

**Verdicts**: Codex REQUEST_CHANGES (2) · Claude COMMENT (0 blocking, 4 notes).

**All accepted.** Both reviewers independently identified the same defect in my regression test, and
it is the one finding in this project where I had explicitly *argued* for the mistake in a comment.

---

## Both reviewers — the regression test pinned a COPY, not the code

*(Codex #1; Claude, calling the stated rationale backwards)*

`spec-1470-real-worktree-context.test.ts` re-declared the `listDirs` binding inside the test file
rather than importing the production one. Codex states the consequence exactly:

> Reverting the production binding to `() => []` would leave every test green.

So the test created to pin the `listDirs` defect **could not observe that defect returning.**

What makes this worse than the six earlier vacuous tests: I wrote a comment defending it —
*"copied deliberately rather than imported: a test that imported whatever the command happens to use
would have accepted the stub as correct."* That reasoning is inverted. The purpose of a regression
test is to detect divergence between what the code does and what it should do; copying the expected
behaviour into the test guarantees the two can never disagree. Claude put it plainly, and it is
right.

The earlier six were oversights. This one was a **reasoned** mistake, which is harder to catch,
because a justification in a comment reads like evidence that the question was considered. It was
considered and answered wrongly. **Reasoning about why a shortcut is safe is not the same as
checking whether it is.**

**Fixed**: `buildContextFsPort()` is exported from `self-refresh.ts` and imported by the test. A
re-stub now fails, which is the only property that makes it a regression test at all. The comment
explaining the old choice has been replaced with one explaining why it was wrong, so the next reader
does not re-derive it.

## Codex 2 — `--dry-run` under-reported what would happen *(accepted)*

The Phase 4 deliverable says dry-run "prints what would be verified, written and sent". It printed
the inline frame only — omitting the `.builder-reorient.md` write, the delayed re-entry, the
`/clear`, and the challenge delete.

The failure mode is specific: **a rehearsal that shows one of four actions invites the reader to
assume the other three do not exist.** Someone checking "what will this do to my builder?" would
have come away with an incomplete answer that looked complete.

**Fixed**: every side effect is listed, plus the long-form content that would be written.

## Claude — four notes, all taken

### 1. The registry row's worktree was never compared to the actual cwd

`detectCurrentBuilderId` falls back to a tail-segment match for legacy rows, so a row whose
`worktree` points elsewhere can still resolve. Every path below is built from `builder.worktree` —
challenge, state file, re-orientation — so a mismatch would read and write in a **different tree**
and then abort with "state file missing". That message sends the reader to look for a save they
*did* write, in a place nobody looked.

**Fixed** with a named refusal that states both paths.

**Implementing it exposed a second problem in my own tests**: the check fired on all 24 command
tests, because the fixtures used a fake worktree path while `process.cwd()` was the real vitest
directory. The fixtures had never simulated running inside a builder worktree — the very context the
command only ever runs in. I fixed the fixtures rather than relaxing the check: the check is
correct, and the fixture was lying about where it ran.

### 2. `getConfig().workspaceRoot` resolves to the worktree here *(comment added)*

Correct, and correct *for its three remaining uses* — worktree-local config, prompt templates, forge
config all genuinely want worktree-local files. Given that a production-fatal defect already came
out of this exact ambiguity, Claude is right that it should be stated rather than re-derived by
whoever reads it next. The registry lookup's deliberate use of `workspace` instead is named in the
same comment.

### 3. `--begin --dry-run` printed a usable-looking nonce *(fixed)*

The rehearsal printed a full save request containing a nonce marker for a challenge that was never
written. Anyone following it would write a state file against a nonce no challenge carries, and
execute would refuse it as `wrong-nonce` — a confusing failure two steps removed from its cause. Now
warned explicitly as illustrative.

### 4. `accepts the no-argument form` asserted weakly *(fixed)*

It checked only that no exit-1 occurred, which would also pass if the harness never rejected
anything. Now carries a **positive control**: it first asserts a positional *is* rejected by the same
harness, so "accepted" cannot pass vacuously. This is the rule from iteration 2 applied to its own
neighbourhood — a negative or permissive assertion needs a control proving the setup can produce the
other outcome.

---

## Net

1 regression test made real, 1 dry-run report completed, 1 named refusal added, 1 test fixture
corrected to simulate its own premise, 2 clarity fixes. Command tests 48 → 49, plus the real-layout
file at 6. Full suite 5147 green.

Phase 4 across three rounds has produced **eight findings**, and the tally by category is the useful
part: two wrong port bindings, one lookup scoped to the wrong workspace, two instructions that
dropped a required flag, one parser accepting arguments it ignored, one Tower response half-checked,
and one regression test that could not observe its regression.

Not one was a logic error inside a function. Every one was a mismatch between the code and something
*around* it — its caller, its configuration, its instructions, its runtime, or its own test. That is
the shape of this phase, and the reason the Phase 8 preflight matters more than any additional unit
test I could write.
