# PIR Plan: Stream Deck phase-aware review dials

## Understanding

Issue #1400 (the current issue body is the spec, rewritten 2026-08-12). When the selected builder
is writing a spec or plan there is no diff yet, so the two diff dials (Files / Changes) sit idle
exactly when the artifact **canvas** is the thing under review. The ask: make those two dials
**phase-aware** so the same physical gestures review whichever artifact form the selected builder's
phase implies.

**The unifying rule** (constant gesture roles, only the artifact form changes):

| Selected builder's state | Coarse dial (today: Files) | Fine dial (today: Changes) | Press | Tap |
|---|---|---|---|---|
| implement / review, or blocked at dev-approval / pr | files (unchanged) | hunks (unchanged) | forward file/hunk (unchanged) | jump to first (unchanged) |
| specify / plan, or blocked at spec-approval / plan-approval | heading step | block step | `composer-open` on the focused block | jump (doc-start — see decision) |

The bridge is done: #1401 shipped `sendCanvasCommand` on the sdk controller subpath and #1404
shipped `phaseArtifactVerb` (the phase/gate resolver). This project is the **deck half** and needs
**no bridge changes** (req 7).

### Key facts from investigation

- The two dials are `DiffFileNav` ("Files") and `DiffHunkNav` ("Changes"), subclasses of the
  abstract `DiffNav` in `apps/streamdeck/src/actions.ts:476-533`. Both are `Encoder` controllers in
  the manifest — the physical dials. Reusing them means **zero layout change** ("ships on the
  existing dial layout").
- `phaseArtifactVerb(b)` (`actions.ts:221`) already resolves state → artifact using the exact wire
  source #1404 uses (`blockedGate` beats `protocolPhase`, never guessed strings): `open-spec` /
  `open-plan` for canvas phases, `view-diff` for diff phases, `undefined` when unknown. A thin
  `reviewMode()` derived from it keys the dials — **no duplicated resolver** (issue: "reuse that
  resolver family").
- `store.client.sendCanvasCommand(command, {workspace, file?}, {count?})` (`tower-client.ts:986`)
  never rejects and returns a `CanvasCommandClientResult` whose failure `code` is a closed union
  `no-canvas | invalid-request | unreachable`. `count` is valid only on the eight traversal verbs
  (`heading-*`, `block-*`, `comment-*`, `column-*`).
- Canvas views register (`canvas-view-registry.ts`) under the **host window's** workspace + the
  absolute file path. The reviewer opens artifacts in the main window, so they register under the
  selected workspace — matching the deck's `store.selectedWorkspacePath()`.

## Proposed Change

Make the two review dials phase-aware by generalizing `DiffNav` into a `ReviewNav` that carries
**two gesture specs** — a diff spec (today's behavior, unchanged) and a canvas spec — and dispatches
on `reviewMode(selectedBuilder)` at both render time and gesture time. All new behavior is in
`apps/streamdeck/src/actions.ts` and its test file. No manifest, layout, sdk, Tower, or vscode
change.

### 1. `reviewMode()` — the mode resolver (reuse #1404's family)

```ts
type ReviewMode = 'diff' | 'canvas' | 'none';

/** Which artifact form the selected builder's phase implies. Derived from the
 *  shared phase/gate resolver so the wire source stays single (blockedGate beats
 *  protocolPhase; never guessed). */
export function reviewMode(b: OverviewBuilder | undefined): ReviewMode {
  if (!b) return 'none';
  const verb = phaseArtifactVerb(b);
  if (verb === 'open-spec' || verb === 'open-plan') return 'canvas';
  if (verb === 'view-diff') return 'diff';
  return 'none'; // unknown gate / no live status
}
```

### 2. `ReviewNav` — the phase-aware dial base (replaces `DiffNav`)

Each dial declares a `diff` spec (unchanged verbs) and a `canvas` spec:

```ts
interface DiffSpec  { label: string; next: string; prev: string; first: string; forward: string; }
interface CanvasSpec {
  label: string;            // legibility: names the semantic in canvas mode
  next: TraversalCommand;   // rotate + tick
  prev: TraversalCommand;
  jump: CanvasCommand;      // tap
  // press is always 'composer-open' (feedback at the focused position) — shared, not per-dial
}
```

- **Coarse dial (`DiffFileNav`)** — diff: `Files` (`diff-next/prev/first-file`, `forward-file`);
  canvas: `Headings` (`heading-next`/`heading-prev`, tap → `doc-start`).
- **Fine dial (`DiffHunkNav`)** — diff: `Changes` (`diff-next/prev/first-hunk`, `forward-hunk`);
  canvas: `Blocks` (`block-next`/`block-prev`, tap → `doc-start`).

Handlers dispatch on `reviewMode(this.store.selectedBuilder())`:

- **`onDialRotate`** — diff: today's single `sendCommand(next|prev)` per event (unchanged). canvas:
  **one** `sendCanvasCommand(dir>=0 ? spec.next : spec.prev, {workspace}, {count: Math.abs(ticks)})`
  per rotate event — count = ticks, never a burst (architect directive). Render the returned
  verdict (below).
- **`onDialDown`** (press) — diff: `sendCommand(spec.forward)` (unchanged). canvas:
  `sendCanvasCommand('composer-open', {workspace})` (no count).
- **`onTouchTap`** (tap) — diff: `sendCommand(spec.first)` (unchanged). canvas:
  `sendCanvasCommand(spec.jump, {workspace})` (no count).
- `none` mode or missing workspace → no-op (dials have no `showAlert`; the render line already reads
  "No builder").

Guard: `sendCanvasCommand` requires `workspace: string`; if `selectedWorkspacePath()` is undefined,
skip the canvas call.

### 3. Legibility (hard requirement) — the touchstrip always names the current semantic

`renderTo` computes `mode = reviewMode(b)` and picks the label: canvas → `Headings` / `Blocks`,
diff → `Files` / `Changes`. Line 2 stays the builder-under-review (id + issue title), bar = progress
— identical framing to today, only the title switches. Because the dial already re-renders on every
`store.onChange` (SSE overview tick) and reads `selectedBuilder()`, a phase change or a selection
change (e.g. #1404's press moving the shared cursor) re-titles the dial automatically. A gesture can
never be a surprise: the strip names what rotate/press/tap will do before you touch it.

### 4. Per-code canvas feedback on the touchstrip

Canvas gestures return a real verdict (diff-mode `sendCommand` is fire-and-forget and has no
meaningful error, unchanged). On `!res.ok`, set a transient status line the next `renderTo` prefers,
cleared on the next success/overview tick:

- `no-canvas` → `Open artifact` (req 3: the artifact isn't open — press the builder's key to open it).
- `unreachable` → `Tower offline`.
- `invalid-request` → `Error` (defensive; we only ever send valid commands + counts).

Implemented as a per-instance `status?: string` on the dial; `renderTo` renders it as the `value`
line for one cycle when set. Keeps the "always legible" invariant even on failure.

### 5. Targeting: workspace-MRU (decided)

**Decided (2026-08-12, issue comment): the deck uses workspace-MRU targeting — `sendCanvasCommand`
with `file` omitted.** The decision was co-signed by the streamdeck architect (this lane) and main as
the codev-types wire-contract stakeholder, after verifying `OverviewBuilder` carries `worktreePath`
only. Requirement 3's file-qualified preference is superseded; MRU (its recorded fallback) is the v1
behavior. This section records the settled model, not a tradeoff.

**The model:** the selected builder's phase picks the dial **mode** (diff vs canvas); the dials then
drive the **MRU canvas — the artifact you are looking at**. These converge in the real workflow:
#1404's press opens and focuses the selected builder's artifact (`open-spec`/`open-plan`), making it
the MRU view, so "drive the MRU" *is* "drive the selected builder's artifact." Concretely, every
canvas gesture targets `{ workspace: selectedWorkspacePath() }` with no `file`.

**Upgrade path (additive, preserved, not a v1 alternative):** file-qualified targeting stays
available as a future enhancement — an additive `OverviewBuilder.specPath` / `.planPath` field
(Tower-computed, specced with main when pursued) plus passing `file` on the deck's `sendCanvasCommand`
call. That is a one-line deck change with no redesign; it is out of this issue's scope because the
wire field is.

### 6. Deferred (spec-time calls resolved here)

- **Reading-mode toggle (req 4): deferred.** The two dials' rotate/press/tap all carry review
  semantics in both modes — no spare gesture. This codebase deliberately avoids press-duration
  heuristics (see the `ZoomNav` comment on touch-in / press-out being two distinct reliable
  gestures). #1410's Row 2 is the natural home. Deferring keeps v1 focused on the core phase-switch
  that needs hardware verification.
- **Column paging (req 5): deferred with it.** Column paging (`column-forward`/`column-back`) only
  applies inside horizontal reading mode, which is unreachable from the deck until the toggle has a
  home. Candidate mapping recorded for the follow-up: coarse dial drives columns while reading mode
  is on.
- **Deck-driven composer submit/cancel (req 6): no** (the stated default). Press = `composer-open`
  only; typing, submit, and cancel stay on the keyboard.

## Files to Change

- `apps/streamdeck/src/actions.ts`
  - Add `reviewMode(b)` (exported, near `phaseArtifactVerb`).
  - Replace `DiffNav` (`:476-519`) with `ReviewNav`: two gesture specs (diff + canvas), mode
    dispatch in `onDialRotate` / `onDialDown` / `onTouchTap`, legible per-mode `renderTo`, and the
    transient per-code `status` line.
  - Update `DiffFileNav` (`:521-526`) and `DiffHunkNav` (`:528-533`) to declare their canvas specs
    (`Headings` / `Blocks`) alongside the existing diff specs. **Same manifest UUIDs, same physical
    dials** — no manifest edit.
  - Import `CanvasCommand` / `TraversalCommand` types from `@cluesmith/codev-sdk/controller` (or
    `@cluesmith/codev-types` as the existing controller re-export allows — match the store's import
    style).
- `apps/streamdeck/src/__tests__/actions.test.ts`
  - Extend the DiffNav tests: rotate/press/tap in **diff mode** still fire the same verbs (regression
    lock). New: rotate/press/tap in **canvas mode** call `sendCanvasCommand` with the right command,
    `count: |ticks|` on rotate, and no count on press/tap.
  - `reviewMode()` table tests mirroring the `phaseArtifactVerb` table (spec/plan → canvas,
    implement/review/dev-approval/pr → diff, unknown/no-builder → none).
  - Legibility: `renderTo` sets `Headings`/`Blocks` when the selected builder is in a canvas phase,
    `Files`/`Changes` in a diff phase.
  - Per-code feedback: a `no-canvas` / `unreachable` verdict sets the status line.
- No changes to `plugin.ts` (the two dials register unchanged), the manifest, the sdk, Tower, or
  vscode.

## Risks & Alternatives Considered

- **Risk: MRU drives the wrong canvas** if the reviewer opens an unrelated canvas after selecting a
  builder. This is accepted and by design: the dials drive the canvas you are looking at. The
  press-builder-key-then-dial workflow (press opens the artifact → MRU) is the intended path, and
  the `no-canvas` feedback covers "nothing open." The additive file-qualified upgrade (§5) remains
  available if a future need arises.
- **Risk: mode flips mid-gesture** as a phase transitions between a rotate and a press. Low blast
  radius — each gesture reads `reviewMode` freshly and fires one self-contained command; a stale
  read at worst sends one command to the other channel, which the receiver handles (or answers
  `no-canvas`). No state is corrupted.
- **Alternative: separate new canvas dial actions** (new manifest UUIDs on reserved keys). Rejected
  — that is the superseded reserved-headroom layout the issue explicitly replaces; it would reopen
  the eight-key conflict on #1410 and add layout the issue says is no longer needed.
- **Alternative: burst N single-tick canvas commands per rotate.** Rejected per architect directive
  — one `sendCanvasCommand` with `count = ticks` per rotate event.

## Test Plan

**Unit (vitest, `apps/streamdeck`):**
- `reviewMode()` table: spec-approval/plan-approval/specify/plan → `canvas`;
  dev-approval/pr/implement/review/verify → `diff`; unknown gate / unknown phase / no builder →
  `none` (mirrors the `phaseArtifactVerb` table).
- Diff-mode regression: rotate/press/tap on both dials fire the existing `sendCommand` verbs
  (`diff-next-file`, `forward-file`, `diff-first-file`, and the hunk equivalents) — unchanged.
- Canvas-mode: with the selected builder in `plan`, coarse-dial rotate(+3) →
  `sendCanvasCommand('heading-next', {workspace}, {count: 3})`, rotate(-1) → `heading-prev` count 1;
  press → `composer-open`; tap → `doc-start`. Fine dial → `block-next`/`block-prev`.
- Legibility: `renderTo` titles are `Headings`/`Blocks` for a canvas-phase builder, `Files`/`Changes`
  for a diff-phase builder.
- Feedback: a stubbed `sendCanvasCommand` returning `{ok:false, code:'no-canvas'}` sets the
  status line; `unreachable` renders the offline line.

**Manual (hardware — the reason this is PIR; verified at dev-approval on the running worktree):**
- Select a builder in `implement`/`review` (or blocked at dev-approval/pr): dials read
  `Files`/`Changes`, rotate/press/tap drive the diff exactly as today (no regression).
- Select a builder in `specify`/`plan` (or blocked at spec-approval/plan-approval): dials **re-title
  to `Headings`/`Blocks`**; press the builder key (#1404) to open its artifact; rotate steps
  headings/blocks in the canvas, press opens the composer at the focused block, tap jumps to doc
  start.
- With no artifact canvas open, a canvas rotate shows `Open artifact` on the strip (no-canvas).
- With Tower stopped, a canvas gesture shows `Tower offline` (unreachable), not a false success.
- Switch the selected builder between a diff-phase and a canvas-phase builder and confirm both dials
  re-title within one overview tick (legibility: the strip always names the live semantic).
