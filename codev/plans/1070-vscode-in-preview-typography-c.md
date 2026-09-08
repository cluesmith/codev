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

### Decision: native editor-title buttons + commands (no keybindings in v1, no webview chrome)

The issue asks me to decide between webview toolbar buttons, command-palette commands, or both.
I choose **command-palette commands surfaced as native `editor/title` icon buttons** — and
deliberately **not** webview HTML chrome, and **no keybindings in v1** (the issue lists keybindings
as optional; see the Risks section for why they are deferred). Rationale:

- It satisfies discoverability (the whole point of the issue): the reviewer sees zoom buttons on
  the preview's title bar, exactly where VS Code's own preview and browsers put zoom.
- It is **host-only**. No webview→host message protocol change (`messages.ts` untouched), no
  webview chrome, and crucially **no control code in the shared `artifact-canvas` package**. A
  webview toolbar would either add chrome to that shared surface or add a bespoke host overlay;
  both are more surface area for a "step a number" action.
- It reuses the extension's own precedent (`openMarkdownPreview` in `editor/title`) and the
  free live-reflow path.
- Custom editors expose the `activeCustomEditorId` context key, so the buttons and palette entries
  scope cleanly to `activeCustomEditorId == codev.markdownPreview` (offered only when the preview is
  the active editor). Note this key tracks the **active editor, not keyboard focus** — see Risks.

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

**In-scope token change (free, serves zoom directly):** make the horizontal-mode minimum column
width scale with font size (a scaling lower bound on the measure, see below) by making the column
tokens em-relative:

- `--codev-canvas-column-width: 400px` → `25em` (400 / 16 = 25em at baseline; identical at 16px).
- `--codev-canvas-column-gap: 48px` → `3em` (48 / 16 = 3em at baseline; identical at 16px).

At baseline these are byte-equivalent in rendered px, so nothing changes today.

**What em actually buys (stated precisely, not overclaimed).** `column-width` is a preferred
**minimum**, and columns stretch to fill the pane, so the *rendered* measure is
`(pane - (n-1)*gap) / n` where `n` is the column count the engine fits. That does **not** stay
constant under zoom — it **sawtooths** as `n` drops. Approx chars/line at 25em/3em (avg glyph
~0.5em; a rule of thumb to sanity-check against a real render at implement time, not a measurement):

| pane | 16px | 20px | 24px | 28px |
|------|------|------|------|------|
| 900px  | 53 | 90 | 75 | 64 |
| 1200px | 72 | 57 | 100 | 86 |
| 1600px | 63 | 77 | 64 | 54 |

Not constant, not monotonic. What em buys is a **scaling lower bound on the minimum column width**:
the floor rises with the prose, so the column count drops at the right point and the measure never
**collapses** to too-narrow under zoom.

**The sawtooth is not new, and this is a preference between failure modes, not a fix.** The
sawtooth is inherent to stretch-to-fill multicol: **px has it too**, and at 16px px and em render
**identically everywhere**. What em changes is only *where the teeth fall* and *which direction the
extremes fail*: **px fails toward too-narrow** (columns stay a fixed pixel width, so under zoom the
prose gets larger inside an unchanged column and the measure shrinks in characters), **em fails
toward too-wide** (the minimum scales, so the last case before a column drop is an over-wide
column). Since this issue is motivated by the **too-narrow** complaint (a reviewer zooming in and
losing measure), em is the **better default** — as a chosen preference between failure modes, not as
a claim of constant measure.

**Failure mode em introduces that px does not have — named and scripted.** At the 1-column boundary
the single column stretches to the **full pane with no cap**, because horizontal mode deliberately
sets `max-width: none` (the prose-measure cap is inert there, `default-theme.css:499-502`). So at a
wide pane + high zoom (e.g. 1200px at 24px) em yields **one over-wide column at ~100 chars**, where
px would have kept 2 columns at ~48 chars — at *that* combination px reads better. Net balance: em
prevents the measure collapsing under zoom, at the cost of column count and an over-wide
single-column case; still right on balance for the too-narrow-motivated issue, and the revert-to-px
path exists. If the over-wide case reads badly at the gate, the response is the container cap below,
not abandoning em.

`column-width` remaining a preferred minimum, D6 is preserved exactly: there is still no settings UI
for the column tokens; overriding them remains the supported retune path.

**First-class design option, recorded but NOT implemented in this lane: a whole-column container
cap.** Cap the multicol **container** to `n * (column + gap)` (centred), where `n` is the largest
column count that fits the pane. This is **not** what the CSS comment at `default-theme.css:499-502`
warns against — that warns against capping to a **prose measure** (e.g. `72ch`), which collapses the
mode to a single column. Capping to a whole-column **multiple** keeps every column that fits and
only stops the **last** column stretching into leftover space.

**Constant by construction (closed form, exact — not a sample).** With the em tokens (col = 25em,
gap = 3em) and the container capped to `n*(col+gap)`, each column is
`(n·28em − (n−1)·3em) / n = 25em + 3em/n`, so `measure = (25em + 3em/n) / 0.5em = 50 + 6/n`
characters. **Pane width and font size cancel entirely** — only column count `n` survives,
contributing at most 6 characters: `n=1 → 56`, `n=2 → 53`, `n=3 → 52`, `n≥8 → ~51`. So the capped
measure is **constant by construction**, not merely flattened: the 52–56 range is the *entire* range
that can exist at any pane and any zoom, not an empirical sample. The precise conclusion — the useful
way the original rationale was wrong: it was **wrong about the mechanism, right about the goal.** Em
alone does not give constant measure; **em plus a whole-column container cap does, almost exactly.**
(Full derivation is posted as a comment on issue #1070 so a follow-up lane inherits the arithmetic.)

The table below is the closed form's empirical shadow, kept as a sanity check (approx chars/line;
same ~0.5em glyph assumption):

| pane | font | no cap | container cap |
|------|------|--------|---------------|
| 900px  | 16px | 2 col 53ch | 2 col 53ch |
| 900px  | 20px | 1 col 90ch | 1 col 56ch |
| 900px  | 24px | 1 col 75ch | 1 col 56ch |
| 900px  | 28px | 1 col 64ch | 1 col 56ch |
| 1200px | 16px | 2 col 72ch | 2 col 53ch |
| 1200px | 20px | 2 col 57ch | 2 col 53ch |
| 1200px | 24px | 1 col 100ch | 1 col 56ch |
| 1200px | 28px | 1 col 86ch | 1 col 56ch |
| 1600px | 16px | 3 col 63ch | 3 col 52ch |
| 1600px | 20px | 2 col 77ch | 2 col 53ch |
| 1600px | 24px | 2 col 64ch | 2 col 53ch |
| 1600px | 28px | 2 col 54ch | 2 col 53ch |

Uncapped ranges 53–100 chars; capped holds 52–56 across every pane and zoom — matching the closed
form exactly. Two caveats to record (for measurement, not argument):

- **(a) It needs JS, not static CSS.** `n` depends on pane width **and** font size, and CSS has no
  floor operation for this. The canvas already observes geometry in JS and publishes
  `--codev-canvas-column-height`, so a sibling `--codev-canvas-column-container-max` follows the
  existing pattern rather than introducing a novel one.
- **(b) It leaves centred dead space, and the dead space is bounded.** The scroll container becomes
  narrower than the pane, centred, with margin either side. The dead space is `pane mod (col+gap)`,
  so it is **at most one column-plus-gap**. Worked cases: 1200px/24px → 528px total (264 per side,
  against a 672px reading window); 1600px/28px → 32px total (16 per side, visually invisible);
  900px/20px → 340px total (170 per side). The cost is **not uniform**: it is worst exactly at the
  boundary where the uncapped version is also at its worst (the ~100-char line). Both failure modes
  cluster at the same place, which makes **1200px/24px the decisive comparison** and the other cases
  confirmatory. Reading research favours the capped window over a 100-char line, but it visibly
  changes how horizontal mode fills the pane — its own judgement at the gate, not an assumed win.
- **(c) Recompute-on-zoom hazard (for the follow-up lane).** The cap depends on font size, which the
  zoom control changes, so the JS observer must recompute the cap on **font-size change**, not only
  on resize. This is the bug class that passes every test and fails in the hand: on zoom the column
  count updates because CSS handles it, but a JS cap wired only to resize does not, and the layout
  goes wrong in a way that reads like a rounding error rather than a bug. If the cap becomes a lane,
  that recompute path deserves **its own dev-approval step**, not a general "it works" check.

This is deferred out of the current lane deliberately; it is the designed response if the wide
1-column case reads badly at dev-approval, evaluated there with the numbers above.

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
  - **No `contributes.keybindings` in v1** (deferred — see Risks).
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

- **Decision — keybindings deferred out of v1 (why).** `cmd+=`/`cmd+-`/`cmd+0` are VS Code's
  workbench-zoom bindings (weight 200); an extension binding (weight 300) wins **wherever its
  when-clause matches**. The tempting gate, `activeCustomEditorId == codev.markdownPreview`, tracks
  the **active editor, not keyboard focus** (the two are distinct — VS Code itself carries a
  separate `focusedCustomEditorIsEditable` key alongside `activeCustomEditorId`). So with the
  preview as the active editor, clicking into the terminal, sidebar, or a search box leaves that key
  `true`, and `cmd+=` would step the preview font instead of zooming the workbench — silently taking
  workbench zoom away in states we did not intend. A genuinely focus-scoped clause would need a
  custom-editor **focus** context key I have not been able to verify resolves as expected. Since the
  issue lists keybindings as **optional** and the discoverability goal is met by the title-bar
  buttons + palette, v1 ships **without keybindings**. A focus-scoped binding is a clean follow-up
  once a correct focus key is verified. (The `activeCustomEditorId` gate is still correct for the
  **buttons and palette entries**, where "offered when the preview is the active editor" is exactly
  the intended semantics and there is no global binding to shadow.)
- **Risk — write-back silently no-ops** under an existing workspace override. Mitigated by writing
  to the setting's existing scope via `inspect()` (Workspace if defined there, else Global).
- **Risk — shared-package ownership.** Workstream B changes a main-owned surface. Delineated above
  and routed to main before plan-approval; A ships independently if B is declined.
- **Risk — horizontal-mode reads badly under zoom.** Two distinct effects: the silent
  tall-block-cap effect (not fixable by tokens; verified tolerable at dev-approval with real
  fences/tables at several zoom levels in both modes, evidence required, see Test Plan), and the
  em over-wide single-column case. If em reads worse on balance, revert B to px and keep A; if only
  the wide 1-column case reads badly, the designed response is the whole-column container cap
  (recorded as a first-class option in Workstream B, not implemented in this lane).
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
**both vertical and horizontal reading modes**, at **~3 zoom levels** (e.g. 14 / 20 / 28px).

1. **The tall-block cap, checked FIRST with visual evidence (the silent failure mode).** In
   **horizontal mode**, at each zoom level, confirm that fences/tables/images/marker cards which
   cross the fixed column cap fall back to **usable inner vertical scroll**, not broken layout or
   content clipped past the column bottom. This is the check tests cannot substitute for; capture
   it explicitly.
2. **Expected column COUNT changes as predicted (not stays constant).** Because em keeps the
   minimum measure scaling, the number of columns that fit **drops as you zoom in** — that is
   correct behavior, not a regression. For each pane width tested, write the expected column count
   at each zoom level *before* looking (use the no-cap table above), then confirm the count changes
   accordingly. Two cases to check as **predictions, not hopes**:
   - **900px at 24px → expect 1 column at ~75 chars** (em winning here; px would give ~36).
   - **1200px at 24px → expect 1 column at ~100 chars** (em losing here; px would give ~48).
   Include at least one **narrow-pane** case (e.g. ~900px at 28px) where high zoom **collapses to a
   single column** and horizontal mode effectively becomes vertical with sideways scroll — confirm
   that is what happens and reads acceptably.
3. **Judge uncapped vs the container cap side by side (do NOT implement the cap in this lane).**
   **1200px at 24px is THE decisive comparison** — it is where the uncapped over-wide line (~100
   chars) and the capped dead space (~264px per side) are *both* at their worst; the other cases are
   confirmatory. Judge the uncapped ~100-char column against the container-cap outcome (constant
   `50 + 6/n` ≈ ~56 chars, centred, with side margin), not in a vacuum. If the uncapped case reads
   badly, that is **not a failed lane** — it is the measurement doing its job, and the **whole-column
   container cap is the designed response** (JS-computed sibling token; see the design-option section
   above). Flag the finding; leave the cap unimplemented.
4. The `$(zoom-in)` / `$(zoom-out)` buttons are visible on the preview's title bar, and the
   command palette offers all three only when the preview is the active editor.
5. +/− reflow **live** (no reopen), and the value **persists** across closing and reopening the
   preview (confirming it was written to the setting, not held in memory).
6. No keybindings ship in v1, so confirm the negative: `cmd+=`/`cmd+-`/`cmd+0` still perform normal
   workbench zoom everywhere, including with the preview as the active editor.
7. Reset restores the baseline in both modes.

Capture **screenshots or a short recording** at each zoom level in each mode (fences + a table in
view), attached to the dev-approval gate — with the horizontal tall-block-cap behavior (check 1)
and the column-count transitions (checks 2–3) shown at every zoom level.

### Cross-platform

Desktop VS Code / Cursor only; no mobile/web surface.
