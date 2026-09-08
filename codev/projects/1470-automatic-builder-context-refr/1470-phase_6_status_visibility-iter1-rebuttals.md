# Rebuttal — Spec 1470, Phase 6 (stalled-refresh visibility) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (2) · Claude REQUEST_CHANGES (2 + 1 minor).

**All accepted.** One is a design error I argued myself into and defended in a code comment; the
other is a regression I introduced into pre-existing output. Both reviewers independently found that
no test invoked `status()`.

---

## Codex — the stall warning fired on every healthy refresh *(accepted; my error)*

`unacknowledgedRefreshes()` flagged **any** unacknowledged boundary, so `porch status` reported a
stall while a healthy builder was still performing its refresh. A false positive during completely
ordinary operation, on every single refresh.

**The part I got wrong was the reasoning, not just the code.** My comment stated the behaviour was
"deliberately NOT time-based", arguing that a wall-clock threshold "would either fire during a long
healthy build or miss a stall for hours". That is true of the design I had rejected and false of
the one I had built. Two different things:

| Approach | Works? |
|---|---|
| Derive the stall from `updated_at` | **No** — that timestamp does not move during a healthy build |
| Grace period on the **acknowledgment** | **Yes** — the acknowledgment moves exactly when the builder returns |

Having built a reliable event, I then reused the argument against the *other* design to justify
having no threshold at all. Given a reliable event, a grace period is simply the answer to "has
enough time passed that silence is suspicious?" — which is the question, and which the plan asked
for in the words "past a threshold".

**A signal that fires during normal operation is not a signal.** Mine would have taught its reader
to ignore it within a day.

**Fixed**: `stalledRefreshes(state, now, graceMs)` with a ten-minute default — comfortably past the
save, the 15-second delay, the mailbox gate and the builder's next `porch next`, and still far
sooner than anyone would otherwise notice a cleared builder sitting idle.
`unacknowledgedRefreshes()` remains as the raw history fact; the two answer different questions and
`--json` carries both.

Status now has **three** states rather than two — `✓` acknowledged, `…` in flight, `!` stalled — so
a refresh in progress reads as progress. And an unparseable `at` counts as **stalled** rather than
ignored: every `NaN` comparison is false, so a naive filter would silently never warn, and a record
we cannot age is a record we cannot vouch for.

## Claude — I introduced a regression into pre-existing output *(accepted)*

My new `CONTEXT REFRESHES` section closed the `isPhased` block early, nesting the pre-existing
**CURRENT / FROM THE PLAN / CRITICAL RULES** output inside `if (refreshes.length > 0)`. Any project
without refreshes lost all of it — legacy projects, protocols that declare no boundaries, and SPIR
before its first plan-phase advance. Claude confirmed it empirically rather than by reading.

**Fixed**, with two regression tests: the block renders both with and without refreshes present.
Re-introduced the nesting bug to confirm the test fails, then restored.

## Both reviewers — no test invoked `status()` *(accepted)*

Correct, and the fourth instance of this exact gap on this project: the helpers were tested in
isolation, so removing the entire history section, the warning, the recovery line, or the new JSON
fields would have left every test green.

**This one has a sharper lesson than the previous three**, because I had *already* applied the
mutation discipline here and it still missed:

- I wrote status-level tests.
- I ran a mutation check — disabling the acknowledgment in `next()` — and it correctly failed.
- The regression still slipped through, because **my fixture had no plan phases**, so the swallowed
  block was unreachable in the test, and the mutation I chose targeted the *acknowledgment* rather
  than the *rendering I had just edited*.

**The mutation discipline is only as good as the fixture's coverage of what is nearby.** I mutated
the thing I was thinking about rather than the thing I had touched. The correction is to pick the
mutation from the diff, not from the intent: I changed rendering, so the mutation should have been
to rendering.

The fixture now carries plan phases, which is what made the pre-existing block reachable at all.

## Claude, minor — a doc claim that outran the code *(fixed)*

`context-refresh.ts` said status "shows how long it has been", while `index.ts` printed the raw
timestamp. Small, but it is the third time on this project that a comment has asserted a property
the code did not have — after the parity test that did not exist and the "logged before performed"
claim in the step log. Prose is not checked by anything, which is exactly why it drifts.

---

## Net

1 design error corrected (grace period, three display states, NaN handled as stalled), 1 regression
repaired with tests that catch it, 6 status-level tests added, 1 doc claim corrected. Phase file
11 → 23 tests. Full suite 5202 green.

The thing worth carrying into Phase 7 and 8: **I defended the wrong design in a comment, and the
comment made it harder to see.** A justification written into the code reads like evidence the
question was considered — and it was considered, and answered wrongly. When I find myself explaining
why a simpler approach does not apply, that is exactly the moment to check whether I am arguing
against a *different* design than the one I built.
