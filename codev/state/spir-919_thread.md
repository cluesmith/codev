# spir-919 — Terminal state `verified` over-promises

Issue #919. SPIR (strict mode). Worktree `.builders/spir-919`.

## Goal
Spec 653 universally renamed terminal project state `complete → verified`, but only SPIR/ASPIR
actually have a `verify` phase + `verify-approval` gate. So BUGFIX/AIR/MAINTAIN/EXPERIMENT reach a
state *named* `verified` without any verification happening. Split back:
- `complete` = phases exhausted (no verification claim)
- `verified` = passed (or `--skip`'d with reason) the `verify-approval` gate

## Key findings (Specify phase)
Blast radius mapped via Explore. Core sites:
- `porch/state.ts:135-141` — `readState` universal migration `complete → verified` (REMOVE / invert)
- `porch/next.ts:249,258,348,777` — terminal comparisons + `state.phase = 'verified'` writes
- `porch/index.ts:200-201,519-529,775-777,813,1188` — display, `advanceProtocolPhase` terminal write,
  verify-approval auto-advance, rollback check, `porch verify --skip`
- `agent-farm/servers/overview.ts:373-386,486-494` — progress %, `derivePrReady` (BUGFIX `verified` fallback)
- `agent-farm/commands/workspace-recover.ts:19` — `TERMINAL_PHASES = {'verified','complete'}`
- `core/src/builder-helpers.ts:32` — idle-waiting terminal check
- Tests: `porch/__tests__/done-verification.test.ts`, `agent-farm/__tests__/overview.test.ts`,
  `agent-farm/__tests__/workspace-recover.test.ts`

Critical insight: `advanceProtocolPhase` is shared between the verify-approval approval path (genuine
verified) and generic phase-exhaustion (spurious verified). Terminal name must be derived from whether
`gates['verify-approval']` is approved (or `verify_skip_reason` present), not from "no next phase."

Migration on load: `verified` + approved verify-approval (or skip reason) → keep `verified`;
`verified` without it → migrate to `complete`; `complete` → leave as `complete` (drop universal rename).

## Consultation (spec)
- R1: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES (overview parser uses own parseStatusYaml
  not readState → both readers must normalize; stale verify_skip_reason survives rollback).
- R2: Gemini/Claude APPROVE; Codex REQUEST_CHANGES (PIR also lacks verify phase → affected;
  next.ts:258 "(verified)" string keyed on hasVerifyPhase not actual state).
- R3: Codex APPROVE. All three APPROVE. Spec ready for gate.
- Added shared raw-value predicate `isGenuinelyVerified(verifyApprovalApproved, hasSkipReason)`,
  dual-reader normalization, rollback-clears-skip-reason, PIR in affected set, honest user-facing strings.

## Status
- [x] Specify — spec drafted, 3-way consult unanimous APPROVE
- [x] Porch-driven consult (specify iter1): Gemini APPROVE, Claude APPROVE, Codex COMMENT → all approved
- [ ] spec-approval gate REQUESTED — STOPPED, awaiting human `porch approve 919 spec-approval`
- [ ] Plan
- [ ] Implement
- [ ] Review
