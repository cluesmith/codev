# PIR Plan: Size the Row-1 builder window from the placed keys

## Understanding

**The correctness bug (this is what earns the lane).** Row-1 selection pages the fleet
by a hardcoded constant, not by how many builder keys the user actually placed:

- `ROW1_WINDOW_SIZE = 4` (`apps/streamdeck/src/store.ts:28`).
- `builderWindowStart()` = `floor(cursor.builder / 4) * 4` (`store.ts:159-161`).
- `windowedBuilder(slotIndex)` = `builders()[windowStart + slotIndex]` (`store.ts:153-155`).
- Each `BuilderAction` key resolves the builder it shows from its Property-Inspector
  `slot` field (1-based → `slotIndex`), via `slotBuilder()` (`actions.ts:98-102`).

The page step is fixed at four and is **independent of the number of placed `BuilderAction`
keys**. Place three builder keys (the exact configuration #1463 creates when its Open
Architect key takes a Row-1 slot) and every builder at index ≡ 3 (mod 4) lands at
`slotIndex 3` — a slot with no physical key. It renders on **nothing**, yet the Select dial
(`ZoomNav` rotate → `rotateCursor`, clamped only to `builders().length`) still walks the
cursor onto it. So that invisible builder becomes `selectedBuilder()`: it drives Row 2's
entire palette (Approve, Send Fb, Open Terminal, Open Architect) and both review dials, and
shows **no accent ring anywhere on the board**. The reviewer is acting on a builder the deck
never displays. The board is only safe while the fleet is no larger than the placed-key count.

The constant is also wrong for most hardware (Mini 3×2, Standard 5×3, XL 8×4, SD+ keypad
4×2) — but that multi-device sizing is the bonus; the ambiguous-selection bug is the reason.

**Root cause, stated precisely:** the window size (page step) is a compile-time constant,
while the *slot* a key represents is a hand-numbered PI field. Neither is tied to the ground
truth — the set of `BuilderAction` keys physically on the board — so the two can disagree and
a builder can be selectable while shown on no key.

**Feasibility — verified against `@elgato/streamdeck@2.1.0` source in `node_modules`:**

- There is **no profile-structure API**. `plugin/profiles.d.ts` states plugins "may only
  switch to profiles distributed with the plugin … and cannot access user-defined profiles",
  and `switchToProfile` is the only profile call. The layout cannot be read directly; it must
  be **derived from the lifecycle**. (Do not go looking for a profile reader — there isn't one.)
- Every visible key fires `willAppear` and exposes `KeyAction.coordinates: { column, row } |
  undefined` — `undefined` when the action is part of a multi-action
  (`dist/plugin/actions/key.d.ts:19`, `dist/api/events/action.d.ts:181,188`).
- `Device.size = { columns, rows }` and `Device.type` are available via `action.device` and
  `streamDeck.devices` (`dist/plugin/devices/device.d.ts:39,44`) — available, but **not needed**
  for this fix (see Risks).

## Proposed Change

Make the ground truth — the placed `BuilderAction` keys — drive both the window size and each
key's position. Two coupled moves:

**1. Window size = count of currently-visible `BuilderAction` keys (replaces the constant).**
`BuilderAction` is a single `SingletonAction` instance serving every builder key; it already
tracks its keys in a per-context `Map` (`actions.ts:116`, `keys.set/delete` on
willAppear/willDisappear). Extend that map to capture each key's `coordinates`, and have the
action report the live count to the store, which pages by it:

- `store.ts`: replace the `ROW1_WINDOW_SIZE` constant with an instance field
  `builderWindowSize` (default `1`) plus `setBuilderWindowSize(n)`. `builderWindowStart()`
  becomes `floor(cursor.builder / max(1, builderWindowSize)) * max(1, builderWindowSize)`.
  `windowedBuilder(slotIndex)` keeps its formula. The `max(1, …)` guards division when no
  builder keys are visible.

*What "count" means — placed keys, not device capacity.* The window size is the number of
`BuilderAction` keys **you actually placed and that are currently on screen**, never the
device's key count. `BuilderAction` is one `SingletonAction` serving every builder key; each
placed key fires `willAppear` on it (and `willDisappear` when removed or paged away), so its
key map holds exactly the live builder keys. Any other action in a neighbouring slot is a
*different* `SingletonAction` — e.g. #1463's Open Architect key fires on `OpenArchitectAction`,
not `BuilderAction` — so it never enters the builder count; the manifest UUID does that routing
for free. Concretely on an SD+ (a 4-wide top row) with **3 Builder Action keys + 1 Open
Architect key**: the map has 3 entries, the window size is 3, the Select dial pages the fleet
by 3, and there is no phantom 4th slot — which is exactly the bug (today's constant `4` invents
a slot-3 with no key, so every 4th builder is selectable but shown nowhere). `Device.size` /
`Device.type` are deliberately *not* consulted: device size describes the whole keypad, not
which keys are builder selectors. The count is also **per visible page** — a profile/page switch
fires `willDisappear`/`willAppear`, so it always reflects what is currently displayed.

**2. Slot order derived by sorting visible keys on `(row, column)`; retire the manual `slot`
field.** In `BuilderAction`, recompute on `willAppear`/`willDisappear`:

- Filter to keys with **defined** coordinates (skip multi-action instances).
- Sort by `(row, column)` — reading order, left-to-right then top-to-bottom (so builder keys
  that span rows on a larger deck still fill in a sensible order).
- Assign each key its rank as its `slotIndex`; the count of these keys is the window size.
- **Debounce** the recompute (~50 ms, injectable for tests): at page load keys arrive over
  several `willAppear` events, and an eager recompute would thrash the size and flicker the
  render. One coalesced recompute after the burst settles, then `renderAll()`.

`renderTo(key)` and `onKeyDown(ev)` resolve their builder from the key's derived `slotIndex`
(looked up by the action's context id in the freshly-computed position map), not from
`settings.slot`. `slotBuilder()` is replaced by this position lookup. The empty-slot face uses
`position + 1` for its label instead of the retired `slot` string.

**Decision — the manual `slot` PI field is RETIRED (argued below; flagged for your confirm).**

The `slot` selector on Builder Action existed only because identical singleton instances had no
cheap way to learn their rank among siblings. `KeyAction.coordinates` now supplies that directly,
so the field is redundant. I recommend **removing it** rather than keeping it as an override:

- *Derived order matches intent in essentially every real layout.* Users place "slot 1" on the
  leftmost key; sorting by `(row, column)` reproduces exactly that, minus the manual step.
- *It kills a whole misconfiguration class.* The manual field permits duplicate slots (two keys
  claiming "slot 2") and gaps (slots 1, 2, 4 → a builder silently skipped at position 3) — the
  same "a builder is hidden while selectable" failure this issue exists to remove.
- *Keeping it as an override reintroduces that surface.* An override needs precedence rules
  ("explicit slot beats positional") and collision handling (tiebreak two keys at the same slot,
  compact-or-skip a gap) — complexity bought only for an exotic "physically reorder my keys by
  number" case that the Stream Deck app already serves by dragging keys.

Retirement is **user-visible and irreversible** for anyone who deliberately set non-physical
slot numbers, so I am not defaulting silently: **this is the one decision I want you to confirm
at plan-approval.** Backward-compat is graceful — no migration needed. The PI drops the Slot
selector; any `slot` value already persisted on a key is simply ignored (it sits unused in
settings), and the key re-orders by its physical position on next `willAppear`. If you prefer
keeping `slot` as an override, say so and I will add the precedence + collision rules instead.

## Files to Change

- `apps/streamdeck/src/store.ts:26-28,153-161` — remove the `ROW1_WINDOW_SIZE` constant; add
  `builderWindowSize` field + `setBuilderWindowSize()`; make `builderWindowStart()` page by the
  dynamic size with a `max(1, …)` guard; refresh the `windowedBuilder` / `builderWindowStart`
  doc comments (no longer "4-wide", no longer "0..3").
- `apps/streamdeck/src/actions.ts:88-199` — in the `SlotKey`/`BuilderAction` layer: capture
  `coordinates` in the key map; add a debounced recompute that sorts visible (defined-coord)
  keys by `(row, column)`, sets the store window size, and re-renders; resolve each key's builder
  from its derived position (replacing `slotBuilder()` and the `settings.slot` reads); label the
  empty face from `position + 1`. Drop `slot` from `SlotSettings`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/builder-action.html` — remove the `Slot`
  `<sdpi-select>` item and the "Pins this key to the Nth builder (slot 1 = first builder)"
  sentence; keep the `verb` ("On press") selector unchanged.
- `apps/streamdeck/README.md:99-136` — update the Row-1 description: the Builder Action keys are
  a window **sized to the number of placed builder keys** (not a fixed 4-wide / slot 1–4); the
  Select dial scrolls it a page (= that many keys) at a time; keys self-order by physical position.
- `apps/streamdeck/src/__tests__/actions.test.ts` (+ possibly a small `store` unit) — rewrite the
  "Row 1 windowing" block to drive via coordinates + visible-key count; see Test Plan for the new
  cases.

Out of scope, explicitly: Row 2 keys, the review/zoom dials, and #1381's larger-profile question.

## Risks & Alternatives Considered

- **Regression risk — window size changes underneath a live selection.** A key appearing or
  disappearing re-pages the window while `cursor.builder` stays fixed. This is the main hazard,
  so it gets a dedicated test: after a size change, the selected builder must still land on a
  rendered key. `rotateCursor` clamps only to `builders().length` and nothing clamps the cursor
  to the window size, so no crash — but the invariant ("selected builder is always on a key")
  must hold, and that is exactly what the bug broke. Tested directly (Test Plan).
- **Async settle / thrash.** Keys arrive over several `willAppear` events at page load; an eager
  recompute flickers size and render. Mitigation: debounce (injectable interval) + one
  `renderAll()` after the burst.
- **Multi-action instances (undefined coordinates).** A Builder Action inside a multi-action has
  `coordinates === undefined`; it is excluded from the count and from positioning, and resolves
  to no builder (inert / empty face) when pressed. Tested.
- **Alternative — read the profile / use `Device.size` to size the window.** Rejected: no profile
  API exists, and device size describes the whole board, not which keys are Builder Action keys.
  The count of visible builder keys is both sufficient and *more precise* — it counts exactly the
  placed selectors, on any device, with no device-type table to maintain.
- **Alternative — keep `slot` as an override on top of positional order.** Rejected (see Proposed
  Change): reintroduces the duplicate/gap misconfiguration surface for a niche capability the
  Stream Deck app already covers by dragging keys. Deferred to your call at the gate.

## Test Plan

**Unit (vitest, `apps/streamdeck` — runs headless in the worktree):**

- *Dynamic window size.* With N visible builder keys reported, `windowedBuilder` pages by N:
  N = 3 over a fleet of 4+ shows builders 0–2 then 3–…; the fourth builder is reachable and never
  falls off a page.
- *Core invariant (the bug).* For a fleet larger than the key count, at **every** `cursor.builder`
  in `[0, builders)` there exists a `slotIndex` in `[0, size)` with
  `windowedBuilder(slotIndex).id === selectedBuilder().id` — i.e. the selected builder is always
  on a rendered key. Asserted for size = 3 and size = 4.
- *Positional ordering.* Keys given `(row, column)` out of placement order still resolve to
  builders in reading order; two keys at different coordinates get distinct, contiguous positions.
- *Cursor paging under a size change.* Select a builder, then add/remove a key so the window size
  changes; assert the selected builder still lands on a key (re-pages, no gap, no crash).
- *Multi-action skip.* A key with `coordinates === undefined` is excluded from the count and
  positioning and does not shift the others.
- *Settle/debounce.* A burst of `willAppear` events yields one authoritative recompute (fake
  timers); the final window size equals the placed-key count.

**Manual — hardware (dev-approval session, Amr driving the deck):**

- *3-key layout (the bug repro).* Place **3** Builder Action keys (one Row-1 slot taken by the
  Open Architect key, per #1463). Spawn 4+ builders. Rotate the Select dial onto the 4th builder
  and confirm: it now renders on a key **and** shows the accent ring; Row 2 + the review dials act
  on the builder that is actually displayed. (Before this change, the 4th builder was selected but
  shown nowhere.)
- *4-key layout (no regression).* Place **4** Builder Action keys; confirm paging and accent match
  today's behaviour for fleets of 4, 5, and 8.
- *Non-SD+ device, if available.* On a Standard/Mini (or XL), place a device-appropriate number of
  Builder Action keys and confirm the window sizes to the placed count and the selection is always
  visible.
- *Reorder sanity.* Drag a Builder Action key to a different position and confirm the slot order
  follows physical placement (validates the retired manual field).
