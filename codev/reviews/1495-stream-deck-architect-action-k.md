# PIR Review: Stream Deck Architect Action key — a board of architects

Fixes #1495

## Summary

Adds a **Architect Action** key to the Stream Deck plugin: a self-ordering board that enumerates
the workspace's live architects, one key each, where a press opens that architect's terminal. It
lives on a second page/profile you reach with a native Stream Deck swipe or Switch-Profile/Folder
key (the plugin ships a Codev-styled `switch` icon to blend that native key in). The feature
started life in #1495 as a fleet-*scoping* cursor and was reshaped twice by owner decision into a
plain second board — no scope, no builder filtering, one shared builder selection untouched.

## Files Changed

Against the merge-base (`e53cab9`):

- `apps/streamdeck/src/actions.ts` (+211 / −117 across the file) — extracted a `PlacedKeys` base
  out of `SlotKey` (reuses #1465's coordinate self-ordering) and added `ArchitectAction`; amended
  `OpenArchitectAction`'s doc comment to narrow the since-changed "never consumes the live view" rule.
- `apps/streamdeck/src/store.ts` (+44) — `architects()` (names of `OverviewData.architects`, `main`
  sorted first, never pinned).
- `apps/streamdeck/src/face.ts` (+30 / −...) — `architectKeyFaceSvg`; new `switch` glyph.
- `apps/streamdeck/src/plugin.ts` (+2) — register `ArchitectAction`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` (+15) — new `Architect Action` action.
- `apps/streamdeck/scripts/render-action-icons.mjs` (+2) — `architect-action` + `switch` icons.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/{architect-action,switch}{,@2x}.png` +
  `icons/list/{architect-action,switch}{,@2x}.png` — generated assets (8 new PNGs).
- `apps/streamdeck/README.md` (+135 / −...) — Design + Actions entries and a two-page recommended
  layout (builders / architects, shared dials).
- `apps/streamdeck/src/__tests__/actions.test.ts` (+116), `face.test.ts` (+24 / −...),
  `manifest-icons.test.ts` (+2 assertions pinning the manifest-less `switch` PNGs) — 16 new tests.
- `codev/resources/lessons-learned.md` — one UI/UX lesson (enumerate-vs-resolve; sort-not-pin).
- `codev/plans/1495-*.md`, `codev/state/pir-1495_thread.md` — plan + builder thread.

## Commits

`git log main..HEAD --oneline` (implementation commits; porch phase-transition commits omitted):

- `ac3925b` [PIR #1495] Architect Action: live-architect enumeration, PlacedKeys base, face
- `f602541` [PIR #1495] Manifest action + architect-action/switch icons
- `0f8938a` [PIR #1495] Register ArchitectAction; document board + native switch
- `72aecfc` [PIR #1495] Tests: architects() enumeration, ArchitectAction, key face
- `c69525e` [PIR #1495] Plan: live-architect enumeration + four rulings; thread update
- `e43eb8b` [PIR #1495] README: two-page layout (builders / architects), shared dials
- `18cfc28` [PIR #1495] README: stack the two page diagrams vertically

## Test Results

- `npm run check-types` (tsc): ✓ pass
- `npm run build` (esbuild): ✓ pass
- `npm run validate` (Elgato manifest/icon validation): ✓ pass
- `npm test`: ✓ pass — **233 tests, 16 new** (14 for the architect board + 2 pinning the
  manifest-less `switch` PNGs; the existing #1465 windowing, manifest-icons, render-action-icons,
  and validate guards all stayed green through the `SlotKey`→`PlacedKeys` extraction).
- Manual (dev-approval, on hardware): approved after relinking the plugin to this worktree and
  driving a two-page profile — builders on page 1, Architect Action keys on page 2 reached by
  **swipe**; the architect keys enumerate the live fleet and a press opens the architect's terminal.
  The owner elected **page-swipe** for board navigation over a switch *button* (his words: "swiping
  is enough"). The Folder / Switch-Profile switch button is an **optional native Stream Deck
  affordance** (not plugin code — the plugin only supplies the `switch` icon); its wiring is
  documented in the README but it was not itself exercised on hardware, since page-swipe is the
  chosen navigation and the switch key's behavior is Stream Deck's, not ours.

## Architecture Updates

**No hot (`arch-critical.md`) or cold (`arch.md`) changes.** This is an app-local Stream Deck
feature: it adds one action and one store selector, crosses no module boundary, changes no wire
contract (it reads the existing `OverviewData.architects` field), and introduces no system-shape
invariant. The deck's own design rationale lives in `apps/streamdeck/README.md` — kept in-tree by
`readme-design.test` — which this PR extends, so the architecture record stays there rather than in
the governance docs.

## Lessons Learned Updates

**Cold (`lessons-learned.md`), UI/UX section — one entry [From #1495].** The durable insight is
that #1463's "the deck never consumes the live-architect view" is really "the deck never *resolves*
liveness": safety hinges on a key's **arity**, not its data source. A single-target key that
resolves one name from a stale list fails **silently** (wrong name rendered faithfully); an
enumeration board that relays each name for the editor to resolve fails **loudly**. So the
Architects board safely enumerates the live view where #1463's key must not. Corollary (filed as
#1497): sort a privileged default first but never *pin* it, because an explicit `'main'` arms
VSCode's main-else-first fallback. Routed cold because it is Stream-Deck-specific, not a
cross-cutting rule for every surface.

(The related "icon render script regenerates all icons / restore byte churn" and "size a window
from placed keys" insights were already captured under #1463 and #1465 respectively; not
duplicated.)

## Things to Look At During PR Review

- **`SlotKey` → `PlacedKeys` extraction** (`actions.ts`). The positional-ordering core (keys map,
  coordinate sort, `slotIndexOf`, debounced settle, `onChange` render) moved to a non-generic base
  that both `SlotKey` and `ArchitectAction` extend. `SlotKey` keeps window-sizing via an
  `onPlacementChanged()` hook. The base is deliberately **non-generic**: per-key settings are never
  used in rendering, so they're read from the press event — this sidesteps needing the SDK's
  `JsonObject` type, which the import-boundary guard bans (`@elgato/utils`) and which isn't
  re-exported from `@elgato/streamdeck`. The #1465 tests are the regression guard.
- **`architects()` reads the LIVE view, not `spawnedByArchitect`.** This reverses the plan's
  original derivation (owner decision). `store.ts`'s comment and the amended `OpenArchitectAction`
  comment both warn against "restoring" the builder-derived version — please don't take those as
  stale.
- **`main` is sorted, never pinned** — see the #1497 reasoning in `store.ts`. An injected `main`
  would be a silent-wrong-target regression on the most-pressed key.
- **The switch is native, not a plugin action** — the plugin ships only the `switch` *icon*; a
  plugin-driven `switchToProfile` toggle is out of scope (deferred #1381/#1440).

**3-way consultation (single pass): Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES.** All
three Codex points were documentation/verification (implementation called "sound"). Dispositions
(full text in `codev/projects/1495-*/1495-review-iter1-rebuttals.md`):
- *Fixed* — added README "Wiring the native switch" steps (which native key gets the `switch.png`).
- *Fixed* — removed a stale "Main-mode key in Row 1 slot 1" recommendation that contradicted the
  new two-page layout.
- *Partially rebutted + gap closed* — Codex pointed at the switch-button *press*, which is genuinely
  **not ours** (a native Switch-Profile / Folder key runs Elgato's code, out of scope; the owner
  also chose page-swipe over a button). But underneath it was a real gap: the four `switch` PNGs
  were the plugin's one shipped asset with **no test coverage**, because they are manifest-less and
  `manifest-icons.test.ts`'s generic loop only walks `manifest.Actions`. **Closed** by adding
  explicit existence + convention-size assertions for the switch PNGs. The seam this fell through:
  the icons + README procedure are *ours* while looking like the platform's. PIR is single-pass —
  please sanity-check this disposition at the gate.

## How to Test Locally

For reviewers pulling the branch:

- **Build**: `pnpm --filter @cluesmith/codev-sdk build && pnpm --filter @cluesmith/codev-streamdeck build`.
- **Sideload**: `streamdeck unlink com.cluesmith.codev` then
  `streamdeck link <worktree>/apps/streamdeck/com.cluesmith.codev.sdPlugin` and
  `streamdeck restart com.cluesmith.codev` (relink to your main checkout when done).
- **What to verify** (maps to the plan's Test Plan):
  - Place several **Architect Action** keys → they list the live architects, `main` first, then
    alphabetical, **including architects that own no builders** (that's the whole point of reading
    the live view). Trailing slots read a dim `No architect`.
  - Press one → its terminal opens in VSCode; the builder selection / Row 2 / dials are untouched.
  - Put the keys on a second page and swipe between builders and architects; the shared dials keep
    acting on the selected builder on either page.

## Flaky Tests

None.

## Protocol Note — the pir-1495 lane reproduced #1462 live

Worth recording as evidence, because #1462 was filed off an *inference* and this is a clean
reproduction: **the protocol wrote its own gate record onto the branch and thereby invalidated the
merge window that record had just opened.**

Two porch bookkeeping commits — `52f88dfe` ("pr gate-approved") and `c67edf53c` ("protocol
complete") — landed on `builder/pir-1495` *after* the `pr` gate was approved. They moved the branch
head off the SHA the gate record was taken against and **restarted all seven required checks**. So
at the moment the gate opened the merge window, the branch's own gate-bookkeeping commits bumped the
head and re-pended the checks, and the merge (`gh pr merge --merge`) was refused —
`mergeStateStatus=BLOCKED` against the new head — until the checks went green again on a now-
*stationary* head (`c67edf53c`), verified per-run by its own `headSha` rather than by board
association.

The generalisable shape: on a branch that has **required status checks** *and* a protocol that
**commits its own gate bookkeeping to that same branch**, the gate-approval SHA and the mergeable
SHA differ by the protocol's own commits — so the window opens and immediately closes itself, and
the merge can only land after the checks re-settle on the post-bookkeeping head. (No code in this
PR is involved; recorded here because the review is where a reader will look for evidence of #1462.)
