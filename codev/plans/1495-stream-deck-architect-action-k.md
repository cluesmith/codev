# PIR Plan: Stream Deck Architect Action key — scope the fleet to one architect's builders

## Understanding

Today the Stream Deck deck shows one flat fleet: Row 1 windows over **every** builder in
the selected workspace's overview, regardless of which architect spawned it. The deck can
*summon* a single architect's terminal (Open Architect Terminal, #1463) but cannot use an
architect as a **filter** over the fleet.

Issue #1495 asks for an **Architect Action** key — the architect analogue of Builder Action
(#1465). Pressing it **scopes** the fleet to that architect's builders; pressing the currently
scoped architect again clears the scope. This is a **scope, not a mode**:

- Nothing re-flows. Row 1 keeps windowing over the (now narrowed) builder list exactly as it
  does today.
- Row 2 (Approve / Send Fb / Dev / Open Terminal / Open Architect) keeps acting on the
  **selected builder**, and the review dials keep reviewing it.
- The "one shared selection" invariant holds: the selection is **always a builder**, never an
  architect. The scope only narrows *which builders are listed and navigable*.

Three decided rulings (from the issue, not open for relitigation):

1. **Scope resets on workspace switch** — a scope belongs to the fleet you are looking at.
2. **An empty scope is visibly empty** — if a scoped architect's builders all vanish, Row 1
   shows empty slots rather than silently widening back to all builders.
3. **No summoning** — this key sets scope only; opening a terminal stays #1463's key.

### Key constraints (architect scoping, confirmed against the code)

- **Derive the architect list from the builders, NOT from `OverviewData.architects`.** The
  navigable architects are the distinct non-null `spawnedByArchitect`
  (`packages/types/src/api.ts:201`) values across the current overview's builders. #1463
  deliberately stopped the deck consuming the live-architect view. We add **no** new wire data
  and **no** live-view dependency.
- **Reuse #1465's self-ordering / self-sizing**, do not reimplement it. The Builder Action
  keys already order themselves by `KeyAction.coordinates` (row, then column), debounce a
  recompute across the willAppear/willDisappear page-load burst, and exclude multi-action
  instances via `coordinates === undefined`
  (`apps/streamdeck/src/actions.ts:110-206`, class `SlotKey`). The Architect Action keys want
  the **identical positional-ordering** mechanism — so we extract that core into a shared base
  and have both key types build on it, rather than writing a second sort.

## Proposed Change

### 1. Store: a fleet scope (`apps/streamdeck/src/store.ts`)

Introduce an optional `scopedArchitect` on the store and make the fleet list *the store already
exposes* respect it, so every existing consumer (Row 1 window, selection, cursor bounds, zoom
dial) narrows coherently with **no** re-plumbing:

- Add `scopedArchitect: string | undefined` (public read — the face reads it to mark the active
  scope).
- Add `allBuilders(): OverviewBuilder[]` returning the **unscoped** `overview.builders` (this is
  what the Architect Action key derives its list from).
- Change `builders()` to return the **scoped** subset when `scopedArchitect` is set
  (`allBuilders().filter(b => b.spawnedByArchitect === scopedArchitect)`), else all. Because
  `windowedBuilder`, `selectedBuilder`, `pendingGates`, and `counts()` all already read through
  `builders()`, Row 1's window, the shared selection, the select-dial bounds, and the zoom
  dial's counts all follow the scope automatically — the cursor can only ever land on a builder
  that is listed.
- Add `architects(): string[]` — the distinct non-null `spawnedByArchitect` across
  `allBuilders()`, **sorted alphabetically** (deterministic, stable as builders come and go).
  This is what an Architect Action key indexes by its slot rank.
- Add `toggleArchitectScope(name: string): void` — press semantics:
  - if `scopedArchitect === name` → clear (`undefined`); else set to `name`.
  - **Preserve the shared selection across the toggle**: capture the selected builder's `id`
    first, apply the scope, then re-point `cursor.builder` at that same id in the new list;
    fall back to index 0 only when it is absent. This keeps the dials reviewing the *same*
    builder when it survives the narrowing (satisfies "the dials keep reviewing it"), and lands
    on a valid selection when it doesn't.
  - `emit()`.
- **Ruling 1 (reset on workspace switch):** clear `scopedArchitect` in the three places the
  store changes workspace — `syncToWorkspace` (the deep-link follow), the workspace-change
  branch of `rotateCursor`, and the "current workspace dropped" branch of `refresh`. Those
  paths already reset `cursor.builder`; clearing the scope beside them means a scope never
  outlives the fleet it filtered.
- **Ruling 2 (empty scope is visibly empty):** falls out for free — a scoped architect whose
  builders vanish makes `builders()` return `[]`, so Row 1 renders empty slots and
  `selectedBuilder()` is `undefined`. We deliberately do **not** auto-clear the scope on empty
  (auto-clearing would be the silent widening the ruling forbids).

### 2. Extract #1465's positional-ordering core (`apps/streamdeck/src/actions.ts`)

`SlotKey` currently bundles two concerns: (a) tracking placed keys and ordering them by
coordinates with a debounced settle, and (b) builder-window sizing + `builderFor`. Extract (a)
into a small reusable base so the Architect Action key reuses the *exact* ordering, not a copy:

- New `abstract class PlacedKeys<S>` (SingletonAction): owns the per-context `keys` map, the
  `onWillAppear` / `onWillDisappear` / `onDidReceiveSettings` tracking, `placedKeys()` (sorted
  by row then column, multi-action instances excluded), `slotIndexOf(action)`, the
  `WINDOW_SETTLE_MS` debounced settle, and the `store.onChange` re-render subscription. Abstract
  `renderTo(action)`; an overridable `onPlacementChanged()` hook (default: no-op) lets a
  subclass react when the placed-key set settles.
- `SlotKey extends PlacedKeys<SlotSettings>` — keeps the builder-specific parts: overrides
  `onPlacementChanged()` to call `store.setBuilderWindowSize(placedKeys().length)`, plus
  `builderFor`, `resolveVerb`, `onKeyDown`. Behaviour is unchanged; the existing #1465 tests
  keep passing.

### 3. Architect Action key (`apps/streamdeck/src/actions.ts`)

New `class ArchitectAction extends PlacedKeys<Record<string, never>>`:

- `manifestId = 'com.cluesmith.codev.architect-action'`. No Property Inspector, no verb, no
  settings — a placed key's identity is purely its slot rank (self-ordering, #1465).
- `architectFor(action)`: `store.architects()[slotIndexOf(action)]` (or `undefined` for a
  multi-action key / a slot past the end of the list).
- `onKeyDown`: resolve the architect at this key's slot; if none, `showAlert()` (inert). Else
  `store.toggleArchitectScope(name)`. **No command is relayed** — scoping is deck-local state
  (ruling 3: no summoning, no Tower round-trip).
- `renderTo`: draw the new scope face (below) — the architect name, accented when it **is** the
  active scope, visibly empty when the slot has no architect.

### 4. Face (`apps/streamdeck/src/face.ts`)

Add `architectScopeFaceSvg(name: string | undefined, active: boolean)`:

- `name === undefined` → a **visibly empty** face: dim `architect` glyph + a muted centered
  `—` (mirrors the empty Builder slot's treatment; never blank-but-live).
- present + inactive → `architect` glyph (muted `#a9a9b2`) over `capitalizeFirst(name)`.
- present + active → the **accent treatment Row 1 uses for the selected builder**: reuse the
  existing `SELECTED_RING`, and tint the glyph/label to the selected accent so the active scope
  is unmistakable.

Reuses the existing `architect` glyph, `capitalizeFirst`, `SELECTED_RING`, and the shared
frame/text helpers — no new glyph vocabulary.

### 5. Manifest + icon (`apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json`, icons)

- Add an `Architect Action` action entry (UUID `com.cluesmith.codev.architect-action`, Keypad,
  `Icon: icons/list/architect-action`, `States[0].Image: icons/architect-action`, a Tooltip
  describing scope-toggle semantics). No `PropertyInspectorPath`.
- Add `{ name: 'architect-action', glyph: 'architect' }` to `ICONS` in
  `scripts/render-action-icons.mjs` and run the script to generate the four PNGs
  (`icons/architect-action{,@2x}.png`, `icons/list/architect-action{,@2x}.png`). The script
  renders from the same `architect` glyph the runtime face draws, so picker and hardware agree
  by construction. (Needs `librsvg` + `imagemagick`, already the repo's icon-build tools.)

### 6. Register + document

- Register `ArchitectAction` in `apps/streamdeck/src/plugin.ts`.
- Add the key to the README `## Design` section (the readme-design test pins that section's
  existence; describing the new key keeps the design rationale in-tree).

## Files to Change

- `apps/streamdeck/src/store.ts` — add `scopedArchitect`, `allBuilders()`, scope-aware
  `builders()`, `architects()`, `toggleArchitectScope()`; clear scope on the three
  workspace-change paths.
- `apps/streamdeck/src/actions.ts` — extract `PlacedKeys` base from `SlotKey`; add
  `ArchitectAction`.
- `apps/streamdeck/src/face.ts` — add `architectScopeFaceSvg`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — new action entry.
- `apps/streamdeck/scripts/render-action-icons.mjs` — add `architect-action` to `ICONS`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/architect-action*.png` +
  `icons/list/architect-action*.png` — generated assets.
- `apps/streamdeck/src/plugin.ts` — register `ArchitectAction`.
- `apps/streamdeck/README.md` — document the key under `## Design`.
- Tests: `apps/streamdeck/src/__tests__/actions.test.ts` (scope toggle, slot→architect
  derivation, inert empty slot, preserved selection, no command relayed),
  `face.test.ts` (scope face: empty / active / inactive), and the existing
  `render-action-icons.test.ts` / `manifest-icons.test.ts` / `validate.test.ts` extend to the
  new icon+action automatically once assets and manifest are in place.

## Risks & Alternatives Considered

- **Risk — scoping the wrong list breaks the zoom cursor.** If `builders()` narrowed but the
  cursor still indexed the full list, Row 1 and the selection would disagree. *Mitigation:* the
  cursor already indexes `builders()`, and `toggleArchitectScope` re-points it at the same
  builder id (or 0); `counts()` reads `builders()` so rotation is bounded to the scoped list.
- **Risk — refactoring the just-landed #1465 `SlotKey`.** *Mitigation:* the extraction is a pure
  move of the positional-ordering members into a base `SlotKey` still extends; the #1465 tests
  (window sizing, multi-action exclusion, slot press) are the regression guard and must stay
  green unchanged.
- **Alternative — a "builder view / architect view" mode toggle.** Rejected (and called out by
  the architect): Row 2's Approve/Dev/Send Fb and both review dials have nothing coherent to act
  on when Row 1 lists architects. Scope keeps the selection a builder throughout.
- **Alternative — read `OverviewData.architects`.** Rejected: it reports architects Tower can
  currently see a live session for and carries #1463's three failure modes (empty during a
  restart window, transiently missing `main`, a live row behind a dead PTY). Deriving from
  builders needs no new wire data and can only ever offer an architect that owns visible work.
- **Alternative — auto-clear scope when it goes empty.** Rejected by ruling 2: silent widening
  is worse than an obvious empty.

### #1406 impact (stated, not fixed — out of scope)

#1406 (spawn mis-attribution) makes `spawnedByArchitect` wrong/`null` when the
`CODEV_ARCHITECT_NAME` prefix is missing. Under this feature that surfaces two ways: a
mis-attributed builder is scoped under the **wrong** architect, and a `null`-attributed builder
appears under **no** architect (excluded from `architects()`, unreachable by any scope). This
plan does not fix #1406; the derive-from-builders design simply inherits whatever attribution
the overview carries.

## Test Plan

**Unit (vitest, run from the worktree):**

- `store`: `builders()` narrows to the scoped architect; `allBuilders()` stays full;
  `architects()` returns distinct non-null `spawnedByArchitect`, sorted, de-duplicated;
  `toggleArchitectScope` sets → clears on re-press; selection preserved by id across a toggle
  and reset to 0 when the selected builder isn't in the new scope; scope cleared on
  `syncToWorkspace` and on a workspace-change rotate.
- `actions` (`ArchitectAction`): key N (by coordinates) shows the Nth architect; press toggles
  scope and relays **no** command; a slot past the architect list is inert (`showAlert`); a
  multi-action instance (undefined coordinates) has no slot; re-render on `store.onChange`.
- `face`: `architectScopeFaceSvg` renders empty (`—`, dim) for `undefined`; the accent ring only
  when `active`; the capitalized name otherwise.
- Icon/manifest guards (`render-action-icons`, `manifest-icons`, `validate`) pass with the new
  action + assets.

**Manual (dev-approval — hardware, needs ≥2 architects owning builders):**

The scoping behaviour only proves itself where more than one architect owns builders. To
demonstrate at the gate I will stand up a workspace with **two architects each owning ≥1
builder** (e.g. `main` plus a second `afx workspace add-architect`, each spawning a builder),
place two Architect Action keys plus a row of Builder Action keys, and verify on the physical
board:

1. With no scope, Row 1 lists **both** architects' builders; both Architect Action keys show
   their names, neither accented.
2. Press architect A → Row 1 narrows to A's builders; A's key shows the active accent; the
   selected builder (if it was A's) stays selected and the dials still review it.
3. Press A again → scope clears, Row 1 shows all builders, accent gone.
4. Press B while scoped to A → scope switches to B (single active accent, not two).
5. Switch workspace (zoom out/in) → scope resets (ruling 1); Row 1 shows the new fleet
   unfiltered.
6. Scope to an architect, then let its builders drain (merge/cleanup) → Row 1 goes visibly
   empty rather than widening (ruling 2).

I will capture this as a short narration in the review; if a two-architect board can't be stood
up at review time, I will flag it and fall back to the unit coverage plus a single-architect
smoke (scope-to-self narrows to that architect, re-press clears).
