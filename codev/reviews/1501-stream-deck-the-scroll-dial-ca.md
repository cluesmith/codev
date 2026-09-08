# PIR Review: Scroll dial scrolls a spec/plan under review (canvas viewport-scroll)

Closes #1501

## Summary

The Stream Deck Scroll dial's rotation relayed VSCode's `editorScroll`, which acts only on a
text editor — so it did nothing when the reviewer was reading a spec/plan in the artifact-canvas
webview, the one long document where keyboard-free scrolling matters most. This adds a
`viewport-down`/`viewport-up` canvas command (a raw viewport pan, distinct from the existing
block/heading focus moves) and phase-switches `ScrollNav.onDialRotate` to drive it over
`sendCanvasCommand` in canvas mode — mirroring the mode split the review dials already use —
while keeping `editorScroll` for diff/text-editor mode. The press stays builder-diff-only by
design (#1498), so on a canvas the dial is half-live: rotation scrolls, press is inert.

## Files Changed

- `packages/types/src/canvas-command.ts` (+18 / -3) — new `viewport-down`/`viewport-up` in the
  `CanvasCommand` union and `TraversalCommand`.
- `packages/types/type-tests/canvas-command.type-test.ts` (+2 / -0) — classification (drift guard).
- `packages/codev/src/agent-farm/servers/canvas-relay.ts` (+4 / -0) — Tower relay allowlists.
- `apps/vscode/src/markdown-preview/canvas-view-registry.ts` (+2 / -0) — VSCode host allowlist.
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+48 / -2) — `scrollViewport`
  (pans the host-page scroller), `VIEWPORT_SCROLL_STEP_PX`, count-loop signature extension.
- `apps/streamdeck/src/actions.ts` (+66 / -15) — `ScrollNav` mode split + `Scroll · read only`.
- `apps/streamdeck/src/__tests__/actions.test.ts` (+40 / -4) — diff/canvas rotate tests.
- `packages/artifact-canvas/playwright/remote-commands.spec.ts` (+66 / -0) — real-browser scroll tests.
- `apps/streamdeck/README.md` (+8 / -2) — Scroll dial doc, phase-aware split.

(Plus the plan, this review, the builder thread, and porch `status.yaml`.)

## Commits

- `126000771` [PIR #1501] Add viewport-down/up to the canvas command wire contract
- `7c2f4393a` [PIR #1501] Allow viewport-scroll commands through the Tower relay and VSCode host
- `a4df4b4aa` [PIR #1501] Scroll the canvas viewport on viewport-down/up (host page scroller, count-aware)
- `be3e5b55a` [PIR #1501] Route the Scroll dial to canvas viewport-scroll in canvas mode
- `a2836b23f` [PIR #1501] Test Scroll dial rotation in both modes; add first genuine diff-mode coverage
- `56db55602` [PIR #1501] Address impl-review: fix stale Scroll dial docs, host-contract note
- (thread-update commits omitted)

## Test Results

- Build: ✓ (`pnpm -r build`, porch `build` check 7.2s)
- Tests: ✓ streamdeck 242 (10 new/changed), artifact-canvas 177 unit + 10 Playwright (4 new
  `#1501`, real Chromium), codev canvas-relay 30, vscode registry 17; all `check-types` +
  `type-tests`. Porch `tests` check 30.9s.
- Manual verification (dev-approval, real Stream Deck hardware, by the human): rotating the Scroll
  dial scrolls a spec/plan in the artifact-canvas; the `Scroll · read only` label and the 60px
  step were confirmed on the dial. (One `Error` touchstrip appeared first — diagnosed as a stale
  globally-installed Tower rejecting the new command as `invalid-request`, not a code defect; see
  Lessons.)

## Architecture Updates

**COLD** (`codev/resources/arch.md`): appended one clause to the #1380 artifact-canvas host-contract
entry recording that in vertical reading mode the **host page** (document scrolling element) is the
vertical scroll container, not the canvas body — the invariant `viewportStartLine` already encodes
and that the new viewport-scroll command now also depends on.

No **HOT** arch change: this adds no new module boundary. The viewport-scroll command follows the
existing spec-1401 pattern exactly — a closed command vocabulary mirrored across four drift-guarded
allowlists (types union/`TraversalCommand`, Tower `canvas-relay`, VSCode `canvas-view-registry`,
canvas-local `TRAVERSAL_COMMANDS`) plus the type-test classification map.

## Lessons Learned Updates

**COLD** (`codev/resources/lessons-learned.md`, Testing), two entries:

1. **The host-scroller find** (the most valuable catch in this lane). The approved plan said pan
   `root.scrollTop`; the canvas body is not the vertical scroller (in vertical mode the host page
   scrolls — `viewportStartLine` measures against the window, and the VSCode host leaves body
   overflow default), so that would have silently no-oped in the real webview while passing every
   jsdom test. Generalizable shape: **a DOM assumption that unit tests cannot falsify (which element
   actually scrolls) needs a real-browser test, and an approved plan is not evidence about runtime.**
   Caught and proven in real Chromium before writing the code, not argued.

2. **The stale-Tower `Error`** sharpens #1414: a canvas-command Stream Deck feature spans a *third*
   independently-versioned artifact — Tower (the codev server validates the command in
   `canvas-relay`). A stale global Tower rejects a new command as `invalid-request`, which the deck
   renders as `Error` on the touchstrip, even with the deck bundle and VSCode extension both
   on-branch.

No HOT lesson: (1) sharpens the existing hot lesson "'tests pass' is not 'it works' — verify the
real user path" rather than displacing a capped entry; both are spec-adjacent recipes that belong cold.

## Things to Look At During PR Review

- **The count-loop signature change** (`ArtifactCanvas.tsx`, `runCanvasCommand`): the progress
  signature gained the document scroller's `scrollTop` (`originLine:scrollLeft:scrollTop`). This is
  shared by every canvas command's repeat loop — verify it still edge-stops for block/heading/column
  commands (it does: at an edge nothing moves; when focus moves `originLine` already differs). The
  huge-count Playwright test pins the bound (`count: 1_000_000` finishes < 5s at the bottom).
- **`'canvas'`-specific keying** in `ScrollNav.onDialRotate`: the branch is `reviewMode === 'canvas'`,
  never "not diff", so `none` (no builder / unknown phase) keeps `editorScroll`. The #1505
  empty-state guard pins this.
- **The `:638` test repoint** (ruled by the architect): it moved to a diff-mode builder (`pir-2`)
  and is the *first genuine diff-mode rotate coverage* — the old test rode the canvas-mode default
  fixture through then-mode-independent code. Not an accommodation of a regression.
- **CMAP consult already run at implement** (advisory, at the architect's request): Gemini APPROVE,
  Codex COMMENT, Claude REQUEST_CHANGES. All addressed — the substantive one was a stale ScrollNav
  *class-level* doc comment (the `renderTo` doc was updated, the class header was missed).
- **Two review nits deliberately left, ruled by the architect:** the focus-ring re-arm on a pure pan
  (via `runCanvasCommand`, accepted after hardware use) and the ~5-line overlap with
  `ReviewNav.runCanvas` (extracting a shared helper would couple two actions with different semantics).
- **Horizontal reading mode is a defined no-op.** `scrollViewport` clamps to `max = 0` when the body
  clips vertically (`overflow-y: hidden`), so `viewport-down`/`up` do nothing in horizontal mode —
  "up/down" has no meaning there. Tower still answers `ok` and the label still reads `Scroll · read
  only` (no per-mode label was in scope). Pinned by `viewport-scroll is inert in horizontal reading
  mode`, the mirror of the existing `column paging is inert in vertical mode`.
- **A deliberate deviation from the plan:** the plan said cancel the in-flight wheel glide (as
  `pageColumn` does). The implementation does not — the glide is horizontal-only and drives
  `body.scrollLeft`, which a document-scroller vertical pan never fights, so the cancel was dead code
  (flagged in the impl-review and removed).
- **Why the count-loop signature change is safe:** `runCanvasCommand` is fully synchronous — no
  animation frames run mid-loop — so a smooth `scrollIntoView` from an earlier command cannot advance
  the signature between iterations and defeat the edge-stop (which is also the `count: 1_000_000`
  spin guard). The huge-count Playwright test corroborates.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1501 → **Review Diff**.
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1501`. Note this is a cross-surface
  change — hardware testing needs Tower + the VSCode extension + the deck plugin all built from this
  branch, not the installed package (a stale Tower renders `Error` on the dial).
- **What to verify**: select a builder blocked at plan/spec-approval (canvas mode), open its
  plan/spec in the artifact-canvas, rotate the Scroll dial → the page scrolls up/down; spin faster →
  proportional; at the bottom it stops. On a diff-phase builder the dial still scrolls the diff
  editor and the press still submits/queues the selection.
