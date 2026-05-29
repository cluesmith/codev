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

## 2026-05-29 — spec-approval APPROVED by architect → Plan phase

Architect approved spec-approval. **Coordination note from architect (load-bearing for the plan):**
the change touches SHARED infra — keeping `pr` in detectBlocked/GATE_LABELS AND adding `verify-approval`
to GATE_LABELS affects **VSCode** (Needs Attention tree, gate toast, status-bar counter), not just the
dashboard. **Amr (owns area/vscode) is looped in on #927.** Plan MUST:
- treat VSCode consumers of detectBlocked/GATE_LABELS as an explicit **blast-radius item with their own
  test coverage**;
- flag anything needing Amr's eyes.
Do NOT advance past plan-approval without the human.

## 2026-05-29 — Plan drafted (3 phases)

Plan at `codev/plans/927-...md`, checks pass (plan_exists, has_phases_json, 3 phase ids). Phasing chosen so
every commit type-checks + tests green in BOTH packages, and the VSCode blast radius is concentrated in Phase 1:

1. **server-derivation** (`packages/codev` overview.ts + `packages/types`): gate-authoritative `derivePrReady`
   (requested_at-aware, drop bugfix branch + field dependency); add `verify-approval`→`"verify review"` to
   GATE_LABELS; unify `detectBlockedSince` on `Object.keys(GATE_LABELS)`. **Does NOT remove
   recentlyMergedIssueIds** (keeps dashboard green). ← shared infra / VSCode blast radius lives here.
2. **dashboard-surfacing** (`packages/dashboard`): delete builder-emit branch; `if (b.prReady) continue;`;
   add verify gateKindClass + `.attention-kind--verify` CSS; stop consuming recentlyMergedIssueIds (drop prop +
   WorkView pass); invert 2 tests, remove 1.
3. **remove-dead-projection** (`packages/codev` + types): delete recentlyMergedIssueIds field+computation;
   **RETAIN fetchRecentMergedPRs** (issueToPrUrl/recentlyClosed).

VSCode blast radius (architect's coordination note) is an explicit cross-cutting section: consumers verified
(`views/builders.ts`, `notifications/gate-toast.ts`, `commands/approve.ts`, `extension.ts` status bar; tests
`test/builders.test.ts`, `__tests__/menu-when-clauses.test.ts`). `pr` stays in GATE_LABELS → no VSCode regression
by construction. New: verify-approval surfaces as a blocked builder in VSCode (intended; flagged for **Amr** at
plan-approval — open Q: does VSCode want a GATE_ACTIONS "Verify" entry? additive follow-up, not a blocker).

Next: commit plan draft → `porch done` → 3-way consult.

## 2026-05-29 — Plan 3-way consult done

**Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES** (all HIGH). Codex's REQUEST_CHANGES was about
strengthening the plan as an execution guide, not a design problem:
- (#1) VSCode blast radius was *discussed* not *owned* → moved concrete VSCode work INTO Phase 1
  (files: `packages/types/src/api.ts` prReady-comment rewrite + `packages/vscode/src/test/builders.test.ts`;
  added VSCode acceptance criteria + test-plan items; `pr` regression-guarded).
- (#2) Phase 1 title says "+ types" but omitted api.ts → added api.ts (prReady doc comment, L183-194 describes
  the old derivation).
Claude obs-a (VSCode test-scope ambiguity) → resolved by labeling the checkboxes "OWNED BY PHASE 1".
Claude obs-b (pre-existing `dev review` gateKindClass styling gap) → added as a **flagged optional drive-by** in
Phase 2, default OUT of scope pending architect okay.

Two architect/Amr decisions teed up at plan-approval: (1) VSCode verify-approval UX (surface as blocked? want a
GATE_ACTIONS "Verify" action?); (2) include the dev-review styling drive-by or not (default: no).

Next: write plan rebuttal → commit → `porch done` → expect plan-approval gate (STOP, notify architect + note Amr).

## 2026-05-29 — plan-approval APPROVED → Implement

Architect approved plan-approval. Confirmed decisions:
- (2) dev-review gateKindClass drive-by → **OUT of scope** (file separately if ever).
- Amr has NOT weighed in on verify-approval VSCode UX → proceed with plan **DEFAULT**: surface verify-approval
  as a blocked builder in VSCode tree/toast/status-bar via the gate-toast **generic fallback**. A dedicated
  'Verify' GATE_ACTION is a **non-blocking additive follow-up** — do NOT block implementation on it.
- Sequence **Phase 1 first** (shared overview infra + the VSCode blast-radius tests it owns), keep EVERY phase
  commit green in BOTH packages, and **render-verify the dashboard** (esp. new `--verify` styling) before PR.
- Next gate = **pr gate at the PR** (human's call). No autonomous per-phase PRs.

Starting Phase 1 implementation.

## 2026-05-29 — Phase 1 (server-derivation) implemented

Edits:
- `overview.ts`: `derivePrReady` → gate-authoritative (`gates['pr']==='pending' && requested_at`), dropped
  field dependency + bugfix branch; `GATE_LABELS` += `'verify-approval':'verify review'`; `detectBlockedSince`
  now iterates `Object.keys(GATE_LABELS)` (no more separate hardcoded array); `OverviewBuilder.prReady` comment.
- `packages/types/src/api.ts`: `prReady` doc comment → gate-authoritative.
- `overview.test.ts`: rewrote derivePrReady block (universal-gate true; requested_at-guard false;
  approved false; ignores pr_ready_for_human; no bugfix-verified fallback); added verify-approval cases to
  detectBlocked + detectBlockedSince.
- `packages/vscode/src/test/builders.test.ts`: added `orderForDisplay — #927 gate blast radius` suite
  (verify-review-blocked → blocked bucket; PR-review unchanged; sort together by blockedSince). Extended
  `builder()` helper with `blockedLabel`.

**Worktree-setup gotcha (cohort note):** this self-hosted codev repo has **no `worktree.postSpawn`** in
`.codev/config.json`, so the worktree spawned WITHOUT `node_modules` (root missing; vitest unresolvable).
Builders here must `pnpm install --frozen-lockfile` from the worktree root before any build/test/porch-check.
Running that now.

porch checks (from protocol.json): `build` = root `npm run build` (core + codev, incl. dashboard; NOT vscode);
`tests` = `pnpm --filter @cluesmith/codev test` (codev vitest only — NOT vscode, NOT dashboard). So Phase 1's
overview.test.ts IS gated by porch; the vscode test is verified separately (porch won't run it).

**Phase 1 verification + 3-way:** porch `build` ✓ (5s) + `tests` ✓ (20s). vscode `compile-tests` (tsc) ✓
(builders.test.ts is a vscode-test/Electron mocha test — vitest doesn't glob `src/test/`; full Electron run
is area/vscode CI). 3-way impl consult: **Gemini APPROVE, Codex APPROVE, Claude APPROVE** (all HIGH, no
issues). Note: Gemini's FIRST run errored on a consult infra flake ("Tool run_shell_command not found", no
verdict/file) — retried, clean APPROVE. Phase 1 unanimous, no rebuttal needed. Committed a4941322.

Next: `porch done`/`next` → advance to Phase 2 (dashboard-surfacing). Per porch's reminder, /compact before
the new phase if context is heavy.

## 2026-05-29 — Phase 2 (dashboard-surfacing) implemented

Edits (`packages/dashboard`):
- `NeedsAttentionList.tsx` buildItems: deleted the builder-emit branch + bookkeeping
  (emittedPrReadyIssueIds, mergedIssueIdSet, recentlyMergedIssueIds param); builder loop now `if (b.prReady)
  continue;` then gate rows for `b.blocked && b.blockedSince` (covers spec/plan/dev/verify; pr excluded because
  pr-gate builders are prReady → skipped). gateKindClass += `verify review → attention-kind--verify`.
- `index.css`: `.attention-kind--verify` (review-style accent, var(--status-waiting)).
- `WorkView.tsx`: dropped `recentlyMergedIssueIds` prop pass; prop removed from NeedsAttentionListProps.
- tests: inverted the 2 "missing PR still surfaces builder" → assert no row; replaced merged-suppression test
  with "missing PR ⇒ no row"; added verify-approval gate-row test. 14/14 pass.

**porch check gating note:** porch `tests` = `pnpm --filter @cluesmith/codev test` runs ONLY codev tests, NOT
dashboard tests. So Phase 2's NeedsAttentionList.test.tsx is NOT porch-gated — I run it manually
(`pnpm --filter @cluesmith/codev-dashboard exec vitest run`). porch `build` DOES type-check the dashboard
(codev build includes dashboard), so the WorkView/buildItems signature changes are gate-covered. porch
build ✓ + tests ✓; dashboard tests 14/14. Committed 36523a35.

Render-verify of the `--verify` styling: deferred to before-PR (Phase 3 doesn't touch dashboard rendering, so
the dashboard state is final after Phase 2). Will render Needs Attention (PR row + verify gate row + empty) per
architect's pre-PR instruction.

Next: Phase 2 3-way impl consult → advance to Phase 3 (remove-dead-projection).

## 2026-05-29 — Phase 2 3-way: Codex REQUEST_CHANGES (valid) → fixed

**Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES** (all HIGH). Codex's catch was correct and I agree:
Phase 2 carried over the OLD gateless-BUGFIX shape (prReady=true with no gate/no blockedSince) which is
IMPOSSIBLE under Phase-1 gate-authoritative derivePrReady. Two problems:
- C1: `waitingSince: readySince || pr.createdAt` let an *affiliated* PR fall back to createdAt — spec says
  affiliated uses the gate timestamp (blockedSince) exclusively; createdAt is unaffiliated-only.
- C2: tests at :86 ("BUGFIX has no gate") and :160 ("falls back to createdAt w/o blockedSince") encoded the
  impossible shape and locked in the stale fallback.

Fixes:
- Code: `const waitingSince = prReady ? (readySince ?? pr.createdAt) : pr.createdAt;` — affiliated→gate time
  (the `??` is now an unreachable type guard, documented), unaffiliated→createdAt.
- Tests: reframed :86 to post-#887 gate shape (asserts waitingSince===blockedSince); removed :160
  (impossible shape); strengthened the human-PR test to assert waitingSince===createdAt. 13/13 pass.

Good scrutiny outcome: this is the 3rd time scrutinizing reviewer feedback paid off (1st: caught Gemini's bad
gate-check + helper-delete suggestions on spec; here: Codex's valid catch I accepted in full). Wrote rebuttal,
re-running porch check → porch done → expect iter-2 consult.

## 2026-05-29 — Phase 2 iter-2 UNANIMOUS APPROVE → Phase 3

Phase 2 iter-2: **Gemini APPROVE, Codex APPROVE (confirms fallback fixed), Claude APPROVE** (all HIGH).
Phase 2 done. (Porch quirk: after committing the fix + `porch done`, the first `porch next` re-showed the
iter-2 implement prompt; a second `porch done` → "ready for verification" → `porch next` then yielded the
iter-2 consult task with `--context …iter2-context.md`. The consults use iterN-context.md to carry the rebuttal.)

## 2026-05-29 — Phase 3 (remove-dead-projection) implemented

Edits:
- `packages/types/src/api.ts`: removed `recentlyMergedIssueIds` field + doc comment from OverviewData.
- `overview.ts`: removed the field from the local OverviewData interface, deleted the computation block
  (#901 merged-issue projection), and dropped it from the returned `result`. **KEPT** `fetchRecentMergedPRs`,
  the `mergedPRs` Promise.all fetch, and the `issueToPrUrl` build (recentlyClosed PR-link enrichment).
- `overview.test.ts`: removed the 2 recentlyMergedIssueIds tests + the empty-array assertion in the
  null-mergedPRs test. The positive prUrl-enrichment test (L1853) stays → proves fetchRecentMergedPRs retained.
- grep clean: only remaining ref is an explanatory comment in NeedsAttentionList.test.tsx (documents the removal).

Running porch check (build type-checks dashboard+codev w/o the field) + dashboard tests.

## 2026-05-29 — Phase 3 UNANIMOUS APPROVE → Review phase

Phase 3 3-way: **Gemini APPROVE (HIGH), Codex APPROVE (MED), Claude APPROVE (HIGH)** — no issues. All 3
implement phases done. porch → **review** phase. Checks: pr_exists, review_has_arch_updates,
review_has_lessons_updates, e2e_tests (e2e soft-skips: no root test:e2e script).

**Render-verify (architect's pre-PR instruction + UI-PR policy):** built the dashboard, loaded the REAL built
CSS + exact NeedsAttentionList row DOM in headless chromium. `.attention-kind--verify` → `rgb(234,179,8)`
(=--status-waiting, == PR row), ≠ spec (red), ≠ unstyled control. Proves the new className gets styling (no
"className w/o CSS" gap). Screenshot tmp/verify-render.png. Harness in tmp/ (NOT committed).

Net change: **−45 LOC** (227+/272−, 8 files) — a deletion, as designed.

Wrote review doc (codev/reviews/927-...md) with Architecture Updates (universal-pr-gate contract +
dashboard-local rule + render-verify evidence) and Lessons Learned Updates. Next: commit review → push →
open PR → porch done (review checks) → CMAP-at-PR → pr gate (HUMAN merges).

## 2026-05-29 — PR #928 opened; PR-level CMAP iter-1

PR #928 created. Review checks all ✓ (pr_exists, review_has_arch_updates, review_has_lessons_updates,
e2e_tests[soft-skip]). PR-level CMAP: **Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES**.
- C1 (FIXED, legit): spec/plan were still `Status: draft` with no `approved`/`validated` frontmatter — SPIR
  final-approval steps require it. Added frontmatter (approved: 2026-05-29, validated: [gemini,codex,claude]) +
  flipped Status→approved on both.
- C2 (REBUTTED): `dev review` gateKindClass styling gap — architect EXPLICITLY ruled this OUT of scope at
  plan-approval. Rebutted citing that decision; tracked as a follow-up. Not a #927 correctness issue (Codex agrees).
Committed + pushed (PR auto-updates). porch done → re-consult iter-2.

## 2026-05-29 — pr gate APPROVED → MERGED → verify phase

Architect approved the pr gate and authorized merge. Merged PR #928 via `gh pr merge 928 --merge --admin`
(branch protection needs admin override this cycle — no second same-identity reviewer; regular merge commit
0e300f3c, NOT squash). porch done → review checks ✓ → advanced to optional **verify** phase.

**Post-merge integration verification (done):**
- Merge clean, no conflicts.
- None of my 8 touched files were modified by the other PRs that merged this cycle (#902/#904/#923/#924) —
  checked `git log 94df5d75..origin/main` per file.
- No dangling `recentlyMergedIssueIds` consumer introduced by any parallel PR (`git grep` on origin/main →
  only the explanatory comment in NeedsAttentionList.test.tsx).
- ⇒ integrated main's #927 behavior == my verified branch state (unit tests + headless-chromium render-verify
  all passed pre-merge). No separate rebuild needed — identical code.

Per architect: this PR **retires #902's recentlyMergedIssueIds mechanism** and **reconciles the now-closed #919**
(#919's NA/derivePrReady parts superseded; terminal-rename was its remaining scope, architect closed it). The
**dev-review gateKindClass styling** stays a separate issue (architect will file).

Running `porch done` → requests verify-approval gate (HUMAN approves). I will NOT approve it.
