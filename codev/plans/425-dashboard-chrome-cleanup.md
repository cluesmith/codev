# Plan: Dashboard Chrome Cleanup

## Metadata
- **ID**: plan-2026-02-18-dashboard-chrome-cleanup
- **Status**: draft
- **Specification**: codev/specs/425-dashboard-chrome-cleanup.md
- **Created**: 2026-02-18

## Executive Summary

Minimal cleanup of dashboard chrome: replace "Agent Farm" branding with project name in header and tab title, remove redundant footer. Approach 1 (minimal) from the spec — frontend-only changes to App.tsx and index.css, plus Playwright test updates.

## Success Metrics
- [ ] Header shows `<project-name> dashboard` (or just `dashboard` for falsy workspace name)
- [ ] Footer/status bar removed (HTML + CSS)
- [ ] Browser tab title shows `<project-name> dashboard`
- [ ] Playwright E2E tests pass
- [ ] No visual regressions

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "chrome_cleanup", "title": "Header, footer, and title cleanup"},
    {"id": "test_updates", "title": "Playwright test updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Header, footer, and title cleanup
**Dependencies**: None

#### Objectives
- Replace header branding with project name
- Remove footer status bar
- Update browser tab title

#### Deliverables
- [ ] Updated App.tsx with new header, no footer, updated document.title
- [ ] Updated index.css with removed `.header-meta`, `.builder-count`, `.status-bar` rules

#### Implementation Details

**App.tsx** (`packages/codev/dashboard/src/components/App.tsx`):

1. **Document title** (lines ~43-50): Change from `${state.workspaceName} Agent Farm` / `Agent Farm` to `${state.workspaceName} dashboard` / `dashboard`. Treat falsy workspaceName (undefined, null, empty string) as unavailable.

2. **Header** (lines ~168-175): Replace:
   ```tsx
   <header className="app-header">
     <h1 className="app-title">Agent Farm</h1>
     <div className="header-meta">
       <span className="builder-count">
         {state?.builders?.length ?? 0} builder(s)
       </span>
     </div>
   </header>
   ```
   With:
   ```tsx
   <header className="app-header">
     <h1 className="app-title">
       {state?.workspaceName ? `${state.workspaceName} dashboard` : 'dashboard'}
     </h1>
   </header>
   ```

3. **Footer** (lines ~194-198): Remove the entire `<footer className="status-bar">...</footer>` block.

**index.css** (`packages/codev/dashboard/src/index.css`):

4. Remove `.header-meta` rule (lines ~76-79)
5. Remove `.status-bar` rule (lines ~242-253)
6. `.builder-count` has no CSS rule — nothing to remove

#### Acceptance Criteria
- [ ] Header shows workspace name + "dashboard" when name available
- [ ] Header shows just "dashboard" when workspace name is falsy
- [ ] No footer rendered
- [ ] Tab title matches header text
- [ ] Dashboard layout fills space correctly without footer

#### Rollback Strategy
Revert the two file changes (App.tsx, index.css).

---

### Phase 2: Playwright test updates
**Dependencies**: Phase 1

#### Objectives
- Update Playwright tests that assert on "Agent Farm" text
- Verify no other tests break from removed elements

#### Deliverables
- [ ] Updated `tower-integration.test.ts` assertion
- [ ] Verified `dashboard-bugs.test.ts` still passes
- [ ] All E2E tests pass

#### Implementation Details

**tower-integration.test.ts** (`packages/codev/src/agent-farm/__tests__/e2e/tower-integration.test.ts`):
- Line 49: Change `toContainText('Agent Farm')` → `toContainText('dashboard')`
- Line 92: `.app-title` visibility check — no change needed (class preserved)

**dashboard-bugs.test.ts** (`packages/codev/src/agent-farm/__tests__/e2e/dashboard-bugs.test.ts`):
- Line 92: `.app-title` visibility check — no change needed (class preserved)

#### Acceptance Criteria
- [ ] `tower-integration.test.ts` passes with updated assertion
- [ ] `dashboard-bugs.test.ts` passes unchanged
- [ ] No other E2E tests broken

#### Rollback Strategy
Revert test file changes.

## Validation Checkpoints
1. **After Phase 1**: Visual check — dashboard header shows project name, no footer
2. **After Phase 2**: All Playwright E2E tests pass

## Approval
- [ ] Technical Lead Review
- [ ] Expert AI Consultation Complete
