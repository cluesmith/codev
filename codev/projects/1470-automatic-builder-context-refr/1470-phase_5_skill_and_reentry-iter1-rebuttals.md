# Rebuttal — Spec 1470, Phase 5 (skill and re-entry frame) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (3) · Claude REQUEST_CHANGES (5).

**All accepted.** Both reviewers independently found the same top-two problems, and the first is
the one I should be most uncomfortable about: **I never implemented the acceptance criterion I
personally discovered.**

---

## Both reviewers — the re-entry frame did not identify itself as automatic

*(Codex #1; Claude #1, which cited `tower-routes.ts:1537` as the wrapping site)*

The frame scheduled `payload.inline` from the shared assembler, whose heading is only
`## CONTEXT REFRESH — re-orientation`. Tower wraps a self-sent message as
`### [ARCHITECT INSTRUCTION | … ] ###`, so a refreshed builder receives its own re-orientation
looking like an order — and may treat it as a new instruction, or wait for a follow-up that never
comes.

**Why this one stings.** I found the need for this myself, by probe, during the specify phase: I ran
`afx send spir-1470 "<probe>"` from inside this worktree and watched the harness render my own
message as an architect instruction. I wrote acceptance criterion 33 *from that observation*,
documented the reason in the spec's Current State, carried it into the plan's Phase 5 deliverables —
and then implemented the frame using the shared re-orientation verbatim.

Discovering a requirement is not implementing it. The probe felt like the hard part, and apparently
stood in for checking that the code did the thing it taught me to do.

**Fixed**: `buildAutomaticReentryFrame()` prefixes a marker naming the message as a self-initiated
refresh, stating plainly that it is not from the architect, that nobody is waiting on a reply, and
that the next work is whatever `porch next` returns.

**Deliberately on the self path only**, not in `assembleReorientation`: on the driven path the
message genuinely *is* from an architect who typed `afx refresh`, so labelling it automatic there
would be false. The discriminator belongs to the path that is actually automatic.

## Both reviewers — no test over the message actually scheduled

*(Codex #2; Claude #2, naming spec tests 32 and 33 as unpinned for the self path)*

Correct, and I found the same gap independently about ten minutes before the reviews landed, via the
mutation check that is now standing practice:

> Removed the wrapper from the real `scheduleReentry` call. **103 tests passed.**

My new frame tests exercised `buildAutomaticReentryFrame()` in isolation and never asserted that
`runSelfRefresh` *calls* it. That is precisely the wiring gap that produced the copied-binding defect
two phases ago — the function is right, and nothing checks it is used.

**Fixed**: the core test asserts `terminal.scheduled[0].message` carries the marker and still
carries the re-orientation. Verified by re-applying the mutation, watching it fail, restoring, and
confirming green.

## Codex — the skill claimed every refusal leaves the context intact *(accepted)*

All four copies said so. But `clear-failed` means the clear was **attempted** and may have landed —
a distinction Phase 3 built deliberately (`clear-attempted` versus `clear`), and which the command
reports honestly by refusing to say "your context is intact".

My skill flattened that back into blanket reassurance, and told the builder to carry on immediately
in every case. For the ambiguous outcome that is actively wrong advice: a builder whose context may
have just been wiped should not start new work.

**Fixed**: the refusal guidance now has two sections — pre-clear refusals (context intact, report
and continue) and `clear-failed` (genuinely unknown, do not start new work, tell the architect the
outcome is ambiguous, expect the queued re-entry either way).

## Codex — the planned `spec-1470-reentry-frame.test.ts` was absent *(accepted)*

A named Phase 5 deliverable, simply not written. It exists now: 11 tests covering the marker, that
the frame preserves every element of the underlying re-orientation, four-way skill parity,
byte-identity across copies, the deferral (no hand-written invocations in the skill), and a
repo-wide `.claude`/`.codex` pairing guard so a future skill cannot land in one provider directory
only — the failure that made this phase's suite red in the first place.

## Claude — three more, all taken

### `self-refresh-invocation.ts` claimed a parity test that did not exist

The module comment asserted that a parity test guards the skill against a hand-typed invocation.
When written, it did not. It does now, and the comment is corrected to describe what the test
actually does — assert the skill contains **no** hand-written invocation at all, which is stricter
than checking each carries the flag and fails on the first line someone adds rather than on the
first mistake.

Worth naming the pattern: **documentation asserting a guarantee it does not have** is the prose
version of a vacuous test. Both read as evidence that something was checked.

### `'enter:review'` was a bare literal

Uncoupled from `enterBoundary()`, which is what actually produces boundary ids. A change to that
format would have silently deleted the review-boundary save constraint — no error, no failing test,
just a review boundary that quietly stops excluding self-assessment from the save. Since that
exclusion is the entire reason the review boundary is a quality feature and not merely a context
one, a silent loss there is expensive. Now derived from the same function.

### Vestigial imports after the port consolidation

`node:fs` imports in `mailbox-wiring.ts` were left behind. Small, but instructive: collapsing three
copies into one leaves debris at each site, and I had checked the behaviour was right without
checking what had become dead.

---

## Net

1 unimplemented acceptance criterion built, 1 wiring gap closed (found by mutation before the
reviews arrived), 1 dangerous piece of skill guidance corrected across four copies, 1 missing test
file written, 2 accuracy fixes, 1 cleanup. New file at 11 tests; core at 93. Full suite 5175 green.

The lesson I am taking from the criterion-33 miss is narrower and more useful than "be careful":
**a finding I make myself gets less scrutiny than a finding a reviewer hands me.** I verified the
probe, wrote it into three artifacts, and never verified the implementation against it — whereas
every reviewer-reported item in this project has been checked against the code before I acted. The
asymmetry is backwards, since my own findings arrive without a second reader attached.
