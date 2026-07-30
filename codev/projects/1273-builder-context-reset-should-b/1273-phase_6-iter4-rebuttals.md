# Rebuttal — Phase 6 (Reset orchestrator + CLI wiring), iteration 4

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

**Accepted.**

---

## Codex — REQUEST_CHANGES

### Issue: "Missing the phase's promised wedged-builder integration coverage for `--interrupt-first`"

**Accepted, and this is a plan commitment I skipped rather than an oversight.** The plan's Test Plan for
this phase says:

> **Integration**: spec scenario 14a — wedged builder → `--interrupt-first` → turn breaks → save request
> read → flow completes. Uses the existing terminal test harness; **skipped-with-annotation only if the
> harness cannot simulate a wedged turn, and called out in the review if so.**

The plan gave me an explicit escape hatch and required me to *declare* it. I did neither — I did not write
the test and did not annotate a skip. Silently dropping the one scenario that models the original incident
is the worst of the three options available.

**It turns out the escape hatch was not needed.** The wedge is observable to reset in exactly two ways: the
builder does not act on messages it has received, and its terminal keeps emitting. Both are expressible
against the injected ports, and the ESC is what flips them. So no harness limitation applied — I had
assumed one without checking, which is the same mistake this phase has now produced four times.

**Changed** — scenario 14a as two tests:

1. **The recovery.** A builder that receives the save request but never reads it, with a terminal that
   never falls silent. With `--interrupt-first`, the ESC precedes the request, the turn ends, the queued
   request processes, the state file appears, quiescence is reached and the flow completes through
   `/clear`.
2. **The control, which is the more important half.** The *same* wedged builder reset *without* the flag:
   the request is never read, the receipt never verifies, and nothing is cleared. Without this, test 1
   proves only that a permissive harness lets the flow through; with it, the flag is demonstrably what
   made the difference.

The control also asserts the abort message names `--interrupt-first`, so an architect who hits the wedge
without the flag learns the recovery exists at the moment they need it — the incident's actual failure was
that this recipe lived only in architect lore.

---

## Gemini — APPROVE · Claude — APPROVE

No issues raised.

---

## Net effect

The scenario that motivated the feature is now covered, with a control proving the mechanism rather than
the harness. Tests 3950 → 3952. Build clean.
