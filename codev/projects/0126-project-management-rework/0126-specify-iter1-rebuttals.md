# Rebuttal: Spec 0126 — Iteration 1

## Gemini (APPROVE)

No issues raised. Noted that legacy spec summary parsing is a solvable engineering detail — agreed, and now addressed explicitly in the spec under "getProjectSummary() replacement" and "Legacy spec compatibility."

## Codex (REQUEST_CHANGES)

### 1. PR-to-issue linkage rules
**Accepted.** Added "PR-to-issue linkage" section under Tower endpoint design. Uses GitHub closing keywords (`Fixes #N`, `Closes #N`) and existing commit message convention (`[Spec N]`, `[Bugfix #N]`). `linkedIssue` is `null` if no match found.

### 2. Label defaults for missing/ambiguous labels
**Accepted.** Added defaults: no `type:*` → feature, no `priority:*` → medium, multiple → first alphabetical.

### 3. Testing strategy
**Accepted.** Added "Testing Expectations" section covering Playwright (UI), unit tests (summary replacement, linkage parsing, label defaults), integration tests (spawn CLI, API endpoint, degraded mode), and E2E.

### 4. Error handling for `gh` auth failures and caching
**Accepted.** Added "Degraded mode" section: `/api/overview` still returns builders from Tower state, PRs/backlog empty with error message. Added cache behavior (60s TTL, in-memory, manual refresh endpoint). Added `codev doctor` check for `gh` authentication.

### 5. Multi-repo/forks
**Not applicable.** Codev assumes a single repo. This is consistent with existing behavior and not a regression.

### 6. `/api/overview` security
**Not applicable.** Dashboard runs locally on `localhost`. Tower is not exposed to the network. No auth needed.

## Claude (COMMENT)

### 1. Migration path (Medium)
**Accepted.** Added "Migration" section: `projectlist.md` becomes a dead file. No migration command, no deletion, no warnings. `codev init/adopt` stop creating it. `codev doctor` checks `gh` auth instead.

### 2. Unified positional arg resolution (Medium)
**Accepted.** Expanded the spawn flow to explicitly show: `--protocol` is required, drives the code path. No ambiguity. Also clarified that `gh issue view` is non-fatal (spec-only mode for legacy specs).

### 3. `getProjectSummary()` replacement (Medium)
**Accepted.** Added "getProjectSummary() replacement" section with three-step fallback: GitHub issue title → spec file first heading/paragraph → status.yaml title.

### 4. `projectlist-archive.md` (Low)
**Accepted.** Addressed in Migration section: same treatment as `projectlist.md` — dead file, no longer created.

### 5. Offline/degraded network (Low)
**Accepted.** Added degraded mode and network risk entries.

### 6. Cache TTL for backlog (Low)
**Accepted.** Clarified: same 60s TTL for both PR and issue data, in-memory cache, manual refresh via `POST /api/overview/refresh`.

### 7. Builder "Open" button tab behavior
**Accepted.** Clarified in Resolved Questions: opens in dashboard's tab bar, not a browser tab.

### 8. Issue/legacy ID collision
**Addressed in Resolved Questions.** Expected to be the same thing; if unrelated, spec file takes precedence.

### 9. Superseded spec 0119
**Addressed in Resolved Questions.** No work started on 0119, nothing to discard.
