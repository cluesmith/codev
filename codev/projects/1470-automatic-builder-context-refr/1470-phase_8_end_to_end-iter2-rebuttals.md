# Rebuttal — Spec 1470, Phase 8 (end-to-end) iteration 2

**Verdicts**: Codex REQUEST_CHANGES (2) · Claude APPROVE (2 non-blocking).

**All four accepted.** One of Claude's "non-blocking" items is the most serious finding of the
project, and I have promoted it accordingly rather than filing it as a nit.

---

## Codex — the simulation never drove the orchestrator *(accepted)*

> It would therefore pass if every emitted refresh failed receipt verification, never scheduled
> re-entry, or never cleared. Phase 8 explicitly requires driving `next()` and the orchestrator
> together with fake ports.

Correct, and checkable against the plan rather than a matter of taste: line 630 says exactly that.
My simulation drove `next()` only — on a refresh task it recorded the emission and asked for work
again. Everything downstream of the emission was unexercised, so the three failure modes Codex lists
would all have passed.

**Fixed** with `spec-1470-integration.test.ts`, which performs the real handshake at every emitted
boundary. The Phase 3 fakes are **extracted and imported** rather than re-declared, so the
integration test cannot drift into asserting against a differently-behaved double.

Mutation-checked against Codex's exact list: never schedule → fails; never clear → fails; accept any
save → fails; drop the byte floor so a stub passes → fails, including the fail-safe arm. None of
these failed before.

### Three defects in that test, all from guessing a shape instead of reading it

Worth recording because they are one habit, not three accidents:

1. `.step` instead of `.name` on the step log — every entry came back `undefined`.
2. `.failure?.code` on a plain **string union** — so the assertion written to surface an abort
   reported "no failure" while the run had aborted at `assembly-failed`. **A diagnostic that lies in
   the reassuring direction** is worse than no diagnostic; it cost the longest detour here.
3. A missing `buildResumeNotice`, without which the assembly gate refuses and every refresh aborts.

(1) and (3) failed loudly. (2) did not — and (1) also revealed that my refusal test passed
*vacuously* on a list of `undefined`s, since `not.toContain('clear')` is satisfied by anything. It
now carries a positive floor.

## Codex — transition coverage under-asserted *(accepted)*

The gated arm checked only `enter:plan`; the ASPIR arm asked for "at least one boundary, no
duplicates" — which passes with `enter:implement`, either plan-phase advance, or the review boundary
missing.

**Fixed**: both arms pin the exact five-boundary set, as the pre-approved arm already did. I had
applied the right standard to one arm and left the others loose.

Doing so exposed a second problem Codex did not mention: **my ASPIR arm pre-approved its artifacts**,
so it took the pre-approval skip — the path the first arm already covers — and never exercised the
no-gate direct advance, which is ASPIR's distinguishing feature and the only reason that arm exists.
Now ungated.

## Claude — the acknowledgment fires before the clear *(accepted; promoted above "non-blocking")*

> a lost re-entry would have left no unacknowledged boundary and `porch status` would have flagged
> nothing — the invisible-stall case the marker exists for.

This is the most serious finding on the project, and Claude found it by reading a timeline rather
than running anything:

```
15:06:40  boundary recorded
15:08:01  acknowledged_at SET     ← a `porch next` inside the window
15:12:01  the clear
```

The refusal-and-escalation round-trip put a `porch next` between emission and clear. So the boundary
read *acknowledged* before it was ever cleared, and a lost re-entry would have produced a healthy
`porch status` over an idle cleared builder — the exact scenario Phase 6 was built to make visible.

What stings is that **Phase 6's own doc comment states the honest reading**: *"no builder has asked
for work since this boundary was recorded."* That is precisely what fails — asking for work *before*
the clear is indistinguishable from asking *after*. I wrote down what the signal means and did not
notice the case where what it means is not what it is being used for. Writing the limitation down
felt like handling it.

**Not fixed here**, and I want to be explicit that this is a judgement rather than an oversight: the
fix belongs with the staleness fix, because they share a root — the `--begin` → execute window is
where the design assumes nothing happens, and **both live runs put real events in it**. Patching the
acknowledgment alone (say, only acknowledging after a recorded clear) would need porch to learn
something it currently cannot observe, which is design work.

Recorded as one follow-up with one root, and flagged as the top item. Stated plainly there:
staleness is mitigated by instruction; **this is not mitigated at all**.

## Claude — the runbook still asserts a disproved constraint *(accepted)*

> the live-run runbook still asserts the subject's porch "cannot emit a refresh task" … and which
> `spec-1470-runbook-accuracy.test.ts:155` now pins.

The second clause is the one that matters. My own test was **enforcing my mistaken framing** — the
false constraint had become a checked invariant. A test that pins its author's error is worse than
no test: it makes the error durable and gives the next reader a reason to trust it.

**Fixed** with an addendum stating plainly that the constraint below it is false, that only the
*installed* porch cannot emit, and that driving `porch.js` by path needs no Tower restart — plus a
corrected test that now requires the distinction *and* the addendum.

Corrected rather than rewritten, deliberately: the original text is what passes 1 and 2 were actually
run against, and a runbook that quietly rewrites its own history is worse than one carrying a visible
correction.

---

## Net

1 integration test closing a real coverage hole, 2 arms pinned, 1 test un-fossilised, 1 finding
promoted to top follow-up. Suite 5289 green.

**The lesson**: three of the four findings this round were places where I had *already written down
the right thing* — the plan said "and the orchestrator", the doc comment said what the acknowledgment
really means, the runbook framing was mine to check — and had then not acted on my own words.
Recording a constraint is not satisfying it, and writing down a limitation is not handling it.
