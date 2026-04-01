# Review: Team Page — Show Issue/PR Details and Activity Feed

## Summary
Expanded the team page to show individual issue/PR titles with clickable GitHub links (replacing count-only display) and added a combined activity feed showing recent merged PRs and closed issues across all members. Included a minimal backend fix to add `url` to the GraphQL query for recent activity items.

**Stats**: 6 files changed, 325 insertions, 21 deletions across 5 commits.

## Spec Compliance
- [x] Member cards show individual issue titles with clickable GitHub links
- [x] Member cards show individual PR titles with clickable GitHub links
- [x] Combined activity feed renders below Messages section
- [x] Activity feed entries sorted reverse chronologically with correct attribution
- [x] Activity feed entries link to GitHub (entire row clickable)
- [x] Empty states handled (`github_data: null` hides sections; empty arrays show text)
- [x] Long titles truncated with CSS ellipsis
- [x] Existing member card info preserved (name, role, GitHub handle)
- [x] Relative dates: "just now" (<1h), "Xh ago", "Xd ago"
- [x] All links open in new tab with `noopener noreferrer`

## Deviations from Plan
- **Backend change added**: Original issue described this as "frontend-only," but all 3 spec consultants identified that `recentActivity` items lacked `url` fields. Added a minimal backend fix (GraphQL query + type updates) — 4 lines of query change.
- **Tests added for dashboard logic**: Plan didn't originally include frontend unit tests. Codex reviewer requested them. Added `activityFeed.test.ts` with 8 tests covering `relativeDate` and `buildActivityFeed` pure functions.

## Lessons Learned

### What Went Well
- 3-way consultation caught a real data gap (missing `url` on activity items) before implementation started — saved a rework cycle
- Clean separation of pure functions (`relativeDate`, `buildActivityFeed`) from React components made testing straightforward
- Existing `TeamMemberGitHubData` interface and `useTeam` hook required zero modifications to the data flow

### Challenges Encountered
- **GraphQL URL gap**: The `_merged` and `_closed` query fragments omitted `url` even though the GitHub API supports it. Caught during spec consultation, not during code review — consultation was load-bearing here.
- **Dashboard test config**: Dashboard tests run with a separate vitest config (`dashboard/vitest.config.ts`) with jsdom environment, excluded from the main test suite. Required running from the `dashboard/` subdirectory.

### What Would Be Done Differently
- Check data completeness (all fields available) during spec writing rather than assuming "all data is already available"

## Technical Debt
- No Playwright E2E tests for the new UI — existing team tab E2E tests only verify API contract and tab visibility, not rendered content

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: `recentActivity` items lack `url` — spec claims frontend-only but can't link activity items
  - **Addressed**: Updated spec to include minimal backend fix

#### Codex (REQUEST_CHANGES)
- **Concern**: Relative date format under-specified; empty state for `github_data: null` unclear; CSS truncation needs bounds; testing should include Playwright
  - **Addressed**: Added relative date format spec, null vs empty distinction, CSS truncation requirement
  - **Rebutted**: Playwright coverage deferred as out of scope for ~250 LOC change

#### Claude (COMMENT)
- **Concern**: Same URL gap; suggested truncation guidance and date formatting utility
  - **Addressed**: All points incorporated into spec revision

### Plan Phase (Round 1)

#### Gemini (APPROVE)
- No concerns. Provided helpful CSS tip (block-level for ellipsis).

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing test tasks; "entire row clickable" not explicit; sub-1h date undefined
  - **Addressed**: Added test update task, explicit anchor requirement, "just now" fallback

#### Claude (APPROVE)
- No concerns.

### Implement: backend-url-fix (Round 1)

#### Gemini (APPROVE), Claude (APPROVE)
- No concerns.

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing explicit `url` assertions in tests
  - **Addressed**: Added `toEqual` assertions and query-level regex checks

### Implement: expanded-member-cards (Round 1)

#### All three (APPROVE)
- No concerns raised.

### Implement: activity-feed (Round 1)

#### Gemini (APPROVE), Claude (APPROVE)
- No concerns.

#### Codex (REQUEST_CHANGES)
- **Concern**: No frontend test coverage for activity feed logic
  - **Addressed**: Added `activityFeed.test.ts` with 8 tests for pure functions

## Flaky Tests
No flaky tests encountered.

## Architecture Updates
Updated `codev/resources/arch.md` Team View section to reflect:
- Member cards now show clickable issue/PR title lists (not just counts)
- Added combined activity feed description

## Lessons Learned Updates
No lessons learned updates needed — straightforward frontend enhancement with no novel insights beyond existing entries.

## Follow-up Items
- Add Playwright E2E tests for team page rendered content (issue/PR links, activity feed ordering)
- Consider item count cap if teams have many open issues/PRs (currently shows all)
