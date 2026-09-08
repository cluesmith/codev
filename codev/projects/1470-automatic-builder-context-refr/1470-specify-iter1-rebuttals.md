# Rebuttal — Spec 1470, Specify iteration 1

Both reviewers returned REQUEST_CHANGES. **I accepted every point.** There is nothing in this
rebuttal I am declining to change; where my original text was wrong I say so plainly rather
than defending it.

Claude's review verified its claims against the tree instead of reading my prose, and that is
how it found the one hard factual error. I re-verified each of its load-bearing claims myself
before acting on them (summaries are evidence, not ground truth) — all confirmed.

---

## Claude #1 — `--delay` "not persisted" is false *(accepted; my error)*

**The claim**: my Constraint stated that `afx send --delay` is dropped on Tower restart. I
sourced that from the CLI help string and `/arch-save`'s skill text. Both are stale.

**Verified independently before acting.** `packages/codev/src/agent-farm/servers/delayed-send.ts`
states it in its own header: a plain `--delay` *"keeps no timer at all and survives a Tower
restart by construction"*, because `handleDelayedSend` persists the message **body** to the
durable mailbox at *request* time with a `not_before` due time, and the gated backstop drainer
delivers it. Only the delayed-`--interrupt` Ctrl+C nudge is dropped at shutdown. The header
names this the conscious reversal of Spec 1307's original body-drop-on-restart trade.

My spec was not merely inaccurate — it was inaccurate in the direction that would have made the
plan build compensation for a solved problem.

**Changed**: Current State gains a subsection stating what `--delay` actually does. The
Constraint is replaced (delivery is mailbox-first and gate-checked; the design must work *with*
the gate). The Assumption is now marked verified. The Risk row is rewritten. A new success
criterion requires the re-entry to survive a Tower restart, with test 34. The stale help text
and skill text are now an in-scope incidental fix with its own criterion.

**And the consequence Claude pointed at**: the render gate probably answers my own biggest open
question, since it delivers only onto a prompt proven empty and holds otherwise. I took this
but did not overclaim it — see Claude #4.

## Claude #2 — "the protocol schema validates the key" isn't free *(accepted; my error)*

**Verified**: `loadProtocol` is `JSON.parse` plus a hand-rolled `normalizeProtocol` that checks
only `name` and `phases`. No ajv, no zod. `protocol-schema.json` is editor tooling via `$schema`
and validates nothing at run time. There are **three** copies, not two:
`codev/protocols/`, `codev-skeleton/protocols/`, `codev-skeleton/`.

Claude is right about the consequence: left as written, a builder would edit the schema file,
assume it did the work, and ship a boundary that can be declared but never fires.

**Changed**: the criterion now says porch must *reject* an invalid boundary at protocol load and
states explicitly that this is new validation logic, not a schema edit. Current State says the
same. All three schema copies are named in the parity criterion. Test 7 covers rejection, test 8
covers no regression to existing protocols. A risk row covers the silently-dead-boundary failure.

**Bonus found while verifying**: `codev/protocols/spir/protocol.json` declares
`"$schema": "../../protocol-schema.json"`, which resolves to a file that does not exist (the real
one is one level up). Pre-existing and harmless; listed as nice-to-know.

## Claude #3 / Codex #6 — ASPIR inconsistency *(accepted)*

Both reviewers caught the same incoherence: my Problem Statement named "SPIR and ASPIR most
acutely" and then my criteria configured only SPIR, demoting ASPIR to a nice-to-know.

Claude's argument settles it: ASPIR has the identical phase shape (verified — `specify`, `plan`,
`implement` per-plan-phase, `review`, `verify`) and runs **without** the spec/plan human gates.
It is therefore *the* unattended case, which is the exact case Baked Decision 4 exists for.
Shipping the safety feature for the supervised protocol while excluding the unsupervised one is
backwards.

**Changed**: ASPIR is in scope with the same four boundaries. Desired State has an explicit
protocol table naming who opts in and who declares none, with reasons. Test 6 covers ASPIR's
gate-free transitions. Adding any other protocol later is a config line with no code change,
which is now stated as a design property.

## Claude #4 — the "harmless" claim hides the real failure ordering *(accepted; the sharpest point)*

I wrote that a clear failing after a successful schedule is harmless. True, but it is the benign
direction. The damaging one is the reverse: re-entry consumed *before* the clear takes effect,
then destroyed by it → an idle builder, empty context, no instruction, nobody watching. My tests
34/35 (now 32/33) framed message *contents*, not the race.

**Changed**: Approach 1 now names both directions and marks the damaging one explicitly. The
render gate mitigates it — a busy terminal holds rather than delivers — but I deliberately did
**not** claim it eliminates it. The gate covers the window before turn-end; whether a queued
`/clear` can consume a re-entry delivered just *after* turn-end is an empirical property of the
harness, not something the code lets me assert. So it is now: the top risk row, an Important open
question requiring the delay value to come from live measurement rather than inheriting
`/arch-save`'s architect-tuned 15s, and live acceptance test 37.

## Claude #5 / Codex #4 — no stall detection; the acceptance test doesn't test the feature *(accepted)*

Both reviewers converged here, and Codex put it best: the fake-terminal tests do not validate the
feature's central unproven behavior. Claude added the sharper framing — my mitigation for "re-entry
never arrives" was *a human types one command*, in a feature whose entire premise is that no human
is watching.

**Changed**, taking Codex's "require a real end-to-end test **or** define it as best-effort" as
*both*, since the two are complementary rather than alternatives:
- Live demonstration on a real builder at a real boundary is a success criterion, with evidence
  recorded in the review (test 37), plus a live *negative* test that a failed receipt gate leaves
  the context intact (test 38).
- Re-entry is defined as best-effort with observable recovery: `porch status` surfaces a refresh
  emitted but never completed (promoted from nice-to-know to a requirement), `.builder-reorient.md`
  is on disk before the clear, and recovery is one documented command.

An Important open question now asks where the in-flight marker lives, since that choice changes
what porch stores.

## Codex #1 — failure semantics are undefined *(accepted)*

Correct, and the tension Codex identified is real: porch records the boundary at emission, before
the refresh succeeds, while only porch may write `status.yaml` — so how is completion represented?

**Answer, now a dedicated subsection of Desired State**: it isn't, and it doesn't need to be.

- The boundary is consumed at emission, in the same state write that emits the task.
- Consumed means consumed — at most once, whatever the outcome. No retry.
- The builder-side command never writes `status.yaml`, so there is no completion signal to model
  and no way for a failed refresh to corrupt protocol state.
- The refresh task never blocks the phase's normal work: on any outcome, the next `porch next`
  sees the boundary recorded and returns normal tasks. A failure costs one missed refresh, which
  costs context and nothing else.

Tests 12 and 13 pin no-retry and non-blocking. This resolves Codex's "permanently skipped,
retried, or blocks?" as: permanently skipped, never blocks.

## Codex #2 — coincident boundaries *(accepted)*

Entering `implement` *is* entering the first plan phase, so my boundary set would have cleared
twice in a row.

**Changed**, and I preferred a definitional fix over a dedup special case: the per-plan-phase
boundary fires on **advance between** plan phases, which excludes the first by construction.
Nothing has to detect and suppress a collision because none can occur. Boundary identifiers are
derived from the actual transition so the record cannot drift from the event. Test 4 asserts no
refresh on entering the first plan phase; a criterion states two refresh tasks never fire back to
back.

## Codex #3 — cold-review goal conflicts with the save request *(accepted, with a finding)*

Codex is right that a "complete cold-reader narrative" would restore exactly the implementation
intent the review refresh is meant to remove.

**A finding that softens the fix**: I read `buildSaveRequest`, and it already asks for *pointers* —
receipts with file paths and commit hashes, standing orders, position in the protocol, next
concrete action. It does not ask for a defense of the work. So the conflict is narrower than it
looks and needs one added constraint, not a separate save path.

**Changed**: the review boundary's save carries no self-assessment, no defense, and no narrative
of how the code came to be; deviations from plan, flaky tests and deferred work — the facts a cold
reader cannot recover from the diff — are exactly what it *should* carry. "Pointers, not
persuasion." This is a criterion, and Current State notes the request's existing orientation.

On whether `.builder-state.md` is read at re-entry and how it meets the 1000-byte gate: the
re-orientation points at it, as for every other boundary; suppressing it would throw away the
flaky-test knowledge that is the whole point. The size question is Codex #3's other half and
merges with Claude #6 below.

## Codex #5 — self-target authorization *(accepted; satisfiable by construction)*

**Verified**: `detectCurrentBuilderId` derives identity from cwd, resolves it against the shared
`global.db` scoped to this workspace, and **throws** rather than falling back — the #1094
anti-spoofing path, built precisely because a silent bare-name fallback once misrouted builder
messages to main.

So Codex's requirement is met by taking it further than asked: the command accepts **no target
argument at all**. There is nothing to pass, so there is nothing to point at another session.

**Changed**: a criterion states the command takes no target and refuses rather than guessing;
tests 25–27 cover it, including proof that builder A cannot clear builder B or an architect.

## Claude #6 — min-size tension, back the reading with eyes open *(accepted)*

Claude confirmed my reading (keep the gate per BD4) but added the calibration point I had missed:
1000 bytes was tuned on a *mid-phase* manual reset — the reference save ran 203 lines — not on a
clean boundary where in-flight nuance is near zero by design. So the number is being inherited
from a different situation than the one it will now govern, and the pressure to pad a save to pass
it is a failure mode I had already listed without connecting it to the cause.

**Changed**: the Open Question now carries the calibration mismatch explicitly and instructs the
plan to decide the number deliberately rather than inherit it silently. The risk row names padding
and points at the re-decision.

## Claude, minor — `afx reset` vs `afx refresh`

The Baked Decisions quote `afx reset`; #1489 renamed it. I keep the quotation verbatim (it is the
architect's fixed text and altering it would misrepresent the record) and added a note that the
decisions predate the rename and that the rest of the spec and the plan use `afx refresh`.

---

## Net

11 distinct points, 11 accepted, 0 declined. Two of my own factual claims were wrong (`--delay`
persistence, runtime schema validation) and both were sourced from documentation rather than code —
which is the lesson, not the incident. Three corrections improved the design rather than merely
patching the text: the durable mailbox plus render gate is a *better* re-entry mechanism than the
best-effort delay I had specified; defining the plan-phase boundary as *advance between* phases
removed a special case instead of adding one; and taking the no-target requirement further than
asked made the misuse unrepresentable rather than merely tested.
