# PIR Plan: Stream Deck Builder Action composite, state-coded key face

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
with the icon confined to an upper zone and the text in a reserved band below.

**Adopt the sidebar's model (scope, expanded 2026-08-12 with owner approval).** VS Code's
Builders sidebar already differentiates builders on **two axes**
(`apps/vscode/src/views/builder-row.ts`):

- **Colour = state severity.** `blocked` → warning yellow
  (`notificationsWarningIcon.foreground`), `waiting` → info blue
  (`notificationsInfoIcon.foreground`), `active` → green (`testing.iconPassed`). The colour is
  the constant "does this need me?" signal.
- **Icon shape = which gate** (when blocked), via `gateIconFor`: `spec-approval` → `book`,
  `plan-approval` → `checklist`, `dev-approval` → `code`, `pr` → `git-pull-request`,
  `verify-approval` → `verified`, else `bell`. The shape encodes *what kind of review* is
  needed; active/waiting builders show one generic glyph.

The deck adopts the **same two axes**, so the deck and the sidebar tell one story and — the
point that motivated the expansion — colour + icon carry the blocked/working distinction, which
lets the text label stay short without collision. Concretely: a `plan-approval` key is **yellow
with a checklist**, a `plan` phase key is **green with the bolt**; both can read "Plan" and stay
unmistakable. This directly serves the #1381 context (the smart key became load-bearing under
#1404's press-selects, so its face must carry its weight).

**Key enabler (verified):** `KeyAction.setImage(image?, options?)` accepts *"an SVG `string`"*
directly (SDK d.ts, `@elgato/streamdeck@2.1.0/dist/plugin/actions/key.d.ts:29-34`). So we build
the whole face as an SVG string with **zero new dependencies** — no canvas/native module, which
matters because the plugin is a single esbuild→node bundle (`apps/streamdeck/esbuild.js`) and
pure functions are the established, SDK-free-testable pattern here (cf. `src/nav/cursor.ts`).

## Proposed Change

### 1. New plugin-local module `apps/streamdeck/src/face.ts` (pure, no SDK import)

All presentation logic lives here, pure and unit-testable in isolation (mirrors `nav/cursor.ts`).
The deck LCD face is a **static SVG** — it cannot bind VS Code `ThemeColor` tokens — so the
palette is inlined as hexes that mirror VS Code's default-theme values, with a comment tying each
back to its token. The gate→icon and state→colour maps are the streamdeck twin of
`builder-row.ts`; because the two apps can't import each other, they are duplicated with a
sync-note (the same pattern as `GATE_LABELS` being kept in sync with `overview.ts`).

**(a) State classification** — mirrors the sidebar's blocked > waiting > active precedence:

```ts
export type BuilderState = 'blocked' | 'waiting' | 'active';

/** Mirrors builder-row.ts: a blocked builder (gate pending) beats idle-waiting beats active. */
export function builderState(b: Pick<OverviewBuilder, 'blocked' | 'blockedGate'>): BuilderState {
  if (b.blocked || b.blockedGate) return 'blocked';
  return 'active';
  // `waiting` (blue) is the optional third severity — it needs an idle threshold derived from
  // `lastDataAt`, matching the sidebar's `isIdleWaiting`. Core ships blocked/active; adding
  // waiting later is a strict superset (the blue token is already defined, just unused until
  // the classifier returns `'waiting'`). Decision flagged to the architect.
}
```

**(b) State palette** — inlined hexes mirroring the sidebar tokens:

```ts
// Mirrors VS Code's default-theme state colours (apps/vscode/src/views/builder-row.ts →
// BUILDER_STATE_GLYPH). The deck face is a static SVG with no ThemeColor binding, so the hexes
// are inlined; keep in sync with the sidebar if that palette changes.
const STATE_COLOR: Record<BuilderState, string> = {
  blocked: '#cca700', // notificationsWarningIcon.foreground
  waiting: '#3794ff', // notificationsInfoIcon.foreground
  active:  '#73c991', // testing.iconPassed (dark)
};
```

**(c) Gate → icon map** — the streamdeck twin of `gateIconFor`, plus the `bell` fallback:

```ts
type GlyphKey = 'bolt' | 'book' | 'checklist' | 'code' | 'pull-request' | 'verified' | 'bell';

// Keep in sync with GATE_ICONS in apps/vscode/src/views/builder-row.ts.
const GATE_ICONS: Record<string, GlyphKey> = {
  'spec-approval':   'book',
  'plan-approval':   'checklist',
  'dev-approval':    'code',
  'pr':              'pull-request',
  'verify-approval': 'verified',
};
```

The actual glyph shapes are inlined SVG path data transcribed from `@vscode/codicons` (MIT) — a
small `Record<GlyphKey, string>` of `<path>` snippets, **not** a new dependency (codicons aren't
vendored; VS Code supplies them at runtime, so we carry only the handful of paths we use, with a
provenance comment). Active/waiting builders show the plugin's `bolt`, tinted to the state colour.

**(d) Presentation label map** — short labels; colour + icon now carry the state, so the label no
longer has to. Keyed on canonical `blockedGate` / `protocolPhase` (never `b.blocked`, a
server-authored human label). Gate beats phase, matching `phaseArtifactVerb`
(`actions.ts:229-239`):

```ts
const GATE_LABELS: Record<string, string> = {
  'spec-approval':   'Spec',
  'plan-approval':   'Plan',
  'dev-approval':    'Dev',
  'pr':              'PR',
  'verify-approval': 'Verify',
};
// `verify` is the IN-PROGRESS phase; `verified` is porch's TERMINAL id (next.ts:204), with
// legacy `complete` migrating to it (state.ts:135-140) — both display 'Verified'.
const PHASE_LABELS: Record<string, string> = {
  specify: 'Specify', plan: 'Plan', implement: 'Implement',
  review: 'Review', verify: 'Verify', verified: 'Verified', complete: 'Verified',
};

/** Deliberate short label for a builder's state; '' → the caller's fallback. */
export function stateLabel(b: Pick<OverviewBuilder, 'blockedGate' | 'protocolPhase'>): string {
  const gate = b.blockedGate ?? '';
  if (GATE_LABELS[gate]) return GATE_LABELS[gate];
  const phase = b.protocolPhase ?? '';
  if (PHASE_LABELS[phase]) return PHASE_LABELS[phase];
  const raw = gate || phase; // defensive: title-case an unmapped id, never clip mid-word
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}
```

**Complete id → (label, icon, colour) table for review:**

| Wire id | Source | Label | Icon | Colour |
|---|---|---|---|---|
| `spec-approval` | blockedGate | Spec | book | warning yellow |
| `plan-approval` | blockedGate | Plan | checklist | warning yellow |
| `dev-approval` | blockedGate | Dev | code | warning yellow |
| `pr` | blockedGate | PR | git-pull-request | warning yellow |
| `verify-approval` | blockedGate | Verify | verified | warning yellow |
| _(blocked, unmapped gate)_ | blockedGate | title-cased | bell | warning yellow |
| `specify` | protocolPhase | Specify | bolt | green |
| `plan` | protocolPhase | Plan | bolt | green |
| `implement` | protocolPhase | Implement | bolt | green |
| `review` | protocolPhase | Review | bolt | green |
| `verify` | protocolPhase | Verify | bolt | green |
| `verified` | protocolPhase | Verified | bolt | green |
| `complete` | protocolPhase | Verified (legacy) | bolt | green |
| `''` / unknown | either | title-cased/empty | bolt | green |

**(e) SVG face builder** — `builderFaceSvg(face)` returns a self-contained `<svg>` string.
Layout (72×72 viewBox; the deck upscales, vector stays crisp):

```
┌───────────────┐  0
│      ⬛        │   icon zone (top ~30px): the state glyph — a gate codicon when
│               │              blocked, the bolt otherwise — coloured by state
├───────────────┤  ~35  hairline divider
│    #1414      │   number line (bold ~16px, high-contrast) — the primary datum
│    Plan       │   label band (~12px, one short line — colour+icon carry the state)
└───────────────┘  72
```

- Dark rounded background (`#1b1b1e`, the deck's neutral key ground) so the composed face reads
  as one design, like the Gates key.
- **Icon zone and text band never overlap by construction** — the fix for symptom (1).
- Glyph coloured by `STATE_COLOR[state]`; blocked keys read yellow-with-gate-shape, active keys
  read green-with-bolt (the sidebar mirror).
- Number line renders `#${issueId}` (or `id` when null); "#1414" renders as literal glyphs, no
  comma (fixes the data-corruption symptom). Labels are short single words — one line, no wrap,
  no truncation possible.
- Empty-slot variant: same frame, bolt drawn dimmed/neutral-grey, band shows `Slot N`, no number
  line (requirement 4 — consistent row).

```ts
export interface BuilderFace {
  kind: 'builder'; number: string; label: string; state: BuilderState; icon: GlyphKey;
}
export function builderFaceSvg(face: BuilderFace | { kind: 'empty'; slot: string }): string;

/** Assemble the full face descriptor for a builder — all mapping in one testable place. */
export function faceForBuilder(b: OverviewBuilder): BuilderFace {
  const state = builderState(b);
  const icon: GlyphKey = state === 'blocked' ? (GATE_ICONS[b.blockedGate ?? ''] ?? 'bell') : 'bolt';
  return { kind: 'builder', number: b.issueId ? `#${b.issueId}` : b.id, label: stateLabel(b), state, icon };
}
```

### 2. Rewire `BuilderAction.renderTo` (`actions.ts:164-169`)

Replace the `setTitle` overlay with an image render. **Only this method changes**; press/rotate
behaviour (`resolveVerb`, `onKeyDown`, `phaseArtifactVerb`, the `automatic`→`open-diff-first`
resolution from #1429/#1404/#1414) is **untouched**.

```ts
protected renderTo(action: KeyAction, settings: SlotSettings): void {
  const b = slotBuilder(this.store, settings);
  const svg = b
    ? builderFaceSvg(faceForBuilder(b))
    : builderFaceSvg({ kind: 'empty', slot: settings.slot ?? '1' });
  void action.setImage(svg);
  void action.setTitle(''); // suppress the SDK title layer so the SVG is the whole face
}
```

All mapping stays in `face.ts`; the action stays a thin adapter. `setTitle('')` guarantees no
residual manifest/user title paints over the SVG (belt-and-braces against the stacking that
caused symptom 1).

### 3. No other layers change

- **Manifest**: unchanged. The `icons/builder-action` PNG stays as the static/PI thumbnail; at
  runtime `setImage` replaces the face.
- **Wire / types / server**: **no change** (requirement 3). Everything reads existing
  `blockedGate` / `protocolPhase` / `issueId` fields already on `OverviewBuilder`.
- **Press/rotate**: **no change** — the architect's hard boundary (#1429 `resolveVerb` intact).

## Files to Change

- `apps/streamdeck/src/face.ts` — **new**. Pure module: `BuilderState` + `builderState()`,
  `STATE_COLOR`, `GATE_ICONS` + inlined codicon `<path>` data, `GATE_LABELS`/`PHASE_LABELS` +
  `stateLabel()`, `faceForBuilder()`, `builderFaceSvg()`. No SDK import (testable like
  `nav/cursor.ts`).
- `apps/streamdeck/src/actions.ts:164-169` — `BuilderAction.renderTo` switches to
  `builderFaceSvg(faceForBuilder(b))` + `setImage`; add the `face.ts` import. Nothing else changes.
- `apps/streamdeck/src/__tests__/actions.test.ts:146-155` — the two render assertions currently
  expect `setTitle` to contain `plan review` / `implement` / `#101`. Update to assert `setImage`
  called with an SVG string containing `#101` + the mapped short label + the state colour
  (`#cca700` for pir-1's blocked plan-approval, `#73c991` for pir-2 active). Add
  `setImage: vi.fn()` to the `slotKey` mock (`actions.test.ts:133`).
- `apps/streamdeck/src/__tests__/face.test.ts` — **new**. Unit-test the pure module:
  `builderState` (blocked when `blockedGate`/`blocked`, else active); `faceForBuilder` picks the
  right gate glyph per gate id + `bell` fallback + `bolt` when active; `stateLabel` for every
  mapped id + fallbacks; `builderFaceSvg` output contains number, label, the state colour, and a
  distinct `Slot N` empty variant.

## Risks & Alternatives Considered

- **Risk: gate→icon / state→colour duplicated from `builder-row.ts`.** The streamdeck plugin and
  the vscode app can't import each other, so the maps are twinned with a sync-note comment (same
  established pattern as `overview.ts` ↔ `builder-row.ts` `GATE_LABELS`). If the sidebar palette
  or gate icons change, both must update. Low churn (gates rarely change); the comment names the
  counterpart file.
- **Risk: inlined codicon paths.** We transcribe a handful of `@vscode/codicons` (MIT) `<path>`
  strings rather than add a dependency. Provenance noted in a comment. The glyphs must read at
  72px on hardware — verified at the photo gate; sizes/strokes are cheap to tune in the SVG.
- **Risk: a profile-pinned custom image silently defeats `setImage`.** SDK doc: *"The image can
  only be set by the plugin when the user has not specified a custom image."* If the
  bundled/imported profile pins a custom image on a Builder Action key, the SVG face is ignored
  with no error. Mitigation: verify the profile (incl. the #1404-revved one) does **not** pin
  custom images; if the face doesn't render at the gate, this is the **first** suspect. In the
  hardware checklist.
- **Risk: static PNG flashes before the first `setImage`.** Low impact (one paint on appear); the
  SVG is set in the `onWillAppear`→`renderTo` path, so the window is a single frame. Escalate to a
  manifest swap only if visibly flashing.
- **Risk: import churn from air-1411** (parallel, touches `apps/streamdeck` imports only). This
  change adds one import line in `actions.ts` plus one new file. Re-resolve at merge and flag to
  the architect per instruction — no logic overlap.
- **Observation (not a change): `verify-approval` press-path gap.** The presentation map now
  renders `verify-approval` (label + `verified` icon), mirroring the sidebar. But the press
  resolver `phaseArtifactVerb` (`actions.ts:229-239`) doesn't handle `verify-approval` — a
  pre-existing gap. Left untouched here (press/rotate is out of scope per the architect boundary);
  flagged for a separate follow-up.
- **Alternative: neutral face, differentiate by text only (the prior plan).** Rejected after the
  owner review: short gate labels alone collide with same-named phases (`plan-approval` vs `plan`);
  two-word labels wrap to cramped two-line text. Colour + icon differentiate without either cost,
  and match what the owner already reads in the sidebar.
- **Alternative: render with node-canvas.** Rejected: native dep, breaks the single-file esbuild
  bundle for no benefit over an SVG string that `setImage` accepts natively.
- **Alternative: key the maps on `b.blocked` (server label).** Rejected: `blocked` is a
  non-deterministic human label — keying canonical `blockedGate` keeps everything plugin-local and
  deterministic.

## Test Plan

- **Unit (`face.test.ts`)**: `builderState` returns `blocked` for a set `blockedGate` (or
  `blocked`) and `active` otherwise; `faceForBuilder` maps each gate id to its glyph
  (`book`/`checklist`/`code`/`pull-request`/`verified`), falls back to `bell` for an unmapped
  blocked gate, and uses `bolt` when active; `stateLabel` returns the exact short label for every
  mapped id (incl. `verify`→'Verify' vs `verified`/`complete`→'Verified') with the title-cased
  fallback; `builderFaceSvg` output contains the number, the short label, and the state colour,
  and the empty variant renders `Slot N` with no number.
- **Unit (`actions.test.ts`)**: `renderTo` calls `setImage` with an SVG containing `#101`,
  `Plan`, and `#cca700` (pir-1, blocked plan-approval) / `Implement` and `#73c991` (pir-2,
  active); empty slot → `setImage` containing `Slot 2`; a store change re-renders every slot key.
- **Build/typecheck**: `pnpm --filter @cluesmith/codev-streamdeck build`, `check-types`, and
  `test` all clean. Run from the worktree.
- **Manual (dev-approval = hardware session, photo-level):** deploy the built plugin to the
  physical deck and photograph the Builder Action key across states — **active** (`#1414` +
  `Implement`, green bolt), each **blocked gate** (yellow, with its distinct glyph — checklist
  for plan-approval, code for dev-approval, pull-request for pr), and **empty** (`Slot N`).
  Confirm: number reads with no comma; colour (yellow vs green) reads at a glance; each gate's
  icon is distinguishable; legibility matches the Gates key; and press/rotate still fire the same
  verbs (regression check on the untouched path).
- **Manual — pre-flight (first at the hardware gate):** confirm the active/imported profile
  (incl. #1404-revved) does **not** pin a custom image on the Builder Action keys — a pinned
  custom image makes `setImage` a silent no-op. Check this before debugging the SVG or render path.
