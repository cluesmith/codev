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
