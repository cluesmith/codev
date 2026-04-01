# Specification: Team Page — Show Issue/PR Details and Activity Feed

## Metadata
- **ID**: spec-2026-04-01-team-page-detail
- **Status**: draft
- **Created**: 2026-04-01

## Clarifying Questions Asked
No clarifying questions needed — the issue description (#650) is detailed and the existing data structures are well-defined.

## Problem Statement
The team page currently renders only aggregate counts ("3 issues", "2 PRs") for each member. The backend fetches issue/PR details via GraphQL, but the frontend discards this data and shows only counts. Users must leave the dashboard and go to GitHub to see what each team member is actually working on.

Additionally, the GraphQL query fetches `url` for assigned issues and open PRs, but omits `url` for recent activity items (merged PRs and closed issues). This gap needs to be fixed in the backend query so the activity feed can link to GitHub.

## Current State
- `MemberCard` displays counts: `{issueCount} issues`, `{prCount} PRs`
- Recent activity shows only `{mergedCount} merged`, `{closedCount} closed` with a "last 7d" label
- No clickable links to individual issues or PRs
- No combined activity feed across members
- The `TeamMemberGitHubData` interface already provides full objects:
  - `assignedIssues`: `{ number, title, url }[]`
  - `openPRs`: `{ number, title, url }[]`
  - `recentActivity.mergedPRs`: `{ number, title, mergedAt }[]` (missing `url` — needs backend fix)
  - `recentActivity.closedIssues`: `{ number, title, closedAt }[]` (missing `url` — needs backend fix)

## Desired State

### 1. Expanded Member Cards
Each member card shows actual issue/PR titles instead of just counts:

- **Working on** section: Lists assigned issue titles, each clickable and linking to GitHub. Shows issue number and title (e.g., "#42 Fix login timeout"). Falls back to "No assigned issues" when empty.
- **Open PRs** section: Lists open PR titles, each clickable. Shows PR number and title (e.g., "#45 Add retry logic"). Falls back to "No open PRs" when empty.
- **Recent activity** summary: Keeps existing merged/closed counts with "last 7d" label (unchanged).

### 2. Combined Activity Feed
A new section below Messages showing a unified timeline of recent activity across all members:

- Shows merged PRs and closed issues from the last 7 days (data already filtered by backend)
- Each entry displays: relative date (e.g., "2d ago"), @author (from parent member), action verb (merged/closed), #number, title
- Sorted reverse chronologically by timestamp
- Entire entry row is clickable, linking to GitHub (using `url` field added to backend)
- Relative dates: use simple "Xd ago" / "Xh ago" format, computed from ISO 8601 timestamps
- Shows "No recent activity" when empty

### 3. Empty States and Edge Cases
- Member with `github_data: null`: hide Working on / Open PRs sections entirely (show only name, role, GitHub handle). Do not show empty-state text — absence of GitHub data means it wasn't fetched.
- Member with `github_data` but empty arrays: show "No assigned issues" / "No open PRs" text.
- Long titles: truncate with CSS `text-overflow: ellipsis` to prevent card layout breakage.
- No item count cap — show all items. Truncation can be added later if needed.

### 4. Preserved Behavior
- Existing member card info (name, role, GitHub handle) remains unchanged
- Refresh button continues to work
- Loading/error states unchanged
- Messages section unchanged

## Stakeholders
- **Primary Users**: Architects using the Codev dashboard to monitor team activity
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] Member cards show individual issue titles with clickable GitHub links
- [ ] Member cards show individual PR titles with clickable GitHub links
- [ ] Combined activity feed renders below Messages section
- [ ] Activity feed entries are sorted reverse chronologically
- [ ] Activity feed entries link to GitHub
- [ ] Empty states handled gracefully (no blank sections)
- [ ] Existing member card info preserved
- [ ] Visual design consistent with existing team page styles

## Constraints
### Technical Constraints
- Primarily frontend change with a minimal backend fix (add `url` to GraphQL query for recent activity)
- Files to modify:
  - `team-github.ts`: Add `url` to merged PR and closed issue GraphQL fragments + types
  - `api.ts`: Update `TeamMemberGitHubData` type to include `url` on recent activity items
  - `TeamView.tsx`: Expand member cards and add activity feed
  - `index.css`: Styles for new UI elements
- Must work with existing `useTeam` hook

### Business Constraints
- ~250 LOC change — ASPIR-appropriate scope

## Assumptions
- Issue/PR URLs from the backend are valid GitHub URLs
- `recentActivity.mergedPRs[].mergedAt` and `recentActivity.closedIssues[].closedAt` are ISO 8601 date strings
- GitHub GraphQL API supports `url` field on both `Issue` and `PullRequest` types (verified)

## Solution Approaches

### Approach 1: Inline Expansion (Recommended)
Expand the existing `MemberCard` component to render issue/PR lists inline. Add a new `ActivityFeed` component below the Messages section that aggregates activity across all members.

**Pros**:
- Minimal structural change — enhances existing component
- All data available without additional API calls
- Simple, flat UI consistent with current design

**Cons**:
- Cards will be taller with many issues/PRs (acceptable trade-off)

**Estimated Complexity**: Low
**Risk Level**: Low

## Open Questions
None — all consultation feedback has been incorporated.

## Performance Requirements
- No additional API calls — the `url` field is added to the existing GraphQL query (no extra round trips)
- Activity feed sort is O(n log n) on a small dataset (< 100 items typically)

## Security Considerations
- URLs come from GitHub via the backend — no user-controlled input
- Links open in new tab with `rel="noopener noreferrer"` (existing pattern)

## Test Scenarios
### Functional Tests
1. Member with assigned issues: card shows issue titles with clickable links
2. Member with open PRs: card shows PR titles with clickable links
3. Member with `github_data: null`: card hides Working on / Open PRs sections
4. Member with empty arrays: card shows "No assigned issues" / "No open PRs"
5. Activity feed with mixed merged PRs and closed issues: sorted reverse chronologically
6. Activity feed empty: shows "No recent activity"
7. Multiple members contribute to activity feed: all entries present and attributed correctly
8. Long titles: truncated with ellipsis, no layout overflow
9. Activity feed links open in new tab with `noopener noreferrer`

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Cards too tall with many items | Low | Low | Natural scrolling; could truncate later if needed |

## Expert Consultation
**Date**: 2026-04-01
**Models Consulted**: Gemini, Codex, Claude
**Key changes from consultation**:
- Added `url` field to recent activity backend data (all 3 reviewers flagged this gap)
- Clarified relative date format ("Xd ago" / "Xh ago")
- Added explicit `github_data: null` vs empty array behavior
- Added CSS truncation requirement for long titles
- Updated constraints from "frontend-only" to include minimal backend fix

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete
