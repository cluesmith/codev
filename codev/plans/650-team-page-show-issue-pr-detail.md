# Plan: Team Page — Show Issue/PR Details and Activity Feed

## Metadata
- **ID**: plan-2026-04-01-team-page-detail
- **Status**: draft
- **Specification**: codev/specs/650-team-page-show-issue-pr-detail.md
- **Created**: 2026-04-01

## Executive Summary
Expand the team page to show individual issue/PR titles with GitHub links (instead of just counts) and add a combined activity feed. Requires a minimal backend fix to add `url` to recent activity GraphQL fragments, then frontend changes to `TeamView.tsx` and `index.css`.

## Success Metrics
- [ ] Member cards show issue/PR titles with clickable GitHub links
- [ ] Combined activity feed below Messages section
- [ ] Activity feed sorted reverse chronologically with correct attribution
- [ ] Empty states handled (`github_data: null` hides sections; empty arrays show text)
- [ ] Long titles truncated with ellipsis
- [ ] Build passes, no regressions

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "backend-url-fix", "title": "Add URL to recent activity data"},
    {"id": "expanded-member-cards", "title": "Expand member cards with issue/PR lists"},
    {"id": "activity-feed", "title": "Add combined activity feed"}
  ]
}
```

## Phase Breakdown

### Phase 1: Add URL to recent activity data
**Dependencies**: None

#### Objectives
- Add `url` field to merged PRs and closed issues in the GraphQL query and types

#### Deliverables
- [ ] Updated GraphQL query fragments in `team-github.ts`
- [ ] Updated TypeScript types in `team-github.ts` and `api.ts`
- [ ] Updated response parsing to include `url`

#### Implementation Details

**File: `packages/codev/src/lib/team-github.ts`**
- `TeamMemberGitHubData.recentActivity.mergedPRs`: add `url: string` to type (line 26)
- `TeamMemberGitHubData.recentActivity.closedIssues`: add `url: string` to type (line 27)
- GraphQL query `_merged` fragment (line 94): add `url` → `nodes { ... on PullRequest { number title url mergedAt } }`
- GraphQL query `_closed` fragment (line 97): add `url` → `nodes { ... on Issue { number title url closedAt } }`
- `parseTeamGraphQLResponse` (lines 123-124): update type casts and map to include `url`

**File: `packages/codev/dashboard/src/lib/api.ts`**
- `TeamMemberGitHubData.recentActivity.mergedPRs`: add `url: string` (line 60)
- `TeamMemberGitHubData.recentActivity.closedIssues`: add `url: string` (line 61)

#### Acceptance Criteria
- [ ] `url` field present on all recent activity items
- [ ] Update existing unit test mocks in `team-github.test.ts` to include `url` field
- [ ] Existing unit tests still pass
- [ ] Build succeeds

---

### Phase 2: Expand member cards with issue/PR lists
**Dependencies**: Phase 1

#### Objectives
- Replace count-only display with individual issue/PR title lists in `MemberCard`

#### Deliverables
- [ ] Updated `MemberCard` component showing issue/PR titles
- [ ] CSS styles for issue/PR lists
- [ ] Empty state handling

#### Implementation Details

**File: `packages/codev/dashboard/src/components/TeamView.tsx`**
- Replace the `team-member-stats` div (lines 29-32) with two sections:
  - "Working on" section: render `gh.assignedIssues` as a list of `<a>` tags with `#{number} {title}`
  - "Open PRs" section: render `gh.openPRs` as a list of `<a>` tags with `#{number} {title}`
- When `github_data` is `null`: hide both sections entirely
- When arrays are empty: show "No assigned issues" / "No open PRs" text
- Keep existing recent activity summary (merged/closed counts with "last 7d")

**File: `packages/codev/dashboard/src/index.css`**
- Add styles for `.team-member-issues` and `.team-member-prs` list containers
- Style `.team-item-link`: `display: block`, `text-overflow: ellipsis`, `overflow: hidden`, `white-space: nowrap` (block-level with constrained width for ellipsis to work)
- Style section labels (small, muted headers for "Working on" / "Open PRs")

#### Acceptance Criteria
- [ ] Each issue/PR title displayed as clickable link
- [ ] Links open in new tab with `noopener noreferrer`
- [ ] Long titles truncated with ellipsis
- [ ] `github_data: null` hides sections
- [ ] Empty arrays show placeholder text

---

### Phase 3: Add combined activity feed
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Add a unified activity timeline below the Messages section

#### Deliverables
- [ ] New `ActivityFeed` component
- [ ] CSS styles for activity feed
- [ ] Relative date formatting helper

#### Implementation Details

**File: `packages/codev/dashboard/src/components/TeamView.tsx`**
- Add `ActivityFeed` component that:
  1. Aggregates `recentActivity.mergedPRs` and `recentActivity.closedIssues` across all members
  2. Tags each item with the member's `name` and `github` handle
  3. Sorts by timestamp (mergedAt/closedAt) in reverse chronological order
  4. Renders each entry as: `{relativeDate} @{github} {merged|closed} #{number} {title}`
  5. Each entry rendered as a single `<a>` anchor wrapping the entire row (entire row clickable), with `target="_blank"` and `rel="noopener noreferrer"`, linking to GitHub via `url` field
- Add inline `relativeDate(isoString: string)` helper: returns "just now" (<1h), "Xh ago" (1-23h), "Xd ago" (1d+)
- Add the feed as a third section in `TeamView` after Messages
- Show "No recent activity" when feed is empty

**File: `packages/codev/dashboard/src/index.css`**
- Style `.team-activity-feed` container
- Style `.team-activity-entry`: row layout, muted date, action text
- Style `.team-activity-author`: `@handle` display

#### Acceptance Criteria
- [ ] Activity feed shows entries from all members
- [ ] Entries sorted reverse chronologically
- [ ] Relative dates display correctly
- [ ] Links open in new tab
- [ ] Empty state shows "No recent activity"

## Dependency Map
```
Phase 1 (backend-url-fix) ──→ Phase 2 (expanded-member-cards) ──→ Phase 3 (activity-feed)
```

## Risk Analysis
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| GraphQL url field not available | Very Low | Medium | Verified: GitHub API exposes `url` on Issue and PullRequest |
| CSS layout breakage on narrow widths | Low | Low | Existing `minmax(200px, 1fr)` grid handles this; add `text-overflow: ellipsis` |

## Validation Checkpoints
1. **After Phase 1**: `npm run build` passes, types are consistent
2. **After Phase 2**: Member cards render titles in dashboard
3. **After Phase 3**: Full feature complete, activity feed renders correctly

## Expert Review
**Date**: 2026-04-01
**Models Consulted**: Gemini, Codex, Claude
**Key changes from consultation**:
- Added explicit unit test update task for Phase 1 (Gemini, Codex)
- Specified "entire row clickable" as single `<a>` anchor for activity feed (Codex)
- Added "just now" fallback for sub-1h relative dates (Codex)
- Clarified CSS ellipsis requires block-level display (Gemini)

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete
