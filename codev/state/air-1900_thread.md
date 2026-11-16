# air-1900 — porch skip-phase: drop one plan phase after implement starts

**Protocol**: AIR (strict). Issue #1900. Worktree `.builders/air-1900`.

## Problem
Porch copies the plan's phases into `status.yaml` once, on entering `implement`, and never
re-reads them. An adopter's owner dropped the last plan phase after the earlier ones merged;
porch still listed it as pending, so review was unreachable. `porch rollback <id> implement`
re-extracts, but resets every phase.

## Decision: option 1 only (skip-phase), not the re-sync command
The issue said option 1 covers the reported case and is smaller. Re-sync (option 2) would need
reconciliation rules for reorder/rename. It also has to keep the human gate, because it too
changes an approved plan. Left out.

## Design
- New plan-phase status `skipped`, with `skip_reason` + `skipped_at` stored on the phase itself.
  The reason lives next to the phase it explains, not in the loose `context` map that
  `verify --skip` uses.
- `isPlanPhaseSettled()` (complete | skipped) drives navigation: `getCurrentPlanPhase`,
  `allPlanPhasesComplete`, `advancePlanPhase`.
- **Latent bug fixed along the way:** `advancePlanPhase` marked `phaseIndex + 1` in_progress
  blindly. With skip in the mix, that would resurrect a skipped middle phase. It now steps to
  the next *unsettled* phase after the current one.
- `porch skip-phase <id> <plan-phase> --reason "..." --a-human-explicitly-approved-this`:
  refuses without the flag (throws, writes nothing), without a reason, outside a
  per_plan_phase phase, on unknown/complete/already-skipped phases. Skipping the current
  phase resets iteration/build_complete (that in-flight cycle belonged to the dropped phase).
  Skipping the last unsettled phase moves to `review`, the same target as the normal
  all-phases-complete advance (see the surprise below for why not `getNextPhase`).
- No context-refresh boundary fires on a skip. It is a manual command, not a `porch next`
  transition, and a missed refresh costs context only (Spec 1470's asymmetric-cost rule).
- Tower overview progress counts skipped as settled.
- Skill docs updated in all four copies (`.claude`/`.codex` × instance/skeleton).

## Surprise: the unit tests passed, the real CLI run didn't
The first CLI run against a throwaway SPIR project left `phase: implement` after skipping the
last phase. `normalizePhase` maps a per_plan_phase phase's `transition.on_complete` (implement
itself) to `next` and drops `on_all_phases_complete`. So `getNextPhase('implement')` loops
back to implement, which is why `handleVerifyApproved` hardcodes `'review'`. My hand-written
fixture had `next: 'review'` and hid it. Fix: target `'review'` like handleVerifyApproved
(comment says change them together). The test now copies the real
`codev-skeleton/protocols/spir/protocol.json` so the fixture can't drift.

End to end, against the built `bin/porch.js` with a bare remote: skip → `implement → review`;
`porch next` emits review tasks; `porch status` shows `⊘ phase_3: UI (skipped: <reason>)`.
