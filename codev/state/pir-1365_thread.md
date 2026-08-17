# pir-1365 — Serializer convergence (issue #1365)

## Plan phase (2026-08-17)

Read the three write paths end to end before proposing anything, per the architect's
instruction that the issue's "Evaluate first" section governs.

**What I found that changes the framing.** The issue (and the accepted-boundary comment in
`session-submit.ts`) reason about the *fusion* case: a gated delivery landing inside an
interrupt's `^C`→settle→text window. There is a second ordering nobody wrote down: the `^C`
landing inside the **delivery's own** text→Enter window (50–130 ms+). The `^C` clears the
composer, the delivery's Enter fires into nothing, `writeMessagePaced` returns `true`
(the PTY accepted every byte — it only detects #1198 socket drops, not semantic loss), and
`markDelivered` transitions the row. That is silent message loss with a false `delivered`
audit record — the one outcome Spec 1313's architecture exists to exclude.

That, plus the fact that the delayed-interrupt path fires **unattended** (so the "an
operator is standing at this terminal" premise that makes the boundary acceptable does not
hold for it, and #1481 makes that co-occurrence routine), is why the evaluation lands on
**converge** rather than wontfix.

**Design constraint I want the reviewer to weigh.** Taking the per-terminal lock *alone*
would make things worse, not better: a delivery that classified clean and then waits ~150 ms
behind an interrupt would write onto a screen the interrupt just changed. So the gate
verdict must be re-validated **inside** the lock (the same `writable` + `ringToken` pair the
code already checks pre-write, re-run at the write instant). The in-lock precheck is the
fix, not a refinement of it. Correspondingly the lock stays a leaf around the *write* only —
widening it to cover the async classify would queue `--interrupt`, the human's escape hatch,
behind a gate classification.

Verified for deadlock-freedom: lock order is always per-agent → per-terminal (paths A/C
never enter the per-agent serializer), and `PtySession.write()` emits no `'submit'` signal
(only `handleUserInput` does; `'quiescence'` comes off an output timer), so nothing can
re-enter the other lock from inside a lock callback.

Answers to the other two failure questions: the delayed-interrupt reshape leaves **no**
window for the body to land mid-turn (the body can only leave the mailbox through the gate);
escalation/held bookkeeping stays internally consistent but silently diverges from reality
in the Ordering-2 case, with no detector.

Plan written to `codev/plans/1365-serializer-convergence-route-m.md`, committed, awaiting
`plan-approval`. Flagged for #1481: the `^C`→body gap is gate-mediated, not atomic, and a
no-op `^C` is only logged — both are things `--interrupt-after` must design against.

**Standing constraint**: we are not cluesmith/codev maintainers. Never merge the PR; park it
after review and report protocol-complete.
