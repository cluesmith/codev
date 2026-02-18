# Specification: Dashboard Chrome Cleanup

## Metadata
- **ID**: spec-2026-02-18-dashboard-chrome-cleanup
- **Status**: draft
- **Created**: 2026-02-18
- **GitHub Issue**: #425

## Clarifying Questions Asked

The issue description is detailed and prescriptive. Key decisions to note:

1. **Q: What to show in the header?** A: Replace "Agent Farm" with `<project-name> dashboard`. Remove builder count badge. The issue offers several options for the freed whitespace; this spec proposes the minimal approach (just project name, clean).

2. **Q: What about the footer?** A: Remove the "N builders N shells N files" counts entirely. These are redundant with the tab layout which already shows what's running.

3. **Q: Tab title format?** A: Change from `{workspaceName} Agent Farm` to `{workspaceName} dashboard` (or just `{workspaceName} dashboard` with fallback to `dashboard`).

## Problem Statement

The dashboard wastes its most prominent screen real estate on redundant and unhelpful chrome:

1. **Header**: Shows "Agent Farm" with a builder count badge. "Agent Farm" is branding, not useful information. The builder count is redundant with the tab layout.
2. **Footer**: Shows "N builders N shells N files" counts. This is entirely redundant with the tab bar which already shows these items.
3. **Tab title**: Shows `{workspaceName} Agent Farm` or just `Agent Farm`. The "Agent Farm" branding is not helpful, especially when multiple dashboards could be open.

## Current State

- **Header** (`App.tsx` lines ~168-175): Displays hard-coded "Agent Farm" title on the left, builder count badge on the right. Takes 40px height.
- **Footer** (`App.tsx` lines ~194-198): Displays builder, shell, and file counts. Takes 24px height.
- **Tab title** (`App.tsx` lines ~43-50): Sets `document.title` to `{workspaceName} Agent Farm` or just `Agent Farm`.
- **Workspace name** is already available via `state.workspaceName` (derived from `path.basename(workspacePath)` on the backend).

## Desired State

- **Header**: Shows `<project-name> dashboard` (e.g., "codev-public dashboard") left-aligned. No badge, no `.header-meta` wrapper. Clean and minimal. The word "dashboard" is always lowercase. Header height remains 40px.
- **Footer**: Removed entirely — both HTML elements and associated CSS (`.status-bar`). The 24px is reclaimed for content.
- **Tab title**: Shows `<project-name> dashboard` (e.g., "codev-public dashboard"). Falls back to just `dashboard` if workspace name is unavailable.
- **Fallback rule**: Treat falsy `workspaceName` (undefined, null, or empty string `""`) as unavailable. Fall back to just `dashboard`.

## Stakeholders
- **Primary Users**: Developers using the Agent Farm dashboard
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] Header displays `<project-name> dashboard` instead of "Agent Farm" + builder count badge
- [ ] Footer/status bar is completely removed (HTML + CSS)
- [ ] Browser tab title shows `<project-name> dashboard`
- [ ] Fallback behavior works when workspace name is unavailable
- [ ] No visual regressions in remaining dashboard layout
- [ ] Existing Playwright tests pass (or are updated to match)

## Constraints
### Technical Constraints
- Must use the existing `state.workspaceName` value (already provided by the backend)
- Dashboard is a Preact app bundled with esbuild
- Changes are limited to the dashboard frontend; no backend changes needed
- **Scope**: Only modify `App.tsx` header/footer/title. Do not change other "Agent Farm" references in other views (e.g., WorkView's `.projects-info h1` at `dashboard-bugs.test.ts:168` is out of scope)

### Business Constraints
- None specific beyond keeping the dashboard functional

## Assumptions
- `state.workspaceName` always returns a usable project name (derived from `path.basename()` of the workspace path)
- The tab layout already provides sufficient visibility into active builders/shells/files
- No other components depend on the header's builder count badge or the footer counts

## Solution Approaches

### Approach 1: Minimal Cleanup (Recommended)
**Description**: Replace header text with project name, remove footer entirely. Clean and minimal.

**Pros**:
- Simple, low-risk change
- Recovers 24px of vertical space from footer
- Removes redundant information
- Aligns with issue's "nothing - just the project name left-aligned, clean and minimal" option

**Cons**:
- Leaves header whitespace on the right empty (but this is intentional - clean)

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Minimal Cleanup + Header Metadata
**Description**: Same as Approach 1, but add tower version/uptime to the header's right side.

**Pros**:
- Uses freed header space for genuinely useful info
- Version/uptime is not available elsewhere in the UI

**Cons**:
- Requires new backend data (tower version, uptime) to be added to the state API
- Slightly increases scope

**Estimated Complexity**: Medium
**Risk Level**: Low

## Open Questions

### Critical (Blocks Progress)
- None - the issue is clear and prescriptive

### Important (Affects Design)
- [x] Should we use Approach 1 (minimal) or Approach 2 (with metadata)? **Decision: Approach 1 - keep it minimal. Metadata can be added later via a separate spec.**

### Nice-to-Know (Optimization)
- [ ] Should the header height be reduced now that it only shows text? (Currently 40px - probably fine as-is for visual balance)

## Performance Requirements
- No performance impact expected (removing elements, not adding)

## Security Considerations
- No security implications

## Test Scenarios
### Functional Tests
1. Header shows project name + "dashboard" when workspace name is available
2. Header shows just "dashboard" when workspace name is unavailable
3. Tab title matches the header text
4. Footer is not rendered
5. Layout remains correct without footer (no gaps, content fills space)

### Non-Functional Tests
1. Existing Playwright E2E tests pass or are updated to reflect the changes

## Dependencies
- None - all required data (`workspaceName`) already exists

## Known Test Impacts
- **`tower-integration.test.ts:49`**: Asserts `toContainText('Agent Farm')` on `.app-title` — **will break**, must be updated to assert `dashboard` or project-name-based text.
- **`dashboard-bugs.test.ts:92`**: Asserts `.app-title` `toBeVisible()` — will still pass if `.app-title` class is preserved.
- **`dashboard-bugs.test.ts`**: References `.projects-info`, `.dashboard-header`, `.section-tabs` — these may target legacy layout elements and should be audited during implementation.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Playwright tests reference removed elements | High | Low | Update test selectors/assertions (known: `tower-integration.test.ts:49`) |
| Other components depend on footer | Low | Low | Search codebase for references |
| Long workspace names overflow header | Low | Low | Existing CSS handles text overflow; verify during implementation |

## Expert Consultation
**Date**: 2026-02-18
**Models Consulted**: Gemini, Codex (GPT), Claude
**Sections Updated**:
- **Desired State**: Added explicit fallback rule for falsy workspaceName (empty string edge case) per Claude/Codex feedback
- **Desired State**: Specified lowercase "dashboard", header height stays 40px, explicit CSS cleanup per Codex feedback
- **Constraints**: Added scoping note — only App.tsx, not other "Agent Farm" references per Claude feedback
- **Known Test Impacts**: New section identifying specific tests that will break per Gemini/Claude feedback
- **Risks**: Updated Playwright test risk from Medium to High probability, added long workspace name overflow risk per Codex feedback

All three models approved (Gemini: APPROVE, Codex: COMMENT with minor suggestions incorporated, Claude: APPROVE).

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete
