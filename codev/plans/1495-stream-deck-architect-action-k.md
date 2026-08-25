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
`KeyAction.coordinates` (reuse #1465, do not reimplement).

### The architect list is the LIVE ARCHITECT VIEW (owner decision, 2026-08-18)

The board enumerates **`OverviewData.architects`** — the names of the workspace's architects with
a live session — **not** the distinct `spawnedByArchitect` values across the builders. The board
now *summons* (ruling 3 lifted), so the list must be "architects that **exist**", every one of
them, not "architects that own visible work". Verified on the live fleet: six architects are live
(`main`, `security`, `streamdeck`, `demos`, `vscode`, `reviewer`) and only four own builders — a
builders-derived list would render four keys and leave `demos` and `reviewer` **permanently
unopenable** from the deck.

**Why this does not violate #1463 ("the deck never consumes the live-architect view").** That
ruling guards against a *silently wrong action* on a **single-target** key: a stale list could
resolve the wrong architect and the face would faithfully render the wrong name, so the human
never learns. An **enumeration** board has a different failure shape — the press relays
`open-architect-terminal <name>` and VSCode performs resolution, including its "No 'X' architect
found — is the workspace activated?" warning, so a stale/incomplete list yields a key that **fails
loudly** when pressed, never one that quietly opens the wrong person. The principle behind the
ruling — *the deck does not RESOLVE liveness* — stays intact: this board enumerates candidates and
still delegates resolution to VSCode. #1463's key is unchanged.

**Read `OverviewData.architects`, never `DashboardState.architects`.** Both are filled by the same
`liveArchitects` helper (sessionless architects skipped), but `DashboardState`'s doc comment wrongly
says "Full collection of *registered* architects… empty means no architect is registered" — that
sentence is filed as #1496, and a sibling lane (#1494) already built on the lie. `OverviewData`'s
comment is correct: "Only architects with a live session are listed… `[]` when the workspace has no
architects OR none are live." Never infer "no architect exists" from an empty list — empty means
none live, nothing more.

**The three failure modes, decided here (not at implement time):**

- **(a) Empty list during a Tower restart / sessions not yet reattached.** These are *physical* key
  placements that cannot vanish, so an emptied board renders **visibly inert** keys (dim glyph +
  dim `No architect`), never blank-but-live — self-correcting on the next overview.
- **(b) Transiently missing `main`.** Enumerate the live view **exactly as it comes; pin nothing**
  (see the declined recommendation below).
- **(c) A live row behind a dead PTY.** A key that opens nothing; VSCode owns the not-found warning.
  **Accept and document it — add no deck-side pre-validation**, which would re-import the liveness
  resolution we are deliberately keeping out.

**Declined: do not pin `main` unconditionally.** Pinning `main` to key 1 even when it has no live
session is *unsafe*, not just unnecessary. VSCode resolves an explicit `'main'` as main-else-first
(`const fallback = targetName === 'main' ? architects[0] : undefined; const target = match ??
fallback`, `extension.ts`). So a pinned `main` key pressed while `main` is transiently invisible
does **not** fail loudly — an explicit `'main'` arms VSCode's main-else-first fallback (**#1497**),
so a pinned key could silently open the wrong architect's terminal under main's own *unqualified*
label, and only self-corrects on the next press once `main` is live (full trace on #1497). That is
exactly the silently-wrong-action failure ruling 2 exists to prevent, on the one key most likely to
be pressed (the documented #1463 residual, by a new route). An **unpinned** `main` key is simply
*absent* during the flicker: visible, self-correcting on the next overview, and unable to open the
wrong person — the safer failure. We therefore **sort** main-first (so `main` sits on key 1
whenever it is live) but never **inject** it when absent.

## Proposed Change

### 1. Reuse #1465's positional-ordering core (`apps/streamdeck/src/actions.ts`)

`SlotKey` (the Builder Action base) bundles two concerns: (a) tracking placed keys and ordering
them by coordinates with a debounced settle across the willAppear/willDisappear burst, and (b)
builder-window sizing + `builderFor`. Extract (a) into a shared base so the Architect Action key
reuses the *exact* ordering, not a copy:

- New `abstract class PlacedKeys` (SingletonAction): owns the per-context `keys` map (action
  handle + coordinates only), the `onWillAppear` / `onWillDisappear` / `onDidReceiveSettings`
  tracking, `placedKeys()` (sorted by row then column, multi-action instances with
  `coordinates === undefined` excluded), `slotIndexOf(action)`, the `WINDOW_SETTLE_MS` debounced
  settle, and the `store.onChange` re-render subscription. Abstract `renderTo(action)`; an
  overridable `onPlacementChanged()` hook (default no-op) lets a subclass react when the
  placed-key set settles. The base is **non-generic** — per-key settings are never used in
  rendering (both key types render from the store), so they are read from the press event where
  needed rather than tracked here, which sidesteps needing the SDK's `JsonObject` type (the
  import-boundary guard bans `@elgato/utils`, and it is not re-exported from `@elgato/streamdeck`).
- `SlotKey extends PlacedKeys` — keeps the builder-specific parts unchanged: overrides
  `onPlacementChanged()` to call `store.setBuilderWindowSize(placedKeys().length)`, plus
  `builderFor`, `resolveVerb` (now reading the `verb` off the raw press-event settings), and
  `onKeyDown`. The #1465 tests are the regression guard for this extraction.

### 2. Architect Action key (`apps/streamdeck/src/actions.ts`)

New `class ArchitectAction extends PlacedKeys`:

- `manifestId = 'com.cluesmith.codev.architect-action'`. No Property Inspector, no verb, no
  settings — a placed key's identity is purely its slot rank (self-ordering, #1465).
- `architectFor(action)`: `store.architects()[slotIndexOf(action)]`, or `undefined` for a
  multi-action key / a slot past the end of the architect list.
- `onKeyDown`: resolve the architect at this key's slot; if none, `showAlert()` (inert). Else
  relay `open-architect-terminal [name]` (reuses #1463's verb; VSCode owns liveness and the
  not-found warning — the deck enumerates candidates but does not RESOLVE liveness). The shared
  builder selection is **untouched** — this key does not select, scope, or re-flow anything.
- `renderTo`: draw the architect-key face (below).

### 3. Store: enumerate the live architect list (`apps/streamdeck/src/store.ts`)

A single addition — **no** `scopedArchitect`, **no** change to `builders()`:

- `architects(): string[]` — the `name`s of `OverviewData.architects` (the workspace's architects
  with a live session), ordered **`main` first, then alphabetically**. This twins
  `sortArchitectsForPicker` (`apps/vscode/src/views/architect-display.ts:31`) — the order the
  VSCode architect picker already uses — replicated here (not imported across apps) with a
  sync-note, per the accepted twinned-presentation-map pattern. Main-first keeps `main` on key 1
  **whenever it is live**; we **sort** main-first but never **pin/inject** it when absent (see the
  declined recommendation above). Tower already returns the list main-first; we sort anyway rather
  than depend on the server's order.

### 4. Face (`apps/streamdeck/src/face.ts`)

Add `architectKeyFaceSvg(name: string | undefined)`:

- present → the `architect` glyph (muted `#a9a9b2`) over `capitalizeFirst(name)` as the prominent
  line (shrink-to-fit for long names).
- `undefined` (a slot past the live list, or an empty board during a Tower restart) → **visibly
  inert**: dim `architect` glyph + dim `No architect` (never blank-but-live; self-corrects on the
  next overview).

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
- `apps/streamdeck/src/store.ts` — add `architects()` (names of `OverviewData.architects`,
  main-first sort, no pin).
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
- **Alternative — derive the list from the builders' `spawnedByArchitect`.** Rejected by the
  owner (2026-08-18): a summoning board must list "architects that exist", so a live architect
  owning no builders (`demos`, `reviewer`) must still get a key — a builders-derived list would
  leave them permanently unopenable. Enumerating `OverviewData.architects` is safe here precisely
  because the board summons and delegates resolution to VSCode (fails loudly), unlike a
  single-target key (see the live-view section above). This was the *original* plan's derivation;
  the amended `OpenArchitectAction` doc comment and the `architects()` reasoning both warn a future
  maintainer against "restoring" it.
- **Risk — more architects than placed keys.** Architect keys index `architects()` directly (no
  paging dial, unlike the builder window). Trailing architects beyond the placed keys are
  unreachable. *Mitigation:* place enough keys; document. Acceptable — architect counts are
  small, and `main` sorts to key 1 whenever live.
- **Risk — refactoring the just-landed #1465 `SlotKey`.** *Mitigation:* the extraction is a pure
  move of the positional-ordering members into a base `SlotKey` still extends; the #1465 tests
  (window sizing, multi-action exclusion, slot press) stay green unchanged.

### #1406 impact (stated, not fixed — out of scope)

#1406 (spawn mis-attribution) makes a builder's `spawnedByArchitect` wrong/`null`. Because the
Architects board now enumerates `OverviewData.architects` (the live *sessions*), **not**
`spawnedByArchitect`, this feature is largely **insulated** from #1406: the board lists the
architects that have a session regardless of how their builders are attributed. #1406 still
mis-attributes builders elsewhere (wrong summon target on #1463's per-builder key, wrong `afx
status`), but it does not corrupt this board's list. This plan does not fix #1406.
*(Note: the architect's earlier request for a "null-attribution superset" test was tied to the
scoping model — proving a null builder stayed reachable under a filter. That model is gone. The
inverse property now matters instead and is tested below: an architect with **zero** builders
still appears, because the list is the live view, not the builder-derived one.)*

## Test Plan

**Unit (vitest, run from the worktree):**

- `store.architects()`: returns the `name`s of `OverviewData.architects`, ordered `main` first
  then alphabetical (a fixture where `main` is not already first proves the sort); **an architect
  with zero builders still appears** (the inverse of the dropped superset test — pins that the
  board lists "architects that exist", not "architects that own work"); `[]` when the overview has
  no live architects (and this is *not* read as "no architects exist").
- `ArchitectAction`: key N (by coordinates) shows the Nth architect; press relays
  `open-architect-terminal [name]` with the selected workspace path and **no** selection change;
  a slot past the architect list is inert (`showAlert`, no relay); a multi-action instance
  (undefined coordinates) has no slot; re-renders on `store.onChange`.
- `face.architectKeyFaceSvg`: renders the capitalized name when present; the dim inert
  `No architect` state for `undefined`.
- Icon/manifest guards (`render-action-icons`, `manifest-icons`, `validate`) pass with the new
  action + `architect-action` and `switch` assets.

**Manual (dev-approval — hardware; native two-profile or Folder setup):**

The current fleet has **six live architects** (`main`, `security`, `streamdeck`, `demos`,
`vscode`, `reviewer`); only four own builders. On the physical board:

1. **Builders board unchanged** — Row 1, Row 2, and the dials behave exactly as before.
2. **Architects board** — the placed Architect Action keys list **all six** live architects,
   `main` on key 1 (main-first) then the rest alphabetically. Crucially `demos` and `reviewer`
   **DO appear** even though they own no builders — the live-view enumeration made visible (a
   builders-derived list would have wrongly omitted them).
3. **Press an architect key** → that architect's terminal opens in VSCode. No builder selection,
   Row 1, or dial changes. Pressing an architect that has since gone away fails loudly via
   VSCode's "No 'X' architect found" warning (the deck adds no pre-validation).
4. **The native switch button** (custom Codev icon) flips between the builders board and the
   architects board, and the icon reads as one of the Codev keys (blends with its neighbours).
5. An empty architect slot (more keys than live architects) renders the dim, inert `No architect`
   face, never blank-but-live.

I will capture this as a short narration in the review.
