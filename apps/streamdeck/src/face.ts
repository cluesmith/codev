import type { OverviewBuilder } from '@cluesmith/codev-sdk/controller';

/**
 * Builder Action key face — the plugin composes the WHOLE key as one SVG (handed to
 * `KeyAction.setImage`), instead of stacking a `setTitle` over the manifest's bolt PNG. The two
 * stacked layers were the root cause of #1428 (text on the icon's diagonal, `#1414` reading as
 * `#1,414` where the bolt edge bleeds between digits, and mid-word truncation).
 *
 * The face mirrors the VS Code Builders sidebar's two-axis vocabulary
 * (`apps/vscode/src/views/builder-row.ts`): COLOUR encodes state severity, ICON encodes which
 * gate a blocked builder waits on. The maps below are the streamdeck TWIN of that file — the two
 * apps can't (and, by owner ruling, shouldn't) import each other, so the deck REPLICATES the
 * sidebar's look independently and the maps are kept aligned by the sync-notes on each. This is an
 * accepted, intentional pattern here, not single-source-of-truth debt.
 *
 * Pure and SDK-free so it unit-tests without the Stream Deck runtime (mirrors `nav/cursor.ts`).
 */

/** State severity, in the sidebar's precedence: blocked beats waiting beats active. */
export type BuilderState = 'blocked' | 'waiting' | 'active';

/**
 * Classify a builder's state. Mirrors `builder-row.ts`'s blocked > idle > active precedence.
 *
 * v1 ships `blocked` / `active` only. `waiting` (blue) is the deferred strict-superset follow-up:
 * it needs an idle threshold derived from `lastDataAt` (the sidebar's `isIdleWaiting`); until this
 * returns `'waiting'`, the blue token in `STATE_COLOR` is defined-but-unused. Adding it later
 * changes only this function.
 */
export function builderState(b: Pick<OverviewBuilder, 'blocked' | 'blockedGate'>): BuilderState {
  if (b.blocked || b.blockedGate) return 'blocked';
  return 'active';
}

/**
 * State → colour. Inlined hexes that mirror VS Code's default-theme tokens (the deck LCD face is a
 * static SVG with no `ThemeColor` binding). Keep in sync with `BUILDER_STATE_GLYPH` in
 * `apps/vscode/src/views/builder-row.ts`.
 */
const STATE_COLOR: Record<BuilderState, string> = {
  blocked: '#cca700', // notificationsWarningIcon.foreground
  waiting: '#3794ff', // notificationsInfoIcon.foreground
  active: '#73c991', //  testing.iconPassed (dark)
};

/** The glyphs the face can draw: a gate shape when blocked, the bolt otherwise. */
export type GlyphKey = 'bolt' | 'book' | 'checklist' | 'code' | 'pull-request' | 'verified' | 'bell' | 'comment' | 'terminal' | 'play' | 'architect' | 'switch';

/**
 * Gate id → glyph. The streamdeck twin of `gateIconFor` in `apps/vscode/src/views/builder-row.ts`
 * — keep in sync. A blocked builder whose gate isn't mapped falls back to `bell` (see
 * `faceForBuilder`), matching the sidebar.
 */
const GATE_ICONS: Record<string, GlyphKey> = {
  'spec-approval': 'book',
  'plan-approval': 'checklist',
  'dev-approval': 'code',
  pr: 'pull-request',
  'verify-approval': 'verified',
};

/**
 * Glyph → inner SVG markup, drawn in a 24×24 box and stroked/filled in the caller's colour. The
 * shapes are modelled on the matching VS Code codicons (book / checklist / code / git-pull-request
 * / verified / bell); the codicon font isn't vendored, so these are drawn in-plugin — which also
 * keeps the bundle dependency-free. The bolt is filled (the plugin's identity mark); the rest are
 * line glyphs like the codicons.
 */
const GLYPHS: Record<GlyphKey, (color: string) => string> = {
  bolt: (c) => `<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="${c}"/>`,
  book: (c) => stroked(c, '<path d="M5 4h13v16H5z"/><path d="M11 4v16"/>'),
  checklist: (c) => stroked(c, '<path d="M3 6l2 2 3-3"/><path d="M11 7h10"/><path d="M3 15l2 2 3-3"/><path d="M11 16h10"/>'),
  code: (c) => stroked(c, '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/>'),
  'pull-request': (c) =>
    stroked(c, '<circle cx="7" cy="6" r="2.3"/><circle cx="7" cy="18" r="2.3"/><circle cx="17" cy="18" r="2.3"/><path d="M7 8.3v7.4"/><path d="M17 15.7V12a3 3 0 0 0-3-3h-3.5"/>'),
  verified: (c) => stroked(c, '<path d="M12 3l7 3v5c0 4.5-3 7.6-7 9.2C8 18.6 5 15.5 5 11V6z"/><path d="M8.6 12l2.3 2.3 4.6-4.6"/>'),
  bell: (c) => stroked(c, '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10.5 20a1.6 1.6 0 0 0 3 0"/>'),
  comment: (c) => stroked(c, '<path d="M4 5h16v11H10l-4 4v-4H4z"/>'),
  terminal: (c) => stroked(c, '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 10l3 2.5-3 2.5"/><path d="M12.5 15h4"/>'),
  play: (c) => `<path d="M8 5v14l11-7z" fill="${c}"/>`, // VS Code's Run/Start-Dev affordance
  // architect: a person mark — the architect you talk to (#1463). No trailing comment: the icon
  // render script (scripts/render-action-icons.mjs) parses this exact line and rejects one.
  architect: (c) => stroked(c, '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>'),
  // switch: two opposed arrows — the Builders/Architects board toggle (#1495). Rendered onto a
  // Codev key ground so a native Switch-Profile / Folder key blends with the plugin's own keys. No
  // trailing comment ON the entry line: the icon render script parses that line and rejects one.
  switch: (c) => stroked(c, '<path d="M4 9h13"/><path d="M14 6l3 3-3 3"/><path d="M20 15H7"/><path d="M10 18l-3-3 3-3"/>'),
};

/** Wrap line-glyph paths in a shared stroke group (round caps/joins, like the codicons). */
function stroked(color: string, paths: string): string {
  return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
}

/**
 * Gate id → short display label (blocked builders). The streamdeck twin of the sidebar's gate
 * vocabulary. Short by design: colour + icon carry the blocked-vs-working distinction, so the
 * label need not — `Plan` (gate) and `Plan` (phase) stay unmistakable via yellow-checklist vs
 * green-bolt. Keyed on the canonical `blockedGate` id, never the free-form `blocked` label.
 */
const GATE_LABELS: Record<string, string> = {
  'spec-approval': 'Spec',
  'plan-approval': 'Plan',
  'dev-approval': 'Dev',
  pr: 'PR',
  'verify-approval': 'Verify',
};

/**
 * Protocol phase id → display label (active builders). `verify` is the IN-PROGRESS phase; `verified`
 * is porch's TERMINAL id (`next.ts:204`), with legacy `complete` migrating to it
 * (`state.ts:135-140`) — both display `Verified`.
 */
const PHASE_LABELS: Record<string, string> = {
  specify: 'Specify',
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  verify: 'Verify',
  verified: 'Verified',
  complete: 'Verified',
  pr: 'PR',
};

/**
 * Deliberate short label for a builder's state. Gate beats phase (matching `phaseArtifactVerb`);
 * an unmapped id is title-cased so nothing renders lowercase or clips mid-word; no state → `''`.
 */
export function stateLabel(b: Pick<OverviewBuilder, 'blockedGate' | 'protocolPhase'>): string {
  // A blocked builder's gate ALWAYS wins over its phase — even an UNMAPPED gate title-cases to a
  // short label, so a pending gate is never masked by the phase beneath it. (The face is already
  // yellow + bell for an unmapped gate; the label must agree, or the key would read as its phase
  // while looking blocked.) Only a builder with no gate at all falls through to its phase.
  const gate = b.blockedGate ?? '';
  if (gate) return GATE_LABELS[gate] ?? titleToken(gate);
  const phase = b.protocolPhase ?? '';
  if (phase) return PHASE_LABELS[phase] ?? titleToken(phase);
  return '';
}

/** Short, key-friendly fallback for an unmapped id: its first alphanumeric token, title-cased
 *  (e.g. `security-approval` → `Security`) — never lowercase, never a mid-word clip. */
function titleToken(raw: string): string {
  const token = raw.split(/[^a-zA-Z0-9]/, 1)[0] ?? '';
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** A fully-resolved builder face: what to draw and how to colour it. */
export interface BuilderFace {
  kind: 'builder';
  number: string;
  label: string;
  state: BuilderState;
  icon: GlyphKey;
  /** True for the Row-1 slot holding the shared selection — draws an accent ring
   *  so the live builder among the four is unmistakable (#1410). */
  selected: boolean;
}

/** Resolve a builder into its face descriptor — all id→presentation mapping in one testable place.
 *  `selected` marks the Row-1 slot that currently holds the shared selection. */
export function faceForBuilder(b: OverviewBuilder, selected = false): BuilderFace {
  const state = builderState(b);
  let icon: GlyphKey = 'bolt';
  if (state === 'blocked') {
    icon = GATE_ICONS[b.blockedGate ?? ''] ?? 'bell';
  }
  let number = b.id;
  if (b.issueId) {
    number = `#${b.issueId}`;
  }
  return { kind: 'builder', number, label: stateLabel(b), state, icon, selected };
}

/**
 * Render a key face as a self-contained SVG string for `setImage`. 72×72 viewBox (the deck
 * upscales; vector stays crisp): an icon zone up top, a hairline divider, then a reserved text
 * band (number + short label). Icon zone and text band never overlap by construction — the fix
 * for the collision symptom.
 */
export function builderFaceSvg(face: BuilderFace | { kind: 'empty'; slot: string }): string {
  if (face.kind === 'empty') {
    return svg(`${BG}${iconZone('bolt', '#63636b')}${DIVIDER}${centeredLine(`Slot ${face.slot}`)}`);
  }
  return svg(
    `${BG}${iconZone(face.icon, STATE_COLOR[face.state])}${DIVIDER}` +
      `${primaryLine(face.number)}${secondaryLine(face.label)}` +
      `${face.selected ? SELECTED_RING : ''}`,
  );
}

/** Accent ring drawn on top of the selected Row-1 slot's face (#1410). */
const SELECTED_RING = '<rect x="2" y="2" width="68" height="68" rx="11" fill="none" stroke="#f4f4f6" stroke-width="3"/>';

/**
 * The Row-2 **[Approve gate]** key face (#1410): it acts on the SELECTED builder,
 * so it renders that builder's pending gate — the gate label (e.g. `Plan`) over an
 * `Approve` band, warning-tinted, when the selection is blocked at a gate; a dim,
 * inert `Approve` when it isn't (or nothing is selected). Never a fleet-wide count —
 * the pending-gate tally lives on the [Next / attention] key.
 */
export function approveFaceSvg(b: Pick<OverviewBuilder, 'blockedGate'> | undefined): string {
  const gate = b?.blockedGate ?? '';
  if (!gate) {
    return labelFaceSvg('verified', 'Approve', '#63636b');
  }
  const label = GATE_LABELS[gate] ?? titleToken(gate);
  return svg(
    `${BG}${iconZone('verified', STATE_COLOR.blocked)}${DIVIDER}` +
      `${primaryLine(label)}${secondaryLine('Approve')}`,
  );
}

/**
 * The Row-2 **[Send Fb]** key face (#1410): a comment glyph with the selected
 * builder's queued-feedback count. `n > 0` → active-green icon + count + `Send Fb`
 * (press flushes the queue); `n === 0` → dim glyph + `Send Fb` (inert — nothing
 * queued, or the workspace forwards immediately).
 */
export function sendFbFaceSvg(n: number): string {
  if (n <= 0) {
    return labelFaceSvg('comment', 'Send Fb', '#63636b');
  }
  return svg(
    `${BG}${iconZone('comment', STATE_COLOR.active)}${DIVIDER}` +
      `${primaryLine(String(n))}${secondaryLine('Send Fb')}`,
  );
}

/**
 * A simple action-key face: an icon over a single centered label, no primary datum. For keys that
 * aren't builder-state-coded (e.g. the Run Dev key) but should still match the composite pattern
 * — icon in the zone, text in the band, never stacked.
 */
export function labelFaceSvg(icon: GlyphKey, label: string, color: string): string {
  return svg(`${BG}${iconZone(icon, color)}${DIVIDER}${centeredLine(label)}`);
}

/** Capitalize the first letter of an architect name for display. The wire name is lowercase
 *  (`[a-z][a-z0-9-]*`), so `main` → `Main`, `streamdeck` → `Streamdeck`. Deck-local, NOT a twin of
 *  VS Code's uppercase `displayArchitectName` (which marks a mixed architect tier the deck lacks);
 *  the deck's own band labels are Title-case. */
export function capitalizeFirst(name: string): string {
  if (!name) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The Row-2 **[Open Architect]** key face (#1463): a person glyph over a title/subtitle band. The
 * title is the constant `Architect`; the subtitle is the RESOLVED architect name — and the subtitle
 * is the safeguard, not decoration: it shows who a press would summon before you press. When no
 * architect resolves (Builder mode with nothing selected / no owner), the whole face DIMS and the
 * subtitle reads `None` — visibly unavailable, never a normal-looking key that silently does nothing.
 */
export function architectFaceSvg(name: string | undefined): string {
  if (name === undefined) {
    return svg(
      `${BG}${iconZone('architect', '#63636b')}${DIVIDER}` +
        `${primaryLine('Architect', '#63636b')}${secondaryLine('None', '#63636b')}`,
    );
  }
  return svg(
    `${BG}${iconZone('architect', '#a9a9b2')}${DIVIDER}` +
      `${primaryLine('Architect')}${secondaryLine(capitalizeFirst(name))}`,
  );
}

/**
 * The Architect Action key face (#1495): the architect glyph over that architect's NAME — one
 * key per live architect on the Architects board. Unlike the Open Architect key (which titles a
 * single resolved target `Architect` / name), an enumeration key IS the name, so the name is the
 * prominent line, shrink-to-fit for long names. `undefined` — a slot past the end of the
 * enumerated list, or an empty board during a Tower restart — renders VISIBLY INERT (dim glyph +
 * dim `No architect`), never blank-but-live; these are physical key placements that cannot
 * vanish, so an emptied board must read as inert and self-corrects on the next overview. No
 * active/accent state: the board carries no scope, so nothing is "selected".
 */
export function architectKeyFaceSvg(name: string | undefined): string {
  if (name === undefined) {
    return svg(
      `${BG}${iconZone('architect', '#63636b')}${DIVIDER}` +
        `<text ${textAttrs(36, 55, 12, 500)}${fit('No architect', 9)} fill="#63636b">No architect</text>`,
    );
  }
  const label = capitalizeFirst(name);
  return svg(
    `${BG}${iconZone('architect', '#a9a9b2')}${DIVIDER}` +
      `<text ${textAttrs(36, 55, 14, 600)}${fit(label, 9)} fill="#f4f4f6">${escapeXml(label)}</text>`,
  );
}

/** Shared face frame: the rounded key ground and the hairline that splits icon zone from text band. */
const BG = '<rect width="72" height="72" rx="12" fill="#1b1b1e"/>';
const DIVIDER = '<line x1="14" y1="35" x2="58" y2="35" stroke="#333338" stroke-width="1"/>';

/** Place a glyph, tinted, in the icon zone (upper ~30px). */
function iconZone(glyph: GlyphKey, color: string): string {
  return `<g transform="translate(24,7)">${GLYPHS[glyph](color)}</g>`;
}
/** Shrink-to-fit for a string that would overflow the 72px face (a long builder-id fallback, an
 *  unusually long unmapped-id label). Empty for short strings, so the common case keeps its
 *  natural width instead of being stretched. */
function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return '';
  return ' textLength="60" lengthAdjust="spacingAndGlyphs"';
}
/** Primary datum: bold, high-contrast (issue number / pending count). `color` dims it for inert faces. */
function primaryLine(text: string, color = '#f4f4f6'): string {
  return `<text ${textAttrs(36, 50, 16, 700)}${fit(text, 6)} fill="${color}">${escapeXml(text)}</text>`;
}
/** Secondary label: muted, below the primary line. `color` dims it for inert faces. */
function secondaryLine(text: string, color = '#a9a9b2'): string {
  return `<text ${textAttrs(36, 63, 12, 500)}${fit(text, 9)} fill="${color}">${escapeXml(text)}</text>`;
}
/** A single muted line centered in the band, when there is no primary datum (empty slot / no gates). */
function centeredLine(text: string): string {
  return `<text ${textAttrs(36, 55, 14, 600)} fill="#8a8a92">${escapeXml(text)}</text>`;
}

function svg(inner: string): string {
  // Explicit width/height (not just viewBox): Stream Deck's rasterizer needs an intrinsic size or
  // it drops the image entirely and falls back to the manifest PNG.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">${inner}</svg>`;
}

/**
 * Encode a face SVG for `setImage`. Stream Deck (6.x) renders an SVG reliably only as a base64
 * data URI with the mime type declared — a raw `<svg>` string is silently dropped (the whole key
 * reverts to its manifest image). This is the SDK's documented "base64 encoded string with the
 * mime type declared" form.
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** Shared text attributes: centered, generic sans (the rasterizer resolves it), given baseline/size/weight. */
function textAttrs(x: number, y: number, size: number, weight: number): string {
  return `x="${x}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${size}" font-weight="${weight}"`;
}

/** Escape the five XML entities so a builder id / label can't break the SVG string. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
