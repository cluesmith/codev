# Spec 0074: Remove Today Summary Dead Code

## Summary

Remove the dead backend code from the "Daily Activity Summary" feature (Spec 0059) that remains in dashboard-server.ts after the frontend was removed. This is a cleanup task to reduce code size and maintenance burden.

## Background

Spec 0059 added a "What did I do today?" clock button to the dashboard that:
1. Collected activity data (git commits, PRs, builders)
2. Calculated time spent
3. Generated AI summary via `consult` CLI
4. Displayed in a modal with copy-to-clipboard

The **frontend** (activity.js, activity.css, modal HTML) was removed in commit e909095 ("remove dashboard Today Summary feature"). However, the **backend code** (~500 lines) remains in `dashboard-server.ts` as dead code:

- Interface definitions (lines 586-634): `Commit`, `PullRequest`, `BuilderActivity`, `ProjectChange`, `TimeTracking`, `ActivitySummary`, `TimeInterval`
- Helper functions (lines 639-1089):
  - `escapeShellArg()` - Shell argument escaping (used only by activity code)
  - `getGitCommits()` - Fetch today's commits
  - `getModifiedFiles()` - Get files modified today
  - `getGitHubPRs()` - Query GitHub PRs via gh CLI
  - `getBuilderActivity()` - Get builder status from state
  - `getProjectChanges()` - Parse projectlist.md diffs
  - `mergeIntervals()` - Merge overlapping time intervals
  - `calculateTimeTracking()` - Calculate active time
  - `findConsultPath()` - Find consult CLI path
  - `generateAISummary()` - Generate AI summary via consult
  - `collectActivitySummary()` - Orchestrate all data collection

The `/api/activity-summary` endpoint that called this code has already been removed.

## Problem Statement

Dead code increases:
- File size (dashboard-server.ts is already ~2200 lines)
- Maintenance burden (false positives in searches, outdated comments)
- Cognitive load when reading the file

## Solution

Remove all backend code related to the activity summary feature from dashboard-server.ts.

## Scope

### In Scope

1. Remove all interface definitions for activity summary (lines 582-634)
2. Remove all helper functions for activity summary (lines 639-1089)
3. Update architecture documentation (`codev/resources/arch.md`) to remove references to `/api/activity-summary` and "Daily Activity Summary"
4. Add test to verify the dead code is not present

### Out of Scope

1. Removing historical spec/plan/review files for 0059 (these serve as documentation)
2. Removing the feature from projectlist-archive.md (historical record)
3. Any other dashboard-server.ts refactoring

## Acceptance Criteria

1. **MUST**: All ActivitySummary-related interfaces removed from dashboard-server.ts
2. **MUST**: All activity collection functions removed from dashboard-server.ts
3. **MUST**: dashboard-server.ts compiles without errors after removal (`npm run typecheck`)
4. **MUST**: All existing tests pass (`npm test`)
5. **MUST**: arch.md updated to remove activity summary references
6. **MUST**: Add regression test to prevent resurrection (see Testing Strategy below)

## Technical Approach

This is a straightforward deletion. The code is contiguous (lines ~582-1089) with a clear comment marker ("Activity Summary (Spec 0059)").

### Files to Modify

| File | Action |
|------|--------|
| `packages/codev/src/agent-farm/servers/dashboard-server.ts` | Remove ~500 lines of dead code |
| `codev/resources/arch.md` | Remove activity summary references |

### Estimated Changes

- Lines removed: ~507 (dashboard-server.ts)
- Lines added: 0 (net negative)
- Documentation updates: ~5 lines in arch.md

## Testing Strategy

### Regression Test Requirements

Add a test to `packages/codev/src/__tests__/dead-code.test.ts` that ensures the activity summary code stays removed:

```typescript
import { readFileSync } from 'fs';
import path from 'path';

describe('Dead Code Prevention', () => {
  it('should not contain ActivitySummary code in dashboard-server.ts', () => {
    const dashboardServerPath = path.join(__dirname, '../agent-farm/servers/dashboard-server.ts');
    const content = readFileSync(dashboardServerPath, 'utf-8');

    // These patterns should not exist after removal
    const forbiddenPatterns = [
      'ActivitySummary',
      'collectActivitySummary',
      'getGitCommits',
      'getGitHubPRs',
      'getBuilderActivity',
    ];

    for (const pattern of forbiddenPatterns) {
      expect(content).not.toContain(pattern);
    }
  });
});
```

**Test location**: `packages/codev/src/__tests__/dead-code.test.ts` (new file)
**Test runner**: Jest (existing test infrastructure)
**Purpose**: Prevent accidental resurrection of the removed code

### Verification Steps

1. Run `npm run typecheck` to verify TypeScript compilation
2. Run `npm test` to verify all tests pass (including new regression test)
3. Run `grep -r "ActivitySummary" packages/` to verify no references remain

## Risks

| Risk | Mitigation |
|------|------------|
| Some code may be used elsewhere | Grep for function names before removal; TypeScript will catch compile errors |
| Tests may rely on interfaces | Run full test suite; interfaces are not exported |

## Success Metrics

1. dashboard-server.ts reduced by ~500 lines
2. Build passes
3. All tests pass
4. No grep matches for removed function names

## Consultation

### Round 1: Initial Spec Review

| Model | Verdict | Confidence | Key Feedback |
|-------|---------|------------|--------------|
| Gemini 3 Pro | APPROVE | HIGH | Spec is clear, precise, and low-risk |
| GPT-5 Codex | REQUEST_CHANGES | HIGH | Testing requirement is underspecified (where/how to add the grep-based safeguard) |
| Claude | APPROVE | HIGH | Clean, well-scoped deletion spec with clear boundaries |

**Codex Feedback (addressed):**
> The spec doesn't specify where that test should live, what runner to use, or how it integrates with the existing suite.

**Resolution**: Added "Testing Strategy" section with specific test file location (`packages/codev/src/__tests__/dead-code.test.ts`), sample test code, test runner (Jest), and verification steps.

