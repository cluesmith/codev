# PIR Plan: Full-Row '+' Affordance (GitHub-Diff Pattern)

## Understanding

The artifact canvas's "+" add-comment affordance is a **canvas-anchored overlay**: hovering a
block sets `activeLine` + `overlayTop` (computed from `el.offsetTop`,
`ArtifactCanvas.tsx:574-583`) and renders `.codev-canvas-overlay` absolutely positioned at
`left: 0` of the canvas (`ArtifactCanvas.tsx:641-657`, `default-theme.css:260-271`), inside a
canvas-level `padding-left: 1.9rem` gutter on the body (`default-theme.css:90-93`).

That model puts a **travel gap** between trigger (the hovered block) and target (the "+" at the
canvas's left edge, at the block's *first* line). #1236 damped the resulting dismiss/re-anchor
races with grace timers and pin-on-overlay-hover (`OVERLAY_GRACE_MS`, `graceTimerRef`,
`overlayPinnedRef` — `ArtifactCanvas.tsx:89,170-180,561-623`), but damping cannot close the
residual gaps found at pir-1237's dev gate: right-edge hover on wide blocks still means a long
diagonal journey, and dead strips (gutter, block margins) offer no affordance at all.

This issue adopts the GitHub-diff pattern: **the whole row is the hover target and the "+"
renders inside the hovered row's own box**. With no journey between trigger and target, the
grace/pin machinery is dead code and is deleted in this PR (architect direction).

**Binding constraint from #1380** (multi-column mode, queued behind this): the affordance must
be **block-scoped** — rendered within the block's own DOM and positioned against the row, never
against the canvas — and the canvas-level gutter should become **block-local leading space**, so
column layout later places both for free and vertical mode becomes the one-column case. I am not
implementing multi-column, only not foreclosing it: no `offsetTop`-against-the-canvas geometry
survives this change.

## Proposed Change

### 1. Block-local leading space replaces the canvas gutter

- Remove `padding-left: 1.9rem` from `.codev-artifact-canvas-body`.
- New token `--codev-canvas-gutter: 1.9rem`; every **top-level row** gets it as its own leading
  padding: `.codev-artifact-canvas-body > [data-line] { position: relative; padding-left:
  var(--codev-canvas-gutter); }`. Only direct children of the body are positioned/padded — nested
  blocks (`li`, `p` inside `blockquote`) are covered by their host row and must not double-pad.
- Blocks with their own left chrome keep their text x-position via padding sums:
  `pre` → `calc(var(--codev-canvas-gutter) + 16px)`, `blockquote` → gutter + `1em`, lists →
  gutter + `2em`. Consequence (deliberate, GitHub-full-bleed): their backgrounds/rules now start
  at the canvas edge and the row's leading strip is part of the row's own hover box. **Flagged
  for the plan reviewer**: code-block backgrounds and the blockquote rule extend into the old
  gutter zone. Fallback if rejected at the gate: per-type `margin-left` keeps today's chrome and
  accepts a dead strip beside those block types only.
- `pre` scrolling moves inward (`pre { overflow: visible }`, `pre > code { display: block;
  overflow-x: auto; }`) so the row box — and the "+" inside it — does not scroll with wide code.
  Tables keep `overflow: auto` on the element itself; a horizontally-scrolled wide table carries
  its "+" with the scroll — accepted, documented v1 limitation (hover/activation still work).
- Injected row siblings follow the rows: `.codev-canvas-marker-cards` and
  `.codev-canvas-comment-composer-host` get `margin-left: var(--codev-canvas-gutter)` (they are
  direct body children, injected after the outermost block — `ArtifactCanvas.tsx:318,377-389`).
- The `.codev-canvas-has-marker` gold bar currently sits at the block's box edge via inset
  box-shadow + 10px padding (`default-theme.css:245-248`). On top-level rows the box edge is now
  the canvas edge, so the bar is redrawn as an absolutely-positioned `::before` strip just left
  of the text (`left: calc(var(--codev-canvas-gutter) - 13px); width: 3px; top: 0; bottom: 0`).
  Nested marked blocks (no gutter padding) keep the existing box-shadow treatment via a
  descendant-scoped rule (`[data-line] .codev-canvas-has-marker`).

### 2. The "+" renders inside the hovered row

- `.codev-canvas-overlay` (canvas-anchored) is deleted. A single positioned wrapper
  (`.codev-canvas-row-affordance`, created once and held in a ref) is **appended into the active
  top-level row element**; `CommentAffordance` is portalled into that wrapper unchanged, so the
  intent seam (`onActivate(line)` → `openComposer`) and the button's role/label survive as-is.
- **Host resolution**: mouseover/focus resolves the innermost `[data-line]` (unchanged,
  `resolveBlock`); `activeLine` stays the innermost block's line (labels and composer targeting
  unchanged). The wrapper's *host* is that element's top-level ancestor row (walk up to the
  direct child of the body). Hovering the 5th `li` of a list hosts the "+" in the `ul`'s gutter
  at that item's row.
- **Vertical placement — "the row under the pointer"**: on mousemove over the body, position the
  wrapper at the pointer's line: `top = innerBlockTop + floor(offsetY / lineHeight) * lineHeight
  + lineHeight/2` (line-height from the innermost block's computed style, reusing the existing
  fallback math), clamped to the host's box, applied by direct style write on the wrapper — no
  React state churn per move. `transform: translateY(-50%)` centers the button on that line. For
  single-line rows (most blocks) this is identical to line-centering; for tall blocks the "+"
  tracks the pointer GitHub-style, so it is never off-screen for a viewport-tall code block.
- **Keyboard parity (#1237)**: focus resolves the same way; the wrapper is placed at the focused
  block's first-line center (offsetTop is host-relative because only top-level rows are
  positioned). Enter/Space on the block keeps opening the composer directly; Tab reaches the
  in-row button. All geometry is host-relative — nothing references the canvas.
- **Rebuild survival**: the body is imperatively-owned DOM; `innerHTML` rebuilds destroy the
  wrapper's attachment but not the node (we hold the ref — React portals into it regardless of
  attachment). The existing reload-reconciliation effect (`ArtifactCanvas.tsx:330-332`) extends
  to re-append the wrapper into the re-resolved host for a still-valid `activeLine`, or clear.
- **Sizing carried over (#1236/#1344 batch)**: the button keeps `min-width/min-height: 24px`;
  it now sits inside the font-sized body, but buttons don't inherit font, so
  `.codev-canvas-add-comment` gains `font: inherit` (replacing the overlay's
  `font-size: var(--codev-canvas-font-size)` — same 16px outcome, new mechanism).

### 3. Grace/pin machinery deleted

`OVERLAY_GRACE_MS`, `graceTimerRef`, `overlayPinnedRef`, `clearGraceTimer`, `scheduleDismiss`'s
delay, the grace branch of `activateFromHover`, the overlay's pin handlers, and the pin-reset in
`openComposer` are all removed. New behavior: first hover and block-crossing re-anchor are
**instant** (moving the "+" to the row you are on is now the feature, not a race), and canvas
mouseleave dismisses **immediately**. Immediate dismiss is structurally safe: the "+" sits on
the pointer's own path at the row's leading edge — you cannot approach it without crossing it,
and re-entry re-lights it instantly at the same spot.

### 4. Dead strips: decision and argument

- **Leading strips (the old gutter)**: structurally alive — they are each row's own padding, so
  hovering them lights that row. This was the worst dead zone (it contained the affordance!).
- **Vertical margins between rows** (16px paragraph spacing): **inert but sticky** — no block
  mouseover fires there, so the previously-lit row's "+" simply persists until another row is
  entered or the canvas is left. Argument: activating the "nearest row" from a margin needs
  midpoint geometry per crossing for ~16px strips a pointer transits in milliseconds, and the
  sticky behavior already shows an affordance during transit. Crucially the "+" physically sits
  *inside* the row it targets, so a lit affordance can never be visually attributed to the wrong
  row — the failure mode that made #1236's loose coupling dangerous is gone. Converting margins
  to padding was rejected: it moves block backgrounds/borders (pre, blockquote) vertically.
- **Host-page padding** (e.g. the webview's `body { padding: 0 14px }`) is outside the canvas
  and stays outside its reach — host chrome, not canvas dead space.

### 5. Text-selection discipline

- `user-select: none` on the wrapper/button (a drag across the row can't smear selection through
  the '+' glyph).
- Hover/move handlers no-op while a primary-button drag is in progress (`e.buttons & 1`), so the
  "+" neither jumps between rows nor re-anchors mid-selection; it never sits between the pointer
  and the text being selected (it occupies only its 24px box in the leading space).

## Files to Change

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`
  - `:89`, `:170-180`, `:561-567`, `:594-623`, `:645-653` — delete grace/pin machinery and the
    overlay JSX; `:156` delete `overlayTop`; `:574-583` replace `anchorOverlay` with host
    resolution + wrapper placement (mouse: pointer-row; focus: first-line center)
  - `:395-401` — `openComposer` drops the pin/grace resets
  - `:330-332` — reload reconciliation additionally re-hosts or clears the wrapper
  - add: wrapper ref creation, mousemove positioning (direct style writes), drag suppression,
    portal of `CommentAffordance` into the wrapper
- `packages/artifact-canvas/src/overlays/CommentAffordance.tsx` — unchanged (verified: the
  intent seam and a11y contract carry over)
- `packages/artifact-canvas/src/styles/default-theme.css`
  - `:90-93` — body loses `padding-left`; `:260-271` — `.codev-canvas-overlay` deleted
  - new `--codev-canvas-gutter` token; `.codev-artifact-canvas-body > [data-line]` position +
    leading padding; per-type padding sums (pre/blockquote/lists); `pre > code` scroll refactor
  - `:225-240` — button gains `font: inherit`, `user-select: none`; new
    `.codev-canvas-row-affordance` (absolute, `translateY(-50%)`, z-index above row content)
  - `:245-248` — has-marker bar rework (top-level `::before` strip; nested keeps box-shadow)
  - `:277-285`, `:344` — marker cards + composer host gain `margin-left: var(--codev-canvas-gutter)`
- `packages/artifact-canvas/src/components/__tests__/hover-affordance.test.tsx` — replaced by
  full-row behavior tests (see Test Plan); grace-window tests deleted with the machinery
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts:110-112` — overlay font-size
  assertion becomes button `font: inherit`; 24px min assertions stay; add gutter-token assertions
- `packages/artifact-canvas/src/components/__tests__/artifact-canvas.test.tsx:390-430` — reload
  keep/clear tests should pass semantically; update any `.codev-canvas-overlay` selector to the
  new structure
- `codev/state/pir-1343_thread.md` — builder thread (committed with the PR)

## Risks & Alternatives Considered

- **Risk: visual shift on chrome blocks** (code-block background, blockquote rule, table borders
  extend into the old gutter). Mitigation: text x-positions preserved via padding sums; explicit
  before/after check at the dev gate; scoped fallback (per-type `margin-left`) if the full-bleed
  look is rejected.
- **Risk: "+" inside a horizontally-scrolled wide table drifts with the scroll.** Accepted v1
  limitation (documented); `pre` — the common case — is fixed by the inner-scroll refactor.
- **Risk: a `<button>` child of `ul`/`table` is invalid HTML.** It is DOM-inserted (no parser
  foster-parenting) and absolutely positioned (participates in no list/table box layout); both
  hosts are Chromium. Mitigation: aria-label preserved; verified in both hosts at the dev gate.
  Alternative (redirecting to a "safe host" per element type) rejected as complexity without an
  observed failure.
- **Risk: mousemove-driven placement jitter/perf.** Direct style writes (no re-render), line
  quantization (the "+" snaps per row rather than sliding), rAF-throttle only if the demo shows
  jank.
- **Alternative: keep the canvas overlay, widen hover math / tune grace.** Rejected: the bug
  class is positional; #1380 forbids canvas-anchored geometry.
- **Alternative: CSS-only `::hover` pseudo-element affordance.** Rejected: not focusable, no
  a11y label, no `onActivate` seam.
- **Alternative: renderer-level row wrappers.** Rejected: invalid around `li`/nested blocks
  (`ul > div`), and a much larger blast radius on the renderer's `data-line` contract.
- **Alternative: hover-extension `::before` strips with the canvas gutter kept.** Rejected: an
  absolutely-positioned pseudo does not travel through column fragmentation — it defeats the
  #1380 constraint the block-local model exists to satisfy.

## Test Plan

Unit (vitest + jsdom; geometry is zero in jsdom, so structural assertions carry the weight —
pixel behavior is the dev-gate demo's job):

- Full-row behavior (replaces hover-affordance.test.tsx):
  - first hover shows the "+" instantly, **inside the hovered row's element**
    (`button.closest('[data-line]') === hoveredBlock`)
  - crossing to another block re-anchors instantly (no timers) into the new row
  - hovering a nested `li` hosts the "+" in its top-level `ul` while labeling/activating the
    `li`'s line
  - mouseover on body whitespace (no `[data-line]` target) leaves the current "+" in place
    (sticky across dead strips)
  - canvas mouseleave dismisses immediately
  - focus lights the "+" in the focused row (keyboard parity); Enter/Space still opens the
    composer; clicking "+" opens the composer for the labeled line (intent seam)
  - "+" suppressed for the line whose composer is open; reload keep/clear reconciliation
  - no re-anchor while a primary-button drag is in progress
- default-theme.test.ts: gutter token on top-level rows, body has no `padding-left`, button
  `font: inherit` + 24px mins, `.codev-canvas-overlay` absent
- Existing suites (keyboard-nav, composer, marker cards, end-to-end) pass unchanged in behavior

Manual at dev-approval (running flow per testing guide — browser `afx open` **and** VS Code
webview, light + dark; inherited regression floor from the gate finding):

- **Right-edge hover on a wide block**: "+" appears in that row instantly; travel left to it
  never dismisses or moves it
- **Dead strips**: hovering the leading strip lights that row; margin strips keep the previous
  row's "+" (sticky); page padding outside the canvas stays inert
- **Tall multi-line blocks** (viewport-tall code fence): "+" tracks the pointer's row; never
  off-screen; code horizontal scroll does not carry the "+" away
- **Rapid vertical travel**: "+" tracks row-by-row with no flicker, lag, or stale anchors
- Drag-selection across rows over a lit "+": selection uninterrupted, no '+' glyph in the copy,
  affordance doesn't jump mid-drag
- Composer flow (#1107), marker cards alignment (#863 — cards/bar sit with the text under the
  new gutter), edit/delete (#1055), full #1237 keyboard pass (jump keys light the "+" per row)
- Chrome-block visuals: pre/blockquote/table before/after comparison for the flagged full-bleed
  change
