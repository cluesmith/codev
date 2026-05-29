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
- **Three sibling functions hold the gate list redundantly**: `detectBlocked` and `detectBlockedGate` iterate `Object.keys(GATE_LABELS)`, but **`detectBlockedSince` keeps its own hardcoded array** `['spec-approval', 'plan-approval', 'dev-approval', 'pr']` (with a "keep in sync" comment). This is a separate sync point: adding `verify-approval` to `GATE_LABELS` without also adding it to `detectBlockedSince` would yield `blocked = "verify review"` but `blockedSince = null`, and `buildItems`' `if (!b.blocked || !b.blockedSince) continue;` would then silently drop the row. The clean fix is to make `detectBlockedSince` iterate `Object.keys(GATE_LABELS)` too, so the gate set lives in exactly one place.

### How `NeedsAttentionList.buildItems` assembles rows today

1. **PR loop** over open PRs (`pendingPRs`): emit a **PR row** when the linked builder is `prReady`, or when an unaffiliated/human PR has `reviewStatus === 'REVIEW_REQUIRED'`.
2. **Builder loop**:
   - skip builders whose PR was already emitted as a PR row;
   - **builder-emit branch**: if a `prReady` builder's PR is *missing* from `pendingPRs`, emit a **builder row** as a "PR review" item — unless the builder's issue is in `recentlyMergedIssueIds` (#902), in which case skip (suppress stale post-merge rows);
   - otherwise, if gate-blocked (`spec/plan/dev` review), emit a **gate row**.

### Supporting state

- **`recentlyMergedIssueIds`** (`OverviewData`, #902): computed in `overview.ts` from recently-merged PRs and threaded through `WorkView` into `NeedsAttentionList`. Its **only** consumer is the builder-emit branch's merged-suppression check.
- **`fetchRecentMergedPRs`** (`packages/codev/src/lib/github.ts`) is the helper that fetches the merged-PR window. **It is NOT exclusive to `recentlyMergedIssueIds`**: its result (`mergedPRs`) is *also* used in `overview.ts` (~line 971) to build the `issueToPrUrl` map that enriches the **recentlyClosed** section with PR links. (Confirmed: `overview.ts` is the helper's only non-test caller, but it uses `mergedPRs` twice.) Therefore removing `recentlyMergedIssueIds` must **keep** `fetchRecentMergedPRs` and the `mergedPRs` fetch intact — only the `recentlyMergedIssueIds` projection (and its consumers) is removed. *(This corrects a consultation suggestion to delete the helper outright.)*
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

### Scope of the "no builder stand-in" rule: dashboard-local (resolves consultation)

The rule **"a builder never stands in for a PR"** is **dashboard-local** to `NeedsAttentionList`. It is *not* a change to the shared blocked-detection infrastructure:

- **Keep `pr` in `GATE_LABELS` / `detectBlocked` / `detectBlockedGate` / `detectBlockedSince`** (the shared `overview.ts` derivation). VSCode's Needs Attention tree, gate toast, and status-bar counter are builder-centric surfaces (they have no PR list to render a proper PR row), so a pr-gate-pending builder *should* keep surfacing there as a blocked builder with the bell icon — that is existing, correct behavior and must not regress.
- The dashboard alone has the open-PR set (`pendingPRs`) needed to render a real PR row, so the dashboard alone enforces "PR-as-PR-row, never as builder-row." It does this in `buildItems` by **excluding PR-ready builders from the builder/gate-row loop entirely** (an early `if (b.prReady) continue;`), so a pr-gate builder can only ever appear via the PR loop. This single guard replaces the deleted builder-emit branch *and* prevents the gate-row catch-all from emitting a stand-in row.

**Consequence for waiting-time (resolves "gate-requested time" criterion):** because `pr` stays in `detectBlockedSince`, a pr-gate-pending builder still carries `blockedSince = gateRequestedAt['pr']`. The PR row continues to use that value for its waiting-since chip ("how long the human has been the bottleneck"), preserving *gate-requested time* — not PR-creation time. The `pr.createdAt` fallback remains only for the unaffiliated/human-PR case (no builder, no gate timestamp).

### The "pending gate" predicate (correctness invariant)

A gate counts as genuinely pending **only when it has both `status: pending` AND a `requested_at` timestamp**. Porch initializes *every* gate to `status: pending` with no `requested_at` at project creation (verified in this project's own `status.yaml`: `pr`, `spec-approval`, `plan-approval`, `verify-approval` all start `pending` with no `requested_at`). A gate is "really pending" only once porch *requests* it (writes `requested_at`).

Therefore the PR-surfacing predicate is:

```
gates['pr'] === 'pending'  AND  gateRequestedAt['pr'] is present
```

and likewise for every gate-row gate. A simplification to `gates['pr'] === 'pending'` alone is **incorrect** — it would mark every freshly-initialized project as PR-ready. (The existing `detectBlocked` / `detectBlockedGate` / `detectBlockedSince` already use the `requested_at`-aware predicate; `derivePrReady` must keep it too.)

### Human-facing label contract for `verify-approval`

`verify-approval` surfaces with the label **`"verify review"`** (mirroring `spec-approval → "spec review"`, `plan-approval → "plan review"`). Consumers render `blocked` directly, so the string is a contract:

- `GATE_LABELS['verify-approval'] = 'verify review'`.
- Dashboard `gateKindClass` gains a `'verify review' → 'attention-kind--verify'` case, and a new `.attention-kind--verify` CSS rule is added to `packages/dashboard/src/index.css` (today only `--pr`, `--spec`, `--plan`, `--code-review` exist; an unmapped label falls back to `--plan`, which is merely a styling smell, not a functional break).
- VSCode gate-toast `GATE_ACTIONS` has no `verify-approval` entry; it uses the generic fallback ("Review" → open builder terminal), which is acceptable and need not change.

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
- [ ] **Gate rows preserved** for `spec-approval`, `plan-approval`, `dev-approval`, and `verify-approval`. (`verify-approval` is **added** to `GATE_LABELS` with label `"verify review"`; it is currently missing. Add the matching `gateKindClass` case + `.attention-kind--verify` CSS rule.)
- [ ] **`pr` gate excluded from the dashboard gate-row path** — it surfaces only as a PR row. The exclusion is dashboard-local (`if (b.prReady) continue;` in `buildItems`); `pr` **remains** in the shared `GATE_LABELS`/`detectBlocked*` so VSCode surfaces are unaffected.
- [ ] **Gate-pending predicate is `requested_at`-aware** — `derivePrReady` (and any new surfacing check) treats a gate as pending only when `status: pending` **and** `requested_at` is present, so freshly-initialized projects are not mis-flagged.
- [ ] **Unaffiliated/human-PR fallback preserved** (`reviewDecision === 'REVIEW_REQUIRED'`, no matching builder).
- [ ] **`recentlyMergedIssueIds` removed end-to-end** — the field (`OverviewData`/`api.ts`), its computation block in `overview.ts`, and its prop threading (`WorkView` → `NeedsAttentionList`) are deleted. **`fetchRecentMergedPRs` and the `mergedPRs` fetch are kept** (still needed for the recentlyClosed `issueToPrUrl` map).
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

### Approach 1 (SELECTED — unanimous consultation): Gate-authoritative surfacing

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

### Resolved by consultation (3-way unanimous)
- [x] **Add `verify-approval`?** **YES.** Add to `GATE_LABELS` as `"verify review"` + `gateKindClass` case + `.attention-kind--verify` CSS. Shared-consumer impact verified manageable (VSCode toast uses a generic fallback for unknown gates; no breakage).
- [x] **Remove `recentlyMergedIssueIds`?** **YES, end-to-end** — but **keep** `fetchRecentMergedPRs`/`mergedPRs` (still needed for recentlyClosed `issueToPrUrl`). (Builder verified the helper has a second consumer; the consultation suggestion to delete the helper was incorrect.)
- [x] **`derivePrReady` form?** **Gate-authoritative** — reduce to the `requested_at`-aware `pr`-gate-pending check and drop the `pr_ready_for_human` field dependency, killing the #919 sticky-field hazard. (Keep the `requested_at` guard — see correctness invariant.)
- [x] **Scope of "no builder stand-in"?** **Dashboard-local.** Keep `pr` in shared blocked-detection (VSCode bell + PR-row waiting-since timestamp depend on it); enforce PR-as-PR-row only in `buildItems`.

### Nice-to-Know (Optimization)
- [ ] Should EXPERIMENT/MAINTAIN `experiment-complete` / `maintain-complete` gates surface as gate rows in the dashboard? Currently they surface nowhere. Recommendation: **out of scope** for #927 (not a regression of this work); track separately if desired.
- [ ] Should porch eventually stop writing `pr_ready_for_human` entirely (becomes vestigial under gate-authoritative surfacing)? Recommendation: **out of scope** (porch-side; the dashboard simply stops depending on it). The field stays written; the dashboard simply ignores it.

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
6. **`verify-approval` surfaces** — builder pending on `verify-approval` ⇒ a gate row labeled `"verify review"`.
7. **`pr` gate never a builder/gate row** — builder with `pr` gate `pending` whose PR is missing from `pendingPRs` produces NO row at all (intersection of #2 and the dashboard-local exclusion).
8. **Freshly-initialized project ⇒ nothing** — a builder whose `pr` gate is `status: pending` but has **no `requested_at`** is NOT treated as PR-ready (guards the `requested_at` invariant).
9. **Unaffiliated/human PR** — open PR with no matching builder surfaces only when `reviewDecision === 'REVIEW_REQUIRED'`.
10. **No double-emit** — PR present AND builder present ⇒ exactly one PR row.
11. **Gateless variant ⇒ nothing** — a builder on a gateless PR-producing protocol does not surface a PR row (documents the universal contract).

### Existing tests to update (enumerated)
`packages/dashboard/__tests__/NeedsAttentionList.test.tsx` has three tests that lock in the deleted behavior and must be **inverted or removed**:
- "still surfaces a prReady BUGFIX builder when its PR is missing from prs" (~lines 183–219) → **invert** (assert no row).
- "still surfaces a prReady gated builder (AIR/SPIR shape) when its PR is missing" (~lines 253–275) → **invert** (assert no row).
- "does NOT surface a prReady builder whose PR has been merged (Issue #901)" (~lines 222–251) → **remove** (the `recentlyMergedIssueIds` mechanism it exercises is deleted; covered now by "missing PR ⇒ no row").

### Non-Functional Tests
1. **Shared-consumer regression check** — adding `verify-approval` to `GATE_LABELS` does not break the VSCode Needs Attention tree / toast / status-bar counter (build + existing tests pass).
2. **Dead-code removal** — `recentlyMergedIssueIds` removed cleanly (type, computation, prop threading) with TypeScript build green; `fetchRecentMergedPRs` retained and the recentlyClosed PR-link enrichment still works.

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
**Date**: 2026-05-29
**Models Consulted**: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude (APPROVE) — 3-way, run by porch.

**Verdicts**: 2 APPROVE / 1 REQUEST_CHANGES. Codex's REQUEST_CHANGES asked for two ambiguities to be pinned down explicitly (shared `blocked` semantics for the `pr` gate; the `verify-approval` label string) — both now resolved in the spec. All three converged on the same design (Approach 1).

**Sections Updated from consultation**:
- **Desired State → "Scope of the no-builder-stand-in rule"** (new): resolves Codex #1 — keep `pr` in shared `GATE_LABELS`/`detectBlocked*` (VSCode bell + PR-row timestamp depend on it); enforce PR-as-PR-row only in the dashboard `buildItems`. Implemented via `if (b.prReady) continue;` (per Gemini).
- **Desired State → "pending gate predicate" invariant** (new): the builder caught that the gate-pending check must be `requested_at`-aware — a bare `gates['pr'] === 'pending'` (as one consultation suggested) would mis-flag every freshly-initialized project, since porch starts all gates `pending` with no `requested_at`. Verified against this project's own `status.yaml`.
- **Desired State → `verify-approval` label contract** (new): resolves Codex #2 / Claude #3 — label `"verify review"`, `gateKindClass` case, `.attention-kind--verify` CSS.
- **Current State**: flagged `detectBlockedSince`'s separate hardcoded gate array as a distinct sync point (Gemini's "implementation trap" / Claude #1); recommend unifying on `Object.keys(GATE_LABELS)`.
- **Current State**: documented that `fetchRecentMergedPRs`/`mergedPRs` has a *second* consumer (recentlyClosed `issueToPrUrl`), so the helper is **retained** — correcting Gemini's suggestion to delete it (builder verified against `overview.ts:971`).
- **Test Scenarios**: dropped the conditional on the `verify-approval` test; enumerated the **three** existing `NeedsAttentionList.test.tsx` tests that need inversion/removal (Claude #5); added the freshly-initialized-project guard test.
- **Open Questions**: the three "Important" design questions are now **resolved** with the consultation's recommendations.

Note: All consultation feedback has been incorporated directly into the relevant sections above.

## Approval
- [ ] Technical Lead Review (architect — `spec-approval` gate)
- [ ] Expert AI Consultation Complete (3-way)

## Notes

- **Net effect is deletion**: two fallbacks (`derivePrReady` bugfix branch, `buildItems` builder-emit branch), the `pr_ready_for_human` field *dependency*, and one data projection (`recentlyMergedIssueIds`) go away; one gate (`verify-approval`) is added to the human-gate allowlist; the `pr` gate is excluded from the *dashboard* gate-row path. The signal everything keys on already exists — the `pr` gate. `fetchRecentMergedPRs` is **retained** (second consumer: recentlyClosed PR links).
- **Scope discipline**: no new markers (req: out of scope), no change to pre-PR gate semantics (req: out of scope), no `verified → complete` rename (belongs to #919).

---

## Amendments

This section tracks any TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
