# PIR Review: Full-Row '+' Affordance (GitHub-Diff Pattern)

Fixes #1343

## Summary

Replaced the artifact canvas's canvas-anchored "+" overlay (absolutely positioned from
`offsetTop` in a canvas-level gutter, damped by #1236's grace timers and pin-on-overlay-hover)
with the GitHub-diff pattern: every top-level block is a full-width row carrying its own
block-local leading space (`--codev-canvas-gutter`), and the "+" renders inside the hovered
row's own DOM — pointer-line tracked in tall blocks, first-line centered for keyboard focus.
Trigger and target now coincide, which structurally eliminates the hover travel-gap bug class:
the grace/pin machinery became dead code and was deleted, and the geometry is block-scoped as
required by #1380's queued multi-column mode. Comment granularity is unchanged (markers still
attach to the block's source line; the per-line feel is placement only).

## Files Changed

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+118 / −96)
- `packages/artifact-canvas/src/styles/default-theme.css` (+89 / −27)
- `packages/artifact-canvas/src/components/__tests__/full-row-affordance.test.tsx` (+160 / −0, replaces `hover-affordance.test.tsx` −125)
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts` (+31 / −7)
- `codev/plans/1343-artifact-canvas-full-row-affor.md` (+215, plan)
- `codev/reviews/1343-artifact-canvas-full-row-affor.md` (this file)
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` (governance updates below)
- `codev/state/pir-1343_thread.md` (builder thread)

## Commits

- `5e0706d7b` [PIR #1343] Plan draft
- `995dad5d4` [PIR #1343] feat: full-row in-row '+' affordance replaces canvas-anchored overlay
- `5c297f635` [PIR #1343] test: full-row affordance behavior + theme contract updates
- `65f845b4e` [PIR #1343] Thread log: implement phase notes

## Test Results

- `pnpm build` (tsdown, CJS+ESM): ✓ pass
- `pnpm run check-types` (tsc --noEmit): ✓ pass
- `pnpm vitest run`: ✓ 97 tests pass (9 new full-row tests; the 6 grace-window tests were
  deleted with the machinery they pinned — the new suite deliberately uses **zero fake timers**,
  so any future timer in this path fails the suite's instant-transition assertions)
- Manual verification: approved at the dev-approval gate (2026-08-10) — running-flow review of
  the inherited regression floor (right-edge hover, dead strips, tall blocks, rapid vertical
  travel), keyboard parity, composer/marker-card flows, and the full-bleed chrome-block look.

## Architecture Updates

Routed **COLD** (`codev/resources/arch.md`, VS Code Extension → Key Design Decisions): new
bullet documenting the row-scoped geometry contract — block-local gutter, "+" rendered inside
the hovered row, no canvas-anchored positioning — and why it is load-bearing for #1380 (block
padding travels through CSS column fragmentation; canvas geometry does not). Includes the
documented v1 limitation (wide-table horizontal scroll carries the "+"). Nothing routed HOT:
the contract is package-scoped, not a cross-cutting always-on fact.

## Lessons Learned Updates

Routed **COLD** (`codev/resources/lessons-learned.md`, UI/UX):

- Closed the loop on the `[From #1237]` travel-gap lesson (marked landed as #1343).
- New `[From #1343]`: accumulating damping (grace timers, pins) around a UI interaction signals
  wrong geometry — collocate trigger and target and the damping becomes deletable, not tunable;
  and let a *queued* feature's constraints (#1380 fragmentation) pick the geometry now.
- New `[From #1343]`: the movable-portal-target technique — one wrapper node held in a ref,
  `appendChild`-moved between hosts, portalled into; React ownership survives moves and
  `innerHTML` wipes of imperatively-managed DOM.

Nothing routed HOT (both are situation-specific recipes, not behavior-changing global rules).

## Things to Look At During PR Review

### Consultation findings (iter-1, single-pass — verify these dispositions at the pr gate)

Codex returned REQUEST_CHANGES with three findings; all three were confirmed real and fixed
(PIR runs one consultation pass, so these fixes were **not** independently re-reviewed):

1. **Affordance-origin focus/keydown retargeted nested lines.** Tab-focusing the "+" (or Enter
   on it) re-resolved through the host row, retargeting an `li`'s line to the `ul`'s line and
   opening the composer on the wrong line. Fixed: a shared `fromAffordance` guard now no-ops all
   three activation paths (pointer, focus, body keydown) for events originating inside the
   wrapper; the button's native Enter/Space activation → onClick carries the correct line.
   Regression test: "focus and keydown on the affordance never retarget it either".
2. **Governance-doc corruption.** The `[From #1237]` focus-restoration lesson in
   `lessons-learned.md` lost its header in an earlier edit, gluing its tail onto the new portal
   lesson. Restored as its own bullet.
3. **Nested marker-card/composer over-indent.** Stacks for nested blocks (an `li`'s marker) are
   injected *inside* their row, which already carries the gutter — the unscoped `margin-left`
   double-indented them. Fixed: gutter margins scoped with a child combinator to top-level
   stacks/hosts only, pinned by CSS-contract assertions in `default-theme.test.ts`.

Claude returned **COMMENT** (plan adherence verified complete; advisory notes). Dispositions:

1. **`hr` / raw-HTML blocks lost the leading indent** (the renderer only stamps `data-line` on
   `_open`/fence tokens, so they got neither the old body padding nor the new row padding).
   Fixed: `.codev-artifact-canvas-body > :not([data-line])` carries the gutter as `margin-left`
   — one rule that also subsumes the Codex fix #3 scoping for card stacks and composer hosts.
2. **The affordance-origin guards are currently unreachable via React** — portal events
   propagate through the React tree (the portal's parent is the canvas div), so the body
   handlers never see button events; the portal placement is the primary isolation. Accepted as
   accurate: comments in `fromAffordance` and the regression test now say so explicitly, and the
   guards stay as deliberate defense-in-depth (they become load-bearing if the affordance is
   ever rendered non-portally, where DOM bubbling *would* reach the body handlers).
3. **Hoist `placeAffordance` above the effect that calls it** — declined (style preference; the
   file's existing pattern already defines handlers after the effects that close over them, and
   the call executes post-render).
4. **Narrow tables** (`width: max-content`) don't span the full row, so hover to their right
   lands on sticky whitespace rather than the table's row. Documented as a v1 wrinkle alongside
   the table-scroll limitation below; the fix (a full-width wrapper) is the same follow-up.

- **`ArtifactCanvas.tsx` — `activateFromPointer`'s three guard clauses** (affordance-origin
  events, primary-button drag, no-block targets). The first is subtle: without it, hovering the
  "+" hosted in a `ul`'s gutter re-resolves to the `ul` and retargets a nested `li`'s line to
  the list's first line. Pinned by the "never retarget" test.
- **The re-host path** (decoration effect): after a watch reload rebuilds the body, the wrapper
  node is detached; the effect re-appends it for a still-valid `activeLine` via
  `activeLineRef` (not a dep — depending on `activeLine` would churn card injection per hover).
- **CSS specificity around the gutter**: the generic row rule (`.body > [data-line]`, 0-2-0)
  intentionally beats `.codev-canvas-has-marker`'s 10px padding (0-1-0) on top-level rows, and
  is itself beaten by the chrome-row sums (`pre[data-line]` etc., 0-2-1). The marker bar for
  top-level rows is a `::before` strip; nested marked blocks keep the classic inset shadow.
- **Full-bleed chrome rows** (flagged at plan gate, accepted at dev gate): pre/blockquote/table
  boxes start at the canvas edge; text x-positions preserved by padding arithmetic.
- **Documented v1 limitation**: a horizontally-scrolled wide table carries its "+" with the
  scroll. `pre` is immune (scroll moved to inner `code`).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1343 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1343`
- **What to verify** (browser `afx open` + VS Code webview, light + dark):
  - Right-edge hover on a wide block: "+" appears in-row instantly; travel to it never
    dismisses or moves it
  - Leading (gutter) strips light their row; margins keep the previous row lit (sticky)
  - Tall code fence: "+" tracks the pointer's line; wide code scrolls inside the block without
    carrying the "+"
  - Rapid vertical travel: row-by-row tracking, no flicker or stale anchors
  - Drag-selection across a lit "+": selection uninterrupted, no '+' in the copied text
  - Composer (#1107), marker cards + gold bar alignment (#863), edit/delete (#1055), full
    #1237 keyboard pass (Tab/jump keys light the "+", Enter/Space opens the composer)
