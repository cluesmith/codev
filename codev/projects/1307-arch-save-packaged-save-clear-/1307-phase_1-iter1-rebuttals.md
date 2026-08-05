# Phase 1 (`afx send --delay`) — Rebuttals, iteration 1

Both reviewers returned `REQUEST_CHANGES` (HIGH confidence). **All findings accepted and
fixed.** Nothing defended.

They converged on four issues independently — the third round running where independent
convergence has picked out the items that actually mattered.

Fix commit: `413e4261`. Build clean, 4059 tests passing.

---

## 1. Ordering tests asserted against a *copy* of the predicate — both reviewers

**Accepted, and this was the most serious finding in the round.**

`spec-1307-send-delay.test.ts` re-implemented `shouldDefer` inside the test file. So the
tests guarding the one hazard that a manual re-send *cannot* repair — a delayed
`/arch-init` overtaking a buffered `/clear`, after which the clear wipes the recovered
context — would have kept passing if the shipped predicate in `tower-routes.ts` regressed.
A guard bolted to a replica of the thing it guards.

Worse, the plan's own Test Plan called for "a route-level test with the buffer engaged."
I wrote route-level tests for eight *other* behaviours and left the one that mattered as a
local copy.

**Fixed**: two route-level tests exercising the real `handleRequest` and the real
module-level `SendBuffer`, structured so the session is *idle* at delivery and the
earlier message is still queued — which isolates the `hasPending` term specifically rather
than passing via the pre-existing "user is typing" term.

**Verified by mutation.** With `queueAhead` forced to `false`, both new tests fail; the
guard restored, both pass. I ran this because a regression guard that has never been
observed failing is a guess about its own value. The predicate-copy tests are retained
(they document the rule readably) but they are no longer the only thing standing between
the codebase and that inversion.

## 2. Delayed `--interrupt` bypassed FIFO entirely — both reviewers

**Accepted.** `shouldDefer = !interrupt && (...)`, so `--interrupt --delay` wrote directly
and could overtake queued messages — reintroducing the exact inversion through a side
door, in the same function that argues against it at length.

Codex called it a violation of the phase's ordering requirement; Claude judged it a
documented gap, being off the `/arch-save` path. **Codex's reading is the right one.** The
existing justification for interrupts bypassing the buffer — "an interrupt that can be
deferred is not an interrupt" — is sound for an *immediate* interrupt and does not survive
being applied to one already deferred by N seconds.

**Fixed properly rather than documented.** A delayed interrupt now queues, carrying its
Ctrl+C on the message itself (`BufferedMessage.interruptFirst`), written 100ms ahead of
its own payload at flush time. The queue drains in order *and* the interrupt still
interrupts.

I considered refusing `--interrupt` with `--delay` (the way `escape` + `delay` is refused).
Rejected: `afx send X --delay 15 --interrupt "msg"` has a clear, legitimate meaning — "in
15s, interrupt and deliver this" — and removing a capability is not a fix for an ordering
bug. Refusal was the cheap option, not the correct one.

## 3. `--all --delay` reported as "Sent" — both reviewers

**Accepted.** `sendToAll` pushed every target into `results.sent` and printed "Sent to N
builder(s)" even when Tower had merely *scheduled* them — precisely the misreport the
single-target path had been fixed to avoid, one function away.

**Fixed**: `sendToAll` returns `scheduled` alongside `sent` and `failed`, and reports them
separately. Covered by tests for delayed-only, immediate-only, and mixed outcomes.

## 4. `deferred` never surfaced to the CLI — both reviewers

**Accepted.** The route returns `deferred`, `TowerClient.sendMessage` dropped it, and the
plan's deliverable explicitly listed "`deferred`/`scheduled` surfaced in the CLI result."
I implemented half of it.

**Fixed**: `deferred` is threaded through the client and reported — a send buffered because
someone is typing now says so, instead of looking like a completed send.

## 5. Duplicated delay ceiling — Claude

**Accepted.** `cli.ts` hardcoded `3600` and its error string repeated "between 1 and 3600",
while `delayed-send.ts` exported `MAX_DELAY_SECONDS`. Two bounds that can drift, and the
drift is silent until the CLI accepts something Tower rejects.

**Fixed**: the CLI imports `validateDelaySeconds`, so there is one bound and one error
message. Claude's observation that `delayed-send.ts` has zero imports made this free.

## 6. No `--all` + `--delay` coverage — Claude (nit)

**Accepted.** It was the only composition flag in the spec with no test. Added, at the
reporting layer where the actual risk lives (misreporting scheduled as sent).

---

## Note on the review environment

Codex reported it could not execute tests (`EPERM` — Vitest writing its generated config
under a read-only filesystem), so its findings came from source inspection. Worth
recording: every one of its findings was still correct, and it independently found the
same four issues Claude found with a working test run. The environment limitation cost
nothing this round, but a reviewer that cannot run tests cannot catch a test that passes
for the wrong reason — which is exactly finding #1.

## Summary

| # | Finding | Source | Fix |
|---|---|---|---|
| 1 | Ordering tests asserted against a predicate copy | Both | Route-level tests; mutation-verified |
| 2 | Delayed `--interrupt` bypassed FIFO | Both | Queues, carrying its Ctrl+C |
| 3 | `--all --delay` reported as "Sent" | Both | `scheduled` tracked and reported |
| 4 | `deferred` dropped by the client | Both | Threaded through and reported |
| 5 | Duplicated `3600` ceiling | Claude | Imports `validateDelaySeconds` |
| 6 | No `--all --delay` test | Claude | Added |

**What I take from this round.** Findings 1 and 4 are the same mistake in two places: I
wrote the *shape* of what the plan asked for and skipped the part that made it load-bearing
— route-level tests for everything except the hazard, and half of a two-field deliverable.
Both passed a self-review because the artifact existed. Existence is not the criterion;
"would this fail if the thing it protects broke?" is, and it is a question I can ask
myself with a two-minute mutation run.
