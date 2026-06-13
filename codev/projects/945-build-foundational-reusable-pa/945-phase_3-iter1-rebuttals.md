# Phase 3 (overlay) — Rebuttal to implement consult iteration 1

**Verdicts:** Codex REQUEST_CHANGES (HIGH); Claude REQUEST_CHANGES (HIGH); Gemini COMMENT.
Both reviewers converged on the same items — all **accepted and fixed** (commit `106dce84`).

## Codex + Claude (convergent) — accepted & fixed

1. **BUG: `fileAdapter.watch()` was unguarded by try/catch.** A synchronous throw from a host's
   `watch` would propagate out of the `useEffect` and crash the component, violating the P3 AC
   "a rejecting `read`/`watch`/`list` is caught → `onError` fired + logged; the component does not
   throw." **Fixed:** `watch(...)` is now wrapped in try/catch → `report(err)` + a no-op
   `Disposable` fallback (so the cleanup function still works). Test added (synchronous watch throw
   → `onError` fired, component renders, no throw).

2. **Missing error/teardown tests against explicit ACs.** **Fixed** — added:
   - `FileAdapter.read` rejection → `onError` + no throw.
   - `FileAdapter.watch` synchronous failure → `onError` + no throw.
   - `Disposable.dispose` called twice → safe no-op (idempotent contract).
   - Space-key activation (Enter was already covered).
   Suite is now 26/26 green.

## Codex #2 — marker "author + text via the overlay" (accepted & fixed)

Phase 1's minimal rendering exposed marker author+text only via a `title` tooltip. The plan's
deferred-#4 wording is "minimal line-level indicator … author + text **via the overlay**."
**Fixed:** the overlay now renders the active line's markers as a labeled list
(`author: text`, `aria-label="Comments on line N"`) alongside the `+` affordance, in addition to
the `.codev-canvas-has-marker` line indicator + `title`. Still minimal v1 (no #863 inline bubbles
or `<canvas>` minimap). Test added (hovering a marked line surfaces author + text).

## Claude minor (non-blocking) — addressed where cheap
- `onMouseLeave` on the canvas container now clears the active affordance.
- Space-key path now tested (was Enter-only).
- The `+` overlay's visual *positioning* near the hovered block remains a Phase 4 concern (the
  smoke host is the visual-verification venue); the functional contract (intent fires with the
  correct line) is met and tested.

## Gemini — COMMENT (non-blocking); no changes required.

Net: both REQUEST_CHANGES resolved; suite 26/26 green; no scope creep into #863/#860–#862.
