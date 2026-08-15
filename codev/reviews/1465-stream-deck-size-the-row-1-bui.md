# PIR Review: Size the Row-1 builder window from the placed keys

Fixes #1465

## Summary

The Stream Deck Row-1 fleet selector paged by a hardcoded `ROW1_WINDOW_SIZE = 4`,
independent of how many `BuilderAction` keys the user actually placed. With fewer
placed keys than four, a builder at index ≡ 3 (mod 4) rendered on no key while the
Select dial still walked the cursor onto it — so it became the selected builder,
drove Row 2 and both review dials, and showed no accent ring anywhere. This change
sizes the window to the number of visible `BuilderAction` keys and derives each key's
slot from its physical board position (`KeyAction.coordinates`, sorted by row then
column), retiring the manual `slot` Property-Inspector field. The window now follows
the placed keys, so a builder can never be selected while shown on no key.

## Files Changed

- `apps/streamdeck/src/store.ts` — removed the `ROW1_WINDOW_SIZE` constant; the window
  is sized by a reported placed-key count (`setBuilderWindowSize`, `max(1,·)` guard).
- `apps/streamdeck/src/actions.ts` — `SlotKey` captures each key's `coordinates`, sorts
  placed keys by `(row, column)` for slot order, reports the count, skips multi-action
  (undefined-coordinate) instances, and debounces a full re-render across the page-load
  settle. `slotBuilder()` and `settings.slot` retired.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/builder-action.html` — dropped the
  Slot selector (slots are now positional); kept the verb selector; rewrote help text.
- `apps/streamdeck/README.md` — recommended SD+ layout now leads with an Open Architect
  (main-mode) anchor in Row 1 slot 1 + three Builder selectors; Row 2 revised to
  free · Approve Gate · Open Architect (builder mode) · Open Builder Terminal; windowing
  prose stated in placed-key terms.
- `apps/streamdeck/src/__tests__/actions.test.ts` — windowing tests rewritten to drive
  via coordinates + placed-key count, plus the selected-always-shown invariant, the
  debounced settle, and cursor-paging coherence under a window-size change.

## Commits

```
8c016a973 [PIR #1465] Docs: revise recommended Row 2 (free · Gate · Arch(bldr) · Bldr Term)
3bbf15782 [PIR #1465] Docs: recommended SD+ layout leads with the architect anchor
2feb84922 [PIR #1465] Tests: dynamic window sizing, the selected-always-shown invariant, settle + paging
99491b5f5 [PIR #1465] Retire the manual Slot PI field; document placed-key windowing
a73523b71 [PIR #1465] Size the Row-1 window from placed builder keys
```
(plus builder-thread and porch bookkeeping commits.)

## Test Results

In the worktree (`apps/streamdeck`): `npm run build` ✓, `npm run check-types` (tsc) ✓,
`npm test` ✓ (212 tests, incl. the rewritten dynamic-window suite), `npm run validate`
✓. Porch's `build` + `tests` gate checks also passed. The running plugin was verified
on hardware at the `dev-approval` gate (3-key and 4-key Row-1 layouts).

## Architecture Updates

No arch changes. The fix is internal to the Stream Deck plugin's Row-1 windowing —
it changes no module boundary, wire contract, state store, or the four-tier resolver,
so nothing qualifies for `arch-critical.md` (hot) or `arch.md` (cold).

## Lessons Learned Updates

Routed one **COLD** lesson to `codev/resources/lessons-learned.md` (UI/UX), tagged
`[From #1465]`: a UI "window onto a list" must size itself from the elements actually
placed, not a hardcoded page constant, or a selection can point at an element rendered
on no key; and — Stream-Deck-specific — with no profile-structure API the layout must be
derived from the lifecycle (`willAppear` `KeyAction.coordinates`, excluding undefined-coord
multi-action instances), sorted by `(row, column)`, counted for the width, and debounced
across the page-load settle. This is a plugin-narrow recipe, so COLD, not the hot tier.

## Things to Look At During PR Review

- **The correctness invariant.** The load-bearing test is "the selected builder is always
  on a rendered slot, for every cursor × window size 3 and 4" (`actions.test.ts`). That is
  the property the bug violated; it directly encodes the fix's guarantee.
- **Immediate render vs debounced settle.** `willAppear` sizes the window and renders the
  arriving key synchronously (so a press always resolves against the current layout), while
  a debounced `renderAll` (`WINDOW_SETTLE_MS = 50`) coalesces the page-load burst. A rare
  reload with a non-first builder already selected shows a ~50 ms transient face before the
  settle corrects it — a deliberate trade to avoid flicker, called out here so it isn't read
  as a bug. The debounce is on the full re-render, never on press resolution.
- **Retiring the manual `slot` field is user-visible.** Any `slot` value previously persisted
  on a key is now ignored (it sits unused in settings) and the key re-orders by physical
  position. This was raised and confirmed by the reviewer at plan-approval; no migration is
  needed, but it is the one behavior change a returning user could notice.
- **Docs shipped with the fix on purpose.** The recommended 3-key layout would hide every
  fourth builder under the old constant, so the README layout guidance and the code fix must
  land together (owner-directed, folded into this lane rather than a separate PR).

## How to Test Locally

For a reviewer pulling the branch (hardware):

```bash
pnpm --filter @cluesmith/codev-sdk build
pnpm --filter @cluesmith/codev-streamdeck build
cd apps/streamdeck
npx streamdeck unlink com.cluesmith.codev            # it may be linked to another worktree
npx streamdeck link "$(pwd)/com.cluesmith.codev.sdPlugin"
npx streamdeck restart com.cluesmith.codev
npx streamdeck list                                  # confirm it points at this worktree
```

Repro the fixed bug: place **3** Builder Action keys + an Open Architect key in the 4th
Row-1 slot, spawn 4+ builders, and rotate the Select dial onto the 4th builder — it now
renders on a key with the accent ring (before, it was selected but shown nowhere). Then
confirm a 4-key layout still pages/accents as before.

Unit only: `cd apps/streamdeck && npm test`.
