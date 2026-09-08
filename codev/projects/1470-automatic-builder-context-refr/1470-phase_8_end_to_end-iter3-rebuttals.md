# Rebuttal — Spec 1470, Phase 8 (end-to-end) iteration 3

**Verdicts**: Codex APPROVE (no issues) · Claude APPROVE (2 non-blocking).

Phase 8 converged at iteration 3 without a force-advance. Both non-blocking items accepted; one is
fixed here, the other is routed to the architect because filing it is not a builder's call.

---

## Claude — leftover debug write *(accepted; fixed)*

`fsNode.writeFileSync('/tmp/integ-diag.json', …)` at `spec-1470-integration.test.ts:189`, left over
from diagnosing the `.step` / `.failure?.code` shape bugs.

Mine, and it should not have survived the commit. Removed, and I swept the whole test tree for the
same pattern — no others. A test that writes to `/tmp` as a side effect is not merely untidy: it
makes the suite's behaviour depend on a path outside the repo, which is exactly the kind of thing
that works on one machine and fails in CI.

## Claude — the false-acknowledgment gap should be a GitHub issue *(accepted; architect action)*

> follow-up #9(b) … should be filed as a GitHub issue rather than living only in the review artifact
> — it is unmitigated and undermines Phase 6's stall signal.

Agreed, and the reasoning is right: a follow-up buried in a review artifact is found only by someone
already reading that artifact, which is nobody once the PR merges. This one deserves better than
that, because **it is unmitigated and it silently weakens a signal that ships in this same PR**. The
staleness half at least carries an instruction; this half carries nothing.

Not filing it myself — issue creation on this project has run through the architect (as with #1503),
and inventing my own convention at the last phase is not an improvement. **Flagged to the architect**
with the recommendation that it be filed before merge, so the review artifact can reference the issue
number rather than the reverse.

---

## Net

1 leftover removed, 1 finding routed for filing. Suite green. No force-advance; both reviewers
APPROVE with nothing blocking.

**Closing note on the phase**: Phase 8 took three iterations and two extra live runs, and every
round found something real — an unasserted status, a test that proved only that `enqueue` stores its
argument, a simulation that never drove the thing it was named for, and a live pass that satisfied
two of four clauses in an approved criterion. None of those would have been caught by running the
suite, because in every case the suite was green and wrong.
