# pir-1404 — Stream Deck: merge Fleet Slot into Builder Action

## Plan phase (2026-08-12)

Investigated `apps/streamdeck`. Key findings:
- Fleet Slot and Builder Action share `SlotKey` base; differ only in `defaultVerb` + `renderTo` (`actions.ts:132-152`).
- The phase→verb resolver the issue wants already exists as `zoomInVerb` (`actions.ts:208-217`), tests at `actions.test.ts:319-334`. Owner's issue note: reuse/extract it.
- Only real difference: `zoomInVerb` falls back to `view-diff`; Automatic key must fall back to `open-terminal`. Plan extracts `phaseArtifactVerb(b): string|undefined` (recognised verb or undefined) and lets each caller pick its fallback → preserves `zoomInVerb` exactly.
- State strings come from `OverviewBuilder.protocolPhase` / `blockedGate` (`packages/types/src/api.ts:141-183`), no hardcoded guesses.
- Bundled SD+ profile is a zip; inner manifest (`93B4E89C-…/manifest.json`) has 3 fleet-slot keys (slots 1,1,3) + 1 builder-action. Rev: fleet-slot → builder-action Automatic, keep slots, update cached Name.
- Docs to fix: `README.md`, `marketplace/release-notes.md`. Icons `fleet-slot*.png` in `icons/` and `icons/list/` become unreferenced.

Open question flagged to gate reviewer: requirement 1 says "state colouring" but neither action colours today (title-based v1). Plan matches existing Fleet Slot render and calls colour a separate SVG polish.

Plan written to `codev/plans/1404-stream-deck-merge-fleet-slot-i.md`. Awaiting plan-approval gate.

## Plan revision (2026-08-12) — design discussion with owner

Owner used me as a design sounding board for the broader SD+ interaction model (two-zone: Row 1 selectors + Row 2 action palette; dial queue/send semantics where timing follows a VS Code workspace setting, not a deck guess; per-builder queued-feedback count on the overview wire; attention/Next key). Decision (owner via AskUserQuestion): **keep #1404 narrow, spin the rest into a separate spec/issue.**

One refinement folded into #1404: the merged BuilderAction press now also **selects** the builder (`store.syncToBuilder(b.id)`, existing method) so it acts as the Row 1 fleet selector and the diff dials follow the press. Plan + tests + hardware steps + tooltip updated for this. No `store.ts` change needed.

Broader design captured as a draft GitHub issue for the owner to file (not a spec file — per convention, requirements go in the issue, a future builder authors the spec via protocol).

Filed #1410 at owner's direction. Architect since reviewed it: adopted into the streamdeck lane, relabeled `area/cross-cutting` (deck + vscode + overview wire), sequenced after #1404 (feedback-queue half also waits on #1049 panel semantics). Layout conflict flagged: #1410's all-8-keys claim collides with #1400's reserved canvas-review headroom — reconciliation is a spec-time decision, don't let either issue silently claim the same keys. Single-approve-affordance direction confirmed (Row 2 Approve ships → singleton retires into [Next]). Convention (for the record): spin-off designs route through the architect to file, not self-filed from a builder session.

Architect confirmed the #1404 press-also-selects delta is sound (syncToBuilder no-op-safe, no store change). Plan-approval gate still awaits the human's explicit decision — holding. Focus: #1404 only.

## Implement phase (2026-08-12)

Plan-approval gate approved by the human; porch advanced to implement. Implemented per the plan:
- `actions.ts`: extracted `phaseArtifactVerb(b): string|undefined` (recognised verb or undefined); `zoomInVerb` now wraps it (`?? 'view-diff'`), behaviour unchanged. `SlotKey.onKeyDown` calls `store.syncToBuilder(b.id)` (press selects) + new `resolveVerb` hook. `BuilderAction` default verb → `automatic` (resolves `phaseArtifactVerb(b) ?? 'open-terminal'`), absorbs the two-line live tile render. `FleetSlot` deleted.
- `plugin.ts`: dropped FleetSlot import + registration.
- manifest: removed fleet-slot action, truthful builder-action tooltip. PI: builder-action.html gains Automatic (default, first), relabel "On press"; fleet-slot.html deleted. Unreferenced fleet-slot icons deleted (icons/ + icons/list/).
- Profile `Codev.streamDeckProfile`: 3 fleet-slot keys → builder-action Automatic (slots kept: -, 1, 3; verbs dropped; Name updated). Re-zipped, integrity OK, 0 fleet-slot refs. Needs hardware import verification at dev-approval.
- Docs: README + marketplace/release-notes updated (Fleet Slot folded into Builder Action).
- Tests: new `phaseArtifactVerb` suite + Automatic/explicit/fallback/select tests; `zoomInVerb` suite unchanged. Swapped FleetSlot→BuilderAction in slot-key tests.

Worktree had no linked/built workspace deps (fresh builder worktree): ran `pnpm install`, built codev-types + codev-sdk, then streamdeck. Build ✓, tsc --noEmit ✓, `vitest run` 72/72 ✓. Awaiting dev-approval gate (hardware verification of the profile import + phase-across-states press).

## Dev-approval review with owner (2026-08-12)

Sideload steps confirmed (README "Install & develop"): `streamdeck link` this worktree's sdPlugin (verify via `streamdeck list` → path under .builders/pir-1404), import the revved `Codev.streamDeckProfile` separately.

Two items raised during hardware review:
1. **Repeated firing (OPEN):** owner reports the Automatic press's verb (e.g. open-plan) re-fires every few seconds. Traced statically end-to-end: deck sends exactly one command per tap (all sendCommand in input handlers; onChange only re-renders), Tower relay broadcasts once per POST (stateless, command-relay.ts:105), broadcastNotification writes once (30s heartbeat only, no command replay; reconnection replay is terminal-only #1047), VSCode relay wired once + focus-gated. Code says "once" at every hop → repeat is a runtime reconnect/multi-window/delivery effect, NOT the deck merge. `streamdeck list` shows a single link (double-instance ruled out). Decisive test pending from owner: quit the Stream Deck app — does it keep firing? (yes → Tower/VSCode delivery loop, separate bug; no → deck runtime, add keyDown counter log). My #1404 change didn't introduce it (open-plan default just made a pre-existing loop visible).
2. **Diff branch → first file (SPUN OFF → #1412):** owner wants Automatic's diff branch to open the builder's FIRST file (dial-ready per-file), not view-diff's aggregate vscode.changes editor. Can't be deck-only: diff-first-file ignores the builder-id arg (resolves from editor/lastPosition, diff-nav.ts:118), view-diff is the only id-taking opener. Needs a vscode-side builder-id-scoped open-first-file verb. Routed to architect (per their convention), filed as #1414 (area/cross-cutting), verify-first folded into this dev-approval hardware session.

#1404 merge itself stands: implemented, 72/72, pushed. Holding at dev-approval.
