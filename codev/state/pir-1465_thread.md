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
