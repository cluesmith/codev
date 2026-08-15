# PIR Plan: Stream Deck key to open the architect that spawned the selected builder

## Understanding

The deck can act on every builder (open artifact, approve gate, run dev, send
feedback, open terminal) but cannot reach a single architect. When a review
raises something the builder can't settle, the next move is talking to whoever
owns the lane — today that means leaving the deck for the mouse.

This adds one **builder-scoped** Row-2 key with a **two-mode** Property
Inspector, so the user's intention is set in config and shown on the face:

- **Builder's architect** (default) — opens the terminal of the architect that
  spawned the **selected builder** (`OverviewBuilder.spawnedByArchitect`). This is
  the everyday contextual key: *talk to whoever owns the work I'm reviewing.*
- **Main architect** — always opens the workspace's `main` architect. The
  deliberate-escalation instance, and how `main` is reached without a main-owned
  builder selected.

There is **no positional fallback** in either mode: Builder mode opens exactly
the recorded owner (or is inert), and Main mode opens exactly `main`. Because
neither mode can silently resolve to an *unexpected* architect, the design needs
no "guess a substitute" logic — and the face still shows the resolved name, so
you see who you'd summon before pressing.

This supersedes the issue's earlier free-text `Automatic`/pin revision (owner
comment `5300180262`): two explicit modes restore deliberate `main`-reachability
(the revision's goal) without a free-text field, without a positional fallback,
and without breaking the Row-2 invariant that every key acts on the selection.

### Existing wiring this reuses (verified)

- Verb `open-architect-terminal` is already in the relay allowlist
  (`apps/vscode/src/command-relay.ts:62` → `codev.openArchitectTerminal`); args
  are forwarded verbatim (only `approve-gate` is arg-filtered), so
  `sendCommand('open-architect-terminal', [name], ws)` reaches
  `executeCommand('codev.openArchitectTerminal', name)` unchanged.
- `codev.openArchitectTerminal(architectName?)` resolves the workspace's architect
  list, opens the match, and for the literal `'main'` opens `main` if present else
  the first architect (`apps/vscode/src/extension.ts:920-922`); an unresolvable
  name shows `No '<name>' architect found` and returns `undefined`. The deck
  passes a name and never second-guesses liveness (ruling 2).
- `OverviewBuilder.spawnedByArchitect: string | null` is on the wire the deck
  reads (`packages/types/src/api.ts:201`, re-exported via
  `@cluesmith/codev-sdk/controller`). Architect names are validated lowercase
  `[a-z][a-z0-9-]*` (`packages/sdk/src/architect-name.ts:41`), so the deck applies
  a first-letter-capitalize for display. **No types / Tower / relay change.**

### Relationship to the existing Codev Action key (kept as-is)

The configurable **Codev Action** key lists `Open Architect Terminal` in its verb
menu (`ui/codev-action.html:15`), but `CodevAction` fires every verb with **no
args**, so that entry sends `open-architect-terminal` with no name — VS Code's
undefined path: a manual **QuickPick** (or `main` when there's a single
architect), on a static generic face. That is a different, manual affordance
(pick every press, no builder context, no target on the face). It stays as the
generic escape hatch; the new key is the zero-friction, legible complement. No
change to `codev-action.html`.

## Proposed Change

A new key action `OpenArchitectAction` with a dynamic composite face.

### 1. The action class (`apps/streamdeck/src/actions.ts`)

The issue named a `VerbKey` subclass, but `VerbKey` paints its face **once** in
`onWillAppear` (see `DevServerAction`/`OpenTerminalAction`, static
`labelFaceSvg`). This key's face must re-render on selection change (Builder mode
reads `selectedBuilder()`) and settings change (mode toggle). That is exactly the
shape `ApproveGate`/`SendQueueAction` already use — the other two Row-2
selection-scoped keys with a dynamic composite face: a `SingletonAction` tracking
its `KeyAction`s in a per-context `Map`, subscribing to `store.onChange`, and
re-rendering. **Ratified at plan-approval:** use that shape.

- **Settings**: `{ target?: 'builder' | 'main' }`, default `'builder'`.
- **Resolution** (`resolve(settings): string | undefined`, shared by press and
  render):
  - `target === 'main'` → `'main'` (always resolvable; VS Code handles the
    main-else-first + not-found edges).
  - `target === 'builder'` (default) → `selectedBuilder()?.spawnedByArchitect ??
    undefined`. `undefined` when nothing is selected or the builder has no owner —
    the inert case (ruling 3).
- **Press** (`onKeyDown`): `const name = resolve(settings)`. If `undefined`,
  `showAlert` and do nothing (inert). Otherwise
  `sendCommand('open-architect-terminal', [name], selectedWorkspacePath())`, then
  `ack` (red alert on failure; silent success, matching the other keys).
- **Render** (`renderTo`): `setImage(svgToDataUri(architectFaceSvg(resolve(settings))))`
  + `setTitle('')`, called from `onWillAppear`, `onDidReceiveSettings`, and the
  `onChange` subscription.

No store change is needed: Builder mode reads the existing
`selectedBuilder().spawnedByArchitect`, Main mode fires the literal `'main'`.

### 2. The face (`apps/streamdeck/src/face.ts`)

- Add an `architect` glyph to `GLYPHS`/`GlyphKey` — a person/owner mark in the
  same line-glyph style as the codicon-modelled shapes.
- Add `capitalizeFirst(name)` (deck-local: `char0.toUpperCase() + rest`; the wire
  name is lowercase). Kept in-plugin — not a twin of VS Code's
  `displayArchitectName` (which upper-cases to mark a mixed architect tier the
  deck doesn't have); the deck's own labels are Title-case.
- Add `architectFaceSvg(name: string | undefined)` using the existing
  **title/subtitle** band (primary + secondary lines, like the Builder/Approve
  faces):
  - **Title** (primary, bold, constant): `Architect`.
  - **Subtitle** (secondary, muted): `capitalizeFirst(name)` when a name resolves
    (`main`→`Main`, `streamdeck`→`Streamdeck`); the secondary line's existing
    `fit()` guard shrinks long names (`Ob-refine`, `Architect-2`).
  - **Inert** (`name === undefined`): whole face dimmed, subtitle `None`, so an
    unavailable key is legible at a glance — visibly unavailable, never silently
    inactive.

So the two modes read `Architect / Main` vs `Architect / <owner>`, diverging
exactly when the owner isn't `main`.

### 3. Manifest + Property Inspector

- `com.cluesmith.codev.sdPlugin/manifest.json`: add Action
  `com.cluesmith.codev.open-architect` (Name "Open Architect", Keypad, `Icon:
  icons/list/open-architect`, `States[0].Image: icons/open-architect`,
  `PropertyInspectorPath: ui/open-architect.html`, a Tooltip describing the two
  modes).
- `com.cluesmith.codev.sdPlugin/ui/open-architect.html`: a `<sdpi-select
  setting="target" default="builder">` with two options — "Builder's architect
  (follows the selected builder)" and "Main architect" — plus a one-line help
  note. Mirrors `builder-action.html`'s shape.
- Icons: add `{ name: 'open-architect', glyph: 'architect' }` to `ICONS` in
  `apps/streamdeck/scripts/render-action-icons.mjs` and run it
  (`node scripts/render-action-icons.mjs`; `rsvg-convert` + `magick` verified
  installed) to emit the four PNGs (`icons/open-architect.png` 72, `@2x` 144,
  `icons/list/open-architect.png` 20, `@2x` 40). The pipeline parses the glyph
  vector straight out of `face.ts`, so the picker icon and the runtime key agree
  by construction.

### 4. Registration (`apps/streamdeck/src/plugin.ts`)

Export `OpenArchitectAction`; add `new OpenArchitectAction(store)` to `actions`.

### 5. README guidance (`apps/streamdeck/README.md`)

Document the two modes; recommended home is Row 2 alongside the builder-scoped
keys; the natural donor slot is **Send Feedback while the workspace is in forward
mode** (inert there by design); unplacing a key leaves the action in the picker;
the trade disappears with a larger profile (#1381). Note the known edges: Main
mode shows `Main` even if VS Code opens the first architect when `main` isn't live
(mode reflects configured intent), and a live registration behind a dead PTY
opens a terminal nobody reads (the deck can't detect it).

Placement caveat (Row 1): the Main-mode key is selection-independent, so it may
live on a Row-1 key without affecting the selection model — but Row 1's window is
a fixed page of `ROW1_WINDOW_SIZE = 4` (`store.ts:28`), independent of how many
BuilderAction keys are placed. Putting a key there leaves 3 builder slots against
that page-of-4, so at 4+ concurrent builders every 4th builder renders on no key
(fine when the working set is ≤ 3). Recommended for small working sets; otherwise
keep Main on Row 2 or a larger profile. Self-sizing the window from placed keys is
tracked separately in **#1465** — out of scope here.

## Files to Change

- `apps/streamdeck/src/actions.ts` — new `OpenArchitectAction` (SingletonAction +
  keys-map + `onChange`; two-mode resolve → press → render).
- `apps/streamdeck/src/face.ts` — new `architect` glyph; `capitalizeFirst`;
  `architectFaceSvg(name | undefined)` (title/subtitle, dim `None` when inert).
- `apps/streamdeck/src/plugin.ts` — import + register `OpenArchitectAction`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — new Action entry.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/open-architect.html` — new PI
  (two-mode select).
- `apps/streamdeck/scripts/render-action-icons.mjs` — add `open-architect` to
  `ICONS`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/{,list/}open-architect{,@2x}.png`
  — 4 generated PNGs.
- `apps/streamdeck/README.md` — placement guidance + known edges.
- Tests: `src/__tests__/actions.test.ts`, `src/__tests__/face.test.ts`,
  `src/__tests__/manifest-icons.test.ts`, `src/__tests__/render-action-icons.test.ts`.

(No `store.ts` change — both modes read data already on `store`.)

## Risks & Alternatives Considered

- **Dependency #1406 (stated per the architect, not fixed in this lane).**
  `afx spawn` silently attributes a builder to `main` when
  `CODEV_ARCHITECT_NAME` is absent, even inside another architect's session
  (`packages/codev/src/agent-farm/commands/spawn.ts`). Where that misfires,
  `spawnedByArchitect` is stored as `main`, so Builder mode opens the **wrong**
  architect (`air-1403`: spawned by `streamdeck`, registered as `main`). Today a
  cosmetic wrinkle in `afx status`; here a wrong action on hardware. Mitigation in
  scope: the face renders the resolved owner name, so the mismatch is **visible
  before pressing** — but a static face can't *correct* a wrong attribution.
  Fix/confirm #1406 before ship — out of this lane; called out for the architect.
- **Base-class choice** — resolved: `SingletonAction` (ratified). `VerbKey`
  supports dynamic `args()` but not a dynamic face, and the face is what forces
  the change.
- **Known limitation (documented, not fixed): Main mode vs. missing `main`.** In
  `target='main'` mode when `main` is absent, VS Code opens `architects[0]`
  (`extension.ts:921` — the main-else-first special-case, scoped to that one name;
  any *other* named target fails loudly instead of substituting), while the face
  still reads `Architect / Main`. The relay is fire-and-forget, so the deck never
  learns which architect actually opened. Narrow (a workspace with architects but
  no `main`), and **pre-existing VS Code behaviour** rather than something this key
  introduces. Not chased: deck-side verification would reintroduce exactly the
  live-architect-view coupling this design deliberately removed. Documented in the
  README; deferred to VS Code (ruling 2).
- **Known limitation: stale-but-present architect.** A live registration behind a
  dead PTY resolves normally and opens a terminal nobody reads; the deck can't
  distinguish it from a real session. Out of scope; noted in the README.
- **Alternative — free-text architect pin (`Automatic`/name), owner comment
  `5300180262`.** Superseded: two named modes cover the same reachability
  (contextual owner + deliberate `main`) with a clearer PI, no free-text, and no
  positional fallback whose safety hinges on reading the face.
- **Alternative — first-live positional fallback (`architects[0]`).** Dropped:
  `OverviewData.architects` is "what Tower can currently *see* live" (a Tower
  restart or a momentarily-missing session empties or reorders it), so a
  positional fallback could summon a sibling. Two explicit modes remove the need
  for any fallback.
- **Alternative — statically configured per-architect keys / architect altitude
  on the Zoom dial.** Rejected in the issue: the former breaks the Row-2
  invariant; the latter's cursor *is* the shared selection.

## Test Plan

### Unit (vitest, `apps/streamdeck`)

- `actions.test.ts` (extend the `makeStore` fixture with `spawnedByArchitect` on
  builders):
  - Builder mode (default) + selected builder with owner → press relays
    `open-architect-terminal ['<owner>']`.
  - Builder mode + selected builder with `spawnedByArchitect: null` → **inert**:
    `showAlert`, no `sendCommand`.
  - Builder mode + no selected builder → inert.
  - Main mode (`{ target: 'main' }`) → relays `['main']` regardless of selection.
  - Press failure (`sendCommand` → `{ ok:false }`) → `showAlert`.
- `face.test.ts`: `architectFaceSvg('main')` → title `Architect`, subtitle `Main`;
  `architectFaceSvg('streamdeck')` → subtitle `Streamdeck`; `architectFaceSvg(undefined)`
  → dim face with subtitle `None`; a long name shrinks (asserts the
  `textLength`/`lengthAdjust` fit attribute); output is valid `<svg …>`.
- `manifest-icons.test.ts`: the new action's `Icon` + `States[].Image` resolve to
  @1x/@2x PNGs at convention sizes (72/144 key, 20/40 list).
- `render-action-icons.test.ts`: `extractGlyph(faceSrc, 'architect', …)` returns a
  colored group (guards the icon↔face single-source contract).

### Build

- `pnpm --filter @cluesmith/codev-streamdeck build` and `… test` green from the
  worktree.

### Manual (dev-approval, hardware session)

1. Place the **Open Architect** key (Row 2). In **Builder mode** (default),
   confirm the face reads `Architect / <owner>` and the subtitle updates as the
   Row-1 selection moves between builders owned by different architects.
2. Builder mode, select a builder owned by architect X → press → X's terminal
   opens/focuses in VS Code.
3. Builder mode, select a builder with no owner (or clear the selection) → face
   dims, subtitle `None` → press does nothing (ruling 3).
4. Switch the key to **Main mode** → face reads `Architect / Main` → press opens
   `main`, independent of selection.
5. **Missing-main safeguard**: with `main`'s session momentarily invisible and a
   builder owned by a sibling selected (Builder mode), confirm the subtitle
   **visibly shows the sibling's name**, not a generic label — proving the
   resolved-name face is the trustworthy cue against a wrong summon.
6. Point a mode at a non-live architect → VS Code shows `No '<name>' architect
   found` (deck does not second-guess — ruling 2).
7. Cross-check #1406: with a known mis-attributed builder selected (Builder mode),
   confirm the subtitle shows the (currently wrong) stored owner — demonstrating
   why #1406 must be resolved before ship.
8. **Rename / UUID-stability check** (the only user-visible risk of the pair
   rename): a key placed as "Open Terminal" *before* this change must survive the
   rename — the already-placed key still opens the selected builder's terminal and
   now reads `Builder`. The UUID is unchanged (`com.cluesmith.codev.open-terminal`),
   so only the Name/face moved; this confirms it on hardware, not just in the
   manifest.
