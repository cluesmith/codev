# Rebuttals: data_layer Phase 1 — Iteration 1

## Gemini (REQUEST_CHANGES)

### 1. parseLinkedIssue only returns single issue
**Action: FIXED.** Created `parseAllLinkedIssues(body, title): number[]` in `github.ts` that uses global regex (`matchAll`) to extract all linked issues from closing keywords, `[Spec N]`, and `[Bugfix #N]` patterns. Updated `computeGitHubMetrics` to use it. Added test case for single PR with multiple issue references.

### 2. Missing test for single PR with multiple issues
**Action: FIXED.** Added test `counts all linked issues from a single PR with multiple references` that verifies `body: 'Fixes #42 and Fixes #73'` produces `projectsCompleted: 2`.

## Codex (REQUEST_CHANGES)

### 1. gh pr list vs gh search prs
**Rebuttal: INTENTIONAL DEVIATION.** `gh pr list --state merged --search "merged:>=DATE"` achieves the same server-side filtering as `gh search prs`, with the advantage of automatically scoping to the current repo via `cwd` (no need to determine `OWNER/REPO`). It also provides `mergedAt` which `gh search prs` lacks. Both Gemini and Claude explicitly approved this deviation.

### 2. parseLinkedIssue single-issue limitation
**Action: FIXED.** Same as Gemini item 1 above.

### 3. Partial GitHub failure not surfaced
**Rebuttal: BY DESIGN.** If one GitHub call fails but another succeeds, we have partial data that's still valuable. Setting `errors.github` would suggest all GitHub data is unreliable, when in fact the available data is correct. The spec says "each data source fails independently" — this means the GitHub source as a whole either works (possibly with partial data) or fails entirely (all three calls fail). The current behavior correctly reports an error only when no GitHub data is available at all.

### 4. activeBuilders as parameter vs overview cache
**Rebuttal: DESIGN IMPROVEMENT.** Passing `activeBuilders` as a parameter keeps `computeStatistics` decoupled from the tower's runtime state, making it pure and testable. Phase 2 wires up the active builder count from the workspace terminal registry in the route handler, which is the correct integration point.

## Claude (APPROVE)
No changes required.
