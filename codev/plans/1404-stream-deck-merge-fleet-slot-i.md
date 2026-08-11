# PIR Plan: Merge Fleet Slot into Builder Action (phase-aware press)

## Understanding

Today two Stream Deck key actions cover a single builder:

- **Fleet Slot** (`com.cluesmith.codev.fleet-slot`): a live tile — renders `#issue` + phase/blocked on two lines; default press verb `open-terminal`.
- **Builder Action** (`com.cluesmith.codev.builder-action`): a one-line `#issue` tile; default press verb `view-diff`.

They are the same `SlotKey` base class differing only in `defaultVerb` and `renderTo` (`apps/streamdeck/src/actions.ts:132-152`). The owner's direction (2026-08-11): one key per builder should do what that builder needs, so **merge the two into a single Builder Action** whose default press ("Automatic") opens the artifact that matters for the builder's current protocol state, re-openable on every press (stateless). Approval stays exclusively on the Approve Gate singleton; this key never approves.

The phase→verb resolution already exists for the Zoom Navigator's touch-strip zoom-in — `zoomInVerb` (`actions.ts:208-217`), covered by tests at `src/__tests__/actions.test.ts:319-334`. Per the owner's implementation note on the issue, Automatic mode must **reuse/extract that resolver** rather than writing a second mapping. The only difference: `zoomInVerb` falls back to `view-diff` for unknown/no-status builders (a dial always has an editor to open), while Automatic must fall back to `open-terminal` (requirement 3: "no artifact yet / unknown state → open-terminal"). So the shared core returns the recognised verb or `undefined`, and each caller supplies its own fallback.

**Selection on press (design decision, 2026-08-12).** The store already carries a shared zoom cursor (`store.cursor`, `selectedBuilder()`) that the diff dials, `ScrollNav`, `DevServerAction`, and `ZoomNav` all act on. Today the slot-pinned keys ignore it, so pressing a builder key opens that builder's artifact but leaves the dials pointing elsewhere. The merged key becomes the fleet **selector**: its press points the cursor at the builder (`store.syncToBuilder(b.id)`, `store.ts:236-242`) **and** opens the artifact, so one press focuses the builder for the dials and any selection-scoped keys. This is the sole change in this project taken from a broader SD+ two-zone workflow design; that wider design (a Row 2 action palette, dial queue/send semantics, feedback-mode wiring) is captured in a **separate spec** and is out of scope here.

State strings are read from the overview wire values on `OverviewBuilder` (`packages/types/src/api.ts:141-183`): `protocolPhase` (`specify`/`plan`/`implement`/`review`/`verify`, `''` when no live status) and `blockedGate` (canonical gate name: `spec-approval`/`plan-approval`/`dev-approval`/`pr`, `null` when not blocked). No new hardcoded phase guesses.

The bundled SD+ profile (`com.cluesmith.codev.sdPlugin/Codev.streamDeckProfile`, a zip) references `fleet-slot` on 3 keys and `builder-action` on 1, so it is revved in this same PR.

## Proposed Change

### 1. Extract a shared phase→artifact resolver (`actions.ts`)

Replace the body of `zoomInVerb` with a thin wrapper over a new pure helper that returns the recognised verb or `undefined`:

```ts
/**
 * The artifact verb for a builder's current protocol state, or `undefined` when
 * the state is unknown / has no artifact yet. Callers choose the fallback:
 * the dial zoom-in opens the diff; the Builder Action key opens a terminal.
 * State strings are read from the overview wire values (blockedGate / protocolPhase),
 * never guessed. A gate (blocked) beats the phase — it's the stronger signal.
 */
export function phaseArtifactVerb(b: OverviewBuilder): string | undefined {
  const gate = b.blockedGate ?? '';
  if (gate === 'spec-approval') return 'open-spec';
  if (gate === 'plan-approval') return 'open-plan';
  if (gate === 'dev-approval' || gate === 'pr') return 'view-diff';
  const phase = b.protocolPhase ?? '';
  if (phase === 'specify') return 'open-spec';
  if (phase === 'plan') return 'open-plan';
  if (phase === 'implement' || phase === 'review' || phase === 'verify') return 'view-diff';
  return undefined; // unknown gate / no live status → caller's fallback
}

export function zoomInVerb(b: OverviewBuilder): string {
  return phaseArtifactVerb(b) ?? 'view-diff';
}
```

This preserves `zoomInVerb`'s current behaviour exactly (every existing case still resolves the same: an unrecognised gate or empty phase → `view-diff`), so its tests are unchanged.

### 2. Builder Action absorbs Automatic press + live-tile render (`actions.ts`)

- Add an `'automatic'` sentinel. When `settings.verb` is unset or `'automatic'`, resolve via `phaseArtifactVerb(b) ?? 'open-terminal'`; any other value is an explicit verb used verbatim (requirement 2: explicit choices never overridden).
- Move the resolution into `SlotKey.onKeyDown` via an overridable hook so `BuilderAction` supplies the Automatic behaviour and the base default stays simple. Concretely, replace the `const verb = settings.verb ?? this.defaultVerb` line with `const verb = this.resolveVerb(settings, b)`, where the base returns `settings.verb ?? this.defaultVerb` and `BuilderAction` overrides it to honour the `automatic` sentinel.
- **Press also selects.** In `SlotKey.onKeyDown`, once the slot builder `b` is resolved (before or after firing the verb), call `this.store.syncToBuilder(b.id)` so the press moves the shared cursor to that builder. `syncToBuilder` is an existing no-op-safe method (already used to follow VSCode focus), so this reuses it rather than adding cursor plumbing. The empty-slot path (no builder) still just alerts and selects nothing.
- `BuilderAction.renderTo` adopts Fleet Slot's two-line render: `#issue` (or `b.id`) on line 1, `b.blocked ?? b.protocolPhase` on line 2; `Slot N` when the slot is empty. (Rendering stays title-based, matching the existing `v1` note at `actions.ts:20`; true colour-by-state tiles would need SVG feedback and are out of scope for this merge — flagged under Risks.)
- Delete the `FleetSlot` class and its default `view-diff` on `BuilderAction` becomes `automatic`.

### 3. Remove Fleet Slot registration & manifest entry

- `src/plugin.ts`: drop the `FleetSlot` import (line 9) and `new FleetSlot(store)` (line 41).
- `manifest.json`: remove the entire `fleet-slot` action object (lines ~100-115). Update the `builder-action` Tooltip to describe the shipped behaviour truthfully (requirement 6), e.g. *"Live tile for the Nth builder (set the slot in the PI). Press selects the builder and opens the artifact for its current phase (spec / plan / diff), or a fixed verb you choose."*

### 4. Property Inspector (`ui/builder-action.html`)

- Rename the verb `<sdpi-item>` label to **"On press"**, add an **Automatic** option as the **first** option and set `default="automatic"`. Keep the existing explicit verbs (View Diff, Open Terminal, Open Spec, Open Plan, Open Review, Run Dev).
- Update the helper `<small>` to explain Automatic ("opens the artifact for the builder's current phase").
- Delete `ui/fleet-slot.html`.

### 5. Rev the bundled SD+ profile

The 3 `fleet-slot` keys in the profile's inner manifest (`Profiles/.../93B4E89C-…/manifest.json`) become `builder-action` keys set to Automatic:

- `Actions/0,1`: `fleet-slot` `{verb:"open-plan"}` (slot 1) → `builder-action`, drop `verb` (Automatic), keep slot.
- `Actions/1,1`: `fleet-slot` `{slot:"1", verb:"view-diff"}` → `builder-action`, `{slot:"1"}` (Automatic).
- `Actions/2,1`: `fleet-slot` `{slot:"3", verb:"open-review"}` → `builder-action`, `{slot:"3"}` (Automatic).

Also update each key's cached `"Name": "Fleet Slot"` → `"Builder Action"`. Procedure: unzip, edit the inner `manifest.json` in place, re-zip preserving the exact internal layout (paths relative, `Codev.streamDeckProfile` at the plugin root). Verify by importing on hardware (requirement 5 / suggested protocol).

### 6. Docs hygiene

- `apps/streamdeck/README.md`: drop the Fleet Slot bullet (line ~66) and Fleet Slot references in the model table / diagram / "Open the artifact" tip; fold its live-tile description into Builder Action.
- `apps/streamdeck/marketplace/release-notes.md`: remove the standalone Fleet Slot line; update the Builder Action line to describe the merged live tile + Automatic press.

### 7. Tests (`src/__tests__/actions.test.ts`)

- Keep the existing `zoomInVerb` suite (unchanged behaviour).
- New suite for `phaseArtifactVerb` / Automatic:
  - `specify`/`spec-approval` → `open-spec`; `plan`/`plan-approval` → `open-plan`.
  - `implement`/`review`/`dev-approval`/`pr` → `view-diff`.
  - empty/unknown phase and unrecognised gate → `undefined` (helper) and → `open-terminal` (Builder Action Automatic press).
  - Builder Action with an explicit `verb` (e.g. `open-review`) fires it verbatim, unaffected by phase (requirement 7: explicit-verb keys unaffected).
  - Builder Action render shows `#issue` + phase/blocked on two lines.
  - Pressing a Builder Action selects its slot builder: `store.cursor.builder` (and `selectedBuilder()`) point at that builder after the press; an empty slot selects nothing.

## Files to Change

- `apps/streamdeck/src/actions.ts` — extract `phaseArtifactVerb`; rewrite `zoomInVerb` as a wrapper; `BuilderAction` gains Automatic resolution + two-line render; `SlotKey.onKeyDown` calls `store.syncToBuilder(b.id)` so the press selects; delete `FleetSlot`. (No `store.ts` change — `syncToBuilder` already exists.)
- `apps/streamdeck/src/plugin.ts:9,41` — drop `FleetSlot` import + registration.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — remove `fleet-slot` action; fix `builder-action` tooltip.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/builder-action.html` — Automatic option (default, first); relabel "On press"; update helper.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/fleet-slot.html` — delete.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/Codev.streamDeckProfile` — rev: 3 fleet-slot keys → builder-action Automatic.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/fleet-slot*.png`, `icons/list/fleet-slot*.png` — delete (unreferenced after manifest removal).
- `apps/streamdeck/README.md`, `apps/streamdeck/marketplace/release-notes.md` — doc hygiene.
- `apps/streamdeck/src/__tests__/actions.test.ts` — new Automatic/`phaseArtifactVerb` tests.

## Risks & Alternatives Considered

- **Risk: removing the `fleet-slot` action UUID breaks existing user layouts.** Mitigated by the distribution note on the issue — no released user base (Elgato submission pending, packs on-demand), so this is the cheapest moment. Any deck still carrying a fleet-slot key would show it as unknown after update; acceptable now.
- **Risk: profile re-zip produces an archive Stream Deck won't import.** Mitigated by hardware verification before the PR (dev-approval gate). If hand-zip proves flaky, fall back to importing the current profile, deleting/re-adding the keys in the Stream Deck app, and re-exporting.
- **Risk: "state colouring" (requirement 1) under-delivered.** Neither action colours today (title-based `v1`). This merge matches the existing Fleet Slot render (issue + phase/blocked); colour-by-state tiles need SVG feedback and are a separate polish. Called out here for the gate reviewer to confirm scope.
- **Alternative: press-escalation / long-press to approve** — rejected by the owner (2026-08-11): escalation guesses hidden editor state and breaks re-opening; long/short press is confusing. Approval stays on Approve Gate.
- **Alternative: a second phase→verb mapping for Automatic** — rejected: duplicates `zoomInVerb`; the owner's note directs reuse/extraction.
- **Alternative: keep both actions, add Automatic only to Builder Action** — rejected: the goal is one key per builder; two near-identical actions is the problem being removed.

## Test Plan

**Unit** (`pnpm --filter @cluesmith/codev-streamdeck test`, run from the worktree):
- `phaseArtifactVerb`: phase mapping, blocked-gate mapping, unknown/empty → `undefined`.
- Builder Action Automatic press: fires the resolved verb; unknown → `open-terminal`; re-press fires again (stateless).
- Builder Action press selects the slot builder (cursor follows); empty slot alerts and selects nothing.
- Explicit-verb Builder Action fires verbatim regardless of phase.
- Existing `zoomInVerb` suite still green.
- Builder Action render: two-line `#issue` + phase/blocked; `Slot N` when empty.

**Build**: `pnpm --filter @cluesmith/codev-streamdeck build` clean (no dangling `FleetSlot` reference).

**Manual / hardware** (dev-approval gate):
- Import the revved `Codev.streamDeckProfile` onto a Stream Deck + — the 3 former Fleet Slot keys appear as Builder Action, On press = Automatic.
- With a live workspace, watch a builder move through phases and press its key at each: specify → spec opens; plan → plan opens; implement/review → diff opens; blocked at a gate → the gate's artifact; no builder in the slot → alert. Press twice at one phase → re-opens (stateless).
- Set a key to an explicit verb in the PI → that verb fires, ignoring phase.
- Press a builder key, then rotate a diff dial (Files/Changes) → the dials now act on the builder you pressed (selection followed the press).
- Confirm the Approve Gate key still owns approval; the Builder Action key never approves.
