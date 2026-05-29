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

### Base verification (post-rebase, 2026-05-29)
This branch was rebased onto `origin/main` (merge-base now #923) before planning the implementation.
**All line numbers below were re-verified against the rebased tree.** The rebase surfaced two sites that
did not exist on the original (stale) base and are now incorporated:
- **`done()` idempotency early-exit (#903)** at `index.ts:368-373`, keyed on `state.phase === 'verified'`
  — a new terminal-recognition site that must also accept `complete` (else re-running `porch done` on a
  `complete` project would no longer be a silent no-op). Folded into **Phase 2**.
- **`derivePrReady` + #902's `recentlyMergedIssueIds`**: `derivePrReady` (`overview.ts:493-501`) does
  **not** itself reference `recentlyMergedIssueIds`; #902 computes that separately in `getOverview`
  (~`overview.ts:1011-1023`) and returns it in `OverviewData` for frontend suppression. The Phase 4
  one-line fallback change (`verified` → `complete` at `overview.ts:499`) therefore **layers on top of
  #902 and must not touch the `recentlyMergedIssueIds` machinery.** Folded into **Phase 4**.
New test files on the rebased base also in scope: `pr-ready-872.test.ts` (Phase 4) and the `#903`
idempotency test in `done-verification.test.ts` (Phase 2).

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
- **Update existing**: `done-verification.test.ts:463` (`readState migrates phase complete to verified
  (backward compat)`) — rewrite to assert `complete` stays `complete`, plus add the spurious-`verified`
  demotion case and the genuine-`verified` preservation cases.
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

#### Deliverables (line numbers verified against rebased base)
- [ ] `advanceProtocolPhase` (`index.ts:530-532`): when `getNextPhase` returns nothing, set the
      terminal phase from the predicate over `state` (so the verify-approval approval path → `verified`;
      generic exhaustion → `complete`). Update the "PROTOCOL COMPLETE" log to match.
- [ ] `next.ts:348` and `next.ts:777`: replace hard-coded `state.phase = 'verified'` with the
      predicate-derived terminal name.
- [ ] `next.ts:249-282` completion summary: emit the "(verified)" qualifier (line 258) based on the
      actual terminal phase (`state.phase === 'verified'`) rather than `hasVerifyPhase` (line 252). A
      merged-but-unverified SPIR/ASPIR project (terminal `complete`) must still hit the merge-task branch
      correctly — re-examine the `hasVerifyPhase` branching for the *merge task* so a `complete`
      SPIR/ASPIR does not skip a needed merge task or double-merge. Document the resolved logic in the
      phase commit.
- [ ] **NEW (post-rebase) — `done()` idempotency early-exit (`index.ts:368-373`, #903)**: currently
      `if (state.phase === 'verified')` → silent no-op. Change to also recognize `complete` (e.g.
      `if (state.phase === 'verified' || state.phase === 'complete')`) so re-running `porch done` on a
      terminal `complete` project stays a no-op. Update the log wording to not assert "verified" for a
      `complete` project.
- [ ] `porch verify --skip` (`index.ts:1196-1197`): continue to land `verified`; route it through the
      same terminal-write helper after setting `verify_skip_reason` (so there is one write path), or
      leave the explicit `verified` write with a comment that the predicate would agree. Prefer routing
      through the helper.
- [ ] **NEW (architect amendment, spec req. 8) — re-derive `pr_ready_for_human` at terminal write**:
      in the same terminal-write path (`advanceProtocolPhase` `index.ts:530-532`, and the `next.ts:348`/
      `:777` terminal writes), stop trusting the existing `pr_ready_for_human` (a rollback may have set
      it `false` at `index.ts:849`). Re-derive:
      - if the `pr` gate was approved (`state.gates['pr']?.status === 'approved'`) → `false` (human
        acted; matches `index.ts:753`).
      - else, if a PR was created (guard on `state.pr_history?.length` so PR-less terminals aren't
        flagged) → `true` (awaiting-merge case).
      - Do **not** detect merge state; #902's `recentlyMergedIssueIds` (separate, in `getOverview`)
        suppresses once merged.
      Centralize this in the same terminal-write helper that decides `verified` vs `complete`, so one
      function owns the terminal write. Existing `pr_ready_for_human=true` writes at gate-request
      (`index.ts:499`, `next.ts:757`) are unaffected.
- [ ] Status glyph (`index.ts:200-201`) already handles both names — audit only, no change expected.
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
- [ ] **Verify-capable terminal-`complete` case**: a SPIR/ASPIR project that reaches terminal *without*
      verify-approval (merged but not verified) lands in `complete`, the summary does **not** print
      "(verified)", and the merge-task / `hasVerifyPhase` branching still behaves correctly (no skipped
      or double merge) — covered by a test, not just the non-verify protocols.
- [ ] Completion summary prints "(verified)" only when `state.phase === 'verified'`.
- [ ] No regression in the merge-task emission for non-verify protocols.
- [ ] `pr_ready_for_human` re-derived at terminal: stale rollback `false` → `true` for awaiting-merge;
      `pr`-gate-approved → stays `false`; PR-less terminal → not flagged.

#### Test Plan
- **Unit/Integration** (porch `__tests__`): drive a fake protocol with no verify phase to terminal →
  assert `complete`; drive verify-approval approval → assert `verified`; assert summary string for both;
  assert merge task still emitted where expected.
- **`done()` idempotency** (`done-verification.test.ts:416`, the #903 test `is a no-op when state.phase
  is already verified`): add a companion test asserting the same no-op for `state.phase === 'complete'`.
- **pr-ready re-derivation regression (spec req. 8 / #1895)**: in porch `__tests__` (alongside
  `pr-ready-872.test.ts`), reproduce the #1895 shape — a gateless BUGFIX that creates a PR, rolls back
  during CMAP (driving `pr_ready_for_human=false`), then advances to terminal — and assert the terminal
  state ends with `pr_ready_for_human=true` **and** `derivePrReady` surfaces it. Plus the inverse:
  a project whose `pr` gate was approved before terminal keeps `false`; a PR-less terminal stays `false`.
- **Update existing**: `next.test.ts` completion assertions and any test asserting terminal `verified`
  for a non-verify protocol.

#### Rollback Strategy
Revert the phase commit; write sites revert to prior hard-coded behavior (predicate from Phase 1 stays).

#### Risks
- **Risk**: Breaking the shared `advanceProtocolPhase` for one of its two callers.
  - **Mitigation**: Both callers covered by tests (verify-approval path and generic-exhaustion path).
- **Risk**: Mis-resolving the `hasVerifyPhase` vs terminal-name split in the summary block.
  - **Mitigation**: Dedicated tests for merge-task emission + summary wording across protocol shapes.

---

### Phase 3: Rollback clears stale verify metadata
**Dependencies**: Phase 1 (the predicate) **and** Phase 2 (the predicate-derived terminal write)

> Note: Phase 3's metadata-clearing deliverable is testable on its own, but its end-to-end acceptance
> case ("rollback → re-run to terminal → lands in `complete`") only holds once Phase 2's gate-derived
> terminal write is in place (today the terminal write is still hard-coded `verified`). Phase 3
> therefore sequences after Phase 2.

#### Objectives
- Ensure `porch rollback` past the `verify` phase / terminal state cannot leave behind a
  verify-approval approval or `verify_skip_reason` that would falsely re-promote a re-completed project.

#### Deliverables (line numbers verified against rebased base)
- [ ] In `rollback()` (`index.ts`): the existing "Clear gates at or after the target phase" loop
      (~`index.ts:833-838`) **already** resets `gates['verify-approval']` to `{ status: 'pending' }` when
      the `verify` phase index is `>= targetIndex`. The gap is `context.verify_skip_reason`, which is
      **not** cleared. Add: when `verify` is at/after `targetIndex` (i.e. being rewound past), delete
      `state.context.verify_skip_reason`. Implement alongside the gate-clearing loop so the two stay
      together.
- [ ] Confirm the rollback terminal guard (`index.ts:821`, `state.phase === 'verified' || === 'complete'`)
      still functions now that both names can appear as the pre-rollback phase. (Already handles both —
      audit; note `rollback` from a `complete` terminal must compute `targetIndex` correctly since
      `complete`/`verified` are not in `protocol.phases`.)
- [ ] Tests.

#### Implementation Details
- Files:
  - `packages/codev/src/commands/porch/index.ts`
- Determine "is `verify` downstream of target" via `protocol.phases.findIndex(p => p.id === 'verify') >= targetIndex`
  (mirrors the gate-clearing loop). Only clear the skip reason in that case, to avoid clobbering it on
  unrelated rollbacks. Guard for protocols that have no `verify` phase (`findIndex` returns -1 → never
  clear, which is correct since they can't have a skip reason).

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

#### Deliverables (line numbers verified against rebased base)
- [ ] `parseStatusYaml` (`overview.ts:201-323`): currently parses `phase` (`:232`), `pr_ready_for_human`
      (`:241`), and the `gates` block (`:268-293`) but **not** `context`. Add detection of the *presence*
      of `context.verify_skip_reason` (boolean; the line parser needs presence only, not full
      deserialization) and apply the same demotion as `readState` using the shared predicate — so a
      parsed legacy spurious-`verified` file becomes `complete` in the parsed shape.
- [ ] `derivePrReady` (`overview.ts:493-501`): change the BUGFIX fallback at **`:499`** from
      `parsed.phase === 'verified'` to `parsed.phase === 'complete'` (legacy BUGFIX files are now parsed
      as `complete`); genuinely-`verified` SPIR/ASPIR remain excluded (fail the `bugfix` guard). Preserve
      the `pr_ready_for_human`-authoritative precedence (`:494`). **Do NOT touch #902's
      `recentlyMergedIssueIds`** — it is computed in `getOverview` (~`:1011-1023`) and returned in
      `OverviewData`, entirely separate from `derivePrReady`; this change layers on top of it. Update the
      `derivePrReady` doc-comment (`:476-491`) and the `BuilderOverview` comment (`:100`) which still say
      BUGFIX terminal is `verified`.
- [ ] Audit and confirm these treat both terminal names correctly (fix only if a gap is found):
  - `overview.ts:380-382` (`calculateSpirProgress`) and `:393` (`calculateEvenProgress`) → 100% for both
    (already handle both — audit).
  - `index.ts:200-201` status glyph (handled in Phase 2 audit); `next.ts:249` "already done"
    short-circuit (already handles both — audit + test here).
  - `agent-farm/commands/workspace-recover.ts:19` `TERMINAL_PHASES` set + `:109` check (already both).
  - `agent-farm/commands/status.ts:241-243` display color (`getStatusColor`, `:227`) — already handles
    both, but is module-private with no existing test. **Export `getStatusColor`** and add a focused
    unit test asserting both `verified` and `complete` return green (satisfies the spec's "all read
    sites verified by tests" requirement rather than audit-only).
  - `core/src/builder-helpers.ts:32` idle-waiting check (already handles both — audit + test).
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
Explicit test ownership per audited read site (the spec requires *all* read sites verified by tests, not
just the two that change):
- **`overview.ts` parser** (`agent-farm/__tests__/overview.test.ts`): parser demotion for the four
  cases.
- **`derivePrReady`** (`overview.test.ts` **and** `porch/__tests__/pr-ready-872.test.ts`): updated
  cases — BUGFIX `complete` → true; SPIR/ASPIR `verified` → false; explicit `pr_ready_for_human`
  precedence over fallback. `pr-ready-872.test.ts` already asserts the BUGFIX terminal behavior and must
  be updated for the `verified` → `complete` rename.
- **Progress paths** (`overview.test.ts`): `:373` SPIR progress and `:386` `calculateEvenProgress` →
  100% for both `complete` and `verified`.
- **`workspace-recover.ts`** (`agent-farm/__tests__/workspace-recover.test.ts`): terminal-phase
  skip for both `complete` and `verified` (add the `complete` case).
- **`next.ts` terminal short-circuit** (`porch/__tests__/`): a `complete` project and a `verified`
  project both hit the "already done" path (no re-drive) — own this test here in Phase 4 even though the
  short-circuit also exercises Phase 2 logic.
- **`builder-helpers.ts` idle-waiting** (`core` tests, e.g. `packages/core/src/__tests__/` or the
  existing builder-helpers test): `isIdleWaiting`/equivalent returns false for both terminal names.
- **`status.ts` display color** (`agent-farm/__tests__/`): export `getStatusColor` and unit-test that
  both `verified` and `complete` map to green (no existing status test in-tree, so this adds one).
- **Cross-reader test**: same fixture file through `readState` and `parseStatusYaml` → identical
  terminal name, for each of the four cases (spec test scenario 11).

#### Rollback Strategy
Revert the phase commit; overview reverts to prior parsing/derivation.

#### Risks
- **Risk**: Parser/`readState` divergence persists if the parser doesn't reuse the predicate.
  - **Mitigation**: Import the shared predicate; cross-reader test asserts agreement.

---

## Dependency Map
```
Phase 1 (predicate + migration)
   ├──→ Phase 2 (terminal writes + CLI strings) ──→ Phase 3 (rollback clearing)
   └──→ Phase 4 (overview parser + derivePrReady + audit + docs)
```
Phase 3 sequences after Phase 2 (its end-to-end re-completion assertion needs the gate-derived terminal
write). Phase 4 depends only on Phase 1 and is independent of Phases 2–3. Phases commit in numeric order.

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
**Date**: 2026-05-29 (porch-driven, plan iter1)
**Model**: Gemini (APPROVE), Claude (APPROVE), Codex (REQUEST_CHANGES → addressed)
**Key Feedback**:
- Codex: Phase 3 was not truly independent of Phase 2 — its re-completion assertion needs Phase 2's
  gate-derived terminal write. Resolved: Phase 3 now depends on Phase 2; dependency map updated.
- Codex: Phase 4's "audit all read sites" lacked per-site test ownership. Resolved: Phase 4 test plan
  now names explicit tests for `next.ts` short-circuit, `builder-helpers.ts` idle-waiting, both progress
  paths, and `status.ts`, in addition to overview/workspace-recover.
- Gemini & Claude: APPROVE, no changes requested.

**Plan Adjustments**: Phase 3 dependency tightened; Phase 4 test plan expanded to explicit per-site
ownership.

## Approval
- [ ] Technical Lead Review
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-05-29 | Initial plan | Spec approved | builder spir-919 |
| 2026-05-29 | Plan iter1 review fixes (Phase 3 dep on Phase 2; explicit read-site test ownership) | Codex REQUEST_CHANGES | builder spir-919 |
| 2026-05-29 | **Rebase onto origin/main (#923); re-verified all line numbers; added `done()` #903 early-exit (Phase 2) and #902 `recentlyMergedIssueIds` layering note (Phase 4)** | Architect: branch was 259 commits stale | builder spir-919 |
| 2026-05-29 | **Architect amendment: spec req. 8 — terminal write re-derives `pr_ready_for_human` (rollback-sticky-false fix); added Phase 2 deliverable + #1895 regression test** | Second instance (#1895) reopened gateless re-derivation | builder spir-919 |

## Notes
The architect's two standing directives are encoded structurally: **(1) centralize** — Phase 1 lands the
single predicate and every later write/read site imports it rather than re-expressing the rule;
**(2) audit, don't patch piecemeal** — Phase 4 carries the explicit blast-radius checklist from the
spec's Current State section and verifies each site rather than fixing only the ones that visibly break.

---

## Amendment History

This section tracks all TICK amendments to this plan.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
