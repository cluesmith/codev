# Boundary-save size measurements (Spec 1470, Phase 8)

Phase 3 retained `DEFAULT_MIN_BYTES = 1000` for the automatic path *deliberately* and
promised: "Phase 8 measures real boundary saves to confirm they clear it without padding;
if they cluster at the floor, revisit here with that data."

This is that data. It does not say what Phase 3 expected.

| Sample | Bytes | vs 1000-byte floor | Provenance |
|---|---:|---|---|
| `boundary-save-review-sample.md` | 2952 | **3.0×** — clears easily | **Real.** An actual save for this project at its own `enter:review` boundary, written to the real request text. |
| `boundary-save-terse-sample.md` | 634 | **0.6× — would be REJECTED** | **Constructed.** A plausible small project (one schema phase, no deviations, nothing flaky) at a plan-phase advance. |

## What this shows

Saves do **not** cluster at the floor — they straddle it. A substantial project's boundary
save clears 1000 threefold with no padding, which is what Phase 3 hoped to confirm. But a
genuinely terse save for a small project lands *below* it and would be rejected.

## Why the floor is NOT being lowered

Three reasons, in order of weight.

1. **Baked Decision 4 forbids it.** "Never clear on an unverified save — the auto path must
   be *more* conservative than the manual one." `DEFAULT_MIN_BYTES` is the substance half of
   that gate. Lowering it for the automatic path makes the automatic path *less* conservative
   than the manual one, which inverts the decision. A builder does not get to relitigate a
   Baked Decision because a measurement came out inconvenient.

2. **The failure is safe.** A rejected save means the refresh does not proceed and the
   context is **not** cleared. The builder keeps working with full context — it loses the
   refresh, not its memory. That is the correct direction for this gate to fail in, and it is
   why "reject a real save" is a much cheaper error here than "accept a stub".

3. **The floor self-selects in roughly the right direction.** The projects whose boundary
   saves are small are the projects carrying little context — which are the projects least in
   need of a refresh. A small project's builder is not the one at risk of a context blowout.
   This is a real argument, but it is post-hoc, and it should not be mistaken for the reason:
   reason 1 is the reason.

## What is NOT settled, and is flagged to the architect

The terse sample is **constructed, not observed** — one real data point and one plausible
one is thin evidence for a threshold. The live runs (spec tests 37/38) produce real saves
from a real subject builder; those measurements belong here too, and if they land near or
below the floor the question is the architect's to answer, not a builder's to quietly patch.

The lever that exists if it is ever wanted: `MIN_ALLOWED_MIN_BYTES = 200` already permits an
operator-set floor as low as 200 without a code change. Nothing here needs new machinery —
only a decision.
