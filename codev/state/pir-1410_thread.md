# pir-1410 — Stream Deck SD+ two-zone builder workflow

## What this is
Issue #1410 (PIR). SD+ becomes a remote control bound by one shared selection:
- Row 1 (4 keys): fleet selectors = #1404 Builder Action keys (already exist).
- Row 2 (4 keys): action palette [Approve gate] [Run Dev] [Send Fb (N)] [Next/attention], always acting on the selected builder.
- Dials collect (press = `feedback-*` mode-neutral verb), Send Fb key commits (`send-queue`).
- Overview wire gains a per-builder queued-count map + a per-workspace feedback mode.

## Architect binding constraints (comment 5272792465, agreed by both architect seats)
1. Overview wire field = per-builder MAP (builderId -> queuedCount), never a scalar. #1049's Attention rollup reuses the same map.
2. `feedback-*` / `send-queue` verbs MUST mutate through `ReviewQueueStore` (single source of truth) — no parallel path.
Process: (a) requirement 6 single-approve-affordance decision → owner (Amr) EARLY, with my recommendation; (b) relay-verb + overview-wire plan sections route to `main` pre-gate, whole plan to streamdeck architect pre-gate; (c) dev-approval is a hardware SD+ session.
Cautions: do NOT touch .builders/pir-1428 (live deck symlink) or sibling worktrees; #1431 (verify-approval in phaseArtifactVerb) is a separate lane — don't fix it here.

## Ground-truth found (files)
- Deck actions: `apps/streamdeck/src/actions.ts` — `BuilderAction` (Row 1, slot-scoped, `syncToBuilder` on press), `DevServerAction` (selected-scoped `run-dev`), `ApproveGate` singleton (top-gate target + count badge), `ReviewNav`/`DiffFileNav`/`DiffHunkNav` (dial press currently `forward-file`/`forward-hunk`), `ScrollNav` (`forward-selection`).
- Deck store: `apps/streamdeck/src/store.ts` — `selectedBuilder()`, `pendingGates()`, `topGateBuilderId()`, `builders()`.
- Deck face: `apps/streamdeck/src/face.ts` (#1428 SVG face model — Row 2 keys build on this).
- Wire types: `packages/types/src/api.ts` — `OverviewBuilder` (has `heldCount?` precedent), `OverviewData`.
- Tower overview build: `packages/codev/src/agent-farm/servers/overview.ts` — `discoverBuilders` reads worktree files; `getOverview` assembles + per-builder `heldCount` (precedent for a per-builder count).
- Feedback mode setting: `codev.diffCodelensMode` = 'forward' | 'comment' (`apps/vscode/src/diff-inject-codelens.ts:getDiffCodelensMode`). 'forward' = immediate inject, 'comment' = queue.
- Command relay allowlist: `apps/vscode/src/command-relay.ts` (VERB_COMMANDS map).
- Queue store: `apps/vscode/src/review-queue/store.ts` (`ReviewQueueStore.add/remove/count`), file `.codev/pending-comments.json` shape `{version:1,builderId,comments:PendingComment[]}` (`review-queue/queue.ts`).
- Submit/flush: `apps/vscode/src/review-queue/submit.ts` (`submitReview` → PTY batch, removes via store).
- Approve: `apps/vscode/src/commands/approve.ts` (`approve-gate [builderId]` → confirmation modal; selected-scoped is just a different id arg).

## Status
- 2026-08-13: Plan phase, first run. Investigated codebase. Wrote plan (commit 4c0f07dda), plan-approval gate pending.
- 2026-08-13: Amr resolved req-6 — RETIRE the generic ApproveGate singleton; Row 2 [Approve] = single selected-scoped affordance, jump-to-next + gate-count badge fold into Row 2 [Next/attention].
- 2026-08-13: Amr asked how >4 builders are navigated + how deck syncs a workspace. Found a real gap: #1404's Row 1 keys are FIXED absolute slots (slotBuilder → builders()[slot-1]), so only builders 1-4 show. Added Row 1 windowing to plan: 4-wide window derived from cursor (page = floor(cursor.builder/4)), Select dial (ZoomNav rotate) scrolls it, selected-slot highlight. Workspace sync is already built (bidirectional): VSCode deep-link → store.syncToWorkspace/Builder; deck Select-dial zoom-in → focus-workspace verb → vscode.openFolder brings window to front. Plan revised (commit 8332eac6c), still at plan-approval gate.
- 2026-08-13: Amr (ultrathink) asked how the review dials integrate with the selected builder when they attach to the FOCUS window. Traced it: dials are FOCUS-anchored (diff nav resolveDiffContext via getDiffInjectEntry, diff-nav.ts; canvas via workspace MRU), dial MODE is selection-anchored (reviewMode(selectedBuilder)). Coherence invariant: selectedBuilder == focused-artifact-owner, held by (1) Row 1 press = select+open one gesture (actions.ts:131-133, direct syncToBuilder — works for canvas too), (2) diff focus fires builder-active (extension.ts:679-685) → deep-link → deck syncToBuilder (DIFF ONLY). Added "Layer integration" section + coherence tests to plan. TWO EDGES: E1 = focus→deck back-sync needs the personal-config builder-active→streamdeck:// activity hook configured (prerequisite for hardware session, README-documented). E2 = OWNER DECISION: canvas focus does NOT back-sync (announceActiveBuilderFromEditor gates on getDiffInjectEntry) — accept+document (rec) vs add symmetric canvas-active event (widens scope into #1401/#1425). Plan assumes accept unless told. Committed, still at plan-approval gate.
