# PIR #1400 — Review iteration 1 rebuttal / disposition

3-way consultation verdicts: **Gemini APPROVE**, **Claude APPROVE**, **Codex REQUEST_CHANGES**.
One substantive finding, raised by Codex (HIGH) and independently flagged by Claude as its
observation #1. **Accepted and fixed** — no disagreement.

## Codex REQUEST_CHANGES: `none` mode dispatches diff commands (`actions.ts`)

> `ReviewNav` treats every non-canvas mode as diff. Missing/unknown builders must no-op per plan,
> but rotate, press, and tap currently send diff verbs. Add an explicit `mode === 'diff'` branch and
> regression tests for `none` mode.

**Verdict: valid — fixed.** This was a genuine unstated deviation from the approved plan. Plan §2
specifies: "`none` mode or missing workspace → no-op." The first implementation branched only on
`mode === 'canvas'` and let `none` fall through to the diff verbs (harmless in practice — diff verbs
on no open diff do nothing — but not what the plan says, and untested).

**Change (commit a7a7e81d4):**
- `onDialRotate` / `onDialDown` / `onTouchTap` now branch explicitly on `mode === 'diff'`; `none`
  sends nothing on either channel, with an inline `// none: no-op` comment so a later reader doesn't
  "fix" it back.
- Two regression tests added: an unknown-phase builder and a no-builder overview, each asserting
  `sent` **and** `canvasSent` are empty. Both fail against the pre-fix fall-through.
- `tsc --noEmit` ✓, `npm test` ✓ (84 tests, +2), `npm run build` ✓.

Documented in the review file's "Things to Look At During PR Review" section.

## Claude observation #1 (same finding)

Claude APPROVEd but raised the identical `none`-mode fall-through as a non-blocking observation
("worth one comment … plus a one-line test"). Resolved by the same fix above (comment + two tests).

## Claude observations #2–#4 (non-blocking, no change)

- **#2 Rotate magnitude asymmetry** (diff ignores tick count; canvas passes `count = |ticks|`):
  deliberate per the architect's explicit directive and hardware-verified at dev-approval. No change.
- **#3 Single `current` DialAction per class** (two placed copies of one dial would leave one stale):
  pre-existing pattern in `ZoomNav`/`PrNav`, not a regression from this change. Out of scope.
- **#4 Transient error line can linger if the store is idle**: the set/clear ordering (clear on the
  onChange tick, set after the awaited verdict, re-render only if `current`) is already flagged in the
  review file and reads correct. No change.

## Gemini

APPROVE, no issues.

---

Note: PIR consultation is single-pass (`max_iterations: 1`) — this fix will **not** be independently
re-reviewed by the models. The `none`-mode fix + its two pinning tests plus the human's `pr`-gate
review are the backstop. The architect will be notified leading with the REQUEST_CHANGES and this
disposition.
