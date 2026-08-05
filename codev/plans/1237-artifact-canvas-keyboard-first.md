# PIR Plan: artifact-canvas batch — '+' affordance fix (#1236), arrow cursor (#1232), keyboard-first review navigation (#1237)

One plan, one PR, three issues (architect-directed batch). Implementation order: #1236 (bugfix, first), #1232 (smallest), #1237 (design-heaviest). PR closes all three: `Fixes #1232, Fixes #1236, Fixes #1237`.

All file:line references verified against current source on `builder/pir-1237` (2026-08-05).

## Understanding

### #1236 — the '+' affordance disappears en route; undersized button

Both mechanisms re-verified in source:

1. **Re-anchoring en route.** `activateFromTarget` (`ArtifactCanvas.tsx:411-424`) fires from `onMouseOver` on the body (`ArtifactCanvas.tsx:433`) on *every* block crossing and immediately re-anchors: `setActiveLine(n)` + `setOverlayTop(el.offsetTop + lineHeight/2)`. Diagonal travel from mid-block toward the gutter "+" crosses neighboring `[data-line]` blocks and the button jumps away under the cursor.
2. **Overshoot dismissal.** The canvas root clears instantly: `onMouseLeave={() => setActiveLine(null)}` (`ArtifactCanvas.tsx:427`). The overlay hugs `left: 0` (`default-theme.css:257`), so a 1px overshoot past the canvas's left edge unmounts the button.
3. **Undersized button.** Confirmed: the overlay lives outside the font-sized containers (`default-theme.css:91-98` comment says so explicitly — "the comment cards, overlay `+`, and minimap chrome live OUTSIDE these containers"). `.codev-canvas-overlay` (`default-theme.css:252-260`) sets no font-size, so `.codev-canvas-add-comment` (`default-theme.css:219-227`, `line-height: 1; padding: 0 6px`) renders at the host default (13px in VS Code webviews) beside 16px prose.

The two defects compound: a small target demands precise travel, and precise travel maximizes exposure to re-anchor/overshoot.

### #1232 — I-beam cursor over read-only content

The rendered body shows the UA I-beam over text, but content is read-only and comments are button-driven (hover → "+" → composer), not selection-anchored. Decided in the issue: **uniform arrow, including code blocks**. The five existing cursor rules (add-comment `default-theme.css:223`, card actions `:308`, composer buttons `:364`, disabled submit `:380`, minimap dots `:409`) stay untouched; links keep the UA pointer (`a[href]` UA rule wins over an inherited container default).

### #1237 — possible-by-keyboard ≠ pleasant-by-keyboard

What already works (verified; do NOT rebuild): every mapped block gets `tabindex="0"` at render (`renderer.ts:82`), Enter/Space on a focused block opens the inline composer (`ArtifactCanvas.tsx:436-444`), Cmd/Ctrl+Enter submits and Esc cancels (`CommentComposer.tsx:59-68`), Esc-cancel already restores focus to the originating block (`ArtifactCanvas.tsx:367-376`), the "+" and card edit/delete actions are real `<button>`s with aria-labels, and minimap dots are real `<button>`s with aria-labels (`MarkerMinimap.tsx:70-83`).

The gaps:

1. **Linear-only traversal** — Tab is the only navigation; a 300-block document is 300 tab stops. No jump keys.
2. **Focus lost after submit and delete.** Root cause traced: the host writes the marker → `FileAdapter.watch` fires → `applyLoad` sets new content → `html` changes (marker comment lines shift the `data-line` map even though comment lines are stripped from rendering, `renderer.ts:47-69`) → the innerHTML effect (`ArtifactCanvas.tsx:254-257`) rebuilds the body → the previously-focused element is destroyed and **focus drops to `document.body`**. Same for delete (focus was on the now-destroyed card action button). Esc-cancel is fine because cancel does not rebuild the body.
3. **Minimap dots**: Tab-reachable and activatable already (real buttons), but activation only scrolls (`scrollIntoView`, `MarkerMinimap.tsx:77-83`) — it does not move focus, so a keyboard user's focus stays behind and the next Tab resumes from the dot, not the target block.
4. **No discoverability** — nothing surfaces the existing keys.

## Proposed Change

### Phase A — #1236 (hover state machine + sizing)

**Grace + pin in `ArtifactCanvas.tsx`.** Add two refs and one constant (`OVERLAY_GRACE_MS = 200`):

- `graceTimerRef` — the single pending timer (dismiss OR re-anchor; only one can be pending).
- `overlayPinnedRef` — true while the pointer is inside `.codev-canvas-overlay`.

Behavior:

- **Canvas `onMouseLeave`**: instead of clearing instantly, schedule `setActiveLine(null)` after 200ms. Entering the overlay (or re-entering any block, which re-activates) cancels the pending clear.
- **Block-crossing re-anchor**: in the *mouse* path of `activateFromTarget`, when an overlay is already showing for a different line, defer the re-anchor by 200ms instead of applying it instantly; entering the overlay cancels it. When no overlay is showing (`activeLine === null`), activate immediately (first hover must feel instant).
- **Pin**: `onMouseEnter` on the overlay sets `overlayPinnedRef` and cancels any pending timer — nothing re-anchors or dismisses out from under the cursor. `onMouseLeave` on the overlay unpins (subsequent body/canvas events resume normal handling). While pinned, `activateFromTarget`'s mouse path is a no-op.
- **Keyboard path unchanged and instant**: `onFocus` → `activateFromTarget` bypasses the grace entirely (a focus move must never lag 200ms).
- Timer cleanup on unmount (effect return).

**Sizing in `default-theme.css`:**

- `.codev-canvas-overlay { font-size: var(--codev-canvas-font-size); }` — the button inherits 16px instead of the host's 13px.
- `.codev-canvas-add-comment { min-width: 24px; min-height: 24px; }` (WCAG 2.5.8 floor), keeping `translateY(-50%)` centering (it centers on the line's vertical midpoint regardless of button size).
- Risk check at dev gate: the gutter is `padding-left: 1.9rem` (`default-theme.css:88`) — rem is **root**-relative, so at a 13px webview root that's ~24.7px, tight against a 24px button. If it crowds, bump the gutter to a px value (e.g. `30px`) in the same commit.

### Phase B — #1232 (one rule)

```css
.codev-artifact-canvas-body { cursor: default; }
```

Composed body only — the standalone `.codev-artifact-canvas-rendered` (MarkdownView) is out of scope per the issue. No new tokens (the locked token snapshot in `default-theme.test.ts` is unaffected). Verify at dev gate that links still show the pointer and the five existing cursor rules behave unchanged.

### Phase C — #1237 (jump keys, focus restoration, minimap focus, discoverability)

**C1. Jump keys** — extend the body `onKeyDown` (`ArtifactCanvas.tsx:436`). All jump keys apply only when the event target resolves to a `[data-line]` block (same `lineFromEvent` guard the Enter/Space path uses — keystrokes in the composer textarea, card actions, or minimap never match) and carry no Ctrl/Meta/Alt modifier:

| Key | Action |
|---|---|
| `n` / `p` | next / previous block carrying a marker |
| `]` / `[` | next / previous heading (h1–h6) |
| `Home` / `End` | first / last block |

Mechanics: collect `[data-line]` elements in tree order, dedupe to the **first element per line** (the renderer stamps nested duplicates, e.g. `ul` and its `li` — same outermost-wins rule the decoration effect uses, `ArtifactCanvas.tsx:288`), locate the current block, walk to the target matching the predicate (`.codev-canvas-has-marker` for n/p; tag h1–h6 for ]/[), then `target.focus({ preventScroll: true })` + `target.scrollIntoView({ behavior: 'smooth', block: 'center' })`. Focus fires the existing `onFocus` → `activateFromTarget`, so the "+" follows the keyboard cursor for free. No match → no-op (no wrap-around; predictable).

**C2. Focus restoration across the rebuild** — add `pendingFocusLineRef: number | null`:

- `submitComposer` (`ArtifactCanvas.tsx:354`) sets it to `composingLine` (add) or `editingMarker.line` (edit) before emitting the intent.
- The delete branch of `onBodyClick` (`ArtifactCanvas.tsx:390`) sets it to `marker.line`.
- The decoration effect (`ArtifactCanvas.tsx:266-311`), after decorating, consumes it: focus the first `[data-line="N"]` block; if that exact line no longer exists (line drift), fall back to the nearest preceding `[data-line]`; clear the ref either way. Focusing the *block* (not a neighboring card) is deliberate: cards aren't focusable, the block is the stable anchor, and jump keys resume from it.
- Esc-cancel needs no change (already correct) — it gets a regression test instead.

**C3. Minimap activation moves focus** — in the dot's `onClick` (`MarkerMinimap.tsx:77-83`): `el.focus({ preventScroll: true })` before the existing `scrollIntoView`. Dots are already Tab-reachable real buttons; this makes activation hand the position to the target block so Tab/jump keys resume there.

**C4. Discoverability** — `?` (Shift+/, same block-focus guard) toggles a small keys legend: new `KeyboardHelp.tsx` overlay, rendered by `ArtifactCanvas` behind a `helpOpen` state. Non-modal panel (fixed, bottom-right), `role="dialog"` + `aria-label="Keyboard shortcuts"`; focus does not move into it, `?` or Esc (on a focused block, when help is open) closes it. Lists: Tab/Shift+Tab, Enter/Space, ⌘/Ctrl+Enter, Esc, n/p, [/], Home/End, ?. Styling in `default-theme.css` reusing existing tokens (no new tokens → token snapshot unchanged).

## Files to Change

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`
  - `:411-424` `activateFromTarget` — split mouse vs focus paths; grace + pin on the mouse path
  - `:427` canvas `onMouseLeave` — graced dismiss; overlay div (`:451`) gains `onMouseEnter`/`onMouseLeave` pin handlers
  - `:436-444` `onKeyDown` — jump keys (n/p, ]/[, Home/End) and `?` help toggle
  - `:354-366`, `:390-392` — set `pendingFocusLineRef` on submit/edit-save/delete
  - `:266-311` decoration effect — consume `pendingFocusLineRef` after rebuild
  - render `KeyboardHelp` when `helpOpen`
- `packages/artifact-canvas/src/overlays/MarkerMinimap.tsx:77-83` — dot activation focuses the target block before scrolling
- `packages/artifact-canvas/src/overlays/KeyboardHelp.tsx` — new: the keys legend panel
- `packages/artifact-canvas/src/styles/default-theme.css`
  - `:87-89` — add `cursor: default` to `.codev-artifact-canvas-body` (#1232)
  - `:219-227` — `.codev-canvas-add-comment` min 24×24 hit target (#1236)
  - `:252-260` — `.codev-canvas-overlay` gets `font-size: var(--codev-canvas-font-size)` (#1236); gutter bump only if the dev-gate check shows crowding
  - new `.codev-canvas-keyboard-help` styles (#1237)
- Tests (vitest + jsdom + @testing-library/react, matching existing patterns):
  - `packages/artifact-canvas/src/components/__tests__/hover-affordance.test.tsx` — new (#1236, fake timers)
  - `packages/artifact-canvas/src/components/__tests__/keyboard-nav.test.tsx` — new (#1237: jump keys, guards, focus restoration, Esc regression, help toggle)
  - `packages/artifact-canvas/src/overlays/__tests__/marker-minimap.test.tsx` — extend: activation focuses the target block
  - `packages/artifact-canvas/src/__tests__/default-theme.test.ts` — should pass unchanged (no token changes); add a plain-rule assertion for `cursor: default` if the file's style fits, else rely on the manual check

## Risks & Alternatives Considered

- **Risk: 200ms re-anchor grace makes normal block-to-block hover feel laggy.** Mitigation: single tunable constant; first-hover (no overlay showing) stays instant; verified by feel at the dev-approval gate.
- **Risk: timer/state races (unmount mid-grace, watch reload mid-grace).** Mitigation: single timer ref, cleared on unmount and on every competing transition; fake-timer unit tests cover leave→re-enter, leave→expire, cross→pin.
- **Risk: focus restoration targets a shifted line after the host writes the marker.** A marker comment is written *below* its block, so the block's own original-line is stable for add/edit; delete can shift lines of *later* blocks. Mitigation: exact-line match first, nearest-preceding-block fallback.
- **Risk: single-letter shortcuts and screen-reader browse modes.** Keys only fire when a block (not an input) has focus, matching the GitHub-diff-view convention; all keys are documented in the `?` legend. No `accesskey`, no global listeners — everything is scoped to the body's React handler.
- **Risk: gutter too tight for the 24px button at 13px root font** (1.9rem ≈ 24.7px). Checked at dev gate; fallback is a px gutter.
- **Alternative (rejected for now): move the "+" into the block's own hover row (GitHub-diff pattern).** Eliminates the travel-gap class entirely but restructures the overlay/layout contract (#863's anchoring, gutter, translateY centering). Grace+pin is the proportionate fix; the deeper restructure is the documented fallback if the gutter remains troublesome.
- **Alternative (rejected): roving tabindex over blocks.** Blocks are content, not a widget; Tab-through is legitimate. Jump keys are additive, not a focus-model change.
- **Alternative (rejected): `cursor: default` on the whole canvas root.** The issue scopes it to the content body; overlay/cards/minimap already declare their own cursors.

## Test Plan

Unit (run from the worktree: `pnpm --filter @cluesmith/codev-artifact-canvas test`):

- **#1236 (fake timers)**: overlay survives canvas `mouseleave` for <200ms and re-entry cancels the dismiss; overlay clears after 200ms; crossing to another block does not re-anchor before 200ms; `mouseenter` on the overlay cancels a pending re-anchor and pins (subsequent block crossings are no-ops); focus-driven activation is instant.
- **#1237 jump keys**: `n`/`p` move focus between `.codev-canvas-has-marker` blocks (nested-duplicate dedupe covered by a list-item marker fixture); `]`/`[` between headings; `Home`/`End` to first/last; no-op at the edges; keys inside the composer textarea are ignored (typing "n" types "n").
- **#1237 focus**: Esc-cancel returns focus to the originating block (regression); after submit + simulated watch reload, focus lands on the commented block; after delete + reload, focus lands on the block (fallback path covered with a vanished-line fixture); minimap dot activation focuses the target block.
- **#1237 help**: `?` opens the legend (role=dialog, label), `?`/Esc closes it, focus never moves into it.
- **#1232**: theme test still green (no token changes).

Manual at the `dev-approval` gate (`pnpm --filter @cluesmith/codev-artifact-canvas dev:example`, or `afx open` on a real spec once built into the VS Code host):

- Mouse a diagonal path from mid-paragraph to the "+" — it must not vanish or jump; overshoot 10px past the left edge and come back within the grace — still there.
- Button size: visually ≥24px and proportionate to 16px prose; check in a VS Code webview (13px host default) specifically.
- Arrow cursor over paragraphs, headings, **and code blocks**; pointer hand over links; the five existing cursor spots unchanged.
- Full keyboard-only review pass on a long spec: Tab in → `]` to a section → `n` to an annotated block → Enter → type → ⌘Enter → focus is back on the block → `n` onward → delete a comment via card action → focus back on the block → `?` shows the legend.
