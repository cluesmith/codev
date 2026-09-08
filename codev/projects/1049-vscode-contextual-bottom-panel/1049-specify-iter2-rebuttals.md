# Rebuttal — Spec 1049, Specify iteration 2 (post no-pin rewrite)

Verdicts: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude COMMENT** — all high-confidence. Claude re-verified every codebase claim against source and found the accuracy "unusually high"; the design is validated. The remaining points are refinements, and I adopted essentially all of them. The two reviewers converged on one genuine bug in my spec (the terminal-exit path), which was the most valuable finding.

## Codex (REQUEST_CHANGES)

1. **Scope contradiction: summary lists + drill-in required, but all mode content is placeholder.**
   Adopted. Added a Success Criterion defining the *minimum navigation UI* the umbrella ships: Code Review / Builder Inspector summary placeholders render a minimal clickable list of builder *ids* (cheaply enumerable from `ReviewQueueStore.buildersWithPending()` / `OverviewCache`), and a row drill-in switches to that builder's detail placeholder. Rich per-row content stays with the participating issues. This makes transient nav + drill-in demonstrable without importing feature content.

2. **Define editor-vs-terminal focus semantics now; `activeTerminal`/`onDidChangeActiveTerminal` don't represent every transition.**
   Adopted (and this matched Claude's strongest point). Reframed the active-surface open question from a settled lean to an **API-feasibility question**: the exit path (focus back to an already-active editor) fires none of the enumerated events while `activeTerminal` stays set, so the plan must add an editor-focus proxy (`onDidChangeTextEditorSelection` + a webview/terminal focus signal) and accept residual "fires nothing" cases. Also updated the trigger-set Constraint and added a dedicated "never exits" Risk row.

3. **Lock predicate precedence in the spec, not the plan gate.**
   Adopted. Fixed the order in Success Criteria: `builder-terminal → builder-diff → artifact-path → attention`, with the overlap rationale stated. No longer deferred.

4. **Clarify inapplicable-pill behavior; Document Review has no summary, so clicking it without an artifact is undefined.**
   Adopted. Added a navigability criterion: Code Review / Builder Inspector / Attention are always navigable (they have a summary/global view); Document Review is disabled (greyed, non-clickable, hover hint) when no artifact is active. Reconciled the Desired State paragraph to match.

5. **Remove or reconcile sticky-input — deferral conflicts with "every surface change immediately clears and follows context within ~50 ms."**
   Adopted by **removing sticky-input from the umbrella**. The panel always follows context immediately on a surface change; in-progress input preservation is a participating-mode concern (a mode persists/restores its own draft). This resolves the contradiction in favor of the architect's "purely contextual" principle. Dropped the sticky-input open question and its risk row.

## Claude (COMMENT)

1. **"Most-recently-focused wins" is likely not implementable — terminal-exit path fires no event (source-verified).**
   The strongest point; adopted as in Codex #2. Reframed as a feasibility question, updated the trigger-set constraint, and added the "never *exits*" risk (the Risks table previously only covered "never *triggers*").

2. **Stale constraint — the issue was already amended to no-pin.**
   Correct; adopted. Dropped the "issue body should be amended" clause (I had amended #1049 between writing that line and this review).

3. **`codev.panelContainerEmpty` / `codev.placeholder` disposition under-specified; three test files will break.**
   Adopted. Added a Constraint: the contextual view is always present, so the placeholder + gate are retired; named the three manifest-invariant tests (`contributes-panel.test.ts`, `panel-placeholder.test.ts`, `contributes-dev.test.ts`) that will be updated.

4. **Summary/detail render-target tension — Document Review summary is "N/A" but a criterion mandates a target per mode *and* per level.**
   Adopted. Stated **seven** targets explicitly (Doc Review detail-only; Code Review + Builder Inspector each summary+detail; Attention summary-only) and that the resolver never emits `{document-review, summary}`.

5. **~50 ms budget isn't automatically testable across `postMessage`.**
   Adopted. Split: O(1)/no-IO is the automated assertion; ~50 ms is a dev-approval feel check. Fixed in both Success Criteria and Test Scenarios.

## Gemini (APPROVE)

No changes requested; endorsed the precedence order and (as an optional plan-phase note) the editing-defer signal. The precedence order is now locked in the spec per its suggestion; the editing-defer signal was dropped in favor of "participating mode owns its draft" per the reconciliation above.

## Not adopted

- None outright. The only reviewer suggestion I deliberately went *against* is Gemini's/my own earlier `isEditing` defer signal — removed rather than kept, because Codex correctly showed it contradicts the immediate-follow-context model. Draft preservation is pushed to participating modes instead.
