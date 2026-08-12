# pir-1400 — Stream Deck: phase-aware review dials

## Plan phase (2026-08-12)

Issue #1400. Deck half of phase-aware review; bridge (#1401 `sendCanvasCommand`) already merged.

### What I found investigating

- The two diff dials are `DiffFileNav` ("Files") + `DiffHunkNav` ("Changes") in
  `apps/streamdeck/src/actions.ts`, both `Encoder` controllers in the manifest. Reusing them =
  zero layout change (honors "ships on existing dial layout").
- `phaseArtifactVerb(b)` (actions.ts:221, shipped by #1404) is the exact resolver to key mode off:
  `blockedGate` beats `protocolPhase`, returns `open-spec`/`open-plan` (→ canvas mode) / `view-diff`
  (→ diff mode) / undefined. I'll derive a thin `reviewMode()` from it — no duplication.
- `sendCanvasCommand(command, {workspace, file?}, {count?})` lives on `TowerClient` (tower-client.ts:986),
  reachable via `store.client`. Never rejects; returns `CanvasCommandClientResult` with a closed
  error union (`no-canvas` | `invalid-request` | `unreachable`). `count` valid only on the 8 traversal verbs.
- **Targeting DECIDED (2026-08-12, architect + main):** workspace-MRU for v1 (omit `file`).
  `OverviewBuilder` carries `worktreePath` only — file-qualified genuinely needs an additive
  Tower-computed wire field, out of scope. Model: phase picks the dial MODE; dials drive the MRU
  canvas (what you see); #1404's press converges MRU onto the selected builder's artifact.
  File-qualified recorded as the additive upgrade path (future `OverviewBuilder.specPath`/`.planPath`
  through main's sphere, one-line deck change) — NOT a v1 alternative. Folded into plan §5.
- Canvas view registration (`canvas-view-registry.ts`) keys on host workspace + abs file path; the
  reviewer opens artifacts in their main window, registered under the selected workspace → matches
  the deck's `selectedWorkspacePath()`. Convergence holds.

### Spec-time decisions I'm resolving in the plan (issue body is the spec)

- Tap in canvas mode (architect plan-review revision): **coarse (Headings) → doc-start** (reset),
  **fine (Blocks) → comment-next** (walk commented blocks = "next place needing attention"). Restores
  the headline commented-block navigation; keeps comment-next/prev in the map; no doc-start duplication.
- Reading-mode toggle (req 4) + column paging (req 5): **deferred** — existing dials have no spare
  gesture, press-duration heuristics are avoided in this codebase, #1410 Row 2 is the natural home.
- Deck submit/cancel (req 6): **no** (default) — composer-open only; typing stays on keyboard.

Architect (streamdeck) confirmed these pointers via afx during plan phase. Plan drafted, awaiting
plan-approval gate.

## Implement phase (2026-08-12) — plan-approval APPROVED

Implemented in `apps/streamdeck/src/actions.ts` (+ tests). No sdk/Tower/vscode/manifest change.

- `reviewMode(b)` derives `'diff' | 'canvas' | 'none'` from `phaseArtifactVerb` (single wire source).
- `DiffNav` → `ReviewNav`: carries a `DiffSpec` (unchanged verbs) + `CanvasSpec`; dispatches on
  `reviewMode(selectedBuilder)` in rotate/press/tap and in `renderTo` (legibility). Coarse dial
  `Files`↔`Headings`, fine `Changes`↔`Blocks`.
- Canvas rotate = one `sendCanvasCommand` with `count=|ticks|`; press = `composer-open`; tap =
  `doc-start` (coarse) / `comment-next` (fine). MRU targeting (`{workspace}`, no `file`).
- Per-code touchstrip feedback: `no-canvas`→"Open artifact", `unreachable`→"Tower offline",
  else "Error"; transient `status` line cleared on the next overview tick.
- **Import note:** typed canvas spec fields as `CanvasCommand` (re-exported from
  `@cluesmith/codev-sdk/controller`); `TraversalCommand` is NOT re-exported there and the
  import-boundary test forbids importing `@cluesmith/codev-types` directly — so no sdk change,
  honoring the plan. `count` isn't type-restricted to traversal by the sdk signature anyway.
- **Test-fixture gotcha:** default selection (cursor 0 = pir-1) is now a canvas-phase builder;
  existing diff-mode tests re-pointed at `pir-2` (implement) via `syncToBuilder`.

Verified in worktree: `tsc --noEmit` ✓, `npm run build` ✓, `npm test` ✓ (82 tests, ~10 new).
Needed `pnpm --filter @cluesmith/codev-sdk build` first (sdk dist absent in fresh worktree).
Commit 9aa1a29d9. Awaiting dev-approval gate (hardware verification).

**Manifest rename (owner-requested at dev-approval, commit 1abc02025):** the two dial actions'
user-facing `Name`/`Tooltip`/`TriggerDescription` still said "Diff File/Hunk Navigator" (palette
label seen when configuring) though the live dial face already re-titles Headings/Blocks at runtime.
Renamed to "Review: Files / Headings" and "Review: Changes / Blocks" with dual-mode tooltips. UUIDs
(`diff-file-nav`/`diff-hunk-nav`) and controller/layout structure untouched — stable identity, no
layout change, so no code/test impact. `streamdeck validate` ✓.

## Review phase (2026-08-12) — dev-approval APPROVED

Retrospective at `codev/reviews/1400-stream-deck-phase-aware-review.md`. Also swept
`apps/streamdeck/README.md` Actions list for the rename (grep-both-trees lesson). No arch/lessons
tier change — existing hot lessons already governed (single-source resolver reuse; rename sweep);
arch.md's streamdeck entry stays accurate (sendCanvasCommand is on the controller subpath it names).
PR #1419 opened (Fixes #1400), recorded with porch. Running the single 3-way consult via porch done.
