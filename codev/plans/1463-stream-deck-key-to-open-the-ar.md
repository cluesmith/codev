# PIR Plan: Stream Deck key to open the architect that spawned the selected builder

## Understanding

The deck can act on every builder (open artifact, approve gate, run dev, send
feedback, open terminal) but cannot reach a single architect. When a review
raises something the builder can't settle, the next move is talking to whoever
owns the lane — today that means leaving the deck for the mouse.

This adds one **builder-scoped** key (following the Row 2 invariant: every key
acts on the *selected* builder, architects never enter the selection model). A
press opens the terminal of the architect that owns the selected builder,
resolved from `OverviewBuilder.spawnedByArchitect` — already on the wire the
deck reads (`packages/types/src/api.ts:201`, re-exported via
`@cluesmith/codev-sdk/controller`). **No types / Tower / relay change.**

The design was revised by the owner (issue comment `5300180262`), superseding
ruling 1 in the body. The key mirrors Builder Action's **Automatic-or-explicit**
Property Inspector shape:

- **`Automatic` (default)** — target the selected builder's `spawnedByArchitect`,
  falling back to `main` when nothing is selected or the builder has no recorded
  owner (matching `afx send architect`'s "route to `main` if present, else the
  first registered" convention).
- **An explicit architect name** (pinned in the PI) — always that architect,
  regardless of selection.

The fallback to `main` is safe **only because the key renders its resolved
target's name on its face** (`architectFaceSvg`), so you see who you would summon
before pressing — a visible fallback, not a hidden one. This is the load-bearing
requirement the architect flagged: if the face cannot genuinely show the target,
the fallback is unsafe and we stop and re-scope.

### Existing wiring this reuses (verified)

- Verb `open-architect-terminal` is already in the relay allowlist
  (`apps/vscode/src/command-relay.ts:62` → `codev.openArchitectTerminal`) and the
  deck's Codev-Action PI verb list
  (`com.cluesmith.codev.sdPlugin/ui/codev-action.html:15`).
- `codev.openArchitectTerminal(architectName?)` accepts an optional name
  (`apps/vscode/src/extension.ts:873-927`): it resolves the workspace's architect
  list, opens the match, and on a name it can't resolve shows
  `No '<name>' architect found` and returns `undefined`. **This is exactly the
  "defer to VS Code's handling" of ruling 2** — the deck passes a name and never
  second-guesses liveness.
- The relay forwards the verb's args verbatim (only `approve-gate` is
  arg-filtered), so `sendCommand('open-architect-terminal', [name], ws)` reaches
  `executeCommand('codev.openArchitectTerminal', name)` unchanged
  (`command-relay.ts:95-104`).

## Proposed Change

A new key action `OpenArchitectAction` with a dynamic composite face.

### 1. The action class (`apps/streamdeck/src/actions.ts`)

The issue names a `VerbKey` subclass, but `VerbKey` renders its face **once** in
`onWillAppear` (see `DevServerAction` / `OpenTerminalAction`, which draw a static
`labelFaceSvg`). This key's face must **re-render on every selection change**
(Automatic resolution reads `selectedBuilder()`) and on every settings change
(pinned vs. Automatic). That is precisely the shape `ApproveGate` and
`SendQueueAction` already use — the other two Row-2 selection-scoped keys with a
dynamic composite face: a `SingletonAction` that tracks its `KeyAction`s in a
per-context `Map`, subscribes to `store.onChange`, and re-renders.

**Decision (flag for the gate):** implement `OpenArchitectAction` on the
`ApproveGate`/`SendQueueAction` shape (`SingletonAction` + keys-map + `onChange`),
not the static-face `VerbKey` shape. The issue's "VerbKey subclass" phrasing
predates the realization — which the issue itself raises via the #1444/#1459
compositing note — that the face is dynamic. The press still fires the single
verb `open-architect-terminal`; only the base class differs. If the architect
prefers literal `VerbKey` inheritance, the alternative is to keep `extends
VerbKey` and layer the same keys-map + `onChange` lifecycle on top (widening
`VerbSettings` to carry `architect?`); functionally identical, slightly more
friction against the base generic. Recommending the `SingletonAction` shape.

Behaviour:

- **Settings**: `{ architect?: string }`. Empty / absent / `"automatic"` →
  Automatic; any other value → pinned name (trimmed).
- **Resolution** (`resolve(settings)`, used by both press and render):
  `pinned ?? selectedBuilder()?.spawnedByArchitect ?? 'main'`. Never `null` —
  liveness/not-found is VS Code's job (ruling 2).
- **Press** (`onKeyDown`): `sendCommand('open-architect-terminal',
  [resolve(settings)], selectedWorkspacePath())`, then `ack` (red alert on
  failure; silent success, matching the other keys).
- **Render** (`renderTo`): `setImage(svgToDataUri(architectFaceSvg(resolve(settings))))`
  + `setTitle('')`. Called from `onWillAppear`, `onDidReceiveSettings`, and the
  `onChange` subscription.

### 2. The face (`apps/streamdeck/src/face.ts`)

- Add an `architect` glyph to `GLYPHS` (and `GlyphKey`) — a person/owner mark
  drawn in the same line-glyph style as the codicon-modelled shapes.
- Add `architectFaceSvg(name: string)`: icon zone (the `architect` glyph, tinted
  a neutral accent) over a centered, **shrink-to-fit** name band, so long
  architect names (e.g. `ob-refine`) don't clip. Names render UPPERCASE, twinning
  the sidebar's architect-row convention (`displayArchitectName` in
  `apps/vscode/src/views/architect-display.ts` — the deck replicates the look
  independently, per the existing twin pattern documented atop `face.ts`).
- The current `centeredLine` has no `fit()` shrink; add a fit-aware centered
  variant (or extend `centeredLine`) so the name band never overflows the 72px
  face.

### 3. Manifest + Property Inspector

- `com.cluesmith.codev.sdPlugin/manifest.json`: add an Action entry
  `com.cluesmith.codev.open-architect` (Name e.g. "Open Architect", Keypad
  controller, `Icon: icons/list/open-architect`, `States[0].Image:
  icons/open-architect`, `PropertyInspectorPath: ui/open-architect.html`, a
  Tooltip describing the Automatic/pinned behaviour).
- `com.cluesmith.codev.sdPlugin/ui/open-architect.html`: new PI mirroring
  `builder-action.html`'s shape — a field binding `setting="architect"`. Leave
  blank (Automatic) to follow the selected builder's owner; type a name (e.g.
  `main`) to pin. A free-text field is used rather than a `<select>` because the
  architect roster isn't known at PI-render time and is workspace-specific.
- Icons: add `{ name: 'open-architect', glyph: 'architect' }` to `ICONS` in
  `apps/streamdeck/scripts/render-action-icons.mjs` and run it
  (`node scripts/render-action-icons.mjs`; `rsvg-convert` + `magick` are
  installed) to emit the four PNGs (`icons/open-architect.png` 72,
  `@2x` 144, `icons/list/open-architect.png` 20, `@2x` 40). The render pipeline
  parses the glyph vector straight out of `face.ts`, so the picker icon and the
  runtime key agree by construction.

### 4. Registration (`apps/streamdeck/src/plugin.ts`)

Export `OpenArchitectAction` and add `new OpenArchitectAction(store)` to the
`actions` array.

### 5. README guidance (`apps/streamdeck/README.md`)

Document the key under the existing design prose: recommended home is Row 2
alongside the other builder-scoped keys; the natural donor slot is **Send
Feedback while the workspace is in forward mode** (where that key is inert by
design); unplacing a key leaves the action in the picker; the trade disappears
with a larger profile (#1381). (The plugin ships `Actions: null`; users place
keys themselves — #1404/#1410, so no bundled-profile change.)

## Files to Change

- `apps/streamdeck/src/actions.ts` — new `OpenArchitectAction` (SingletonAction +
  keys-map + `onChange`; resolve → press → render).
- `apps/streamdeck/src/face.ts` — new `architect` glyph in `GLYPHS`/`GlyphKey`;
  new `architectFaceSvg(name)`; fit-aware centered name band.
- `apps/streamdeck/src/plugin.ts` — import + register `OpenArchitectAction`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — new Action entry.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/open-architect.html` — new PI.
- `apps/streamdeck/scripts/render-action-icons.mjs` — add `open-architect` to
  `ICONS`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/{,list/}open-architect{,@2x}.png`
  — 4 generated PNGs.
- `apps/streamdeck/README.md` — placement guidance.
- Tests: `src/__tests__/actions.test.ts`, `src/__tests__/face.test.ts`,
  `src/__tests__/manifest-icons.test.ts` (extend for the new action + sizes),
  `src/__tests__/render-action-icons.test.ts` (extract the `architect` glyph).

## Risks & Alternatives Considered

- **Dependency #1406 (stated per the architect, not fixed in this lane).**
  `afx spawn` silently attributes a builder to `main` when
  `CODEV_ARCHITECT_NAME` is absent, even inside another architect's session
  (`packages/codev/src/agent-farm/commands/spawn.ts`). Where that misfires,
  `spawnedByArchitect` is stored as `main`, so Automatic resolves to `main` and a
  press summons the **wrong** architect (`air-1403` is a real instance: spawned
  by `streamdeck`, registered as `main`). Today that's a cosmetic wrinkle in
  `afx status`; this feature turns it into a wrong action on hardware. Mitigation
  inside our scope: the face renders the resolved target, so the mistake is
  **visible before pressing**. Full correctness needs #1406 fixed or confirmed
  before this ships — out of this lane; called out for the architect.
- **Risk: face must genuinely show the target.** The whole `main` fallback rests
  on the visible name. The `face.test.ts` cases pin that `architectFaceSvg`
  renders the resolved name (pinned, owner, and `main`-fallback), so a regression
  that blanks the face fails the build.
- **Risk: base-class choice.** Using `SingletonAction` rather than literal
  `VerbKey` inheritance (see the Decision above). Surfaced for the gate; trivially
  reversible to the `VerbKey`-plus-lifecycle variant.
- **Alternative — statically configured per-architect keys.** Rejected in the
  issue: breaks the Row-2 invariant (one context-free key among builder-scoped
  neighbours) and needs a slot per architect.
- **Alternative — architect altitude on the Zoom dial.** Rejected in the issue:
  the dial's cursor *is* the shared selection, so an architect altitude either
  hollows out Row 2 or needs a parallel cursor.
- **Alternative — `<select>` of architects in the PI.** Rejected: the roster is
  workspace-specific and unknown at PI-render time; a free-text field is the
  low-friction pin. (A future enhancement could populate it via the PI↔plugin
  channel; out of scope.)

## Test Plan

### Unit (vitest, `apps/streamdeck`)

- `actions.test.ts` (extend the `makeStore` fixture with `spawnedByArchitect`):
  - Automatic + selected builder with an owner → press relays
    `open-architect-terminal ['<owner>']`.
  - Automatic + selected builder with `spawnedByArchitect: null` → relays
    `['main']`.
  - Automatic + **no** selected builder → relays `['main']`.
  - Pinned name in settings → relays `['<pinned>']` regardless of selection.
  - Press failure (`sendCommand` → `{ ok:false }`) → `showAlert`.
- `face.test.ts`: `architectFaceSvg('streamdeck')` contains `STREAMDECK`;
  `architectFaceSvg('main')` contains `MAIN`; a long name shrinks (asserts the
  `textLength`/`lengthAdjust` fit attribute) rather than overflowing; output is
  valid `<svg …>`.
- `manifest-icons.test.ts`: the new action's `Icon` + `States[].Image` resolve to
  @1x/@2x PNGs at convention sizes (72/144 key, 20/40 list).
- `render-action-icons.test.ts`: `extractGlyph(faceSrc, 'architect', …)` returns a
  colored group (guards the icon↔face single-source contract).

### Build

- `pnpm --filter @cluesmith/codev-streamdeck build` (esbuild bundle) and
  `pnpm --filter @cluesmith/codev-streamdeck test` green from the worktree.

### Manual (dev-approval, hardware session)

1. Place the **Open Architect** key on the deck (Row 2). Confirm the face renders
   the resolved architect name and updates as the Row-1 selection moves between
   builders owned by different architects.
2. Select a builder owned by architect X → press → X's terminal opens/focuses in
   VS Code.
3. Select a builder with no recorded owner (or clear the selection) → face reads
   `MAIN` → press opens `main`.
4. Pin the key to an explicit architect in the PI → face shows that name → press
   always opens it, independent of selection.
5. Point Automatic at a name with no live architect → VS Code shows
   `No '<name>' architect found` (deck does not second-guess — ruling 2).
6. Cross-check against #1406: with a builder known to be mis-attributed, confirm
   the face shows the (currently wrong) stored owner — demonstrating the visible
   fallback and why #1406 must be resolved before ship.
