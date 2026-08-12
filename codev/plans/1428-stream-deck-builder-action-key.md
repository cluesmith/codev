# PIR Plan: Stream Deck Builder Action composite key face

## Understanding

The Builder Action key (`apps/streamdeck/src/actions.ts:164-169`) renders by pushing two
raw wire strings through `setTitle`, and the SDK paints that title **over** the full-bleed
`icons/builder-action` bolt PNG declared in the manifest. Two independent layers stacked ⇒
three photo-verified symptoms with one root cause:

1. **Text/icon collision.** Both title lines land on the bolt's diagonal. It's illegible
   enough that `#1414` reads as `#1,414` — there is no number formatter in the plugin and
   `issueId` is a plain string on the wire (confirmed: `OverviewBuilder.issueId: string | null`,
   `packages/types/src/api.ts:143`), so the "comma" is the bolt edge bleeding through between
   digits. The overlay corrupts what the data appears to say.
2. **Casing inconsistency.** Line 2 is `b.blocked ?? b.protocolPhase` verbatim — wire values,
   not display labels — so the key mirrors whatever casing the wire carries (`implement`,
   `verified`).
3. **Truncation.** Long phase names clip mid-word because the SDK title box is narrower than
   the string.

The Gates/approve-gate key reads fine because its icon+label were composed as one design; the
Builder Action key stacks two layers that were never designed to coexist.

The fix is to stop stacking layers: render the **entire** key face as one image in the plugin,
with the icon confined to an upper zone and the text in a reserved band below, and to translate
wire ids to deliberate display labels through a plugin-local map.

**Key enabler (verified):** `KeyAction.setImage(image?, options?)` accepts *"an SVG `string`"*
directly (SDK d.ts, `@elgato/streamdeck@2.1.0/dist/plugin/actions/key.d.ts:29-34`). So we can
build the face as an SVG string with **zero new dependencies** — no canvas/native module, which
matters because the plugin is a single esbuild→node bundle (`apps/streamdeck/esbuild.js`) and
pure functions are the established, SDK-free-testable pattern here (cf. `src/nav/cursor.ts`).

## Proposed Change

### 1. New plugin-local module `apps/streamdeck/src/face.ts` (pure, no SDK import)

Two responsibilities, both pure and unit-testable in isolation (mirrors `nav/cursor.ts`):

**(a) Presentation label map** — wire id → display label. Keyed on the **canonical** ids
`blockedGate` and `protocolPhase` (not `b.blocked`, which is a server-authored human label with
non-deterministic casing). Gate wins over phase, matching the existing precedence in
`phaseArtifactVerb` (`actions.ts:229-239`). This keeps presentation 100% plugin-local:

```ts
// Gate a builder is blocked on (canonical blockedGate ids). Gate beats phase.
const GATE_LABELS: Record<string, string> = {
  'spec-approval': 'Spec Approval',
  'plan-approval': 'Plan Approval',
  'dev-approval':  'Dev Approval',
  'pr':            'PR Review',
};
// Coarse protocol phase (canonical protocolPhase ids).
const PHASE_LABELS: Record<string, string> = {
  specify:   'Specify',
  plan:      'Plan',
  implement: 'Implement',
  review:    'Review',
  verify:    'Verified',
};

/** Deliberate display label for a builder's current state; '' → the caller's fallback. */
export function stateLabel(b: Pick<OverviewBuilder, 'blockedGate' | 'protocolPhase'>): string {
  const gate = b.blockedGate ?? '';
  if (GATE_LABELS[gate]) return GATE_LABELS[gate];
  const phase = b.protocolPhase ?? '';
  if (PHASE_LABELS[phase]) return PHASE_LABELS[phase];
  // Defensive fallback for an unmapped id: title-case the first token so nothing
  // renders lowercase, and never emit a mid-word clip (the SVG never truncates —
  // §(b) sizes the band to the label, not vice-versa).
  const raw = gate || phase;
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}
```

**Complete id → label table for review (every phase + gate id):**

| Wire id | Source field | Display label |
|---|---|---|
| `spec-approval` | blockedGate | Spec Approval |
| `plan-approval` | blockedGate | Plan Approval |
| `dev-approval` | blockedGate | Dev Approval |
| `pr` | blockedGate | PR Review |
| `specify` | protocolPhase | Specify |
| `plan` | protocolPhase | Plan |
| `implement` | protocolPhase | Implement |
| `review` | protocolPhase | Review |
| `verify` | protocolPhase | Verified |
| `''` / unknown | either | title-cased raw, else empty |

Longest single token is "Approval"/"Implement" (8–9 chars). Two-word gate labels are rendered
as **two lines** ("Dev" / "Approval") by construction so nothing clips — see §(b).

**(b) SVG face builder** — `builderFaceSvg(opts)` returns a self-contained `<svg>` string.
Layout (72×72 viewBox; the deck upscales, and vector stays crisp):

```
┌───────────────┐  0
│      ⚡        │   icon zone  (top ~34px): the bolt glyph, centered, drawn as
│               │               an SVG <path> — no PNG overlay, no bleed-through
├───────────────┤  ~36  hairline divider
│    #1414      │   number line (bold ~17px, high-contrast) — the primary datum
│  Dev Approval │   label band (~12px, muted; 1–2 lines, wrapped at the space
└───────────────┘  72               for two-word gate labels — never mid-word)
```

- Dark rounded background (`#1c1c1e`, matching the deck's neutral keys) so the composed face
  reads as one design, like the Gates key.
- Icon zone reserved at top; text band reserved at bottom. They never overlap **by
  construction** — that is the whole fix for symptom (1).
- Number line renders `#${issueId}` (or the builder `id` when `issueId` is null) at a size that
  fits within the band width; "#1414" renders as literal glyphs with no comma (fixes the
  data-corruption symptom).
- Empty-slot variant: same frame, icon drawn dimmed/outline, band shows `Slot N`, no number
  line (requirement 4 — consistent row).

The function signature is a plain data-in/string-out contract, e.g.:

```ts
export function builderFaceSvg(
  face:
    | { kind: 'builder'; number: string; label: string }
    | { kind: 'empty'; slot: string },
): string
```

### 2. Rewire `BuilderAction.renderTo` (`actions.ts:164-169`)

Replace the `setTitle` overlay with an image render. **Only this method changes**; press/rotate
behavior (`resolveVerb`, `onKeyDown`, `phaseArtifactVerb`, the `automatic`→`open-diff-first`
resolution from #1429/#1404/#1414) is **untouched**.

```ts
protected renderTo(action: KeyAction, settings: SlotSettings): void {
  const b = slotBuilder(this.store, settings);
  const svg = b
    ? builderFaceSvg({
        kind: 'builder',
        number: b.issueId ? `#${b.issueId}` : b.id,
        label: stateLabel(b),
      })
    : builderFaceSvg({ kind: 'empty', slot: settings.slot ?? '1' });
  void action.setImage(svg);
  void action.setTitle(''); // suppress the SDK title layer so the SVG is the whole face
}
```

`setTitle('')` guarantees no residual manifest/user title paints over the SVG (belt-and-braces
against the exact stacking that caused symptom 1).

### 3. No other layers change

- **Manifest**: unchanged. The `icons/builder-action` PNG stays as the static/PI thumbnail; at
  runtime `setImage` replaces the face. (If the hardware check shows the static PNG flashing
  before first render, a follow-up could swap the manifest default — noted as a risk, not
  planned work.)
- **Wire / types / server**: **no change** (requirement 3). The map reads existing
  `blockedGate` / `protocolPhase` fields already on `OverviewBuilder`.

## Files to Change

- `apps/streamdeck/src/face.ts` — **new**. Pure module: `GATE_LABELS` / `PHASE_LABELS`,
  `stateLabel()`, `builderFaceSvg()`. No SDK import (testable like `nav/cursor.ts`).
- `apps/streamdeck/src/actions.ts:164-169` — `BuilderAction.renderTo` switches from `setTitle`
  to `builderFaceSvg` + `setImage`; add the `face.ts` import. Nothing else in the file changes.
- `apps/streamdeck/src/__tests__/actions.test.ts:146-155` — the two existing render assertions
  currently expect `setTitle` to contain `plan review` / `implement` / `#101`. Update them to
  assert the SVG face: `setImage` called with a string containing `#101` and the **mapped**
  label (`Plan Approval` for pir-1's `plan-approval` gate, `Implement` for pir-2). Add
  `setImage: vi.fn()` to the `slotKey` mock (`actions.test.ts:133`).
- `apps/streamdeck/src/__tests__/face.test.ts` — **new**. Unit-test the pure module:
  `stateLabel` for every gate/phase id + the empty and unmapped fallbacks; `builderFaceSvg`
  contains the number and label text, wraps two-word gate labels, and emits an empty-slot
  variant.

## Risks & Alternatives Considered

- **Risk: static PNG flashes before the first `setImage`.** Low impact (one paint on appear).
  Mitigation if seen at the hardware gate: set the SVG in `onWillAppear` (already the path —
  `renderTo` is called there) so the window is a single frame; only escalate to a manifest swap
  if the flash is actually visible.
- **Risk: label doesn't fit the band on the physical deck.** The whole point of §1(b) is that
  the SVG sizes the band to the label (and wraps two-word gates), so truncation is impossible by
  construction. The hardware gate is the real check; font sizes are cheap to tune in the SVG
  without touching logic.
- **Risk: import churn from air-1411** (parallel, touches `apps/streamdeck` imports only). My
  change adds one new import line in `actions.ts` and one new file. If air-1411 merges first and
  reorders imports, I re-resolve at merge and flag to the architect per instruction — no logic
  overlap.
- **Alternative: keep `setTitle`, just clean the string + a static composed PNG.** Rejected: a
  PNG can't carry the live issue number/phase, and any title still overlays the icon — it
  doesn't remove the stacking, only tidies it.
- **Alternative: render with node-canvas.** Rejected: native dep, breaks the single-file esbuild
  bundle for no benefit over an SVG string that `setImage` accepts natively.
- **Alternative: key the map on `b.blocked` (server label).** Rejected: `blocked` is a
  non-deterministic human label ("plan review") — mapping the canonical `blockedGate` id keeps
  casing/lengths fully plugin-local (requirement 3) and deterministic.

## Test Plan

- **Unit (`face.test.ts`)**: `stateLabel` returns the exact label for each of the 9 mapped ids,
  gate-beats-phase when both present, the title-cased fallback for an unknown id, and `''` for
  no state; `builderFaceSvg` output contains the number + label, splits a two-word gate label
  across two lines, and produces a distinct `Slot N` empty variant with no number.
- **Unit (`actions.test.ts`)**: `BuilderAction.renderTo` calls `setImage` with an SVG string
  containing `#101` and `Plan Approval` (pir-1, blocked plan-approval) / `Implement` (pir-2);
  empty slot calls `setImage` with `Slot 2`; store-change still re-renders every slot key.
- **Build/typecheck**: `pnpm --filter @cluesmith/codev-streamdeck build` and `check-types` clean;
  `pnpm --filter @cluesmith/codev-streamdeck test` green. Run from the worktree.
- **Manual (dev-approval = hardware session, photo-level):** deploy the built plugin to the
  physical deck and photograph the Builder Action key across states — an **active phase**
  (`#1414` + `Implement`, icon in the upper zone, no collision, no comma), a **blocked gate**
  (`Dev Approval` two-line, legible), and an **empty slot** (`Slot N`). Confirm issue number,
  phase label, and icon are each legible at a glance and that legibility matches the Gates key.
  Verify press/rotate still fire the same verbs as before (regression check on the untouched
  path).
