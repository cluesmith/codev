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

## Architect review round 1 (PR #1508 → REQUEST_CHANGES, batched into one push)
Two gaps, both in `actions.ts`, fixed together (a second push restarts all seven checks, #1462):
- **Gap 1 / #1459**: added a doc comment to the `VerbKey` base class recording that its keys
  have no runtime face — the manifest `Image` IS the hardware face; compositing subclasses
  (e.g. `DevServerAction`) render their own face in `onWillAppear` and treat the manifest
  image as the pre-render placeholder. PR body gains `Closes #1459` so both issues close on merge.
- **Gap 2**: the "rotation still works with nothing selected" claim (the reason we chose a bare
  `Scroll` over `editor only`) was asserted in prose but tested nowhere — the only rotate test
  used a fixture WITH builders. Added a behaviour guard: with an empty overview, `onDialRotate`
  still relays the `scroll` verb with the workspace path. This pins the premise, distinct from
  the queue-leak test which pins RENDERING. Catches a future `onDialRotate` early-return that
  would make the dial fully inert while line 1 still names a live axis.

Re-verified: check-types 0 errors, vitest 240 passed (+1). Reported new head SHA to architect.
Not merging — owner's word, and the architect still owes a hardware deck check.

## User report: scrolling doesn't work in spec/plan (canvas) review mode
That is issue #1501, OPEN and separate — out of this lane's scope. The Scroll dial correctly
RELAYS `scroll`, but VS Code applies it to the focused text editor, and a spec/plan opens in
the artifact-canvas webview (not a text editor), so nothing scrolls there. #1505 only fixed the
LABEL (bare `Scroll` with no builder); restoring canvas rotation needs a new canvas
viewport-scroll command spanning wire + VS Code, which #1501 tracks. Flagged, did not expand scope.
