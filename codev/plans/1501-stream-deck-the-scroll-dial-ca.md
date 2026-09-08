# PIR Plan: Scroll dial scrolls a spec/plan under review (canvas viewport-scroll)

## Understanding

The Stream Deck **Scroll dial** rotates to scroll the focused editor's viewport so a reviewer
can read a long document without touching the keyboard. It works on a diff but does **nothing**
on a spec/plan under review — the one place keyboard-free scrolling matters most.

Root cause (confirmed against the code):

- `ScrollNav.onDialRotate` has a single channel: it always relays the `scroll` verb
  (`apps/streamdeck/src/actions.ts:1059-1066`), which maps to VSCode's built-in **`editorScroll`**
  (`apps/vscode/src/command-relay.ts:59`). `editorScroll` acts only on the **active text editor's**
  viewport.
- A spec/plan under review opens in the **artifact-canvas** — a `WebviewPanel`, not a text editor.
  When it is focused there is no active text editor, so `editorScroll` silently no-ops.
- The review dials work on a spec/plan because `ReviewNav` **switches channel by phase**: in canvas
  mode it drives the canvas over `sendCanvasCommand` (`heading-next`, `block-next`, …) instead of
  the editor/diff verbs (`apps/streamdeck/src/actions.ts:914-928`, mode from
  `reviewMode(selectedBuilder)` at `:558-564`). The Scroll dial has no canvas channel, so it can
  never reach the canvas.

The fix mirrors that split: give the artifact-canvas a **viewport-scroll** capability, then
phase-switch the Scroll dial's rotation to drive it in canvas mode while keeping `editorScroll`
for diff/text-editor mode.

### Scope boundary carried from the issue (not relitigated)

The dial's **press** (`feedback-selection`) is builder-**diff**-only by design: its anchor requires
a tracked builder-diff entry (`apps/vscode/src/review-queue/feedback.ts`), which a spec/plan in the
canvas never has. #1498 deliberately kept the press **ungated** on review mode (it no-ops
server-side on a canvas — see the test at `apps/streamdeck/src/__tests__/actions.test.ts:678`). This
plan **does not touch the press**. After this lands the Scroll dial is *half-live* on a canvas:
rotation scrolls, press stays inert. That is expected; a diff-free spec/plan feedback path is a
separate, larger change and explicitly out of scope.

## Proposed Change

Add a new canvas command pair — `viewport-down` / `viewport-up` — that pans the artifact-canvas
scroll container vertically by a fixed step per unit, classified as **traversal** commands so the
existing `count` mechanism repeats them (one dial rotate event = `count = |ticks|`, exactly as the
review dials already do). Then teach `ScrollNav.onDialRotate` to route to that command via
`sendCanvasCommand` when `reviewMode(selectedBuilder) === 'canvas'`, keeping the `editorScroll`
relay for every other mode. `revealCursor: false` semantics are preserved: the canvas scroll moves
the viewport only and never moves block focus.

The canvas command vocabulary is a **closed union with four independent runtime allowlists** guarded
by compile-time drift asserts (types, Tower relay, VSCode host, canvas component). Adding a command
means updating all four plus the type-test classification, or CI fails to compile — that is the bulk
of the mechanical work.

### Why traversal + a scrollTop signature tweak

The canvas runs each command through a count loop that repeats the action `count` times and
**stops early when a step changes nothing** (the edge), keyed off a position signature
`${originLine}:${root.scrollLeft}` (`ArtifactCanvas.tsx:998-1005`). A vertical viewport pan changes
`scrollTop`, which that signature does **not** capture — so without a change the loop would break
after one step and a multi-tick rotate would scroll only once. The fix is to add `scrollTop` to the
signature. This is safe for the existing commands: at an edge nothing moves and it still breaks; when
focus moves, `originLine` already differs, so the added axis never causes a false continue.

Each `viewport-down`/`-up` step assigns `root.scrollTop` by a fixed pixel step (clamped to
`[0, scrollHeight - clientHeight]`), cancelling any in-flight wheel glide exactly as `pageColumn`
does (`ArtifactCanvas.tsx:896`). Vertical only (matches the issue's "up/down"); horizontal
reading-mode column paging stays keyboard-only and out of scope.

### Two decisions for the reviewer

**Decision 1 — the canvas-mode touchstrip label.** Today canvas mode reads `Scroll · editor only`
because #1498 found *both* gestures inert there (`actions.ts:1106-1107`, test at
`actions.test.ts:669-677`). After this fix rotation works on a canvas, so `editor only` becomes a
lie for rotation — but the press is still inert, so it must not collapse back to `send`/`queue`
either (the issue calls this out explicitly). The qualifier slot has always described the **press**.
Recommended: **`Scroll · read only`** — you can scroll to read, but a press won't send feedback.
Alternative: `Scroll · no send`. This is a small wording call best confirmed on hardware at the
dev-approval gate.

**Decision 2 — the pixel step per tick.** `editorScroll` uses 3 lines/tick; the canvas has no fixed
line height, so exact parity is impossible. Propose a tunable module constant
(`VIEWPORT_SCROLL_STEP_PX`, ≈ 3 lines, start ~60px). The right value is a *feel* parameter — which
is exactly why this is a PIR: tune it on the physical dial at the dev-approval gate.

## Files to Change

Contract + allowlists (mechanical, drift-guarded):

- `packages/types/src/canvas-command.ts` — add `viewport-down` / `viewport-up` to the `CanvasCommand`
  union (`:37-58`) and to `TraversalCommand` (`:73-83`), with a short doc note that they pan the
  viewport (no in-page keyboard twin, like `block-*`).
- `packages/types/type-tests/canvas-command.type-test.ts:37-53` — classify both as `'traversal'` in
  the `CLASSIFICATION` map (compile fails until they are classified).
- `packages/codev/src/agent-farm/servers/canvas-relay.ts` — add both to `CANVAS_COMMANDS` (`:68-84`)
  and `TRAVERSAL_COMMANDS` (`:91-100`).
- `apps/vscode/src/markdown-preview/canvas-view-registry.ts:34-50` — add both to `CANVAS_COMMANDS`
  (the host's defence-in-depth allowlist before forwarding an SSE frame to the webview).

Canvas behaviour:

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx`
  - add both to the local `TRAVERSAL_COMMANDS` (`:36-45`);
  - add a `VIEWPORT_SCROLL_STEP_PX` constant near `SCROLL_LINES_PER_TICK`'s canvas analogue;
  - add `viewport-down` / `viewport-up` entries to `canvasActions` (`:920-968`) that clamp-assign
    `root.scrollTop` by ±step and cancel wheel glide;
  - extend the loop position signature at `:998` to include `root.scrollTop` so counted scrolls
    advance and edge-stop.

Stream Deck dial:

- `apps/streamdeck/src/actions.ts`
  - `ScrollNav.onDialRotate` (`:1059-1066`): when `reviewMode(selectedBuilder) === 'canvas'`, send
    `viewport-down`/`viewport-up` via `sendCanvasCommand({ workspace }, { count: |ticks| || 1 })`
    (MRU targeting — `file` omitted, mirroring `ReviewNav.runCanvas` at `:956-966`); otherwise the
    existing `editorScroll` relay. Add a transient `status` line rendered from `canvasErrorLine`
    (`:827-831`) on a failed canvas scroll, for parity with the review dials;
  - `ScrollNav.renderTo` (`:1099-1114`): change the canvas-mode qualifier from `editor only` to the
    Decision-1 wording, and update the doc comment (`:1080-1098`) to reflect that rotation now
    works on a canvas while the press stays diff-bound.
  - `onDialDown` is **unchanged** (press stays diff-only by design, per #1498).

No change to `apps/vscode/src/command-relay.ts` (`editorScroll` stays the diff/text path) and no
change to `packages/sdk` (`sendCanvasCommand` is generic over `CanvasCommand` and passes `count`
through — `tower-client.ts:986-993`). Not skeleton-mirrored: these are product packages, not
`codev-skeleton/` framework templates.

## Risks & Alternatives Considered

- **Risk — the count loop breaks after one scroll step.** Handled by adding `scrollTop` to the
  position signature (see above). Regression-tested via a Playwright/unit assertion that
  `viewport-down` with `count: 3` moves `scrollTop` by 3× the step (and stops at the bottom edge).
- **Risk — forgetting one of the four allowlists.** The compile-time drift asserts turn any omission
  into a `check-types` failure across `codev-types`, `codev`, `vscode`, and `artifact-canvas`; the
  type-test forces the traversal/non-traversal classification. CI catches all of it.
- **Risk — a misleading touchstrip after the fix.** Decision 1 exists precisely so the canvas-mode
  label stays honest (rotation live, press inert). Confirmed on hardware at dev-approval.
- **Alternative — reuse `editorScroll` by focusing a hidden editor behind the canvas.** Rejected:
  fragile, fights the artifact-canvas design, and the canvas already owns a first-class remote
  command channel built for exactly this.
- **Alternative — make each dial tick send `count=1` and scroll a large fixed chunk.** Rejected:
  loses proportional control on a fast spin; `count = |ticks|` with a modest per-step matches the
  review dials and the current editor feel.
- **Alternative — pass `count` into the action instead of extending the signature.** Rejected as
  more invasive: it changes the `(ctx) => void` action shape shared by every command; the
  signature tweak is one line and keeps the edge-stop behaviour uniform.

## Test Plan

Unit / component (run from the worktree):

- `apps/streamdeck` — extend `ScrollNav` tests (`actions.test.ts`):
  - canvas mode: rotate sends `viewport-down`/`viewport-up` over `sendCanvasCommand` with
    `count = |ticks|` and `{ workspace }` only (MRU, no `file`); the generic verb relay is untouched.
  - diff/text mode: rotate still relays `scroll` (`editorScroll`) — the existing test at `:638`
    stays green.
  - update the label test at `:669` to the Decision-1 wording; assert the press still relays
    `feedback-selection` unchanged (`:678-680`).
  - a failed canvas scroll renders its per-code line on the strip (mirror `:590-604`).
- `packages/artifact-canvas` — `viewport-down`/`viewport-up` move `scrollTop` by the step; `count: N`
  moves N× and stops at the bottom/top edge; focus (current block) is unchanged.
- `packages/codev` / `apps/vscode` — the new commands pass the relay/host allowlists (drift asserts
  compile); an unknown command is still rejected.
- `pnpm check-types` across all touched packages (the drift guards + type-test are the real safety
  net — vitest alone won't surface a missing allowlist entry).

Manual (dev-approval gate, real Stream Deck hardware):

- Select a builder blocked at `plan-approval`/`spec-approval` (canvas mode). Open its plan/spec in
  the artifact-canvas. Rotate the Scroll dial → the canvas viewport scrolls down/up smoothly; spin
  faster → scrolls proportionally; at the bottom it stops.
- Confirm the touchstrip reads the Decision-1 label and that a **press** does nothing (inert by
  design).
- Tune `VIEWPORT_SCROLL_STEP_PX` for feel and confirm the final value.
- Regression: on a builder in implement/review (diff mode), the Scroll dial still scrolls the diff
  editor and the press still submits/queues the selection.
