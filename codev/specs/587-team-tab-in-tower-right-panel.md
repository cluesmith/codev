# Specification: Team Tab in Tower Right Panel

## Metadata
- **ID**: spec-587
- **Status**: draft
- **Created**: 2026-03-06
- **GitHub Issue**: #587

## Clarifying Questions Asked

1. **What data should appear per team member?** — Name, GitHub handle, role, assigned issues, open PRs, recent activity (commits, PR merges, issue closes).
2. **Where do team member definitions live?** — New `codev/team/` directory with one `.md` file per member, using YAML frontmatter for structured data (name, github, role).
3. **Is this read-only or interactive?** — Read-only for v1. Future work includes inter-architect messaging.
4. **How fresh should the data be?** — Poll-based like existing tabs. GitHub data refreshed on tab activation + manual refresh button.
5. **Should it work without `codev/team/` files?** — Yes, show an empty state with instructions on how to add team members.

## Problem Statement

The Tower dashboard currently has no visibility into team composition or what other team members are working on. In a multi-architect setup, each architect works in isolation with no shared view of assignments, activity, or availability. This makes coordination difficult and leads to duplicate work or blocked handoffs.

## Current State

- Tower has two main content tabs: **Work** (builders, PRs, backlog) and **Analytics** (metrics, charts)
- No concept of "team" exists in the dashboard or data model
- Team coordination happens outside the tool (Slack, meetings, etc.)
- No `codev/team/` directory convention exists

## Desired State

- A new **Team** tab in the Tower right panel showing team member profiles and activity
- Each team member defined in a `codev/team/<github-handle>.md` file with YAML frontmatter
- The tab displays per-member: assigned issues, open PRs, and recent GitHub activity
- Empty state guides users to create team member files
- Foundation laid for future inter-architect messaging

## Stakeholders
- **Primary Users**: Architects using Tower to coordinate work
- **Secondary Users**: Team leads reviewing workload distribution
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] New `codev/team/` directory convention with documented file format
- [ ] Team tab appears in Tower right panel alongside Work and Analytics
- [ ] Tab loads team member files and displays parsed frontmatter (name, role, GitHub handle)
- [ ] Tab fetches and displays per-member GitHub data (assigned issues, open PRs, recent activity)
- [ ] Empty state shown when no team files exist, with guidance text
- [ ] Manual refresh button works
- [ ] Tab follows existing UI patterns (styling, layout, responsive behavior)
- [ ] All new code has test coverage >90%
- [ ] No regression in existing Tower functionality

## Constraints

### Technical Constraints
- Must follow existing tab registration pattern in `useTabs.ts` (add `'team'` to type union)
- Must follow existing data fetching pattern (custom hook polling `/api/team` endpoint)
- Must use existing CSS variable theming system
- GitHub API calls must use the existing `gh` CLI or Octokit patterns already in the codebase
- Team member files use YAML frontmatter parsed with the same library used elsewhere (gray-matter or similar)

### Business Constraints
- Read-only in v1 — no editing team files from the UI
- No real-time presence or online status — just GitHub activity data
- Inter-architect messaging is explicitly out of scope (future work)

## Assumptions
- The `gh` CLI is available and authenticated in the environment (same assumption as existing GitHub integrations)
- Team member `.md` files are committed to the repo and available in the worktree
- GitHub handles in team files are valid and correspond to real GitHub users

## Solution Approaches

### Approach 1: File-Based Team Directory with GitHub Integration (Recommended)

**Description**: Each team member gets a `codev/team/<handle>.md` file with YAML frontmatter. The Tower backend reads these files, enriches with GitHub API data, and serves via a new `/api/team` endpoint. The frontend renders a new Team tab.

**Team member file format**:
```yaml
---
name: Waleed Khan
github: wkhan
role: architect
---

Optional freeform notes about this team member.
```

**Pros**:
- Simple, version-controlled team definition
- Follows existing codev conventions (YAML frontmatter in markdown)
- Easy to add/remove team members
- Git history tracks team changes

**Cons**:
- Requires manual file creation per member
- GitHub API rate limits could affect large teams

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: GitHub-Only Discovery

**Description**: Discover team members automatically from GitHub repo collaborators/contributors. No local files needed.

**Pros**:
- Zero configuration
- Always up to date

**Cons**:
- No control over who appears (all contributors shown)
- No place for custom metadata (role, notes)
- Dependent entirely on GitHub API availability
- Can't represent team members who haven't contributed yet

**Estimated Complexity**: Low
**Risk Level**: Medium (less control, API dependency)

### Recommended Approach

**Approach 1** — File-based team directory. It's explicit, version-controlled, and provides a foundation for future features (messaging, role-based views). The file format is trivially simple and consistent with how codev already works.

## Open Questions

### Critical (Blocks Progress)
- [x] File format for team member definitions — **Resolved**: YAML frontmatter in `.md` files

### Important (Affects Design)
- [x] Should the tab be persistent (always rendered, hidden via CSS) or lazy (rendered on activation)? — **Resolved**: Lazy render like Analytics, only fetch when active
- [x] What GitHub activity counts as "recent"? — **Resolved**: Last 7 days of activity (PRs opened/merged, issues opened/closed)

### Nice-to-Know (Optimization)
- [ ] Should team data be cached server-side to reduce GitHub API calls? — Defer to implementation; start with simple per-request fetching, add caching if needed

## Performance Requirements
- **Tab Load Time**: <2s for teams of up to 10 members
- **GitHub API**: Batch requests where possible; graceful degradation if API unavailable
- **Polling**: Only when Team tab is active (same pattern as Analytics)

## Security Considerations
- No new authentication — uses existing `gh` CLI auth
- Team files contain only public GitHub handles and names — no secrets
- API endpoint is local-only (Tower runs on localhost)

## Test Scenarios

### Functional Tests
1. Team tab appears in TabBar when team files exist
2. Team tab appears with empty state when no team files exist
3. Each team member card shows name, role, GitHub handle from frontmatter
4. Assigned issues and open PRs display correctly per member
5. Recent activity section shows last 7 days of GitHub events
6. Refresh button triggers data re-fetch
7. Malformed team files are skipped with warning (not crash)

### Non-Functional Tests
1. Tab renders within 2s for 10 team members
2. Tab gracefully handles GitHub API failures (shows cached/stale data or error message)
3. Tab follows responsive layout patterns for mobile view

## Dependencies
- **External Services**: GitHub API (via `gh` CLI or Octokit)
- **Internal Systems**: Tower server (new `/api/team` endpoint), Dashboard React app
- **Libraries**: gray-matter (or existing YAML frontmatter parser), existing React component patterns

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| GitHub API rate limiting | Medium | Medium | Cache responses, only fetch when tab active, batch requests |
| Team files with invalid YAML | Low | Low | Skip malformed files, log warning, show partial results |
| Large teams (>20 members) | Low | Medium | Paginate or virtualize the member list |

## Notes

The `codev/team/` directory and file format should also be added to the `codev-skeleton/` template so new projects adopting codev get the convention. However, the skeleton update is a small follow-up and not core to this spec.

This feature lays the groundwork for inter-architect messaging (mentioned in issue #587 as future work). The team member file format is intentionally extensible — additional frontmatter fields can be added later without breaking existing files.
