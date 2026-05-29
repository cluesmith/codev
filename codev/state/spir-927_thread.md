# spir-927 — Needs Attention: surface PRs via the universal pr gate

## 2026-05-29 — Specify phase started

Strict-mode SPIR builder for #927. Porch is at `specify`; no spec existed, so I'm authoring one.

### What I learned from the code (grounding the spec)

- **`derivePrReady`** (`packages/codev/src/agent-farm/servers/overview.ts:493`): prefers porch's
  `pr_ready_for_human` field, else falls back to `pr` gate pending **OR** `bugfix && phase==='verified'`.
  The bugfix branch is the gateless-variant crutch the issue wants deleted. Upstream BUGFIX now carries a
  `pr` gate (#887), so the branch is dead weight upstream.
- **`pr_ready_for_human`** is written `true` *only* when the `pr` gate is auto-requested (next.ts:756,
  index.ts:499) and cleared on pr-gate approval (index.ts:753) and on rollback (index.ts:849). So for every
  upstream protocol `pr_ready_for_human === true` ⟺ `pr` gate `pending`. They are coincident.
- **`buildItems`** (`packages/dashboard/src/components/NeedsAttentionList.tsx:51`): first loop emits PR rows
  for open PRs whose builder is `prReady` (or unaffiliated REVIEW_REQUIRED); second loop has the
  **builder-emit branch** (lines 128-140) that emits a *builder* row when a prReady builder's PR is missing
  from `prs` — the thing the issue wants deleted. The gate-row path (142-153) handles spec/plan/dev.
- **`GATE_LABELS`** (overview.ts:430) = {spec-approval, plan-approval, dev-approval, pr}. **`verify-approval`
  is NOT here** — so a pending verify-approval gate currently does not surface anywhere (dashboard, VSCode tree,
  toast, status bar all key off `detectBlocked`). Issue req 3 lists verify-approval as something to surface →
  this is a gap to close.
- **SPIR protocol.json**: verify phase carries `gate: verify-approval` (real, post-merge, architect-approved).
- **`recentlyMergedIssueIds`** (#902): consumed ONLY by the builder-emit branch (mergedIssueIdSet, line 129).
  Delete that branch → the field is dead → removable end-to-end (api.ts type, overview.ts compute 1006-1021,
  WorkView prop, NeedsAttentionList prop).
- **#919** (verified→complete rename): its needs-attention/derivePrReady parts become unnecessary under this
  model. The rename is independent honesty work — NOT done here; reconcile by descoping #919's NA parts.

### Design crux for the spec
Contract: a PR surfaces iff (linked builder's `pr` gate is `pending`) AND (PR is open / in `pendingPRs`).
Never a builder standing in for a PR. The `pr` gate must be **excluded** from the gate-row loop (it surfaces
as a PR row, not a builder row) — otherwise a cache-miss pr-gate builder would fall through and emit the very
builder row we're deleting.

### Decisions surfaced to architect/reviewers (see spec Open Questions)
1. Add `verify-approval` to the gate-row allowlist (closes the gap; broadens to shared GATE_LABELS consumers).
2. Remove `recentlyMergedIssueIds` end-to-end (recommended) vs leave vestigial.
3. `derivePrReady` form: gate-authoritative (recommended, kills #919 sticky-field hazard) vs field-first-minus-fallback.
4. EXPERIMENT/MAINTAIN completion-gate surfacing: documented as out-of-scope (not regressions of this work).

## 2026-05-29 — 3-way consultation done (spec iter-1)

Verdicts: **Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES** (Codex just wanted two things pinned
down explicitly — now resolved). All three converged on Approach 1. Incorporated:

- **Shared-infra decision (Codex #1)**: keep `pr` in `GATE_LABELS`/`detectBlocked*` (VSCode bell +
  PR-row waiting-since depend on it). "No builder stand-in" is **dashboard-local** → `if (b.prReady) continue;`
  in buildItems (Gemini's clean one-liner).
- **`requested_at` invariant (my catch, NOT a reviewer's)**: a bare `gates['pr']==='pending'` check (Gemini's
  suggested simplification) is WRONG — porch inits ALL gates to `pending` with no `requested_at` (verified in
  927's own status.yaml). The predicate MUST be `pending && requested_at present`. Pinned in spec.
- **`fetchRecentMergedPRs` retention (my catch)**: Gemini said delete the helper. WRONG — `mergedPRs` has a
  second consumer at overview.ts:971 (issueToPrUrl for recentlyClosed). Helper stays; only the
  `recentlyMergedIssueIds` projection is removed. Corrected in spec.
- **verify-approval label (Codex #2 / Claude #3)**: pinned to `"verify review"` + gateKindClass +
  `.attention-kind--verify` CSS.
- **detectBlockedSince sync point (Gemini/Claude)**: separate hardcoded array; recommend unifying on
  `Object.keys(GATE_LABELS)`.
- **Tests (Claude #5)**: THREE existing NeedsAttentionList tests to invert/remove (lines ~183, ~253 invert;
  ~222 merged-suppression removed).

Lesson reinforced: scrutinized reviewer suggestions before applying — caught two over-confident Gemini
recommendations (bare gate check; delete helper) that would have introduced bugs.

Committing reviewed spec, then `porch next` → should hit spec-approval gate (STOP, notify architect).
