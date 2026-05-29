# Plan: Needs Attention — surface PRs via the universal `pr` gate; delete gateless builder-derived fallbacks

## Metadata
- **ID**: plan-2026-05-29-needs-attention-surface-prs-vi
- **Issue**: #927
- **Status**: draft
- **Specification**: `codev/specs/927-needs-attention-surface-prs-vi.md`
- **Created**: 2026-05-29

## Executive Summary

Implements the spec's **selected Approach 1 (gate-authoritative surfacing)**. The work is largely *deletion*: the `derivePrReady` `bugfix && verified` fallback, the `NeedsAttentionList.buildItems` builder-emit branch, the `pr_ready_for_human` field *dependency*, and the `recentlyMergedIssueIds` projection all go away. One small addition: `verify-approval` joins the human-gate allowlist with label `"verify review"`. The signal everything keys on already exists — the **`pr` gate going `pending`** (with `requested_at`).

Sequenced into **three phases** so every commit type-checks and tests green in both `packages/codev` and `packages/dashboard`, and so the **shared-infrastructure / VSCode blast radius is concentrated in Phase 1** (the crisp target for area/vscode review — see *Cross-Cutting: VSCode blast radius*).

**Decisions locked by the spec + consultation** (do not relitigate): gate-authoritative `derivePrReady` with a `requested_at`-aware predicate; keep `pr` in shared `GATE_LABELS`/`detectBlocked*` (the "no builder stand-in" rule is dashboard-local); `verify-approval → "verify review"`; remove `recentlyMergedIssueIds` end-to-end but **retain** `fetchRecentMergedPRs` (second consumer: recentlyClosed `issueToPrUrl`).

## Success Metrics
- [ ] All spec success criteria met (PR rows keyed on `pr` gate pending; no builder stand-in; merged PRs drop; gate rows for spec/plan/dev/verify; `requested_at`-aware predicate; unaffiliated REVIEW_REQUIRED preserved).
- [ ] Both `packages/codev` and `packages/dashboard` type-check and all unit tests pass after **each** phase commit.
- [ ] No reduction in coverage; new tests cover the contract + the `requested_at` guard.
- [ ] No VSCode regression (Builders tree, gate toast, status-bar counter); verify-approval surfacing in VSCode confirmed acceptable (flagged for Amr).
- [ ] Documentation/arch notes updated in Review phase.

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "server-derivation", "title": "Gate-authoritative pr signal + verify-approval label (overview server + types)"},
    {"id": "dashboard-surfacing", "title": "PR-rows-only Needs Attention + verify styling (dashboard)"},
    {"id": "remove-dead-projection", "title": "Delete recentlyMergedIssueIds end-to-end (retain fetchRecentMergedPRs)"}
  ]
}
```

## Phase Breakdown

### Phase 1: server-derivation — Gate-authoritative `pr` signal + `verify-approval` label
**Dependencies**: None

#### Objectives
- Make the overview server emit a **gate-authoritative**, `requested_at`-aware `prReady` signal and surface `verify-approval` as a blocked gate — the shared-infrastructure change that all consumers (dashboard **and** VSCode) read.

#### Files to modify
- `packages/codev/src/agent-farm/servers/overview.ts`
  - **`derivePrReady`**: reduce to gate-authoritative — return `parsed.gates['pr'] === 'pending' && !!parsed.gateRequestedAt['pr']`. Delete the `bugfix && phase === 'verified'` branch **and** the `pr_ready_for_human` field dependency (`if (parsed.prReadyForHuman !== null) return …`). Update the doc comment to state the universal-`pr`-gate contract and the `requested_at` invariant.
  - **`GATE_LABELS`**: add `'verify-approval': 'verify review'`. Keep `'pr': 'PR review'` (VSCode depends on it; the dashboard excludes it locally in Phase 2).
  - **`detectBlockedSince`**: replace the hardcoded `['spec-approval','plan-approval','dev-approval','pr']` array with iteration over `Object.keys(GATE_LABELS)` so the gate set lives in one place and `verify-approval` automatically gets a `blockedSince`. (`detectBlocked` / `detectBlockedGate` already iterate `GATE_LABELS`.)
  - Leave `parseStatusYaml`'s `prReadyForHuman` parse in place (harmless; field still written by porch). Do **not** touch `recentlyMergedIssueIds` here.
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` — update/extend (see Test Plan).

#### Implementation Details
- The `requested_at` guard is the correctness crux: porch initializes **every** gate to `status: pending` with no `requested_at`; a bare `=== 'pending'` check would mark freshly-initialized projects PR-ready. Keep the `&& !!parsed.gateRequestedAt['pr']` conjunct.
- After this phase, `OverviewBuilder.prReady` is true iff the `pr` gate is genuinely pending, and a `verify-approval`-pending builder carries `blocked='verify review'` + `blockedSince`.

#### Acceptance Criteria
- [ ] `derivePrReady` true ⇔ `pr` gate `pending` **and** `requested_at` present; false for bugfix-verified-without-pr-gate and for freshly-initialized projects.
- [ ] `detectBlocked`/`detectBlockedSince` return `'verify review'` + timestamp for a verify-approval-pending builder; unchanged for spec/plan/dev/pr.
- [ ] `packages/codev` builds; all overview tests pass.

#### Test Plan
- **Unit (`overview.test.ts`)**: gate-authoritative `derivePrReady` (pr pending+requested ⇒ true; pr pending no-requested ⇒ false; bugfix `verified` no pr gate ⇒ false; field present but pr gate not pending ⇒ false — proves field no longer load-bearing); `detectBlockedSince` returns verify-approval timestamp; `GATE_LABELS` maps verify-approval.
- **Manual**: n/a (pure derivation).

#### Rollback Strategy
Revert the phase commit; `derivePrReady`/`GATE_LABELS`/`detectBlockedSince` return to prior behavior. No data migration involved.

#### Risks
- **Risk**: Adding `verify-approval` to `GATE_LABELS` changes VSCode behavior (verify-approval gates now surface as blocked builders / toast / status count). **Mitigation**: this is the intended, arguably-correct blast radius — covered explicitly under *Cross-Cutting: VSCode blast radius* with test coverage; flagged for Amr at plan-approval.
- **Risk**: Dropping the `pr_ready_for_human` field dependency could change behavior if any state has `pr` gate pending but field false (or vice-versa). **Mitigation**: they are coincident by construction (porch writes both together); gate-authoritative is strictly more correct (kills the #919 sticky-field hazard). Add a test for the divergent case.

---

### Phase 2: dashboard-surfacing — PR-rows-only Needs Attention + verify styling
**Dependencies**: Phase 1 (consumes gate-authoritative `prReady` and `verify review` blocked label — though dashboard unit tests inject these directly, so this phase is independently testable)

#### Objectives
- Make the dashboard surface PRs **only** as PR rows (never a builder stand-in), preserve gate rows for spec/plan/dev/**verify**, and style the verify gate.

#### Files to modify
- `packages/dashboard/src/components/NeedsAttentionList.tsx`
  - **`buildItems`**: delete the builder-emit branch (the `if (b.prReady) { … emit gate-${b.id} … }` block and its `emittedPrReadyIssueIds`/`mergedIssueIdSet` bookkeeping). Replace the builder loop's PR-handling with a single early **`if (b.prReady) continue;`** so PR-ready builders surface *only* via the PR loop (and never fall through to the gate-row catch-all). Keep the PR loop (PR rows for `prReady` linked builders + unaffiliated `REVIEW_REQUIRED`) and the gate-row emission for `b.blocked && b.blockedSince` (now naturally covers verify).
  - Remove the `recentlyMergedIssueIds` parameter/prop usage from `buildItems` and `NeedsAttentionList` (stop consuming it; prop becomes unused → drop from the interface).
  - **`gateKindClass`**: add `case 'verify review': return 'attention-kind--verify';`.
- `packages/dashboard/src/index.css` — add a `.attention-kind--verify { … }` rule (mirror `.attention-kind--spec/--plan`; pick a distinct accent).
- `packages/dashboard/src/components/WorkView.tsx` — stop passing `recentlyMergedIssueIds={…}` to `NeedsAttentionList`.
- `packages/dashboard/__tests__/NeedsAttentionList.test.tsx` — invert/remove + add (see Test Plan).

#### Implementation Details
- `OverviewData.recentlyMergedIssueIds` (the type field) and the server computation are **not** removed in this phase — only the dashboard's *consumption* stops. This keeps the dashboard green now and isolates the type/computation removal to Phase 3. (The field remains emitted-but-ignored between Phase 2 and Phase 3 — dead but harmless.)
- PR-row `waitingSince` continues to come from `b.blockedSince` (= `pr` gate `requested_at`, since `pr` stays in `detectBlockedSince`), with `pr.createdAt` fallback for unaffiliated PRs.

#### Acceptance Criteria
- [ ] Open PR + pr-gate-pending builder ⇒ exactly one PR row; cache-miss (PR absent) ⇒ **no row**; merged PR (absent) ⇒ **no row**.
- [ ] spec/plan/dev/**verify**-approval pending builders ⇒ gate rows with correct label/kind/age; verify row styled via `--verify`.
- [ ] pr-gate-pending builder never emits a builder/gate row.
- [ ] Unaffiliated `REVIEW_REQUIRED` PR still surfaces; no double-emit.
- [ ] `packages/dashboard` builds; all NeedsAttentionList tests pass.

#### Test Plan
- **Unit (`NeedsAttentionList.test.tsx`)**:
  - **Invert** "still surfaces a prReady BUGFIX builder when its PR is missing" (~L183) and "still surfaces a prReady gated builder … when its PR is missing" (~L253) → assert **no row**.
  - **Remove** "does NOT surface a prReady builder whose PR has been merged (Issue #901)" (~L222) → mechanism deleted; replaced by the generic "missing PR ⇒ no row" case.
  - **Add**: verify-approval ⇒ gate row labeled "verify review"; pr-gate builder with missing PR ⇒ no row; no double-emit when PR+builder present (retain existing).
  - Keep the existing PR-gating, unaffiliated, and waitingSince tests (still valid).
- **Manual (render verification — per architect/UI policy)**: render Needs Attention in a browser/Playwright for (a) a PR row, (b) a verify-approval gate row (confirm `--verify` styling renders), (c) empty state. Capture before/after for the verify row since it's a new `className`.

#### Rollback Strategy
Revert the phase commit; `buildItems` returns to the builder-emit model and re-accepts the prop (still present on the type).

#### Risks
- **Risk**: A real cache-miss now shows nothing instead of a defensive row. **Mitigation**: intended by spec (req 1); the next refresh surfaces the PR once `pendingPRs` includes it. Documented tradeoff.
- **Risk**: New `--verify` className without matching CSS renders unstyled. **Mitigation**: add the CSS rule in the same commit; render-verify before marking done (memory: UI visual verification).

---

### Phase 3: remove-dead-projection — Delete `recentlyMergedIssueIds` end-to-end
**Dependencies**: Phase 2 (dashboard no longer consumes the field)

#### Objectives
- Remove the now-dead `recentlyMergedIssueIds` projection while **retaining** `fetchRecentMergedPRs` and the `mergedPRs` fetch (still needed for the recentlyClosed `issueToPrUrl` map).

#### Files to modify
- `packages/types/src/api.ts` — remove `recentlyMergedIssueIds` from `OverviewData` (and the related doc comment).
- `packages/codev/src/agent-farm/servers/overview.ts` — remove the `recentlyMergedIssueIds` field from the local `OverviewData` mirror/interface, delete its computation block (~L1006–1021) and its inclusion in the returned `result`. **Keep** the `fetchRecentMergedPRs` import, the `mergedPRs` Promise.all fetch (~L914), and the `issueToPrUrl` build (~L971).
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` — remove assertions on `recentlyMergedIssueIds`; confirm the recentlyClosed PR-link enrichment test (uses `mergedPRs`) still passes (proves the fetch is retained).

#### Implementation Details
- This is pure dead-code removal. The mock `fetchRecentMergedPRs` in `overview.test.ts` stays (recentlyClosed uses it).

#### Acceptance Criteria
- [ ] `recentlyMergedIssueIds` absent from `OverviewData` and `overview.ts`; both packages type-check.
- [ ] `fetchRecentMergedPRs` retained; recentlyClosed items still carry `prUrl`.
- [ ] All tests pass; no consumer references the removed field (grep clean).

#### Test Plan
- **Unit**: existing recentlyClosed test still green (PR-link enrichment intact); grep confirms no remaining `recentlyMergedIssueIds` references.
- **Build**: `pnpm --filter @cluesmith/codev build` + dashboard build green.

#### Rollback Strategy
Revert the phase commit; the field and computation return. (Low risk — additive-to-revert.)

#### Risks
- **Risk**: A non-obvious consumer of the field exists. **Mitigation**: grep across `packages/` before removal (current grep shows only the now-removed dashboard consumer + type + computation); TS build catches stragglers.

---

## Cross-Cutting: VSCode blast radius (architect coordination — area/vscode / Amr)

The Phase 1 change to **shared** `overview.ts` infra (`derivePrReady`, `GATE_LABELS`, `detectBlocked*`) is read by VSCode as well as the dashboard. Per the architect's note, this is an **explicit blast-radius item with its own test coverage**, and Amr (owns `area/vscode`) is looped in on #927.

**VSCode consumers (verified on disk):**
- `packages/vscode/src/views/builders.ts` — Builders tree: blocked builders sort to top with a bell, using `b.blocked`/`b.blockedSince`.
- `packages/vscode/src/notifications/gate-toast.ts` — gate toast: fires when a builder enters the blocked set; `GATE_ACTIONS` has `pr`/`dev-approval`/etc. with a **generic fallback** for unmapped gates.
- `packages/vscode/src/commands/approve.ts` — mirrors `GATE_ACTIONS` one-for-one (per its own comment).
- `packages/vscode/src/extension.ts` — status-bar counter of attention items.
- Existing tests: `packages/vscode/src/test/builders.test.ts`, `packages/vscode/src/__tests__/menu-when-clauses.test.ts`.

**What changes for VSCode (intended):**
1. `pr` **stays** in `GATE_LABELS` → VSCode pr-gate behavior is **unchanged** (no regression by construction).
2. `verify-approval` is **newly** present → a pending verify-approval gate now surfaces as a blocked builder (tree bell + toast + status count). This is arguably a *fix* (a pending human gate genuinely needs attention) but is a behavior change. `GATE_ACTIONS`/`approve.ts` have no `verify-approval` entry → generic fallback ("Review" → open builder terminal), which is acceptable.

**Test coverage to add/verify (in Phase 1, or a VSCode-scoped addition):**
- [ ] A VSCode-side test (or extend `builders.test.ts`) asserting a `verify-approval`-pending builder appears in the Builders tree as blocked with `blockedSince`, and that `pr`-gate behavior is unchanged.
- [ ] Confirm `gate-toast.ts` generic-fallback path handles `verify-approval` without error (no `GATE_ACTIONS` entry required).

**🚩 Flag for Amr (needs area/vscode eyes at plan-approval):**
- Is surfacing **verify-approval** as a blocked builder in the VSCode tree/toast/status-bar the desired UX, or should VSCode (like the dashboard for `pr`) treat verify-approval specially? Default in this plan: surface it (consistent with "every genuine human gate needs attention"). If Amr wants a `GATE_ACTIONS` entry for verify-approval (e.g. a "Verify" action), that is an additive follow-up, not a blocker for #927.

## Dependency Map
```
Phase 1 (server-derivation) ──→ Phase 2 (dashboard-surfacing) ──→ Phase 3 (remove-dead-projection)
        │
        └── VSCode blast radius (verified + tested in Phase 1; Amr review at plan-approval)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| VSCode regression from shared GATE_LABELS/detectBlocked change | L | M | `pr` kept in map (no change); verify-approval covered by added tests + Amr review | builder / Amr |
| Bare gate-pending predicate mis-flags fresh projects | L | M | `requested_at`-aware predicate + dedicated test | builder |
| `recentlyMergedIssueIds` has a hidden consumer | L | L | grep before removal; TS build | builder |
| New `--verify` className unstyled | L | L | CSS in same commit; render-verify | builder |
| Cross-package build breakage between phases | L | M | phase ordering keeps each commit green (consume-then-remove) | builder |

## Validation Checkpoints
1. **After Phase 1**: overview tests green; manually confirm `derivePrReady`/`detectBlockedSince` via the test cases; VSCode build green.
2. **After Phase 2**: dashboard tests green; render-verify Needs Attention (PR row, verify gate row, empty).
3. **After Phase 3**: grep clean for `recentlyMergedIssueIds`; full `packages/codev` + `packages/dashboard` build + test green.
4. **Before PR**: run the full test suites for both packages; CMAP at PR (`pr` gate).

## Documentation Updates Required
- [ ] Review phase: note the universal-`pr`-gate contract and the dashboard-local "no builder stand-in" rule in `codev/resources/arch.md` (via update-arch-docs skill) if it adds durable architectural shape.
- [ ] Reconcile #919 (descope its Needs-Attention / `derivePrReady` parts) and #902 (recentlyMergedIssueIds removed) — note in the PR/review.

## Expert Review
**Date**: (pending — porch runs 3-way after this draft)
**Models**: Gemini, Codex, Claude
**Key Feedback**: (to be filled)
**Plan Adjustments**: (to be filled)

## Approval
- [ ] Technical Lead Review (architect — `plan-approval` gate)
- [ ] area/vscode review (Amr) — VSCode blast radius
- [ ] Expert AI Consultation Complete (3-way)

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-05-29 | Initial plan draft | Spec #927 approved | builder spir-927 |

## Notes
- No time estimates (per SPIR). Phases are ordered by dependency and build-greenness, not effort.
- The whole change nets to deletion + one small gate addition; complexity is Low–Medium and concentrated in Phase 1's shared infra.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
