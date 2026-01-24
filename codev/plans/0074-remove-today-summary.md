# Plan 0074: Remove Today Summary Dead Code

## Overview

Remove ~500 lines of dead backend code from `dashboard-server.ts` that remained after the frontend "Daily Activity Summary" feature was removed. Update documentation accordingly.

## Dependencies

None. This is a standalone cleanup task.

## Implementation Phases

```json
{
  "phases": [
    {
      "id": "phase_1",
      "title": "Remove Backend Code and Update Docs",
      "description": "Delete dead code from dashboard-server.ts, update arch.md, add regression test"
    }
  ]
}
```

### Phase 1: Remove Backend Code and Update Docs

**Goal:** Remove all activity summary code and update documentation.

**Files to modify:**

| File | Action |
|------|--------|
| `packages/codev/src/agent-farm/servers/dashboard-server.ts` | Remove lines 582-1091 (interfaces + functions + comment block) |
| `codev/resources/arch.md` | Remove `/api/activity-summary` and "Daily Activity Summary" references |
| `packages/codev/src/__tests__/dead-code.test.ts` | Create new file with regression test |

**Steps:**

1. **Remove dead code from dashboard-server.ts:**
   - Use the comment block `// Activity Summary (Spec 0059)` as the authoritative start boundary (not line numbers, which may drift)
   - Delete from that comment until `// Insecure remote mode`
   - This includes:
     - Interfaces: `Commit`, `PullRequest`, `BuilderActivity`, `ProjectChange`, `TimeTracking`, `ActivitySummary`, `TimeInterval`
     - Functions: `escapeShellArg`, `getGitCommits`, `getModifiedFiles`, `getGitHubPRs`, `getBuilderActivity`, `getProjectChanges`, `mergeIntervals`, `calculateTimeTracking`, `findConsultPath`, `generateAISummary`, `collectActivitySummary`
   - **Check for unused imports**: After deletion, remove any imports at the top of the file that are no longer used (e.g., imports that were only used by activity functions)

2. **Update arch.md:**
   - Remove the row for `/api/activity-summary` from the API endpoints table
   - Remove "Daily Activity Summary (Spec 0059)" from the Dashboard Features list
   - Remove mention from v1.5.x release notes if present

3. **Add regression test:**
   - Create `packages/codev/src/__tests__/dead-code.test.ts`
   - Test that `ActivitySummary` and related patterns are not present in dashboard-server.ts

**Verification:**

```bash
# TypeScript compiles
npm run typecheck

# All tests pass (including new regression test)
npm test

# No references remain (exclude the regression test file itself)
grep -r "ActivitySummary" packages/ --exclude="dead-code.test.ts"
grep -r "collectActivitySummary" packages/ --exclude="dead-code.test.ts"
```

**Success Criteria:**

- dashboard-server.ts compiles without errors
- All existing tests pass
- New regression test passes
- No grep matches for removed function names
- arch.md updated

## Estimated Scope

| Metric | Value |
|--------|-------|
| Lines removed | ~510 |
| Lines added | ~25 (regression test) |
| Net change | ~-485 lines |
| Files modified | 3 |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Code used elsewhere | Low | Medium | TypeScript compilation will catch; grep verification |
| Missing reference in docs | Low | Low | Search for "activity" in all docs |

## Consultation

| Model | Verdict | Confidence | Key Feedback |
|-------|---------|------------|--------------|
| Gemini 3 Pro | APPROVE | HIGH | Exclude test file from grep verification to avoid false positive |
| GPT-5 Codex | APPROVE | HIGH | Plan fully addresses spec's deletion, documentation, and testing needs |
| Claude | APPROVE | HIGH | Consider import cleanup; use comment markers as authoritative boundary |

**Incorporated suggestions:**
1. Updated verification grep commands to exclude `dead-code.test.ts` (Gemini)
2. Added note about checking for unused imports after deletion (Claude)
3. Changed to use comment markers as authoritative boundary instead of line numbers (Claude)

