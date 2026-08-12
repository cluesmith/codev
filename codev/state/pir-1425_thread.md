# Builder thread — pir-1425

**Issue #1425**: Stream Deck — map review dials to composer-open-or-submit /
composer-cancel (deck half of #1420). Protocol: PIR (hardware verification before PR).
Refs #1420, PR #1424 (bridge lane, merged).

## PLAN phase (2026-08-12)

Investigated `apps/streamdeck/src/actions.ts`. The two canvas-mode review dials share one
press handler (`ReviewNav.onDialDown`) that hardcodes `composer-open` — the #1400 decision
this issue supersedes. `CanvasSpec` has no press field on purpose (press was identical).

Plan: add `press: CanvasCommand` + `pressLabel: string` to `CanvasSpec`; fine dial
(`DiffHunkNav`, Blocks) → `composer-open-or-submit`, coarse dial (`DiffFileNav`, Headings)
→ `composer-cancel`. Touchstrip line 1 becomes `${label} · ${pressLabel}` in canvas mode
(`Blocks · Open/Submit`, `Headings · Cancel`); line 2 keeps builder identity. Both commands
already exist in `CanvasCommand`, the canvas-relay allowlist, and `ArtifactCanvas` action
map — deck-only remap, no bridge/canvas/types/host change (requirement 4).

Verified the Elgato Plugins symlink currently points at the **pir-1400** worktree, so the
plan covers the sideload swap to pir-1425 for dev-approval and restoring the link after.

Per architect instruction (2026-08-12T10:22Z), routing dial-semantics + hardware-verification
sections to the architect BEFORE the plan-approval gate.

Plan written to `codev/plans/1425-stream-deck-map-review-dials-t.md`. Awaiting plan-approval.

### Plan review revisions (2026-08-12T10:26Z, architect)

Approved with two hardware-section fixes (semantics/press-field/pressLabel/tests all
approved as written; `Blocks · Submit` truncation fallback pre-approved):

1. BUG: swap-build commands must run from the **pir-1425 worktree root**, not main —
   `pnpm --filter` from main builds main's apps/streamdeck, sideloading stale/missing
   `bin/plugin.js`. Rewrote with `cd` to worktree root + absolute link path.
2. RULING: restore target is a **fresh build from the MAIN checkout** (behaviorally
   identical to pir-1400's merged code), which becomes the deck's permanent stable link
   and frees pir-1400 for the #1176 orphan sweep. No longer restoring to pir-1400.

Both applied. Amr runs swap/restore at the gate session. Re-committed; still at
plan-approval.

## IMPLEMENT phase (2026-08-12)

Plan approved. Implemented in `apps/streamdeck/src/actions.ts` (commit fe813cbe3):
- `CanvasSpec` gained `press: CanvasCommand` + `pressLabel: string` (doc comment rewritten;
  the "press is always composer-open, shared" rationale is gone).
- `onDialDown` canvas branch sends `this.canvas.press`.
- `renderTo` canvas-mode line 1 = `${label} · ${pressLabel}`; diff mode unchanged.
- Fine (`DiffHunkNav`): `composer-open-or-submit` / `Open/Submit`. Coarse (`DiffFileNav`):
  `composer-cancel` / `Cancel`.

Tests: updated the two canvas-press assertions + both legibility/title tests to the new
`Headings · Cancel` / `Blocks · Open/Submit` titles (three pre-existing tests asserted the
bare titles). Did NOT add a redundant new title test — folded it into the existing
canvas-legibility test. `check-types` clean, 84/84 tests pass, plugin builds
(`bin/plugin.js` is gitignored, rebuilt at sideload). Note: had to build the sdk dist first
(`pnpm --filter @cluesmith/codev-sdk build`) or the streamdeck check-types can't resolve
`@cluesmith/codev-sdk/*`.

At dev-approval — hardware session. Amr runs the sideload swap (worktree build) → verify →
restore to main-checkout build.

## REVIEW phase (2026-08-12)

dev-approval approved (hardware verified). Wrote
`codev/reviews/1425-stream-deck-map-review-dials-t.md`: no arch change (client dial remap
inside the existing CanvasSpec pattern); no lessons-doc edit (the two sideload gotchas —
build from worktree root, sdk dist first — are streamdeck-local and already documented, kept
in the review). Opening PR next, recording with porch, then `porch done` triggers the single
3-way consult pass → pr gate.
