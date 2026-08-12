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
- **Targeting decision (the one open design question):** `OverviewBuilder` carries `worktreePath` but
  NO artifact path. File-qualified targeting would need an additive wire field. Workspace-MRU (omit
  `file`) converges because #1404's press opens the selected builder's artifact → makes it MRU.
  Recommending **MRU for v1** (no wire/bridge change, honors req 7), file-qualified deferred behind a
  future `OverviewBuilder` artifact-path field (one-line deck change when it lands).
- Canvas view registration (`canvas-view-registry.ts`) keys on host workspace + abs file path; the
  reviewer opens artifacts in their main window, registered under the selected workspace → matches
  the deck's `selectedWorkspacePath()`. Convergence holds.

### Spec-time decisions I'm resolving in the plan (issue body is the spec)

- Tap in canvas mode: **doc-start** (analog of diff-first-*; unsurprising). comment-next noted as alt.
- Reading-mode toggle (req 4) + column paging (req 5): **deferred** — existing dials have no spare
  gesture, press-duration heuristics are avoided in this codebase, #1410 Row 2 is the natural home.
- Deck submit/cancel (req 6): **no** (default) — composer-open only; typing stays on keyboard.

Architect (streamdeck) confirmed these pointers via afx during plan phase. Plan drafted, awaiting
plan-approval gate.
