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
- 2026-08-13: Plan phase, first run. Investigated codebase. Writing plan.
