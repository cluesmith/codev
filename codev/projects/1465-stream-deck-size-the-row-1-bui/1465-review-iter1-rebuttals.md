# Rebuttal — 3-way consultation, iteration 1 (PIR #1465)

Verdicts: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude REQUEST_CHANGES**.

All three REQUEST_CHANGES findings were real (two overlapped across Codex and Claude),
all were documentation/coverage issues around an otherwise-approved core fix, and all
are **accepted and fixed** on-branch (commit `39da9eee5`). No point is disputed.

PIR runs the consultation once (`max_iterations: 1`), so these fixes are not
independently re-reviewed — they are surfaced to the human at the `pr` gate for
verification, and recorded in the review file's "3-Way Consultation — Verdicts &
Dispositions" section.

## 1. Stale README caveat describing the old fixed-4 window as current — FIXED
Raised by Codex (`README.md:184-187`) and Claude (`README.md:182-187`).

The Open Architect Terminal bullet still carried a "Placement caveat" stating Row 1
"is a fixed page of four … hides every fourth builder past a three-builder fleet" and
deferred self-sizing to "#1465" as future work. That is a verbatim description of the
bug this PR fixes, and it contradicted the new recommended layout earlier in the same
file (which places a Main-mode Open Architect key in Row 1 slot 1). This is exactly the
fixed-4 text #1463 shipped for *this* issue to remove; I missed it in the first pass.

**Fix**: rewrote the caveat — the Main-mode key is selection-independent, and because
the Row-1 window now sizes itself to the placed Builder Action keys (#1465), giving a
Row 1 key to it leaves a correctly-sized three-wide builder window with no hidden
builders; pointed at the recommended layout (Row 1 slot 1). No "#1465 is future work".

## 2. Manifest tooltip still instructs setting the retired slot field — FIXED
Raised by Claude (`manifest.json:133`).

The Builder Action `Tooltip` read "Live tile for the Nth builder (**set the slot in the
property inspector**)". The PI Slot control was removed in this PR, so the tooltip — which
is user-visible in the Stream Deck app's action list, and was not in the PR's original
file list — pointed at a field that no longer exists. A reviewer at the hardware session
would go looking for it.

**Fix**: tooltip now says the slot is where you place the key (selectors self-order left
to right, top row first).

## 3. Missing positional-order test — FIXED
Raised by Codex and Claude.

The plan listed a case for keys given `(row, column)` out of placement order; every
fixture used `row 0` with ascending columns, so the comparator's row term and its
out-of-arrival-order behaviour were never exercised — and that comparator is the whole
basis of the "no slot numbers" claim.

**Fix**: added a test that appears four keys across two rows in reverse reading order
(D, C, B, A) and asserts each press targets its reading-order builder (A→b0, B→b1,
C→b2, D→b3), so both the row term and the arrival-order independence are covered.

## Non-blocking notes — accepted, no change
- `WINDOW_SETTLE_MS` is a module constant rather than injectable (the plan said
  injectable). Fake timers cover the debounce fully, so no change — noted by Claude as
  needing none.
- `onWillDisappear` doesn't guard `isKey()`; `Map.delete` on an absent id is harmless.

Claude independently confirmed the core fix correct: the `max(1,·)` divide-by-zero guard,
multi-action (undefined-coordinate) exclusion, and that `setBuilderWindowSize` does not
`emit()` so the eager size update in `onWillAppear` can't re-enter `renderAll` — the
debounce genuinely debounces.

## Verification after fixes
`npm run check-types` (tsc) ✓, `npm test` ✓ (213 tests), `npm run build` ✓,
`npm run validate` ✓ (manifest edited).
