# Implementation Plan: terminal-state-verified-over-p

## Metadata
- **ID**: plan-2026-05-29-919-terminal-state-split
- **Status**: draft
- **Specification**: `codev/specs/919-terminal-state-verified-over-p.md`
- **Created**: 2026-05-29
- **GitHub Issue**: #919

## Executive Summary

Implements Approach 1 from the spec: split the conflated terminal state into honest `complete` (phases
exhausted) and `verified` (passed `verify-approval` or `--skip`'d with reason), keyed on a **single
shared predicate** so write-time and read-time decisions cannot drift.

The architect's directive frames the phase ordering: **centralize first, then audit every comparison
site**. Phase 1 lands the predicate + the load-time migration (the foundation everything else imports).
Phases 2–4 each depend only on Phase 1 and are independent of one another:
- Phase 2 — porch *write* sites derive the terminal name from the predicate (incl. the user-facing
  "(verified)" string).
- Phase 3 — `porch rollback` clears stale verify metadata so a re-completed project isn't falsely
  re-promoted.
- Phase 4 — the second status reader (overview `parseStatusYaml`) + `derivePrReady` + an audit of every
  remaining terminal-comparison read site, plus the doc sweep.

This is a behavior-preserving refactor for every already-`complete`/already-genuinely-`verified`
project; the only intended behavior *changes* are: (a) non-verify protocols now terminate at `complete`,
and (b) spuriously-named `verified` files are demoted to `complete` on load.

## Success Metrics
- [ ] All spec success criteria met (terminal-write split, four-case migration, dual-reader agreement,
      `derivePrReady`, rollback clearing, honest user-facing strings, read-site terminality).
- [ ] No reduction in overall test coverage; all existing tests pass (updated where they asserted the
      old universal-`verified` behavior).
- [ ] One and only one definition of "genuinely verified" exists in the codebase, imported by both
      readers and the write path.
- [ ] `pnpm --filter @cluesmith/codev build` and `pnpm --filter @cluesmith/codev test` are green;
      `@cluesmith/codev-core` builds (the `builder-helpers.ts` change).

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "predicate_and_migration", "title": "Shared predicate + readState load-time migration"},
    {"id": "terminal_writes", "title": "Gate-derived terminal-state writes + honest CLI strings"},
    {"id": "rollback_clearing", "title": "Rollback clears stale verify metadata"},
    {"id": "overview_and_audit", "title": "Overview parser, derivePrReady, read-site audit + docs"}
  ]
}
```

## Phase Breakdown

### Phase 1: Shared predicate + readState load-time migration
**Dependencies**: None

#### Objectives
- Introduce the single source of truth for "is this project genuinely verified?"
- Replace the universal `complete → verified` migration in `readState` with the four-case
  discrimination, keyed on the predicate.

#### Deliverables
- [ ] A raw-value predicate `isGenuinelyVerified(verifyApprovalApproved: boolean, hasSkipReason: boolean): boolean`
      returning `verifyApprovalApproved || hasSkipReason`, exported from the porch state module so both
      readers and the write path can import it. (Placement: add to
      `packages/codev/src/commands/porch/state.ts` and export; if a dedicated module reads cleaner, a
      small `packages/codev/src/commands/porch/terminal-state.ts` is acceptable — keep it in the porch
      command dir either way.)
- [ ] Rewrite the migration block in `readState` (`state.ts:135-141`):
  - `phase === 'complete'` → leave as `complete` (delete the universal rename).
  - `phase === 'verified'` → keep `verified` iff
    `isGenuinelyVerified(state.gates['verify-approval']?.status === 'approved', !!state.context?.verify_skip_reason)`;
    otherwise set `phase = 'complete'`.
  - Migration stays pure/in-memory (no disk write from `readState`).
- [ ] Update the explanatory comment to describe the #919 semantics (replacing the 653 "applies to ALL
      protocols" comment).
- [ ] Tests.

#### Implementation Details
- Files:
  - `packages/codev/src/commands/porch/state.ts` (predicate + migration rewrite) — and/or new
    `terminal-state.ts` if extracted.
- The predicate must take **raw booleans**, not `ProjectState`, so `overview.ts` (which has a different
  parsed shape) can reuse it in Phase 4.
- Helper to compute inputs from a `ProjectState` may live alongside (e.g.
  `isStateGenuinelyVerified(state)`), but the raw-value primitive is the reusable one.

#### Acceptance Criteria
- [ ] Legacy `complete` loads as `complete` (no rename).
- [ ] `verified` + approved verify-approval gate loads as `verified`.
- [ ] `verified` + `context.verify_skip_reason` loads as `verified`.
- [ ] `verified` with neither loads as `complete`.
- [ ] `readState` performs no disk write.

#### Test Plan
- **Unit Tests** (`packages/codev/src/commands/porch/__tests__/`): the four migration cases above; a
  direct unit test of `isGenuinelyVerified` truth table.
- **Update existing**: `done-verification.test.ts` currently asserts `readState migrates phase complete
  to verified` — rewrite to assert `complete` stays `complete`, plus add the demotion case.
- **Integration**: round-trip a `verified`-no-gate file through `readState` and confirm `complete`.

#### Rollback Strategy
Revert the phase commit; the predicate is additive and the migration change is localized to `readState`.

#### Risks
- **Risk**: A genuine verified project mis-demoted to `complete`.
  - **Mitigation**: Predicate keys on durable gate + skip-reason fields already in status.yaml; all four
    cases unit-tested.

---

### Phase 2: Gate-derived terminal-state writes + honest CLI strings
**Dependencies**: Phase 1 (imports the predicate)

#### Objectives
- Every code path that writes the terminal state chooses `verified` vs `complete` via the predicate,
  not by hard-coding `verified` on phase exhaustion.
- The user-facing completion summary reflects the actual terminal state.

#### Deliverables
- [ ] `advanceProtocolPhase` (`index.ts:519-529`): when `getNextPhase` returns nothing, set the
      terminal phase from the predicate over `state` (so the verify-approval approval path → `verified`;
      generic exhaustion → `complete`). Update the "PROTOCOL COMPLETE" log to match.
- [ ] `next.ts:340-348` and `next.ts:774-777`: replace hard-coded `state.phase = 'verified'` with the
      predicate-derived terminal name.
- [ ] `next.ts:246-282` completion summary: emit the "(verified)" qualifier based on the actual
      terminal phase (`state.phase === 'verified'`) rather than `hasVerifyPhase`. A merged-but-unverified
      SPIR/ASPIR project (terminal `complete`) must still hit the merge-task branch correctly — confirm
      the `hasVerifyPhase` branching for the *merge task* still does the right thing (merge already
      happened for verify-capable protocols only when verify ran; re-examine and adjust so a `complete`
      SPIR/ASPIR does not skip a needed merge task or double-merge). Document the resolved logic in the
      phase commit.
- [ ] `porch verify --skip` (`index.ts:1188`): continue to land `verified`; route it through the same
      terminal-write helper after setting `verify_skip_reason` (so there is one write path), or leave the
      explicit `verified` write but add a comment that the predicate would agree. Prefer routing through
      the helper.
- [ ] Tests.

#### Implementation Details
- Files:
  - `packages/codev/src/commands/porch/index.ts`
  - `packages/codev/src/commands/porch/next.ts`
- Centralize the "compute terminal phase for this state" decision in one small helper (reusing Phase 1's
  predicate) and call it from all three write sites, per the architect's "don't patch piecemeal."
- **Care point**: the `next.ts` summary block currently uses `hasVerifyPhase` to decide between the
  "(verified)" no-task return and the merge-task return. After the split these are two orthogonal
  questions: (1) has the merge happened? (2) is the state genuinely verified? Resolve explicitly —
  likely: merge-task is needed when the project reached terminal without a merge step having run; the
  "(verified)" wording is purely cosmetic and keys on `state.phase`.

#### Acceptance Criteria
- [ ] BUGFIX/AIR/PIR/MAINTAIN/EXPERIMENT run to phase-exhaustion → terminal `complete`.
- [ ] SPIR/ASPIR verify-approval approval → terminal `verified`; `porch verify --skip <reason>` →
      `verified`.
- [ ] Completion summary prints "(verified)" only when `state.phase === 'verified'`.
- [ ] No regression in the merge-task emission for non-verify protocols.

#### Test Plan
- **Unit/Integration** (porch `__tests__`): drive a fake protocol with no verify phase to terminal →
  assert `complete`; drive verify-approval approval → assert `verified`; assert summary string for both;
  assert merge task still emitted where expected.
- **Update existing**: any test asserting terminal `verified` for a non-verify protocol.

#### Rollback Strategy
Revert the phase commit; write sites revert to prior hard-coded behavior (predicate from Phase 1 stays).

#### Risks
- **Risk**: Breaking the shared `advanceProtocolPhase` for one of its two callers.
  - **Mitigation**: Both callers covered by tests (verify-approval path and generic-exhaustion path).
- **Risk**: Mis-resolving the `hasVerifyPhase` vs terminal-name split in the summary block.
  - **Mitigation**: Dedicated tests for merge-task emission + summary wording across protocol shapes.

---

### Phase 3: Rollback clears stale verify metadata
**Dependencies**: Phase 1 (the predicate makes stale metadata hazardous)

#### Objectives
- Ensure `porch rollback` past the `verify` phase / terminal state cannot leave behind a
  verify-approval approval or `verify_skip_reason` that would falsely re-promote a re-completed project.

#### Deliverables
- [ ] In `rollback()` (`index.ts`, around the existing downstream-gate-clearing logic ~`:813`+): when the
      rollback target is at or before the `verify` phase (or rewinding from a terminal state), reset
      `gates['verify-approval']` to `{ status: 'pending' }` (drop `approved_at`/`requested_at`) **and**
      delete `context.verify_skip_reason`.
- [ ] Confirm the existing rollback guard that treats `verified`/`complete` as terminal still functions
      (now both names may appear).
- [ ] Tests.

#### Implementation Details
- Files:
  - `packages/codev/src/commands/porch/index.ts`
- Reuse the protocol's phase list to determine whether `verify` is downstream of the rollback target
  (consistent with how downstream gates are already cleared). Only clear the skip reason when `verify`
  is actually being rewound past, to avoid clobbering it on unrelated rollbacks.

#### Acceptance Criteria
- [ ] A verify-skipped project rolled back to an earlier phase has `verify_skip_reason` cleared and
      `verify-approval` reset to pending.
- [ ] A verify-approved project rolled back past verify has the gate reset to pending.
- [ ] On re-completion without re-verifying, the project lands in `complete` (verified via the Phase 1
      predicate + Phase 2 write path).

#### Test Plan
- **Integration** (porch `__tests__`): skip → rollback → re-run to terminal → assert `complete`;
  approve verify-approval → rollback past verify → assert gate pending and re-terminal is `complete`.
- **Negative**: rollback that does NOT rewind past verify leaves `verify_skip_reason` untouched.

#### Rollback Strategy
Revert the phase commit; rollback reverts to clearing only downstream gates (pre-existing behavior).

#### Risks
- **Risk**: Over-clearing skip reason on rollbacks that don't cross verify.
  - **Mitigation**: Guard on "verify is downstream of target"; negative test.

---

### Phase 4: Overview parser, derivePrReady, read-site audit + docs
**Dependencies**: Phase 1 (imports the predicate)

#### Objectives
- Make the *second* status reader (`overview.ts` `parseStatusYaml`) normalize identically to `readState`.
- Re-key `derivePrReady`'s BUGFIX fallback to the post-split terminal name.
- Audit (and fix if needed) every remaining terminal-comparison read site so both `complete` and
  `verified` are treated as terminal.
- Sweep docs that assert a non-verify protocol ends in `verified`.

#### Deliverables
- [ ] `parseStatusYaml` (`overview.ts`): detect presence of `context.verify_skip_reason` (boolean; the
      line parser only needs presence, not full deserialization) and the `verify-approval` gate status
      it already parses; apply the same demotion as `readState` using the shared predicate — so a parsed
      legacy spurious-`verified` file becomes `complete` in the parsed shape.
- [ ] `derivePrReady` (`overview.ts:486-494`): change the BUGFIX fallback to
      `parsed.protocol === 'bugfix' && parsed.phase === 'complete'` (legacy BUGFIX files are now parsed
      as `complete`); genuinely-`verified` SPIR/ASPIR remain excluded (fail the `bugfix` guard).
      Preserve the `pr_ready_for_human`-authoritative precedence.
- [ ] Audit and confirm these treat both terminal names correctly (fix only if a gap is found):
  - `overview.ts:373` (SPIR progress) and `:386` (`calculateEvenProgress`) → 100% for both.
  - `index.ts:200-201` status glyph; `next.ts:249` "already done" short-circuit.
  - `agent-farm/commands/workspace-recover.ts:19` `TERMINAL_PHASES` set.
  - `agent-farm/commands/status.ts` display color.
  - `core/src/builder-helpers.ts:32` idle-waiting check.
- [ ] Docs sweep: update any CLI/protocol/resource docs stating a non-verify protocol ends in
      `verified`. (arch.md / lessons-learned.md updates are handled in the Review phase via the
      `update-arch-docs` skill, not here.)
- [ ] Tests.

#### Implementation Details
- Files:
  - `packages/codev/src/agent-farm/servers/overview.ts` (parser + `derivePrReady`)
  - Read-site files only if the audit finds a site that does NOT already accept both names.
- Reuse Phase 1's `isGenuinelyVerified` raw-value predicate in the parser (do not duplicate the rule).

#### Acceptance Criteria
- [ ] Both readers yield the same terminal name for each of the four on-disk cases.
- [ ] `derivePrReady` still returns true for the #872 legacy BUGFIX case (now `complete`) and false for
      genuinely-`verified` SPIR/ASPIR.
- [ ] Every audited read site treats `complete` and `verified` as terminal.
- [ ] No doc claims a non-verify protocol ends in `verified`.

#### Test Plan
- **Unit Tests** (`agent-farm/__tests__/overview.test.ts`): parser demotion for the four cases;
  `derivePrReady` updated cases (BUGFIX `complete` → true; SPIR `verified` → false; explicit
  `pr_ready_for_human` precedence).
- **Update existing**: `overview.test.ts` cases that asserted BUGFIX `phase=verified` fallback;
  `workspace-recover.test.ts` terminal-phase cases (add `complete`).
- **Cross-reader test**: same fixture file through `readState` and `parseStatusYaml` → identical
  terminal name (spec test scenario 11).

#### Rollback Strategy
Revert the phase commit; overview reverts to prior parsing/derivation.

#### Risks
- **Risk**: Parser/`readState` divergence persists if the parser doesn't reuse the predicate.
  - **Mitigation**: Import the shared predicate; cross-reader test asserts agreement.

---

## Dependency Map
```
Phase 1 (predicate + migration)
   ├──→ Phase 2 (terminal writes + CLI strings)
   ├──→ Phase 3 (rollback clearing)
   └──→ Phase 4 (overview parser + derivePrReady + audit + docs)
```
Phases 2, 3, 4 are mutually independent and could land in any order after Phase 1; they will be
committed in numeric order for a clean history.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| A terminal read site missed in the audit re-drives/mis-renders a `complete` project | Medium | High | Phase 4 explicit audit list from the spec blast radius; tests per site |
| Two readers diverge | Medium | Medium | Single imported predicate; cross-reader test |
| Shared `advanceProtocolPhase` broken for one caller | Low | High | Tests for both callers |
| Stale `verify_skip_reason` falsely re-verifies | Low | Medium | Phase 3 clears it on rollback; dedicated test |
| Mis-resolved merge-task vs "(verified)" wording in `next.ts` summary | Medium | Medium | Phase 2 dedicated tests across protocol shapes |

## Validation Checkpoints
1. **After Phase 1**: migration four-case tests green; predicate truth-table test green.
2. **After Phase 2**: terminal-write tests green for verify and non-verify protocols; summary wording.
3. **After Phase 3**: rollback-clearing tests green.
4. **After Phase 4**: dual-reader agreement + `derivePrReady` + audited read sites green; full build/test.

## Documentation Updates Required
- [ ] CLI/protocol/resource docs that assert a non-verify protocol ends in `verified` (Phase 4).
- [ ] `arch.md` / `lessons-learned.md` (Review phase, via `update-arch-docs` skill).
- [ ] Spec/plan final-status frontmatter (Review phase).

## Expert Review
**Date**: 2026-05-29 (to be run by porch after PLAN_DRAFTED)
**Model**: Gemini, Codex, Claude (porch-driven)
**Key Feedback**: (to be incorporated)

**Plan Adjustments**: (to be filled after consultation)

## Approval
- [ ] Technical Lead Review
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-05-29 | Initial plan | Spec approved | builder spir-919 |

## Notes
The architect's two standing directives are encoded structurally: **(1) centralize** — Phase 1 lands the
single predicate and every later write/read site imports it rather than re-expressing the rule;
**(2) audit, don't patch piecemeal** — Phase 4 carries the explicit blast-radius checklist from the
spec's Current State section and verifies each site rather than fixing only the ones that visibly break.

---

## Amendment History

This section tracks all TICK amendments to this plan.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
