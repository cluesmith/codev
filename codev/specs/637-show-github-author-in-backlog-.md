# Specification: Show GitHub Author in Backlog and PR Views

## Metadata
- **ID**: spec-2026-03-27-show-github-author
- **Status**: draft
- **Created**: 2026-03-27

## Clarifying Questions Asked
- **Q: Should the author be shown for recently closed issues too?** Assumed no — the issue only mentions backlog and PR views.
- **Q: Should external contributors be visually distinguished from team members?** Not specified; out of scope for this feature. Display the username uniformly.
- **Q: Should the username link to the GitHub profile?** Not specified; just display the text username. The row itself already links to the issue/PR.

## Problem Statement

When viewing the workspace overview (dashboard), there is no indication of who filed each backlog issue or who authored each PR. As the project starts receiving contributions from external contributors (like `timeleft--`), the team needs visibility into who is submitting work without clicking through to GitHub.

## Current State

The backlog list displays: priority dot, issue number, type tag, title, age, and artifact links (spec/plan/review).

The PR list displays: PR number, title, review status, and age.

Neither view includes the GitHub username of the author. To see who filed an issue or authored a PR, users must click through to GitHub.

The forge concept commands (`issue-list.sh`, `pr-list.sh`) do not fetch the `author` field, even though `gh` CLI supports it via `--json author`. The data types (`IssueListItem`, `PrListItem` in `forge-contracts.ts`) do not include an author field either.

## Desired State

- Backlog items display the GitHub username of the issue author (e.g., `@timeleft--`)
- PR items display the GitHub username of the PR author
- The author username appears as a subtle, non-dominant element in each row — it should inform without cluttering the existing layout
- Data flows end-to-end: forge concept commands → forge contracts → backend overview types → dashboard API types → frontend components

## Stakeholders
- **Primary Users**: Architect (Waleed) reviewing the dashboard to triage work and understand who's contributing
- **Secondary Users**: Any team member using `afx status` or the dashboard
- **Technical Team**: Codev maintainers
- **Business Owners**: Waleed (project owner)

## Success Criteria
- [ ] Backlog rows show the GitHub username of the issue author
- [ ] PR rows show the GitHub username of the PR author
- [ ] The `issue-list` forge concept command fetches the `author` field
- [ ] The `pr-list` forge concept command fetches the `author` field
- [ ] Types are updated end-to-end: forge contracts, backend overview, dashboard API, components
- [ ] Existing tests pass; new unit tests cover the author field in `deriveBacklog` and PR mapping
- [ ] Non-GitHub forges degrade gracefully (author may be absent)

## Constraints
### Technical Constraints
- Must work through the forge concept abstraction — we modify the default `gh`-based scripts, not hardcode GitHub API calls
- The `author` field in `gh` CLI returns `{ login: string }` for both issues and PRs
- Non-GitHub forge presets (GitLab, Gitea) may not provide `author` in the same shape; the field must be optional in contracts
- The dashboard is a React SPA served by the Tower; changes flow through the overview API endpoint

### Business Constraints
- Low-risk change; no security implications
- Should not add noticeable latency to the overview fetch (the `author` field is already available in the same `gh` API call)

## Assumptions
- The `gh` CLI `--json author` field returns `{ login: string }` for both `gh issue list` and `gh pr list`
- Adding `author` to the `--json` fields does not significantly increase response size or latency
- The dashboard CSS can accommodate an additional small text element per row

## Solution Approaches

### Approach 1: End-to-End Author Field Addition
**Description**: Add `author` to forge concept commands, update all type definitions through the stack, and render in the dashboard components.

**Pros**:
- Clean, idiomatic — follows the existing data flow pattern exactly
- Works for any forge that provides author info
- Minimal changes per layer (one field addition at each level)

**Cons**:
- Touches multiple files across the stack (but each change is small)

**Estimated Complexity**: Low
**Risk Level**: Low

## Open Questions

### Critical (Blocks Progress)
None — the approach is straightforward.

### Nice-to-Know (Optimization)
- [ ] Should we prefix with `@` (e.g., `@timeleft--`) or show plain username? Assumed `@` prefix for clarity.

## Performance Requirements
- **Response Time**: No measurable impact — `author` is fetched in the same `gh` API call
- **Resource Usage**: Negligible — one additional string field per item

## Security Considerations
- GitHub usernames are public information; no privacy concern
- No authentication changes needed

## Test Scenarios
### Functional Tests
1. **Happy path**: Issue with author field → backlog row displays `@username`
2. **Happy path**: PR with author field → PR row displays `@username`
3. **Missing author**: Issue/PR without author (non-GitHub forge) → row renders without author, no error
4. **deriveBacklog mapping**: Author field passes through from forge data to BacklogItem

### Non-Functional Tests
1. **Performance**: Overview API response time unchanged with author field

## Dependencies
- **External Services**: GitHub CLI (`gh`) — already a dependency
- **Internal Systems**: Forge concept commands, overview cache, dashboard API
- **Libraries/Frameworks**: None new

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Non-GitHub forges don't provide `author` | Medium | Low | Make `author` optional in all types; render conditionally |
| `gh` CLI `author` format changes | Very Low | Low | Already matches `{ login: string }` pattern used in `issue-view` and `pr-view` |

## Notes
The `IssueViewResult` and `PrViewResult` interfaces in `forge-contracts.ts` already include `author: { login: string }` for single-item views. This feature extends that pattern to the list views (`IssueListItem`, `PrListItem`).
