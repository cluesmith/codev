# air-1505 — Stream Deck: Scroll dial names a delivery mode with no builder selected

## Task (AIR, strict)
Issue #1505: with no builder selected the Scroll dial's touchstrip still read
`Scroll · send` / `Scroll · queue` while its press is inert (`onDialDown` returns early
when nothing is selected). Line 1 named a delivery mode a gesture could not fire.
Ride-along fix folded into the next `apps/streamdeck/src/actions.ts` touch (the #1454 pattern).

## What I did
- `ScrollNav.renderTo` (`apps/streamdeck/src/actions.ts`): when `selectedBuilder()` is
  undefined, suppress the delivery-mode qualifier and render a bare `Scroll` on line 1.
  Rotation still works with nothing selected (relaying `scroll` needs only the workspace
  path), so the axis word stays honest; only the qualifier drops. Mirrors the canvas
  branch's rule (#1498) that the qualifier appears only where the gesture it names is live.
  Reused the already-fetched `selectedBuilder()` result instead of calling it twice.
- Updated the existing empty-state test to assert the bare `Scroll` title, and added a
  second guard proving the `queue` delivery mode does not leak into line 1 when nothing
  is selected.

## Verification
- `apps/streamdeck` check-types: 0 errors (had to build `@cluesmith/codev-types` +
  `@cluesmith/codev-sdk` first — their dist wasn't present in a fresh worktree; the
  `codev-sdk/controller` module-not-found errors were purely that, not my change).
- `apps/streamdeck` build (esbuild): exit 0.
- `apps/streamdeck` vitest: 239 passed.

Scope: `apps/streamdeck` only, no wire or VS Code involvement. Well under 300 LOC.
