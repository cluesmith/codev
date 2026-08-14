# PIR Plan: In-preview typography controls (zoom) for the Codev Markdown Preview

## Understanding

#1053 wired a typography token tier into the Codev Markdown Preview (the `CustomTextEditor`
webview from #859) plus two user settings, `codev.markdownPreview.fontSize` and
`codev.markdownPreview.lineHeight`. Those settings adjust the preview's prose without moving the
rest of the IDE chrome. Today the only way to change them is VS Code's Settings editor or
`settings.json`: a reviewer reading a long spec has to leave the surface to change a number.

This issue closes that discoverable-affordance gap. It is purely a **UI affordance + write-back**,
not new theming: add an in-surface control that steps `codev.markdownPreview.fontSize` and
**persists the new value back to the setting**, so the control and the Settings editor stay one
source of truth. The existing live-reflow path already re-renders on
`onDidChangeConfiguration` (`apps/vscode/src/markdown-preview/preview-provider.ts:118-123`), so a
write-back reflows immediately for free.

I read the issue body and all four comments. The body is out of date; the corrections that bind
(later comment wins) are folded into the **Shared-surface token change** section below.

### What already exists (so I reuse, not rebuild)

- Settings + schema: `codev.markdownPreview.fontSize` / `.lineHeight`, both `number`, `minimum: 0`,
  `default: 0` where 0 means "use the built-in github-baseline default" (16px / 1.5).
  `apps/vscode/package.json` configuration block.
- Host injection of the tokens: `preview-provider.ts:252-263` reads the two settings and passes
  them to `renderMarkdownPreviewHtml`, which emits `--codev-canvas-font-size` /
  `--codev-canvas-line-height` overrides (`preview-template.ts:116-125`). A non-positive value
  contributes nothing, leaving the package default in place.
- Live reflow: `onDidChangeConfiguration` re-renders the webview HTML on any
  `codev.markdownPreview` change (`preview-provider.ts:118-123`). **No change needed here** — a
  write-back to the setting flows through this path automatically.
- Editor-title toolbar precedent: `codev.openMarkdownPreview` is already contributed to
  `menus.editor/title` (`apps/vscode/package.json:436-441`), so a native title-bar button on the
  preview is an established pattern in this extension.

## Proposed Change

The work splits into two clearly separated workstreams. **Workstream A is the issue's core scope**
and lives entirely in `apps/vscode`. **Workstream B is a shared-surface token change in
`packages/artifact-canvas`** (owned by the main architect) and is delineated here so it can be
routed to them before the plan-approval gate. A can ship without B.

### Decision: native editor-title buttons + commands + keybindings (not webview chrome)

The issue asks me to decide between webview toolbar buttons, command-palette commands, or both.
I choose **command-palette commands surfaced as native `editor/title` icon buttons, plus
keybindings** — and deliberately **not** webview HTML chrome. Rationale:

- It satisfies discoverability (the whole point of the issue): the reviewer sees zoom buttons on
  the preview's title bar, exactly where VS Code's own preview and browsers put zoom.
- It is **host-only**. No webview→host message protocol change (`messages.ts` untouched), no
  webview chrome, and crucially **no control code in the shared `artifact-canvas` package**. A
  webview toolbar would either add chrome to that shared surface or add a bespoke host overlay;
  both are more surface area for a "step a number" action.
- It reuses the extension's own precedent (`openMarkdownPreview` in `editor/title`) and the
  free live-reflow path.
- Custom editors expose the `activeCustomEditorId` context key, so buttons/keybindings scope
  cleanly to `activeCustomEditorId == codev.markdownPreview` (visible/active only on the preview).

### Workstream A — Host affordance (apps/vscode)

Three commands:

- `codev.markdownPreview.increaseFontSize` — icon `$(zoom-in)`
- `codev.markdownPreview.decreaseFontSize` — icon `$(zoom-out)`
- `codev.markdownPreview.resetFontSize` — palette + overflow menu (no title-bar icon, to keep the
  toolbar to two buttons; reset is the rare action)

Stepping logic (extracted as a pure, unit-tested function so the handler stays a thin VS Code
shim):

- Effective current size = `fontSize > 0 ? fontSize : 16` (16 is the github-baseline the token
  default documents).
- Increase: `min(effective + STEP, MAX)`. Decrease: `max(effective - STEP, MIN)`.
  Proposed `STEP = 1`, `MIN = 8`, `MAX = 40` (sane reading bounds; final numbers confirmed at
  dev-approval by feel).
- Reset: write `0` back (restore the built-in default) rather than `16`, so the setting returns to
  its documented "use default" sentinel and any future baseline change still applies. Reset clears
  **both** `fontSize` and `lineHeight` to 0.

Write-back target: write to the scope where the setting is **already** defined
(`configuration.inspect()` — workspace value present → `ConfigurationTarget.Workspace`, else
`ConfigurationTarget.Global`). This avoids the silent-no-op where a Global write is shadowed by an
existing workspace override. Default is Global (a personal reading preference, matching how
per-user reading mode is scoped in spec 1380 D4).

Scope of the +/− control: **font-size only** (not line-height). Line-height is a finer
typographic preference; keeping the buttons to one knob matches browser/preview zoom and keeps the
affordance legible. Reset still clears line-height too (so a user who tuned it in Settings can get
back to baseline from the surface). This is the "font-size only" option the issue lists.

### Workstream B — Shared-surface token change (packages/artifact-canvas) — ROUTE TO MAIN

**This is the only change outside `apps/vscode`. It touches a surface owned by the main
architect and must be routed to them before plan-approval.** It is measurement-gated at
dev-approval and can be dropped without affecting Workstream A.

**What binds (verified against the tree, per the architect's corrections):**

- The token snapshot in `packages/artifact-canvas/src/__tests__/default-theme.test.ts:31-58` pins
  the token **vocabulary (names)**, not values. Column tokens keep their names, so the snapshot is
  unaffected.
- Value assertions in that file are **selective**. Neither `--codev-canvas-column-width` nor
  `--codev-canvas-column-gap` is asserted, so changing their **values** is free (no test breaks).
- But `--codev-canvas-paragraph-spacing` **is** asserted at `16px` (line 71) and
  `--codev-canvas-gutter` at `1.9rem` (line 130). So making **rhythm** scale with font size touches
  an asserted baseline.

**In-scope token change (free, serves zoom directly):** make the horizontal-mode measure track
font size by making the column tokens em-relative:

- `--codev-canvas-column-width: 400px` → `25em` (400 / 16 = 25em at baseline; identical at 16px).
- `--codev-canvas-column-gap: 48px` → `3em` (48 / 16 = 3em at baseline; identical at 16px).

At baseline these are byte-equivalent in rendered px, so nothing changes today; under zoom the
columns widen with the prose, keeping the **measure constant in characters** (which is what a
measure is). `column-width` is a preferred minimum, so real columns still stretch to share
leftover viewport width. D6 is preserved exactly: there is still no settings UI for the column
tokens; overriding them remains the supported retune path.

**Explicitly EXCLUDED from scope — a separate, deliberate decision, not a surprise:** making
**rhythm** (`--codev-canvas-paragraph-spacing`, `--codev-canvas-gutter`) em-relative. Because
font-size grows while paragraph-spacing stays a fixed 16px, rhythm tightens *relative to* the prose
under zoom (architect effect #2). Fixing that would touch the two asserted baselines above (a
one-line test update per token). I recommend **deferring** it: verify at dev-approval whether the
tightening actually degrades reading before touching an asserted contract. If we do pursue it, it
is called out here so review sees it coming.

**The silent effect, documented and measured, not "fixed":** the tall-block cap
(`--_codev-column-cap`, `default-theme.css:506-508`) derives from the **JS-observed column height**
(≈ viewport height) minus rhythm, **not** from font size. So **no token change addresses it.** As
prose grows, fences, tables, images, and marker cards get taller against a fixed cap, so more of
them cross it and become inner vertical scrollers nested inside a horizontally scrolling column
(`default-theme.css:521-553`). This is bounded scroll (never overflow), and it is the effect that
degrades reading **silently**, so it is the first thing to look at at the dev-approval gate — see
Test Plan. It is accepted behavior to be verified tolerable, not a bug to fix in this issue.

**Fixtures that bake the current geometry** (read before changing token meaning; they mock
*resolved computed* values, so an em token change does **not** break them, but they encode the
400px/48px assumption in scroll math): `packages/artifact-canvas/src/components/__tests__/fragment-geometry.test.ts:10`,
`.../horizontal-input.test.tsx:151`, `.../horizontal-input.test.tsx:160`. Confirmed at implement
time that none assert the token **strings**.

## Files to Change

### Workstream A (apps/vscode — core scope)

- `apps/vscode/package.json`
  - `contributes.commands`: add the three `codev.markdownPreview.*FontSize` commands (titles
    `Codev: Increase / Decrease / Reset Markdown Preview Font Size`, with icons on increase/decrease).
  - `contributes.menus.editor/title` (around `:436`): add increase + decrease, `group: navigation`,
    `when: activeCustomEditorId == codev.markdownPreview`.
  - `contributes.menus.commandPalette`: add all three gated
    `when: activeCustomEditorId == codev.markdownPreview` (only offered when the preview is active).
  - `contributes.keybindings`: `cmd+=`/`ctrl+=` (increase), `cmd+-`/`ctrl+-` (decrease),
    `cmd+0`/`ctrl+0` (reset), each `when: activeCustomEditorId == codev.markdownPreview`.
- `apps/vscode/src/markdown-preview/font-size-control.ts` — **new**. Pure functions:
  `effectiveFontSize(raw)`, `steppedFontSize(raw, direction, {step,min,max})`, and the constants.
  No `vscode` import, so it is trivially unit-testable.
- `apps/vscode/src/extension.ts` (near `codev.openMarkdownPreview`, `:1106`): register the three
  handlers. Each reads `codev.markdownPreview`, computes the next value via `font-size-control`,
  resolves the write target via `inspect()`, and `config.update(...)`. Reset writes `0` to both
  `fontSize` and `lineHeight`.
- `apps/vscode/src/__tests__/preview-font-size-control.test.ts` — **new**. Unit tests for the pure
  logic (effective default, step up/down, clamp at min/max, reset semantics).

### Workstream B (packages/artifact-canvas — routed to main, measurement-gated)

- `packages/artifact-canvas/src/styles/default-theme.css:68-69` — `column-width`/`column-gap`
  values px → em (names unchanged).
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts` — optional: add an assertion that
  the two column tokens are em-relative (documents intent; the vocabulary snapshot is untouched).
- No change expected to the three geometry fixtures (they mock resolved values); confirm at
  implement time.

## Risks & Alternatives Considered

- **Risk — keybinding shadowing.** `cmd+=`/`cmd+-`/`cmd+0` are VS Code's workbench zoom bindings.
  Scoping to `activeCustomEditorId == codev.markdownPreview` means our bindings win **only while the
  preview is focused**; everywhere else workbench zoom is unaffected. This matches browser/preview
  norms (zoom keys act on the focused reading surface). Verified these are the workbench-zoom
  defaults before proposing.
- **Risk — write-back silently no-ops** under an existing workspace override. Mitigated by writing
  to the setting's existing scope via `inspect()` (Workspace if defined there, else Global).
- **Risk — shared-package ownership.** Workstream B changes a main-owned surface. Delineated above
  and routed to main before plan-approval; A ships independently if B is declined.
- **Risk — horizontal-mode reads badly under zoom** (the silent tall-block-cap effect). Not
  fixable by tokens; verified tolerable at dev-approval with real fences/tables at several zoom
  levels in both modes (evidence required, see Test Plan). If em columns make it worse, revert B to
  px and keep A.
- **Alternative — webview toolbar buttons in the canvas.** Rejected: adds chrome/message protocol
  to the shared surface for a host-side "step a number" action, more surface area than native
  title-bar buttons buy.
- **Alternative — a `settings.json`-only doc pointer.** Rejected: that is the status quo the issue
  exists to fix.
- **Alternative — include line-height in +/−.** Rejected for the stepping buttons (keeps the
  affordance to one legible knob); reset still clears it.

## Test Plan

### Unit (automated)

- `preview-font-size-control.test.ts`: effective default (0 → 16), increase/decrease by STEP,
  clamp at MIN/MAX, reset returns the sentinel `0`.
- `packages/artifact-canvas` suite stays green: vocabulary snapshot unchanged; no asserted value
  touched by the column-token change; the three geometry fixtures unaffected (they mock resolved
  values). Run the package suite to confirm.

### Manual — dev-approval gate (REQUIRED evidence, not just passing tests)

The failure mode is **silent**, so passing tests are not evidence the surface still reads well.
Open a real spec containing **fenced code, a wide table, and an image** in the preview, then, in
**both vertical and horizontal reading modes**, at **~3 zoom levels** (e.g. 14 / 20 / 28px):

1. The `$(zoom-in)` / `$(zoom-out)` buttons are visible on the preview's title bar, and the
   command palette offers all three only when the preview is active.
2. +/− reflow **live** (no reopen), and the value **persists** across closing and reopening the
   preview (confirming it was written to the setting, not held in memory).
3. Keybindings `cmd+=`/`cmd+-`/`cmd+0` act on the preview when focused and do not disturb workbench
   zoom elsewhere.
4. **Horizontal mode specifically:** the measure stays sane as text grows (Workstream B), and
   fences/tables/images that cross the column cap fall back to **inner vertical scroll** that is
   usable, not broken layout. This is the silent-degradation check.
5. Reset restores the baseline in both modes.

Capture **screenshots or a short recording** at each zoom level in each mode (fences + a table in
view), attached to the dev-approval gate.

### Cross-platform

Desktop VS Code / Cursor only; no mobile/web surface.
