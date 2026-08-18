# PIR Plan: Stream Deck Architect Action key — a second board of architects, native switch

## Understanding

The deck today shows one board: Row 1 windows over the full fleet of builders, and each builder
key already carries a "back to my architect" affordance (Open Architect Terminal, #1463,
builder-mode). What's missing is a way to see and act on the **architects themselves**.

The feature is **two independent boards plus a native switch between them** — *not* a scope or a
filter over the builder list:

- **Builders board** — today's keys, the full fleet, **completely unchanged**.
- **Architects board** — a self-ordering list of **Architect Action** keys, one per architect;
  pressing one opens that architect's terminal.
- **Switch button** — a **native** Stream Deck key (Switch Profile, or a Folder) carrying a
  **custom Codev-styled icon** so it blends with the other keys; Stream Deck performs the page
  flip, the plugin does not.

### Divergence from the issue as written (owner decision, 2026-08-18)

Issue #1495 is written as "a scope, not a mode" — filtering the builder list to one architect.
The owner has decided **against** that: filtering builders by architect is redundant because a
builder already links back to its architect on the builders board. The agreed shape is instead
the two-board switch above. Consequences, all confirmed with the owner:

- **No scope, no filtering, no shared-selection changes.** The builders board never narrows;
  there is no `scopedArchitect` state. (Scope rulings 1 and 2 no longer apply.)
- **Ruling 3 ("no summoning") is intentionally lifted.** With no scope, the only coherent thing
  an architect key can do is open that architect's terminal — so Architect Action becomes the
  self-ordering, one-key-per-architect generalization of #1463's Main mode, reusing #1463's
  `open-architect-terminal` verb.

What is **kept** from the issue and the architect's guidance: self-ordering/self-sizing by
`KeyAction.coordinates` (reuse #1465, do not reimplement), and **deriving the architect list
from the builders' distinct non-null `spawnedByArchitect`**, never from `OverviewData.architects`
(#1463's rationale: that live view carries three failure modes; deriving from builders needs no
new wire data and only ever offers an architect that owns visible work).

## Proposed Change

### 1. Reuse #1465's positional-ordering core (`apps/streamdeck/src/actions.ts`)

`SlotKey` (the Builder Action base) bundles two concerns: (a) tracking placed keys and ordering
them by coordinates with a debounced settle across the willAppear/willDisappear burst, and (b)
builder-window sizing + `builderFor`. Extract (a) into a shared base so the Architect Action key
reuses the *exact* ordering, not a copy:

- New `abstract class PlacedKeys<S>` (SingletonAction): owns the per-context `keys` map, the
  `onWillAppear` / `onWillDisappear` / `onDidReceiveSettings` tracking, `placedKeys()` (sorted by
  row then column, multi-action instances with `coordinates === undefined` excluded),
  `slotIndexOf(action)`, the `WINDOW_SETTLE_MS` debounced settle, and the `store.onChange`
  re-render subscription. Abstract `renderTo(action)`; an overridable `onPlacementChanged()` hook
  (default no-op) lets a subclass react when the placed-key set settles.
- `SlotKey extends PlacedKeys<SlotSettings>` — keeps the builder-specific parts unchanged:
  overrides `onPlacementChanged()` to call `store.setBuilderWindowSize(placedKeys().length)`,
  plus `builderFor`, `resolveVerb`, `onKeyDown`. The #1465 tests are the regression guard for
  this extraction.

### 2. Architect Action key (`apps/streamdeck/src/actions.ts`)

New `class ArchitectAction extends PlacedKeys<Record<string, never>>`:

- `manifestId = 'com.cluesmith.codev.architect-action'`. No Property Inspector, no verb, no
  settings — a placed key's identity is purely its slot rank (self-ordering, #1465).
- `architectFor(action)`: `store.architects()[slotIndexOf(action)]`, or `undefined` for a
  multi-action key / a slot past the end of the architect list.
- `onKeyDown`: resolve the architect at this key's slot; if none, `showAlert()` (inert). Else
  relay `open-architect-terminal [name]` (reuses #1463's verb; VSCode owns liveness and the
  not-found warning, so the deck never consumes the live-architect view). The shared builder
  selection is **untouched** — this key does not select, scope, or re-flow anything.
- `renderTo`: draw the architect-key face (below).

### 3. Store: derive the architect list (`apps/streamdeck/src/store.ts`)

A single addition — **no** `scopedArchitect`, **no** change to `builders()`:

- `architects(): string[]` — the distinct non-null `spawnedByArchitect` across `builders()`,
  de-duplicated, ordered **`main` first, then alphabetically**. This twins
  `sortArchitectsForPicker` (`apps/vscode/src/views/architect-display.ts:31`) — the order the
  VSCode architect picker already uses — replicated here (not imported across apps) with a
  sync-note, per the accepted twinned-presentation-map pattern. Main-first is **load-bearing**
  because the keys are positional: slot 1 is whichever architect sorts first, so this pins `main`
  (the one architect every workspace has) to the first key permanently — plain alphabetical would
  let a new architect named `ai`/`casa` silently displace it.

### 4. Face (`apps/streamdeck/src/face.ts`)

Add `architectKeyFaceSvg(name: string | undefined)`:

- present → the `architect` glyph (muted `#a9a9b2`) over `capitalizeFirst(name)`.
- `undefined` (a slot past the architect list) → **visibly empty**: dim `architect` glyph + a
  muted centered `—` (mirrors the empty Builder slot; never blank-but-live).

Reuses the existing `architect` glyph, `capitalizeFirst`, and the shared frame/text helpers. No
active/accent state — without a scope there is nothing to mark active.

### 5. Native switch button + custom Codev icon (assets + docs, **no switch code**)

The switch is a **native** Stream Deck action, so the plugin adds an **icon asset and wiring
docs**, not a page-switch key:

- Add a `switch` glyph to `face.ts`'s `GLYPHS` (a two-way swap arrow) and to `ICONS` in
  `scripts/render-action-icons.mjs`, so the render pipeline emits a Codev-styled PNG on the same
  rounded ground as the other key icons — it blends by construction.
- Document in the README how to wire it: place the Architect Action keys on a **second profile**
  (recommended) or a **Folder**, and set a native **Switch Profile** key (one on each profile,
  for a symmetric toggle) — or the Folder key — to the shipped switch icon. Stream Deck performs
  the flip; the plugin drives nothing.
- **Out of scope (explicit):** a plugin-*driven* programmatic switch via
  `switchToProfile(deviceId, profile, page)` needs bundled-profile authoring, deferred with
  #1381/#1440. The native route delivers the same button today without it.

### 6. Manifest, register, document

- Add an `Architect Action` action entry to `manifest.json` (UUID
  `com.cluesmith.codev.architect-action`, Keypad, `Icon: icons/list/architect-action`,
  `States[0].Image: icons/architect-action`, a Tooltip describing "opens the Nth architect's
  terminal; self-orders by placement"). No `PropertyInspectorPath`.
- Add `{ name: 'architect-action', glyph: 'architect' }` to `ICONS` and run the render script to
  generate the four PNGs (picker + key, @1x/@2x). Same for the `switch` icon.
- Register `ArchitectAction` in `plugin.ts`.
- Document the Architect Action key and the native switch wiring in the README `## Design`
  section.

## Files to Change

- `apps/streamdeck/src/actions.ts` — extract `PlacedKeys` from `SlotKey`; add `ArchitectAction`.
- `apps/streamdeck/src/store.ts` — add `architects()` (main-first, deduped).
- `apps/streamdeck/src/face.ts` — add `architectKeyFaceSvg`; add the `switch` glyph.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — new `Architect Action` entry.
- `apps/streamdeck/scripts/render-action-icons.mjs` — add `architect-action` and `switch` icons.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/architect-action*.png`,
  `icons/list/architect-action*.png`, `icons/switch*.png` — generated assets.
- `apps/streamdeck/src/plugin.ts` — register `ArchitectAction`.
- `apps/streamdeck/README.md` — document the key + native switch wiring under `## Design`.
- Tests: `actions.test.ts` (architect derivation, key→architect by slot, press relays
  `open-architect-terminal`, inert empty slot, multi-action no-slot, re-render on change),
  `face.test.ts` (architect-key face present/empty), and the existing
  `render-action-icons.test.ts` / `manifest-icons.test.ts` / `validate.test.ts` extend to the new
  icons+action automatically once assets and manifest are in place.

## Risks & Alternatives Considered

- **Alternative — scope/filter the builder list (the issue as written).** Rejected by the owner:
  redundant with the per-builder back-to-architect affordance, and the two-board switch is the
  wanted shape. Dropping it removes `scopedArchitect` and all shared-selection coupling.
- **Alternative — a plugin-driven switch key (`switchToProfile`).** Rejected: needs the deferred
  bundled-profile authoring (#1381/#1440). A native Switch Profile / Folder key with our custom
  icon is in-scope and delivers the same button.
- **Alternative — read `OverviewData.architects`.** Rejected (per #1463): it reports architects
  Tower can currently see a live session for and carries three failure modes. Deriving from
  builders needs no new wire data and only ever lists an architect that owns visible work.
- **Risk — more architects than placed keys.** Architect keys index `architects()` directly (no
  paging dial, unlike the builder window). Trailing architects beyond the placed keys are
  unreachable. *Mitigation:* place enough keys; document. Acceptable — architect counts are
  small, and `main` is always key 1.
- **Risk — refactoring the just-landed #1465 `SlotKey`.** *Mitigation:* the extraction is a pure
  move of the positional-ordering members into a base `SlotKey` still extends; the #1465 tests
  (window sizing, multi-action exclusion, slot press) stay green unchanged.

### #1406 impact (stated, not fixed — out of scope)

#1406 (spawn mis-attribution) makes `spawnedByArchitect` wrong/`null` when the
`CODEV_ARCHITECT_NAME` prefix is missing. Under this feature that surfaces as: a mis-attributed
builder contributes the **wrong** architect to `architects()` (a bad key on the architects
board / a wrong terminal target), and a `null`-attributed builder contributes **no** architect
(it simply doesn't appear on the architects board — but it is still fully present and actionable
on the unchanged builders board, so nothing becomes unreachable). This plan does not fix #1406.
*(Note: the architect's earlier request for a "null-attribution superset" test was tied to the
scoping model — proving a null builder stayed reachable under a filter. With no filter, the
builders board is never narrowed, so that reachability property holds trivially and the test is
moot; called out here so the drop is deliberate, not an omission.)*

## Test Plan

**Unit (vitest, run from the worktree):**

- `store.architects()`: distinct non-null `spawnedByArchitect`, de-duplicated, ordered `main`
  first then alphabetical (a fixture where `main` is not already first proves the pin); empty
  when no builder has an owner.
- `ArchitectAction`: key N (by coordinates) shows the Nth architect; press relays
  `open-architect-terminal [name]` with the selected workspace path and **no** selection change;
  a slot past the architect list is inert (`showAlert`, no relay); a multi-action instance
  (undefined coordinates) has no slot; re-renders on `store.onChange`.
- `face.architectKeyFaceSvg`: renders the capitalized name when present; the dim empty (`—`)
  state for `undefined`.
- Icon/manifest guards (`render-action-icons`, `manifest-icons`, `validate`) pass with the new
  action + `architect-action` and `switch` assets.

**Manual (dev-approval — hardware; native two-profile or Folder setup):**

The current fleet has **four architects owning builders** (`main`, `security`, `vscode`,
`streamdeck`); `reviewer` and `demos` own none. On the physical board:

1. **Builders board unchanged** — Row 1, Row 2, and the dials behave exactly as before.
2. **Architects board** — the placed Architect Action keys list `main` on key 1 (main-first),
   then `security` / `streamdeck` / `vscode` alphabetically; `reviewer` and `demos` **do not
   appear** (they own no builders) — the derive-from-builders decision made visible.
3. **Press an architect key** → that architect's terminal opens in VSCode. No builder selection,
   Row 1, or dial changes.
4. **The native switch button** (custom Codev icon) flips between the builders board and the
   architects board, and the icon reads as one of the Codev keys (blends with its neighbours).
5. An empty architect slot (more keys than architects) renders visibly empty, never blank-live.

I will capture this as a short narration in the review.
