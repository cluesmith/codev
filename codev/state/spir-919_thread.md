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
- [x] spec-approval gate APPROVED by human (2026-05-29). Architect: centralize behind one predicate,
      audit every comparison site, don't patch piecemeal.
- [x] Plan — 4 phases. Porch consult: Gemini/Claude APPROVE, Codex REQUEST_CHANGES (Phase 3 not
      independent of Phase 2; Phase 4 read-site test ownership underspecified). Both accepted & fixed;
      rebuttal written. Plan: (1) predicate+migration, (2) terminal writes+CLI strings, (3) rollback
      clearing [now deps on P2], (4) overview parser+derivePrReady+read-site audit+docs.
- [~] plan-approval gate was requested, but architect found branch 259 commits STALE before approving.
- [x] REBASED onto origin/main (merge-base now #923), clean (only my 5 doc commits, no code).
- [x] Re-verified blast radius against rebased base. New/changed sites:
      - `done()` #903 idempotency early-exit `index.ts:368-373` (keyed on 'verified') → must accept
        'complete' too. Added to Phase 2.
      - `derivePrReady` now at `overview.ts:493-501`, fallback at `:499`. #902's recentlyMergedIssueIds
        is SEPARATE (getOverview ~1011-1023, in OverviewData) — my change layers on top, doesn't touch it.
      - corrected line nums: advanceProtocolPhase 530-532, verify --skip 1196, rollback guard 821,
        gate-clear loop 833-838, progress 380-393, status.ts 241-243, parseStatusYaml 201-323.
      - rollback: gate loop already resets verify-approval gate; the gap is clearing context.verify_skip_reason.
      - new tests in scope: pr-ready-872.test.ts, done-verification.test.ts #903 idempotency companion.
- [x] plan corrected & committed (rebase pass).
- [x] ARCHITECT SPEC AMENDMENT (req 8): second instance #1895 reframed root cause → terminal write must
      RE-DERIVE pr_ready_for_human (don't trust rollback's stale false). Added spec req 8, out-of-scope
      (no write-time merge detection), success criterion, test scenario 13, risk rows. Phase 2 deliverable
      + #1895 regression test added. Rule: pr-gate-approved→false; else PR-created→true; #902 suppresses
      post-merge.
- [x] Re-consult plan: iter2 Gemini/Claude APPROVE, Codex REQUEST_CHANGES (status.ts test-backed;
      Phase 2 verify-capable-complete criterion) → fixed. iter3 Codex COMMENT (exec-summary contradiction;
      builder-helpers test home) → fixed (builder-helpers ALREADY covered in vscode builders.test.ts).
- [x] plan-approval RE-APPROVED by human; force-with-lease pushed rebased+amended history to origin (in sync).
- [~] IMPLEMENT Phase 1 (predicate_and_migration) DONE:
      - state.ts: added isGenuinelyVerified(verifyApprovalApproved, hasSkipReason) + isStateGenuinelyVerified(state).
      - readState: dropped universal complete→verified; now demotes spurious verified→complete (keeps
        genuine verified + legacy complete). Pure/in-memory.
      - Tests: state.test.ts predicate truth-table + done-verification.test.ts #919 normalization suite
        (4 cases + purity); updated #903 fixtures to be genuinely-verified; pr-ready-872 BUGFIX terminal
        now expects 'complete' (was 'verified').
      - Worktree had NO node_modules — ran pnpm install; built core + codev (tsc) + copy-skeleton.
        Full non-e2e suite GREEN: 151 files, 3205 passed, 13 skipped, 0 fail. (All earlier failures were
        build-order/skeleton-missing, not the change.)
- [ ] porch done Phase 1 → consult → next phase.
- [ ] Plan
- [ ] Implement
- [ ] Review
