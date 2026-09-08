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

## Implementation (implement phase, plan-approval passed)
Commits on builder/pir-1410:
- Overview wire: OverviewData.queuedFeedback (Record<builderId,count>, map not scalar) + feedbackMode ('forward'|'queue'). packages/types/src/api.ts.
- Tower overview: countQueuedFeedback (reads each builder's .codev/pending-comments.json) + readFeedbackMode (reads <root>/.vscode/settings.json codev.diffCodelensMode, JSONC-tolerant, default 'forward'). packages/codev/.../overview.ts; tower-routes.ts fallback updated.
- VSCode relay: feedback-file/hunk/selection + send-queue verbs (command-relay.ts). New review-queue/feedback.ts mode-router: forward mode → codev.forwardToBuilder (immediate); comment mode → ReviewQueueStore.add (single source of truth). submitReview now accepts builder-id arg (deck Send Fb passes selectedId; status bar still resolves).
- Canvas back-sync (§F, E2=b): preview-provider fires builder-active on canvas focus (onDidChangeViewState active), builder resolved by worktreePath-prefix via new pure canvas-owner.ts. Reuses existing builder-active event/hook (no new hook).
- Deck: store readers (feedbackMode/queuedFeedback/windowedBuilder + ROW1_WINDOW_SIZE=4). face.ts: selected-slot accent ring, approveFaceSvg, sendFbFaceSvg, 'comment' glyph, gatesFaceSvg label param. actions.ts: slotBuilder→windowedBuilder (4-wide page window), selected highlight, dial press forward-*→feedback-*, ScrollNav→feedback-selection, touchstrip 'Files · send/queue', ApproveGate repurposed selected-scoped, new SendQueueAction + NextAttentionAction. plugin.ts registers them. manifest.json: +send-queue +next-attention actions (reused icons; dedicated icons = polish follow-up).
- README: two-zone layout, mode-neutral feedback, coherence model, builder-active activity-hook prerequisite (E1) with config example.
- Tests: streamdeck 126 pass (windowing, SendFb, NextAttn, faces, mode label, dial verbs); vscode 822 pass (feedback router, relay verbs, canvas-owner); codev overview (countQueuedFeedback/readFeedbackMode).

## Dev-approval gate revisions
- 2026-08-13: Root cause of "deck buttons/dials not showing after relink": the plugin bin/plugin.js was never built in this worktree (root `pnpm build` intentionally skips apps/streamdeck + apps/vscode — they're not npm-published; CI builds them in separate jobs, test.yml:41 comments this). Fix: `pnpm --filter @cluesmith/codev-streamdeck build`. Not a bug (by design) but a footgun; flagged to Amr as a possible build:all/docs follow-up (cross-cutting, out of #1410 scope).
- 2026-08-13: Amr — Row 2 key 4 should be per-builder (Approve/Dev/SendFb all are; Next/Attention was fleet-level, odd one out). Replaced NextAttentionAction with OpenTerminalAction (VerbKey, open-terminal [selectedId], like DevServerAction). Fleet jump-to-next + gate-count DROPPED (covered by Row 1 window gate-faces + Zoom dial N⚠ count). Removed dead gatesFaceSvg + store.topGateBuilderId. manifest: next-attention→open-terminal. Deck 122 tests pass, check-types clean, plugin builds+validates. Plan updated with revision note. req-6 outcome unchanged (single selected-scoped approve). Still at dev-approval gate.

## Merge: main (bugfix-1437 DevServer face) — 2026-08-13
- Merged origin/main (commit 231a6fcb8). Conflicts in face.ts, actions.ts, face.test.ts from a separate builder (bugfix-1437) that: added `play` glyph + `labelFaceSvg(icon,label,color)` helper (icon + centered label, "for keys not builder-state-coded e.g. Run Dev"), gave DevServerAction a composite face (`labelFaceSvg('play','Dev',green)`), and made key-press success SILENT (ack only alerts on failure; no showOk).
- Resolution: unioned GlyphKey + GLYPHS (mine: comment, terminal; theirs: play). Kept my deletion of `gatesFaceSvg` (dead after ApproveGate repurpose + NextAttention removal) — dropped their gatesFaceSvg test too. Merged imports (added labelFaceSvg, dropped gatesFaceSvg). Kept their DevServer face + silent-ack (my actions use ack() so inherit silent success; no test asserted showOk-on-success).
- DRY cleanup: refactored my 3 inert face branches (approve/sendFb/terminal "icon + centered label") to call their `labelFaceSvg` helper instead of hand-rolling — consistency with the new shared helper. Row 2 now: Approve (approveFaceSvg), Dev (labelFaceSvg play), Send Fb (sendFbFaceSvg), Open Terminal (terminalFaceSvg) — all composite faces, all consistent.
- Deck 128 tests pass, check-types clean, plugin builds + validates.

## Review phase — 3-way consultation (2026-08-13)
- PR #1439 opened. Consultation: gemini=APPROVE, claude=APPROVE, codex=REQUEST_CHANGES (2 pts).
- Codex pt2 (refresh trigger) — VALID, FIXED (bf693620e): verified queuedFeedback/feedbackMode had NO deterministic push (porch pushes status.yaml via overview-changed broadcast, but ReviewQueueStore writes never notify Tower + Tower doesn't watch queue files/.vscode/settings.json; deck refresh-on-command-echo races the write). Fix: apps/vscode/src/review-queue/overview-nudge.ts — onDidChangeQueue OR diffCodelensMode config change → TowerClient.refreshOverview() (POST /api/overview/refresh → invalidate cache + broadcast overview-changed, fires AFTER write). Regression test overview-nudge.test.ts (3 cases). vscode 825 pass.
- Codex pt1 (blank profile) — REBUTTED: deliberate, already accepted by human at dev-approval (keys placed on hardware, workflow verified); profile always shipped Actions:null (#1404 same); no safe sdProfile Actions schema. Rebuttal in codev/projects/1410-*/1410-review-iter1-rebuttals.md.
- Notified architect (led with REQUEST_CHANGES + disposition). At pr gate — waiting for human merge. PIR single-pass: no auto re-review; human pr-gate review is the backstop.

## Scope note (intentional deferral)
- SD+ PROFILE (Codev.streamDeckProfile zip) left BLANK as it has always shipped (Actions:null; #1404 shipped Row 1 the same way). No known-good sdProfile Actions schema in history to safely pre-populate; a malformed binary profile would fail import at the hardware session. Two-zone key layout is documented in README; reviewer places the 8 keys at the dev-approval hardware session. Flag to architect.

## Status
- 2026-08-13: Plan phase, first run. Investigated codebase. Wrote plan (commit 4c0f07dda), plan-approval gate pending.
- 2026-08-13: Amr resolved req-6 — RETIRE the generic ApproveGate singleton; Row 2 [Approve] = single selected-scoped affordance, jump-to-next + gate-count badge fold into Row 2 [Next/attention].
- 2026-08-13: Amr asked how >4 builders are navigated + how deck syncs a workspace. Found a real gap: #1404's Row 1 keys are FIXED absolute slots (slotBuilder → builders()[slot-1]), so only builders 1-4 show. Added Row 1 windowing to plan: 4-wide window derived from cursor (page = floor(cursor.builder/4)), Select dial (ZoomNav rotate) scrolls it, selected-slot highlight. Workspace sync is already built (bidirectional): VSCode deep-link → store.syncToWorkspace/Builder; deck Select-dial zoom-in → focus-workspace verb → vscode.openFolder brings window to front. Plan revised (commit 8332eac6c), still at plan-approval gate.
- 2026-08-13: Amr (ultrathink) asked how the review dials integrate with the selected builder when they attach to the FOCUS window. Traced it: dials are FOCUS-anchored (diff nav resolveDiffContext via getDiffInjectEntry, diff-nav.ts; canvas via workspace MRU), dial MODE is selection-anchored (reviewMode(selectedBuilder)). Coherence invariant: selectedBuilder == focused-artifact-owner, held by (1) Row 1 press = select+open one gesture (actions.ts:131-133, direct syncToBuilder — works for canvas too), (2) diff focus fires builder-active (extension.ts:679-685) → deep-link → deck syncToBuilder (DIFF ONLY). Added "Layer integration" section + coherence tests to plan. TWO EDGES: E1 = focus→deck back-sync needs the personal-config builder-active→streamdeck:// activity hook configured (prerequisite for hardware session, README-documented). E2 = OWNER DECISION: canvas focus does NOT back-sync (announceActiveBuilderFromEditor gates on getDiffInjectEntry) — accept+document (rec) vs add symmetric canvas-active event (widens scope into #1401/#1425). Plan assumes accept unless told. Committed, still at plan-approval gate.
- 2026-08-13: Amr chose E2=(b) — add the symmetric canvas back-sync. Verified feasible + designed §F: viewPlanFile opens the artifact INSIDE the builder worktree (view-artifact.ts:83,128 → <worktreePath>/codev/<subdir>/<id>-<slug>.md); canvas panel already fires panel.onDidChangeViewState(active) (canvas-view-registry.ts:141); MarkdownPreviewProvider already holds overviewCache. So on canvas-active, resolve builder by worktreePath-PREFIX match against overview builders, and fire the EXISTING builder-active event (NOT a new canvas-active) → rides the same personal-config hook (no new config), reaches deck via same deep-link → syncToBuilder, deduped by fireActivity lastFiredKey, no loop. §F routes to main (vscode). Added §F + Files + unit/manual tests. Committed, still at plan-approval gate.
