# PIR Review: Stream Deck key to open the architect that spawned the selected builder

Fixes #1463

## Summary

Adds a Row-2 Stream Deck key, **Open Architect Terminal**, that opens an architect's
terminal in VS Code via the existing `open-architect-terminal` verb. It has two
Property-Inspector modes: **Builder** (default — follows the selected builder and
opens the architect that spawned it, `spawnedByArchitect`; inert when nothing is
selected or the builder has no owner) and **Main** (always the workspace's `main`).
The key renders a live face — the constant title `Architect` over the resolved
architect's name — so you see who a press would summon. As a coherence fix, the two
terminal keys were renamed as a symmetric pair: the pre-existing **Open Terminal**
became **Open Builder Terminal** (face `Terminal` → `Builder`, terminal glyph kept).

## Files Changed

Code (`apps/streamdeck`), vs merge-base `3f7061d4a`:

- `src/actions.ts` (+86 / -8) — new `OpenArchitectAction`; builder-key doc + face label rename
- `src/face.ts` (+46 / -8) — `architect` glyph, `capitalizeFirst`, `architectFaceSvg`; optional dim color on the line helpers
- `src/plugin.ts` (+2) — register `OpenArchitectAction`
- `com.cluesmith.codev.sdPlugin/manifest.json` (+20 / -3) — new action entry; paired rename of the two keys
- `com.cluesmith.codev.sdPlugin/ui/open-architect.html` (+26, new) — Property Inspector (Builder/Main select)
- `scripts/render-action-icons.mjs` (+1) — add `open-architect` to `ICONS`
- `icons/{,list/}open-architect{,@2x}.png` (4 new) — rendered from the `architect` glyph
- `README.md` (+39 / -10) — key docs, both renames, layout diagram, known edges, Row-1 caveat
- `src/__tests__/{actions,face,manifest-icons,render-action-icons}.test.ts` (+152) — behavior + face + icon tests
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — cold-tier notes (see below)

## Commits

- `44726b1fe` Add architect glyph + architectFaceSvg (title/subtitle, dim None) and its rendered icons
- `af32dba3d` OpenArchitectAction: two-mode (Builder/Main) Row-2 key, dynamic face, inert when unresolved
- `361af2633` Manifest action + Property Inspector (target: Builder/Main) for Open Architect
- `2f23f332c` README: document Open Architect key, its modes, and known edges
- `d0ae5b9ce` Rename the terminal keys as a pair: Open Builder Terminal / Open Architect Terminal (face 'Terminal'→'Builder')
- (plan/thread commits omitted)

## Test Results

- `pnpm --filter @cluesmith/codev-streamdeck build`: ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck check-types` (tsc): ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ pass (197 tests, 11 new)
- `pnpm --filter @cluesmith/codev-streamdeck validate` (Elgato): ✓ pass
- Manual (dev-approval, hardware, approved by Amr): both PI modes, the inert `None`
  face, the missing-main face, and the already-placed Open Terminal key surviving
  the rename (now reads `Builder`).

## Architecture Updates

**HOT (`arch-critical.md`): none.** This is one key's behavior, not a system-shape
invariant, and the hot file is at its cap.

**COLD (`arch.md`, Integration Points → Stream Deck ↔ VSCode coherence):** added a
bullet recording the key, its two modes, and — the decision a future reader would
otherwise re-derive — **why the deck delegates `main`-else-first to VS Code instead
of resolving it itself**: VS Code's `openArchitectTerminal` already special-cases
the literal `'main'`, so keeping the policy there means *one policy, one home*, and
it is precisely what let the deck **stop consuming `OverviewData.architects` (the
live-architect view) entirely** — dropping the first-live fallback and a store
reader that would have coupled the deck to a transiently-wrong view. The bullet also
records the two accepted residuals and the UUID-stability property (below).

## Lessons Learned Updates

**HOT (`lessons-critical.md`): none** — the core reuse decision ("delegate the
policy to its single existing home rather than duplicate it on the client") is
already covered by the standing hot lesson *"Single source of truth beats
distributed state."* This PR is an instance of it, not a new rule.

**COLD (`lessons-learned.md`, UI/UX):** added a lesson that a Stream Deck action's
identity is its **UUID, not its `Name`** — renaming `Name`/`Tooltip`/face leaves
already-placed keys working as long as the UUID is unchanged; change the UUID and you
orphan them. Included the `render-action-icons.mjs` gotchas (glyph line must carry no
trailing comment; the script re-touches all icons, so restore byte-churned
pre-existing PNGs to keep the diff scoped).

## Things to Look At During PR Review

- **The face is the safeguard, not decoration.** The resolved architect name on the
  subtitle is the only thing between the user and a wrong-architect press, so it must
  render in every mode including the inert `None` state. `architectFaceSvg(undefined)`
  is the dim/`None` face; `face.test.ts` pins all three (`Main`, a sibling name,
  `None`).
- **`resolve()` returns `string | undefined`.** `undefined` (Builder mode, no
  selection / no owner) is the only inert path; Main mode always resolves to `'main'`.
  A named-but-not-live target is *not* inert — the name flows to VS Code, which owns
  the not-found warning (deliberate; ruling 2).
- **Two accepted residuals (documented, not chased):** (1) in **Main** mode when
  `main` is absent, VS Code opens the first live architect while the face still reads
  `Architect / Main` — the relay is fire-and-forget, so the deck never learns which
  opened; narrow (a workspace with architects but no `main`) and pre-existing VS Code
  behaviour, not introduced here. (2) A live architect registration behind a **dead
  PTY** resolves fine and opens a terminal nobody reads — the deck can't detect it.
  Deck-side verification would reintroduce exactly the live-view coupling this design
  removed, so both are limitations, not oversights.
- **The paired rename is UUID-stable.** Both UUIDs (`open-terminal`,
  `open-architect`) are unchanged; only `Name`/`Tooltip`/face moved. That is what
  protects keys users already placed, and it's invisible in a diff — verified on
  hardware at dev-approval.
- **`#1406` is a live prerequisite, not a footnote.** Spawn mis-attribution (a
  builder registered under `main` when `CODEV_ARCHITECT_NAME` is absent) makes
  **Builder** mode summon the wrong architect. The face shows the (currently wrong)
  stored owner, which makes it *noticeable* before a press but cannot *correct* it.
  This key should not ship broadly until #1406 is fixed or confirmed.
- **Out of scope, tracked in #1465:** Row 1's builder window is a fixed page of four,
  so placing the Main-mode key on a Row-1 key leaves three builder slots and hides
  every fourth builder past a three-builder fleet. Self-sizing the window is #1465.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1463` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1463`
- **What to verify** (maps to the plan's Test Plan):
  - Builder mode (default): the face reads `Architect / <owner>` and the subtitle
    tracks the Row-1 selection across builders owned by different architects; press
    opens that architect.
  - Builder mode, no owner / no selection: face dims to `Architect / None`; press is
    inert.
  - Main mode: face reads `Architect / Main`; press opens `main` regardless of
    selection.
  - The already-placed **Open Terminal** key still works and now reads `Builder`
    (UUID stability).
