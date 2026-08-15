# pir-1465 — Stream Deck: size the Row-1 builder window from placed keys

## Context
PIR lane for issue #1465. Correctness bug: Row-1 windowing pages by a hardcoded
`ROW1_WINDOW_SIZE = 4`, independent of how many `BuilderAction` keys the user placed.
With 3 keys against a page of 4, every builder at index ≡ 3 (mod 4) renders on NO key
while the Select dial still walks onto it — so it becomes the selected builder, drives
Row 2 + both review dials, and shows no accent ring anywhere. Triggered by #1463's
Open Architect key taking a Row-1 slot (3 builder keys left).

## Phase: PLAN (2026-08-15)
Investigated the code. Verified SDK feasibility against `@elgato/streamdeck@2.1.0`:
- `KeyAction.coordinates: {column,row} | undefined` (undefined for multi-action) — confirmed
  in `dist/plugin/actions/key.d.ts` + `dist/api/events/action.d.ts`.
- `Device.size {columns,rows}` + `Device.type`, `action.device`, `streamDeck.devices` — confirmed.
- No profile-structure API (profiles.d.ts: plugins "cannot access user-defined profiles"),
  so layout must be DERIVED from lifecycle. Confirmed.

Design decisions taken into the plan:
- Window size = count of currently-visible BuilderAction keys (replaces the constant).
- Slot order derived by sorting visible keys on (row, column); skip undefined-coord (multi-action).
- Debounce recompute across the page-load willAppear/willDisappear settle.
- **Retire the manual `slot` PI field** (argued, not defaulted — flagged for architect confirm as
  the one irreversible/user-visible call). Physical order matches intent in ~all real layouts and
  kills the duplicate-slot / gap misconfiguration class; keeping it as an override reintroduces
  exactly that surface.
- Core invariant to test: the selected builder is ALWAYS on a rendered key (the bug violated this),
  and cursor paging stays coherent when window size changes underneath a selection.
- Row 2 + dials + #1381 profile question OUT of scope. Device size/type available but not needed —
  the visible-key count already encodes the physical layout.

Plan written to codev/plans/1465-stream-deck-size-the-row-1-bui.md. Routing to architect before
plan-approval gate per instruction. dev-approval is a hardware session (3-key + 4-key + non-SD+).

## Phase: IMPLEMENT (2026-08-15) — done, at dev-approval gate
Plan approved (architect confirmed retiring the manual slot field is fine). Implemented:
- store.ts: removed `ROW1_WINDOW_SIZE` constant; added private `builderWindowSize` (default 1) +
  `setBuilderWindowSize()`; `builderWindowStart()` pages by it with a `max(1,·)` guard.
- actions.ts: `SlotKey` now captures `KeyAction.coordinates` per key; derives each key's slot by
  sorting placed keys on (row, column); reports the count to the store; skips undefined-coord
  (multi-action) instances. Window size set synchronously on willAppear/willDisappear (so a press
  resolves against the current layout); a debounced (`WINDOW_SETTLE_MS=50`) full renderAll coalesces
  the page-load burst. `slotBuilder()` + `settings.slot` retired; empty face labels by position.
- builder-action.html: dropped the Slot selector; kept the verb selector; rewrote help text.
- README.md: Row-1 diagram now shows 3 builders + Open Architect (the #1463 layout); prose says the
  window sizes to the placed keys, keys self-order by position.
- Tests (actions.test.ts): rewrote the windowing blocks to drive via coordinates + placed-key count.
  Added: the core INVARIANT (selected builder always on a rendered slot, for every cursor × size 3/4),
  paging-follows-placed-count, multi-action exclusion, debounced-settle re-render, and
  cursor-paging-coherent-under-size-change.

Design note (for review): immediate render on willAppear is KEPT (correct in the common cursor≈0
load; a rare later-selection load shows a ~50ms transient before the settle corrects it). The
debounce is on the full renderAll (the thrash the architect flagged), not on press resolution.

Verified in worktree: `npm run build` ✓, `npm run check-types` (tsc) ✓, `npm test` ✓ (212 tests),
`npm run validate` ✓. dev-approval is the hardware session next.

## Scope addition at dev-approval (owner-directed, 2026-08-15)
Owner wants the recommended SD+ layout to lead with the architect anchor. Updated README
"Recommended layout" section: Row 1 slot 1 = Open Architect Terminal in MAIN mode (fixed,
selection-independent anchor — that's WHY it can sit in Row 1 without breaking "Row 1 selects"),
slots 2-4 = three Builder Action selectors. Redrew the ASCII diagram, rewrote the Row-1 bullet
in placed-keys terms (never "4-wide"), dropped the stale "place Open Architect where a slot frees
up" note. Folded into this lane (no separate PR) because a 3-key Row 1 is only correct once the
window follows the placed keys — the doc and the fix must ship together. readme-design test ✓.
Committed 3bbf15782. Still at dev-approval gate.
