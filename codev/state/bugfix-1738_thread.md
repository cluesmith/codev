# bugfix-1738 — artifact-canvas: block navigation skips the first child of a container

Issue #1738. Lane brief from architect:vscode received (validate hypothesis, keep
nav+marker-anchoring consistent, handle/document card-in-`<ol>` DOM, deliberate test
updates, stay out of apps/streamdeck + apps/vscode, name pr gate + PR# at gate).

## INVESTIGATE (complete)

### Reproduced / root cause (validated against the real token stream)

Dumped `md.parse(...)` for a paragraph→ordered-list→blockquote→nested-list document. Every
container open token carries the SAME `map[0]` as its first child:

- `ordered_list_open` map=[2,6], first `list_item_open` map=[2,3], its inner `paragraph_open`
  map=[2,3] → all stamp `data-line=2`.
- `blockquote_open` map=[6,8] and inner `paragraph_open` map=[6,8] → both `data-line=6`.
- Nested: outer `bullet_list_open` map=[9,12] / outer li map=[9,12]; nested
  `bullet_list_open` map=[10,12] / nested li map=[10,11].

`isMappedBlock` (renderer.ts:29) returns true for every `*_open` token, so containers get
`data-line`. Both `collectBlocks` (ArtifactCanvas.tsx:589) and the marker-decoration guard
(ArtifactCanvas.tsx:413) keep only the FIRST `[data-line]` per line in tree order = the
outermost = the container. So the first list item (and a blockquote's first paragraph, and a
nested list's first item) has no navigable/markable slot; items 2..n each own their own line.
Confirmed the issue's line refs (renderer.ts:75, ArtifactCanvas.tsx:589 + :407 guard).

### Key insight

A container open token's `map[0]` ALWAYS equals its first child's `map[0]`. So dropping
`data-line` from the container never orphans a source line — the first child re-supplies it.

### Fix shape (for IMPLEMENT)

Stop stamping `data-line` + `tabindex` on `ordered_list_open`, `bullet_list_open`,
`blockquote_open` in the renderer core rule. Then the outermost per-first-line element becomes
the `<li>` (or the inner `<p>` for a blockquote), so navigation visits item 1 and markers
anchor to the `<li>`. collectBlocks + marker guard need NO change — both just take the first
`[data-line]`, so they stay consistent automatically (no container-type hardcoding either side).

- **blockquote INCLUDED**: a multi-paragraph blockquote today swallows its first paragraph and
  makes later paragraphs individually navigable — same asymmetry as lists. Dropping
  blockquote_open makes each inner paragraph individually navigable/markable, symmetric with
  lists. Single-paragraph blockquote: navigation lands on the inner `<p>` (same line), no line
  lost. Will state this reasoning in the PR.
- **tables NOT touched**: `table_open` keeps its `data-line` — a table is reviewed as a unit,
  which is the desired outermost-wins behavior. Only list/blockquote containers change.

### Card-insertion DOM residual

`buildMarkerCards` (ArtifactCanvas.tsx:118) builds a `<ul class="codev-canvas-marker-cards">`.
`el.after(...)` on an `<li>` (ArtifactCanvas.tsx:422) places that `<ul>` directly inside the
`<ol>`/`<ul>` (invalid — list children must be `<li>`). PRE-EXISTING for items 2..n. The fix
extends it to item 1 (first-item markers previously anchored to the whole list = valid). The
composer host anchoring (ArtifactCanvas.tsx:511) depends on the cards being the block's
`nextElementSibling`. Decision deferred to IMPLEMENT: assess whether the ol>ul nesting causes a
visible/functional break; if not, document as a pre-existing residual in the PR; if yes, do the
scoped in-`<li>` insertion and adjust composer anchoring to match.

### Scope

Renderer core-rule change (a small container-type exclusion) + deliberate test updates
(data-line.test.ts pins ul/li/blockquote today) + regression tests (para→list visits item 1
then 2; first-item marker decorates `<li>` not the list; nested list + blockquote cases). Well
under 300 LOC. Fits BUGFIX.

## FIX (complete)

### Change

- `renderer.ts`: added `CONTAINER_OPEN_TOKENS = {bullet_list_open, ordered_list_open,
  blockquote_open}`; `isMappedBlock` returns false for them. So the wrapper carries no
  `data-line`/`tabindex`; its first child (the `<li>` or the blockquote's inner `<p>`) becomes the
  outermost block for the line. collectBlocks + the marker-decoration guard both just take the
  first `[data-line]`, so navigation AND anchoring follow with no change on either side — they stay
  coupled, as the architect required. Tables untouched (`table_open` keeps its data-line).
- `ArtifactCanvas.tsx`: addressed the card-in-`<ol>` DOM point (architect item 3). The fix moved
  first-item markers onto the `<li>`, and `el.after()` on an `<li>` places the card `<ul>` directly
  under the list = invalid `ul > ul` (which the guard test explicitly forbids, and which was
  pre-existing for items 2..n). Added `insertBelowBlock` (append INSIDE an `<li>`, else
  `el.after`) + `markerCardsOf`, used for both the marker-card stack and the composer host. So the
  stack and composer now live inside the `<li>` for ALL list items = valid DOM, fixed once. The
  composer effect's idempotency check is now position-aware (cards→prev-sibling, li→lastChild,
  else→next-sibling) to avoid a re-run loop.

### Tests

- `data-line.test.ts`: updated the two container-stamping tests + accessibility test (deliberate);
  added a `container open tokens are not stamped (#1738)` describe (ordered list first-item,
  nested list, multi-paragraph blockquote).
- `keyboard-nav.test.tsx`: updated the old "n lands on OUTERMOST/UL" test to assert LI + li
  decoration; added a `block stepping visits the first child of every container (#1738)` describe
  driving `block-next` via a captured `commandAdapter` (para→item1→item2→item3; nested list;
  blockquote — all with tagName assertions so they pin the bug, not just coincident data-line).
- `artifact-canvas.test.tsx`: rewrote the iter-1 outermost-anchor test to assert the stack sits
  INSIDE the first `<li>` (valid), wrapper has no data-line/marker class.

### Verification

- Full suite: 183 passed. check-types (tsc) clean. build (tsdown) clean.
- Fails-without-fix confirmed: temporarily disabled the exclusion → 9 renderer/nav/anchor tests
  fail (incl. all 4 nav cases after strengthening nested/blockquote with tagName). Restored.

No apps/streamdeck or apps/vscode changes. Changelog left to architect:vscode per brief.

## PR (PR #1741) + CMAP round 1

Opened PR #1741 (`Fixes #1738`). CMAP: gemini SKIPPED (agy unauthenticated, non-blocking),
codex=REQUEST_CHANGES (HIGH), claude=REQUEST_CHANGES (HIGH). Both independently caught a real
regression I missed:

**`data-line` was doing double duty** — navigation/marker identity AND the CSS row-model hook.
`default-theme.css` keyed `position: relative` + gutter on `.codev-artifact-canvas-body >
[data-line]`. Removing data-line from top-level `<ul>`/`<ol>`/`<blockquote>` stripped their
`position: relative`, so the abspos `.codev-canvas-row-affordance` ("+"), appended into the
container by `rowHostOf`/`placeAffordance`, resolved against the wrong ancestor = misplaced "+"
on every list/blockquote. Also: containers fell into the `:not([data-line])` margin bucket (dead
zone reintroduced), and the CI Playwright probe `:scope > ul[data-line]` (a hard, non-skippable
assertion in `fragment-affordance.spec.ts`) would fail. jsdom can't catch any of this.

**Fix (claude's cleaner approach, adopted):** decouple the two concerns. The renderer stamps
`data-row=""` (no data-line, no tabindex) on the three container opens — a CSS-only row hook.
- renderer.ts: container opens get `data-row` instead of nothing.
- default-theme.css: row model keys on `> :is([data-line], [data-row])`; blockquote/list gutter
  rules key on `[data-row]`; margin bucket excludes `[data-row]`; keep-together selectors gained
  a `> .codev-canvas-marker-cards` variant (the stack now lives INSIDE a composing `<li>`).
- default-theme.test.ts: pinned selectors updated to the data-row reality.
- fragment-affordance.spec.ts: probe → `:scope > ul[data-row]` (hard assertion kept).
- full-row-affordance.test.tsx: fixed the vacuous `ul[data-line]`→null test to assert the "+"
  is hosted inside the top-level `<ul>` (data-row present, data-line null).
- data-line.test.ts: added data-row assertions on the ol/blockquote wrappers.

Verified: 183/183 unit tests, tsc clean, build clean. Playwright browser suite running to confirm
the abspos "+" positioning (the browser-only regression). Will push + re-run CMAP.
