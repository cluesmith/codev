# Specification: Horizontal Multi-Column Reading Mode for the Artifact Canvas

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

The artifact canvas renders review documents (specs, plans, reviews) as a single vertical
column. On wide monitors this wastes most of the screen: one column of readable measure
occupies roughly a third of the width, and reviewing a long spec means constant vertical
scrolling with only one screenful of context visible at a time. Gate review is a
cross-referencing activity: requirements against acceptance criteria, a plan phase against its
constraints. A single-column viewport forces the reviewer to hold one side of every comparison
in memory.

Affected users: humans performing gate reviews (spec-approval, plan-approval, PR review) on
wide displays, and anyone reading long markdown artifacts through the canvas.

Proposed: an opt-in **horizontal multi-column reading mode**. Content flows top-to-bottom
within fixed-height columns of readable measure, continuing into the next column rightward
(newspaper flow) inside a horizontally-scrolling container. Three to four columns per
screenful on a typical wide display, so an entire spec section is visible at once. Vertical
stays the default.

### Ground truth correction to the issue premise (host inventory)

The issue describes the canvas as "the `afx open` annotation viewer and markdown preview."
The codebase says otherwise: **the only production host of the canvas package today is the
VS Code webview** (the markdown preview custom editor, #859). `afx open` serves a bespoke
legacy annotator (`templates/open.html`, served by Tower) that has its own line-oriented
markdown rendering and its own annotation system and has **never adopted the canvas package**
— spec 945 explicitly deferred "dashboard host integration" to a future issue. The package
also ships a vite dev host (`pnpm dev:example`) used as its browser-engine proof.

Architect ruling (2026-08-10, option A): this feature is implemented once, natively in the
canvas package. Host parity (requirement 9) is restated honestly as: (i) identical behavior in
a plain browser engine, proven via the package's vite dev host, and (ii) the one production
host, the VS Code webview. The `afx open` surface inherits column mode **when it adopts the
canvas**, which is #1386 (filed in the architect lane); this spec references #1386 as the
delivery path for `afx open` parity rather than owning it.

## Current State

Vertical single-column flow, in both surfaces the package renders
(`.codev-artifact-canvas-body` composed surface and the standalone `MarkdownView`). The
composed surface's review interactions are all block-scoped and in-flow, which matters here:

- **Rows** (#1343, merged via PR #1385): every top-level block is a row carrying block-local
  leading space (`--codev-canvas-gutter` padding). The "+" affordance renders *inside* the
  active row's own DOM as an absolutely-positioned wrapper whose `top` is row-relative; the
  row, not the canvas, is the positioning context. The marked-row indicator is a `::before`
  strip positioned against the row.
- **Marker cards** (#863) are in-flow `<ul>` siblings injected after the annotated block.
- **The inline composer** (#1107) portals into an in-flow placeholder below the block.
- **Keyboard flow** (#1237): every mapped block is focusable (`tabindex="0"`); `n`/`p` jump
  between marked blocks, `[`/`]` between headings, Home/End to extremes — each jump calls
  `scrollIntoView({ block: 'center' })`, a vertical-axis assumption.
- **Minimap** (#863): a fixed right-edge dot rail positioning dots by
  `offsetTop / scrollHeight` — a vertical-flow fraction.
- **Code blocks** (#1343): the `pre` is the row; the inner `code` is the horizontal scroll
  container.

Limitations motivating the change: on a 1600px-wide display the prose column uses ~500px;
cross-referencing two sections a few screens apart requires scrolling away from one to see
the other.

### Spike evidence (throwaway page using the real canvas DOM + theme CSS, Chromium 147)

A spec-phase spike rendered the exact renderer DOM shape (rows, gutter, cards, composer,
nested lists, tables, tall/short fences) under the proposed mechanism
(`column-width: 400px; column-fill: auto`, fixed height, `overflow-x: auto`). Findings, which
several decisions below rest on:

1. **Overflow columns scroll horizontally on the multicol element itself** — no wrapper
   gymnastics needed (`scrollWidth` 5333 vs `clientWidth` 1600 for the sample document).
2. **`break-inside: avoid` holds** for `pre`, `table`, marker-card stacks, the composer host,
   and images: one fragment each (`getClientRects().length === 1`).
3. **`break-inside: avoid` does NOT protect a block taller than the column**: Chromium
   fragments it anyway *and* lets one fragment overflow the column bottom (a 70-line fence
   produced fragments of height 852/1427/17 in a 900px column). Under `overflow-y: hidden`
   that overflow is unreachable. An uncapped tall code block is therefore genuinely broken in
   column mode — the tall-block policy is load-bearing, not cosmetic.
4. **Capping the inner `code` (max-height + `overflow-y: auto`) fixes it cleanly**: the row
   collapses to one fragment that fits the column, and the code stays fully readable via its
   inner vertical scroll.
5. **Fragmenting prose reports one client rect per fragment** via `getClientRects()` —
   per-fragment geometry is available for pointer-side affordance anchoring.
6. **Absolutely-positioned children of a fragmented row resolve `top` in flow coordinates and
   render in the correct fragment**: setting the affordance wrapper's `top` beyond the first
   fragment's height placed it visually in the second column. The #1343 placement mechanism
   therefore generalizes to columns — only the `top` computation needs fragment awareness.
7. **The `::before` marked-row strip fragments with its row** and renders on every fragment —
   marked-row indication survives fragmentation with no changes.
8. **`offsetTop` in a multicol container returns the within-column (visual) position, not the
   cumulative flow position** — the minimap's `offsetTop / scrollHeight` fraction becomes
   meaningless in column mode.
9. **`scrollIntoView({ inline: 'center' })` scrolls the multicol container horizontally**, and
   focus + scroll of far-column blocks behaves (keyboard flow is portable with axis-aware
   options).

## Desired State

A toolbar-toggleable horizontal reading mode:

- The canvas renders a small, token-styled mode toggle in its own chrome, so every host gets
  the control without host work. Vertical remains the default.
- In horizontal mode, content flows into fixed-height, readable-measure columns (~400px
  default) scrolling horizontally. The vertical wheel is remapped to horizontal scroll;
  native horizontal trackpad gestures and pinch-zoom are untouched.
- Every review interaction works identically: row hover/focus lights the "+" in the column
  fragment under the pointer; the composer opens in flow below its block; cards render below
  their block; edit/delete work; the full #1237 keyboard flow works with axis-aware scrolling.
- Code blocks (and other over-tall protected blocks) stay fully readable via inner vertical
  scroll; prose fragments naturally across columns.
- A progress indicator replaces the vertical scrollbar's positional feedback.
- Toggling back restores vertical mode exactly; the mode preference persists per user across
  sessions; switching modes lands the reader within the same section.

## Success Criteria

- [ ] A long spec (≥1000 lines, containing fences, tables, images, nested lists, blockquotes)
      reflows into readable-measure columns with **no clipped or unreachable content**:
      programmatically, no rendered box extends below the column viewport except blocks with
      their own inner scroll, and every `[data-line]` block can be brought fully into view.
- [ ] Toggling back to vertical restores the exact pre-toggle rendering (DOM and computed
      layout identical to a never-toggled canvas), and existing canvas tests pass unchanged.
- [ ] A complete review pass — read → hover/focus a block → open composer → submit → see card
      → edit → delete — works in horizontal mode **mouse-only** and **keyboard-only**.
- [ ] No protected block type (`pre`, `table`, image, individual marker card, open composer)
      ever straddles a column boundary (`getClientRects().length === 1` under test).
- [ ] A code block taller than the column height is fully readable via its inner vertical
      scroll and its row fits within one column.
- [ ] Vertical wheel input scrolls horizontally in horizontal mode; events with a dominant
      horizontal delta and pinch-zoom (ctrl/meta-modified wheel) pass through untouched;
      vertical mode's wheel behavior is untouched.
- [ ] The mode preference survives a host restart (per-user scope); a user who never toggles
      sees zero behavioral change in vertical mode.
- [ ] Mode switch lands the reader within the same section: the block (or nearest heading at
      or above it) that was at the viewport start before the switch is visible after it.
- [ ] Progress indication is visible while scrolling horizontally (position within the
      document) and is announced accessibly (see Test Scenarios).
- [ ] All new chrome uses the `--codev-canvas-*` token vocabulary; legible in light and dark.
- [ ] Demonstrated running in both agreed hosts at dev-approval: the vite dev host (browser
      engine proof) and the VS Code webview (production host), per the testing guide.

## Constraints

Architect non-negotiables (issue #1380 + 2026-08-10 guidance), restated as fixed:

1. **Vertical mode behaviorally untouched.** Horizontal is opt-in; no default change.
2. **No new runtime dependencies.** The mechanism is native CSS multi-column
   (`column-width` + `column-fill: auto`) plus a wheel remap, axis-aware `scrollIntoView`,
   and a progress indicator — all hand-rolled.
3. **Host scope per ruling A**: implemented once in the canvas package; proven in the vite
   dev host and the VS Code webview. `afx open` parity arrives via #1386 (canvas adoption),
   not this feature.
4. **Protected block types never fragment**: `pre`, `table`, images, marker cards, and an
   open composer get `break-inside: avoid`; prose may fragment naturally.
5. **Wheel remap only in horizontal mode, only for vertical wheel deltas**; native horizontal
   trackpad gestures and pinch-zoom untouched.
6. **Theme/token compliance** for all new chrome (light + dark).
7. **Accessibility**: keyboard-focusable container, ARIA roledescription + progress
   announcements, DOM-order focus (= reading order across columns).
8. Fragment-anchoring addendum (issue comment, 2026-08-10): hovering a prose block's
   continuation fragment in column N must NOT surface the "+" back at the block's first
   fragment in column N−1 — that would recreate, across columns, the cross-gap travel problem
   #1343 eliminated.

Existing-system constraints:

- The package's locked public contract (spec 945 types + adapter interfaces, `--codev-canvas-*`
  token vocabulary) may be extended, not broken.
- The package is host-agnostic: no VS Code imports, no filesystem access; persistence must
  flow through the host seam like every other side effect.
- The canvas body is imperatively-owned DOM (React must not reconcile its children); any new
  decoration must follow the established injected-DOM patterns.
- Single-lane scheduling in `packages/artifact-canvas`; branch rebases over anything the
  architect lands there.

## Assumptions

- **#1343 is merged** (PR #1385) — the block-scoped affordance and block-local gutter are the
  geometry this feature inherits. Confirmed on `main`.
- **Both verification hosts are Chromium** (Electron webview; vite dev host verified in
  Chromium). The CSS used is standard and supported in Gecko/WebKit, but only Chromium
  behavior is verified in v1; other engines are best-effort.
- The host gives the canvas a bounded viewport height in horizontal mode (a full-viewport
  webview / dev page). Column mode is meaningless in an unbounded-height embed; the mode
  requires a height context, and the host integration provides it.
- jsdom (the unit-test environment) does not implement CSS fragmentation; fragmentation-
  dependent behavior is verified in a real browser at dev-approval (per the minimap
  precedent), while unit tests assert structure and state logic.
- #1386 (afx open canvas adoption) is separate, later work; nothing here depends on it.

## Solution Approaches

### Approach 1: Native CSS multi-column on the existing body (recommended)

The existing `.codev-artifact-canvas-body` becomes the multicol element in horizontal mode
(a mode class + controlled prop): `column-width` for readable measure, `column-fill: auto`
against a fixed height, overflow columns scrolling horizontally on the same element.
Fragmentation, column packing, and geometry are the browser's job; the package adds the mode
toggle, protection rules, tall-block caps, wheel remap, axis-aware navigation, progress
indicator, and fragment-aware affordance placement.

- **Pros**: zero dependencies; DOM order (= focus order = reading order) unchanged, so
  keyboard flow and accessibility survive structurally; all #1343/#863/#1107 in-flow
  interactions travel with their blocks for free (spike-verified, including abspos and
  `::before` behavior); vertical mode untouched by construction (mode class absent → current
  CSS applies verbatim).
- **Cons / risks**: CSS fragmentation edge cases are engine territory (the tall-monolithic
  fallback found in the spike must be designed around, not assumed away); jsdom can't test it;
  `offsetTop`/union-`getBoundingClientRect` assumptions in existing code need an audit.
- **Complexity**: moderate — concentrated in affordance fragment-awareness and the wheel/nav
  layer.

### Approach 2: Script-driven column packing

Measure blocks and distribute them into explicit per-column flex/grid stacks, re-packing on
resize.

- **Pros**: full control over what lands where (no engine fragmentation quirks); per-column
  DOM containers make per-column chrome trivial.
- **Cons**: reimplements the browser's fragmenter (prose could only break at block
  granularity, or the package must split text nodes itself — either loses newspaper flow or
  is a project of its own); restructures the DOM the entire decoration/injection model
  (cards, composer host, `data-line` queries, `rowHostOf`) assumes; resize thrash; violates
  the spirit of "no new machinery."
- **Complexity**: high. Rejected.

### Approach 3: Writing-mode / transform tricks

Rotate the container (`writing-mode: vertical-lr` + rotated inner content, or CSS transforms)
to turn vertical overflow into horizontal.

- **Pros**: keeps a single scroll axis natively.
- **Cons**: does not produce columns at all (it produces sideways text or a rotated single
  column); hit-testing, selection, and a11y geometry break. Rejected outright.

**Recommendation: Approach 1**, with the spike as evidence that its risks are bounded and its
two hard sub-problems (tall blocks, fragment-local affordance) have verified solutions.

### Decision records (each open decision, resolved)

**D1 — Tall-block policy: inner scroll for over-tall protected blocks; prose fragments.**
Spike finding 3 shows the "allow fragmenting" fallback is not graceful for protected blocks:
Chromium both fragments them and overflows the column, leaving unreachable content. So: in
horizontal mode, `pre` (via its existing inner `code` scroll container, which #1343 already
established), `table` (already `overflow: auto`), and images get a max-height cap tied to the
column height; content beyond the cap is reached by the block's own inner vertical scroll
(code, tables) or scaled to fit (images, which already `max-width: 100%`). Marker-card
*stacks* may break **between** cards (each card individually protected) — a long comment
thread reads on like prose, and no individual card ever splits, which is the requirement's
intent. The open composer is protected whole; its textarea gets a max-height in horizontal
mode so user resizing cannot push it past a column. Prose (`p`, headings, list items,
blockquotes) fragments naturally. "Cap-with-expand" is rejected: it adds interaction state
for no reader benefit over an inner scrollbar.

**D2 — Fragment-local "+" anchoring: pointer-side anchoring in v1 (adopted, not defaulted).**
The architect's condition — adopt if the `getClientRects` approach proves simple in the spike
— is met twice over: (a) fragments are individually addressable (finding 5), and (b) the
existing placement mechanism already resolves an abspos `top` through fragmentation into the
correct column (finding 6). So the affordance's `top` computation becomes fragment-aware:
resolve the pointer's fragment via `getClientRects()`, convert to a flow-coordinate offset
(sum of preceding fragment heights + offset within the fragment), and the browser renders the
"+" in the fragment under the pointer. The keyboard path (block focus) anchors to the
block's first fragment, which is where reading of that block starts — correct as-is. Clamping
must use flow height (sum of fragment heights), not the union bounding box.

**D3 — Minimap: suppressed in horizontal mode (v1).**
Spike finding 8 breaks its positioning model (`offsetTop` fractions collapse to within-column
positions), and its fixed right-edge rail is also geometrically wrong for a horizontal
reading surface. Re-orienting it into a horizontal rail is real design work serving a surface
that also gets a progress indicator and `n`/`p` marker jump keys — redundant in v1. Suppress
(cleanly, mode-conditional), leave a horizontal re-orientation as future work.

**D4 — Preference surface: canvas-owned toggle UI; host-owned per-user persistence.**
The canvas renders the toggle (token-styled, in its own chrome) so every host gets the
control and the two verification hosts stay behaviorally identical. Persistence follows the
package's established seam philosophy (the canvas emits intent, the host owns side effects):
the canvas takes an initial mode and emits mode-change events; each host stores the value
per-user (VS Code: extension global state; vite dev host: browser local storage). Scope is
**per-user** (architect lean adopted): reading-mode preference is about the human's display
and habits, not the workspace's content. A host that persists nothing simply gets vertical
default each session — read-only hosts remain zero-config.

**D5 — Scroll-snap: none in v1 (free scrolling).**
Architect lean adopted. Snap fights precise positioning while composing (an open composer
pinned near a column edge must not have the viewport yanked to a snap point), and keyboard
navigation already provides deterministic positioning via `scrollIntoView`. Revisit only on
real reading-comfort feedback.

**D6 — Column width: fixed ~400px default, exposed as a theme token, no configuration UI.**
The width becomes part of the `--codev-canvas-*` token vocabulary (with the column gap),
which the theming model already lets hosts and users override — configurability for free,
with no settings surface, consistent with how every other canvas dimension is themed. No
per-document or per-toggle width UI in v1.

**D7 — Mode-switch position mapping: viewport-start block anchor.**
On toggle, record the first `[data-line]` block at least partially visible at the viewport
start (top edge in vertical, left edge in horizontal); after re-layout, bring that block into
view at the reading start (axis-aware `scrollIntoView`). This is coarse-position preservation
as required — same section, not same pixel. Nearest-heading fallback applies only if the
recorded block vanished (content reloaded mid-toggle), reusing the #1237 focus-restoration
fallback pattern.

**D8 — Progress indication: column-position readout + the container's native horizontal
scrollbar.**
Horizontal mode shows a small token-styled indicator ("column *k* of *n*" derived from scroll
position, column width, and gap), doubling as the ARIA progress announcement (see
Constraints 7); the container's own horizontal scrollbar remains for continuous positional
feedback. A document fitting entirely on screen shows no indicator.

## Open Questions

None critical or important — the architect required every open decision resolved in-spec
(D1–D8 above). Remaining nice-to-know items, explicitly deferred:

- **Nice-to-know**: Gecko/WebKit fragmentation parity (matters only if a non-Chromium host
  appears; assumption recorded above).
- **Nice-to-know**: a horizontal minimap rail design, if post-v1 feedback misses the dot rail
  in horizontal mode (D3 suppression is v1 scope).
- **Nice-to-know**: whether #1386's adoption surface wants the toggle surfaced additionally
  in its own toolbar chrome (a #1386 concern; the canvas-owned toggle ships regardless).

## Test Scenarios

Functional, horizontal mode (real browser; unit-level where jsdom permits):

1. Long mixed document reflows into columns; every block reachable; toggling back restores
   vertical layout identical to a never-toggled canvas (success criteria 1–2).
2. Full review pass mouse-only: hover prose in a continuation fragment → "+" appears in that
   fragment (not the block's first fragment) → click → composer opens in-flow below the block
   → submit → card renders → edit → delete.
3. Full review pass keyboard-only: Tab/focus block → "+" lights at block start → Enter opens
   composer → type/submit → `n`/`p` jump between marked blocks with horizontal scrolling
   (`inline`-aware) → `[`/`]`, Home/End → `?` legend still works.
4. Fragmentation protection: document with fences, tables, images, card stacks, open
   composer — each protected element reports exactly one client rect; a 200-line fence fits
   one column with a working inner scrollbar; a many-card stack continues across columns with
   no individual card split.
5. Wheel: vertical deltas scroll horizontally; dominant-horizontal deltas pass through
   natively; ctrl/meta-wheel (pinch) untouched; in vertical mode no remap handler is active.
6. Mode switch position: scroll to a mid-document section, toggle → the same section is
   visible; toggle back → same section again.
7. Preference: toggle horizontal, restart the host (webview reload / page reload) → horizontal
   restored; fresh profile → vertical.
8. Progress: scrolling updates the column readout; readout absent when content fits.
9. Watch-reload during horizontal mode (file changes on disk): content rebuilds, mode
   persists, affordance re-hosting and focus restoration behave as in vertical mode.

Non-functional:

10. Vertical-mode regression: the full existing canvas test suite passes unchanged; a
    vertical-mode DOM snapshot shows no new classes/attributes when the mode was never
    toggled.
11. Accessibility: reading order = DOM order = Tab order across columns; container carries an
    ARIA roledescription; progress changes are announced (aria-live) without spamming per
    scroll tick; all controls reachable and operable by keyboard.
12. Theming: light and dark, toggle + progress chrome legible, only `--codev-canvas-*` tokens
    used (existing token-compliance test pattern extended).
13. Host demos at dev-approval: vite dev host and VS Code webview, per the testing guide.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Chromium fragments a protected block taller than the column anyway (spike finding 3), leaving clipped content | High (without design) | High | D1 caps every protected block below column height so the fallback path is never entered; success criterion asserts it |
| Residual vertical-flow geometry assumptions (`offsetTop`, union `getBoundingClientRect`) misplace chrome in columns | Medium | Medium | Spec mandates an audit of all layout-reading code paths (affordance placement, minimap, focus restoration); minimap suppressed (D3); clamping defined on flow height (D2) |
| jsdom cannot exercise fragmentation, so unit tests under-cover the core mechanism | High | Medium | Split verification: unit tests for state/structure; real-browser verification (Playwright + both host demos) at dev-approval — the established minimap precedent |
| Wheel remap fights native horizontal gestures or pinch-zoom | Medium | Medium | Remap only vertical-dominant, unmodified wheel events; explicit pass-through scenarios in tests (scenario 5) |
| Host embeds the canvas without a bounded height, making column mode degenerate | Medium | Low | Assumption recorded; host integration for the two v1 hosts provides the height context; mode toggle is a no-op benefit-wise elsewhere but never corrupts layout |
| Single-lane conflicts: architect lands canvas changes mid-flight | Medium | Low | Rebase over `main` at phase boundaries; #1343 already merged (the big geometric dependency) |
| `column-fill`/`break-inside` behavior differs in future engine updates | Low | Medium | Success criteria are behavior-based (rect counts, reachability), so regressions surface in the real-browser checks rather than silently |

## References

- Issue #1380 (requirements payload) + architect addendum comment of 2026-08-10
  (fragment-local affordance behavior) + architect ruling A on host scope (2026-08-10).
- #1386 — migrate `afx open` onto the canvas package (delivery path for `afx open` parity).
- Spec 945 (`codev/specs/945-build-foundational-reusable-pa.md`) — package contract, adapters,
  token vocabulary; #1029 — package-split decision record (host inventory ground truth).
- #1343 / PR #1385 — full-row affordance + block-local gutter (geometric prerequisite);
  #863 — marker cards + minimap; #1107 — inline composer; #1055 — edit/delete; #1237 —
  keyboard flow; #1053 — typography tokens.
- Spike: throwaway multicol page over the real canvas DOM/theme CSS, Chromium 147 headless
  (findings summarized in Current State; spike code is throwaway and intentionally not
  committed).
- `codev/resources/testing-guide.md` — UI verification requirements at dev-approval.
