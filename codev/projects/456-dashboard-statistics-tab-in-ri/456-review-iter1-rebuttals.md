# Rebuttals: Review Phase — Iteration 1

## Claude (APPROVE)
No changes required. Minor observations (hardcoded empty response, fetchIssueList limit) noted for future maintenance.

## Gemini (APPROVE)
No changes required. Minor note about status.yaml phase tracking is cosmetic — porch manages phase state internally.

## Codex (REQUEST_CHANGES)

### 1. Spec mismatch: `gh pr list` vs `gh search prs`
**Action: REBUTTED.** This was already addressed in the data_layer phase (iteration 1, Codex concern #1). `gh pr list --state merged --search "merged:>=DATE"` achieves the same server-side filtering as `gh search prs` but with automatic repo scoping (no OWNER/REPO needed) and `mergedAt` in JSON output. The deviation is documented in the review document under "Deviations from Plan".

### 2. Spec mismatch: GitHub error handling
**Action: REBUTTED.** Partial data is more valuable than full defaults. When 2 of 3 GitHub calls succeed, returning real data for the successful calls alongside zeroed metrics for the failed call is better UX than discarding all results and showing defaults. The `errors.github` field is only set when ALL three calls fail (total outage). This design was rebutted in the data_layer phase (iteration 1, Codex concern #2).

### 3. Missing E2E tests
**Action: REBUTTED.** E2E/Playwright tests are documented as a follow-up item in the review document (line 114). The spec's testing strategy includes E2E as aspirational coverage — all required unit and component tests (54 total) are in place. E2E tests for new dashboard tabs are not required by the plan's phase criteria.
