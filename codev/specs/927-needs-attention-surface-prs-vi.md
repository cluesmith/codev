# Specification: Needs Attention — surface PRs via the universal `pr` gate; delete gateless builder-derived fallbacks

## Metadata
- **ID**: spec-2026-05-29-needs-attention-surface-prs-vi
- **Issue**: #927
- **Status**: draft
- **Created**: 2026-05-29

## Clarifying Questions Asked

Issue #927 is highly prescriptive — it names the root cause, the universal signal, the exact code to delete, and the desired behavior. Rather than re-ask answered questions, the design questions that remain are captured under **Open Questions** for the architect/reviewers to settle. The issue's "Direction" section is treated as authoritative intent (effectively baked decisions); this spec fleshes it out and grounds it in the current code.

No `## Baked Decisions` section is present in the issue body, so there is no verbatim-copy block. The five numbered "Direction" items and the "Out of scope" list are honored as fixed intent.

## Problem Statement

The dashboard's **Needs Attention** surface (`WorkView` → `NeedsAttentionList`) has accreted a *builder-state-derived* model for "a PR is ready for a human." That model is fragile and produces three wrong behaviors, all faces of one root cause:

1. It surfaces **builder rows** standing in for PRs (not just PR rows).
2. It keeps **merged PRs** showing (stale "PR review" rows for already-shipped work).
3. It can **hide ready PRs**.

The root cause: bugfix-style PR-readiness is derived from porch *terminal/builder* state instead of from the PR. Three artifacts embody this:

- `derivePrReady`'s `bugfix && phase === 'verified'` fallback (`packages/codev/src/agent-farm/servers/overview.ts`),
- the `pr_ready_for_human` status.yaml field (porch), and
- the **builder-emit** branch in `NeedsAttentionList.buildItems` (`packages/dashboard/src/components/NeedsAttentionList.tsx`) that emits a *builder* row when a `prReady` builder's PR is absent from the open-PR set.

These exist solely to cope with **one deviation**: a *gateless* bugfix variant (observed on an external adopter, codev 3.1.4 — a 4-phase `investigate/fix/verify/pr` graph with **no `pr` gate**). With no `pr` gate, the dashboard had no uniform "ready for human" signal and fell back to the fragile `bugfix && verified` derivation plus the builder-emit defense. The gated path never broke (it self-heals through rollback by re-requesting the `pr` gate).

## Current State

### How "PR ready for human" is computed today

- **Porch** writes `pr_ready_for_human: true` to `status.yaml` exactly when it auto-requests the `pr` gate (sets the gate `pending`), and clears it to `false` on `pr`-gate approval and on rollback past the PR-creating phase. Every upstream PR-producing protocol — BUGFIX, AIR, SPIR, ASPIR, PIR — now carries a `pr` gate on its PR-creating phase (#887 closed the BUGFIX gap). Therefore, **for every upstream protocol, `pr_ready_for_human === true` is coincident with the `pr` gate being `pending`** (written in the same commit).
- **`derivePrReady(parsed)`** (overview.ts) returns the explicit `pr_ready_for_human` field when present; otherwise it falls back to: `pr` gate pending **OR** `bugfix && phase === 'verified'`. The builder object's `prReady` boolean is set from this.
- **`detectBlocked` / `GATE_LABELS`** (overview.ts) map pending gates to labels: `spec-approval → "spec review"`, `plan-approval → "plan review"`, `dev-approval → "dev review"`, `pr → "PR review"`. **`verify-approval` is absent from this map**, so a pending `verify-approval` gate produces `blocked = null` and surfaces nowhere.

### How `NeedsAttentionList.buildItems` assembles rows today

1. **PR loop** over open PRs (`pendingPRs`): emit a **PR row** when the linked builder is `prReady`, or when an unaffiliated/human PR has `reviewStatus === 'REVIEW_REQUIRED'`.
2. **Builder loop**:
   - skip builders whose PR was already emitted as a PR row;
   - **builder-emit branch**: if a `prReady` builder's PR is *missing* from `pendingPRs`, emit a **builder row** as a "PR review" item — unless the builder's issue is in `recentlyMergedIssueIds` (#902), in which case skip (suppress stale post-merge rows);
   - otherwise, if gate-blocked (`spec/plan/dev` review), emit a **gate row**.

### Supporting state

- **`recentlyMergedIssueIds`** (`OverviewData`, #902): computed in `overview.ts` from recently-merged PRs and threaded through `WorkView` into `NeedsAttentionList`. Its **only** consumer is the builder-emit branch's merged-suppression check.
- **`pendingPRs`** lists **open PRs only** — a merged PR is correctly absent.

### Why it's wrong

- The builder-emit branch makes a *builder* stand in for a *PR* whenever the open-PR cache misses — and historically when state was stale, surfaced merged work.
- The `bugfix && verified` fallback fires for the gateless variant and, because `verified` conflates "phases done" with "human-verified" (#919), interacts badly with sticky `pr_ready_for_human` state across version boundaries.

## Desired State

**Needs Attention = (A) ∪ (B):**

- **(A) PR rows** for **open** PRs whose linked builder has a **pending `pr` gate** (the universal, post-CMAP "ready for human" signal). Emit **PR rows only**. If the open PR is not found (cache miss / pagination / transient API failure), **emit nothing** — never a builder row.
- **(B) Gate rows** for genuine pre-PR / post-merge **human-approval** gates that are **not** the `pr` gate: `spec-approval`, `plan-approval`, `dev-approval`, `verify-approval`.
- **Plus** the existing fallback for **unaffiliated / human-authored PRs**: surface when `reviewDecision === 'REVIEW_REQUIRED'` and there is no matching builder.

A **builder never stands in for a PR.** The `pr` gate surfaces **only** as a PR row (via the open-PR set), never as a builder/gate row.

### The universal contract

> A protocol must carry a `pr` gate on its PR-creating phase for its PR to surface in Needs Attention.

This is satisfied by all bundled PR-producing protocols (BUGFIX, AIR, SPIR, ASPIR, PIR). A gateless PR-producing variant **will not** surface PR rows — **by design**. Adopters with custom variants align to the pr-gated upstream (the external adopter's bugfix is realigned separately; see Dependencies).

### EXPERIMENT / MAINTAIN

EXPERIMENT and MAINTAIN do **not** follow the CMAP→PR pattern and do **not** produce a `pr` gate; they carry `experiment-complete` / `maintain-complete` completion gates. They therefore **never** surface as PR rows. Their completion gates are the appropriate signal; wiring those completion gates into the dashboard gate-row path is **out of scope** here (they are not regressions of this work) — see Open Questions.

## Stakeholders
- **Primary Users**: Architects watching the Tower dashboard Work view to know what needs human action (approve a gate, review a PR).
- **Secondary Users**: External adopters whose custom protocol variants must conform to the pr-gate contract to be surfaced.
- **Technical Team**: Codev maintainers of `packages/codev` (overview server) and `packages/dashboard` (Work view).
- **Business Owners**: Codev project (self-hosted).

## Success Criteria

- [ ] **PR-surfacing keys on the `pr` gate.** An open PR whose linked builder has a pending `pr` gate surfaces as exactly one **PR row** (linking to the PR URL).
- [ ] **No builder-stand-in.** When a pr-gated builder's PR is absent from the open-PR set (cache miss), **no row** is emitted for it. The `derivePrReady` `bugfix && phase === 'verified'` fallback and the `NeedsAttentionList.buildItems` builder-emit branch are **deleted**.
- [ ] **Merged PRs drop automatically.** A merged PR (absent from `pendingPRs`) produces no Needs Attention row, with no reliance on a recently-merged suppression list.
- [ ] **Gate rows preserved** for `spec-approval`, `plan-approval`, `dev-approval`, and `verify-approval`. (`verify-approval` is **added** to the gate-row path; it is currently missing.)
- [ ] **`pr` gate excluded from the gate-row path** — it surfaces only as a PR row, so a cache-missed pr-gate builder cannot fall through to a builder/gate row.
- [ ] **Unaffiliated/human-PR fallback preserved** (`reviewDecision === 'REVIEW_REQUIRED'`, no matching builder).
- [ ] **`recentlyMergedIssueIds` reconciled** — assessed and (recommended) removed end-to-end since its only consumer (the builder-emit branch) is deleted; OR an explicit justification is recorded for keeping it.
- [ ] **#919 reconciled** — this spec supersedes #919's Needs-Attention / `derivePrReady` parts; the `verified → complete` terminal-state rename is **not** performed here and is documented as independent.
- [ ] All affected unit tests updated; new tests cover the contract (below). No reduction in coverage.
- [ ] No regression in the VSCode Needs Attention tree / toast / status-bar counter that share `detectBlocked` (verified, since `GATE_LABELS` is shared infrastructure).

## Constraints

### Technical Constraints
- The surfacing signal is the **`pr` gate `pending`** state in `status.yaml`, read by the afx overview server (`overview.ts`) and exposed via `OverviewData` to the dashboard. No new marker, field, or abstraction is introduced.
- `GATE_LABELS` / `detectBlocked` / `detectBlockedSince` in `overview.ts` are **shared** by multiple consumers (dashboard `NeedsAttentionList`, VSCode Needs Attention tree, VSCode toast, status-bar counter). Any change to the gate allowlist (e.g. adding `verify-approval`) affects all of them; this is acceptable and arguably correct (a pending human gate genuinely needs attention everywhere), but must be verified, not assumed.
- `pendingPRs` contains **open PRs only**; this is the mechanism by which merged PRs drop. Do not reintroduce closed/merged PRs into that set.
- No changes to **pre-PR gate semantics** (porch behavior for spec/plan/dev gates is untouched).

### Business Constraints
- Self-hosted Codev; ship via the normal SPIR → PR → merge flow. No external deadlines.

## Assumptions
- For all bundled protocols, `pr_ready_for_human === true` ⟺ `pr` gate `pending` (verified in porch `next.ts` / `index.ts`). The two signals are coincident, so keying on the gate does not change behavior for correctly-gated builders.
- The external adopter's gateless bugfix variant is realigned to the pr-gated upstream **separately** (out of this repo's scope); this spec does not add compatibility shims for gateless variants — that is the explicit design choice (req 4).
- `verify-approval` is a real, post-merge, architect-approved gate on SPIR/ASPIR's `verify` phase (confirmed in `spir/protocol.json`).

## Solution Approaches

### Approach 1 (recommended): Gate-authoritative surfacing

**Description**: Make the **`pr` gate `pending`** the single source of truth for PR-surfacing.

- Reduce `derivePrReady` so the PR-ready signal is "the `pr` gate is `pending`" (preferring porch's explicit `pr_ready_for_human` field when present is acceptable since it is coincident, but the `bugfix && phase === 'verified'` branch is **deleted**). Recommendation: treat the **gate** as authoritative to eliminate the sticky-`pr_ready_for_human: false` hazard #919 flagged (a stale field could otherwise suppress a genuinely-pending PR).
- In `NeedsAttentionList.buildItems`: keep the PR loop (emit PR rows for open PRs whose builder is pr-gate-pending, plus the unaffiliated REVIEW_REQUIRED case); **delete** the builder-emit branch; ensure the gate-row loop **excludes** the `pr` gate and **includes** `verify-approval`.
- Remove `recentlyMergedIssueIds` end-to-end (dead once the builder-emit branch is gone).

**Pros**:
- Eliminates all three wrong behaviors at the root; smallest conceptual surface ("the gate is the signal").
- Kills the sticky-field hazard #919 describes.
- Net deletion of fragile code (two fallbacks + a now-dead data field).

**Cons**:
- Touches shared `GATE_LABELS` (to add `verify-approval`) → broader (but correct) blast radius.
- Gateless variants stop surfacing (intended, but a behavior change for any such adopter).

**Estimated Complexity**: Low–Medium
**Risk Level**: Low

### Approach 2: Minimal field-first (delete only the bugfix branch)

**Description**: Keep `derivePrReady` field-first; delete only the `bugfix && phase === 'verified'` line and the builder-emit branch; leave `recentlyMergedIssueIds` in place; do not add `verify-approval`.

**Pros**: Smallest diff; lowest chance of unrelated regressions.

**Cons**: Leaves vestigial dead code (`recentlyMergedIssueIds`); leaves the `verify-approval` gap open (contradicts desired-behavior (B)); retains the sticky-field hazard. Does not fully realize the issue's "delete the gateless fallbacks" intent.

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 3: Bespoke per-protocol markers (rejected)

Explicitly **out of scope** per the issue — the `pr` gate is the universal signal; no new markers.

## Open Questions

### Critical (Blocks Progress)
- [ ] **None.** The issue's direction is unambiguous on the core mechanism.

### Important (Affects Design)
- [ ] **Add `verify-approval` to the gate-row path?** Desired-behavior (B) lists it, but it is currently absent from `GATE_LABELS`/`detectBlocked`, so "keep" cannot be satisfied literally — it must be **added**. Recommendation: **add it** (rounds out "every genuine human gate surfaces; the `pr` gate surfaces as a PR row"). Note the shared-consumer impact (VSCode tree/toast/status bar).
- [ ] **Remove `recentlyMergedIssueIds` end-to-end, or leave it vestigial?** Recommendation: **remove** (its only consumer is deleted; #902 becomes unnecessary). Confirm no other consumer exists before removal.
- [ ] **`derivePrReady` form**: gate-authoritative (recommended — kills #919 sticky-field hazard) vs field-first-minus-bugfix-branch (smaller diff). Functionally equivalent for correctly-gated builders.

### Nice-to-Know (Optimization)
- [ ] Should EXPERIMENT/MAINTAIN `experiment-complete` / `maintain-complete` gates surface as gate rows in the dashboard? Currently they surface nowhere. Recommendation: **out of scope** for #927 (not a regression of this work); track separately if desired.
- [ ] Should porch eventually stop writing `pr_ready_for_human` entirely (becomes vestigial under gate-authoritative surfacing)? Recommendation: **out of scope** (porch-side; the dashboard simply stops depending on it).

## Performance Requirements
- No new network calls or heavy computation; this is presentational/derivation logic over already-fetched `OverviewData`. No measurable performance impact expected. (Removing `recentlyMergedIssueIds` removes a small amount of per-refresh work.)

## Security Considerations
- None. No authn/authz, data-privacy, or audit surface is touched. PR URLs already shown are unchanged.

## Test Scenarios

### Functional Tests (the contract)
1. **PR row via `pr` gate** — open PR + linked builder with `pr` gate `pending` ⇒ exactly one PR row, linking to the PR URL, waiting-since = gate-requested time. (Covers BUGFIX, AIR, SPIR, ASPIR, PIR shapes uniformly.)
2. **Cache miss ⇒ nothing** — builder with `pr` gate `pending` but PR absent from `pendingPRs` ⇒ **no row** (no builder stand-in). (Replaces the old "still surfaces a prReady builder when its PR is missing" tests, which must be inverted.)
3. **Merged PR ⇒ nothing** — builder's PR merged (absent from `pendingPRs`) ⇒ **no row**, with no reliance on `recentlyMergedIssueIds`.
4. **Pre-CMAP PR excluded** — open PR whose builder has NOT yet reached the `pr` gate ⇒ no row.
5. **Gate rows preserved** — builder pending on `spec-approval` / `plan-approval` / `dev-approval` ⇒ a gate row with the correct kind/label and waiting-since.
6. **`verify-approval` surfaces** (if Approach 1 adopted) — builder pending on `verify-approval` ⇒ a gate row.
7. **`pr` gate never a gate row** — builder with `pr` gate `pending` whose PR is missing does NOT produce a "PR review" gate/builder row (intersection of #2 and the exclusion rule).
8. **Unaffiliated/human PR** — open PR with no matching builder surfaces only when `reviewDecision === 'REVIEW_REQUIRED'`.
9. **No double-emit** — PR present AND builder present ⇒ exactly one PR row.
10. **Gateless variant ⇒ nothing** — a builder on a gateless PR-producing protocol does not surface a PR row (documents the universal contract).

### Non-Functional Tests
1. **Shared-consumer regression check** — adding `verify-approval` to `GATE_LABELS` does not break the VSCode Needs Attention tree / toast / status-bar counter (build + existing tests pass).
2. **Dead-code removal** — `recentlyMergedIssueIds` removed cleanly (type, computation, prop threading) with TypeScript build green.

## Dependencies
- **External Services**: GitHub/forge PR listing (already used to build `pendingPRs`); no new calls.
- **Internal Systems**: porch `status.yaml` gate state; afx overview server (`overview.ts`); dashboard `WorkView`/`NeedsAttentionList`; shared `OverviewData` types (`packages/types/src/api.ts`).
- **Related issues**:
  - **#902** (`recentlyMergedIssueIds` / fixes #901): becomes unnecessary; assess for removal.
  - **#919** (`verified → complete` rename): its Needs-Attention / `derivePrReady` parts become unnecessary under this model. This spec **supersedes** those parts; the terminal-state rename is independent honesty work and is **not** performed here. Reconcile/descope #919 accordingly.
  - **#887** (BUGFIX gained a `pr` gate): the precondition that makes the universal contract hold upstream.
  - **External adopter (shannon)**: realign its bugfix to the pr-gated upstream separately so it is covered by the universal mechanism (tracked outside this repo).

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Adding `verify-approval` to shared `GATE_LABELS` regresses another consumer | Low | Medium | Build + run all consumer tests; review VSCode tree/toast/status-bar usages of `detectBlocked`. |
| Removing `recentlyMergedIssueIds` breaks a non-obvious consumer | Low | Low | Grep all consumers before removal (current grep shows only the builder-emit branch); TS build catches type removals. |
| A real gateless adopter silently loses PR surfacing | Low | Medium | This is the intended contract; document loudly in review/lessons and in the realignment task for the adopter. |
| Inverting the "cache-miss surfaces a row" tests masks a genuine cache-miss UX gap | Low | Low | Accept by design (issue req 1); the next refresh surfaces the PR once `pendingPRs` includes it. Document the tradeoff. |

## Expert Consultation
**Date**: (pending)
**Models Consulted**: Gemini, Codex, Claude (3-way, run by porch after this draft)
**Sections Updated**: (to be filled after consultation)

Note: All consultation feedback will be incorporated directly into the relevant sections above.

## Approval
- [ ] Technical Lead Review (architect — `spec-approval` gate)
- [ ] Expert AI Consultation Complete (3-way)

## Notes

- **Net effect is deletion**: two fallbacks (`derivePrReady` bugfix branch, `buildItems` builder-emit branch) and one data field (`recentlyMergedIssueIds`) go away; one gate (`verify-approval`) is added to the human-gate allowlist; the `pr` gate is excluded from the gate-row path. The signal everything keys on already exists — the `pr` gate.
- **Scope discipline**: no new markers (req: out of scope), no change to pre-PR gate semantics (req: out of scope), no `verified → complete` rename (belongs to #919).

---

## Amendments

This section tracks any TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
