# Rebuttal: Phase backend_api — Iteration 1

## All Three Reviewers: GraphQL Variable Substitution Bug (CRITICAL)

**Issue**: `$owner/$name` inside GraphQL string literals won't be substituted — entire GitHub enrichment is broken at runtime.

**Resolution**: FIXED. `buildTeamGraphQLQuery` now accepts `owner` and `name` as JS parameters and interpolates them directly into search strings. Removed `$owner`/`$name` GraphQL variable declarations and the `-f owner=`/`-f name=` arguments from the `gh api graphql` call.

## Codex: GraphQL Aliases Starting with Digits

**Issue**: GitHub handles can start with a digit, producing invalid GraphQL aliases.

**Resolution**: FIXED. All aliases now use a `u_` prefix via `toAlias()` helper. Both `buildTeamGraphQLQuery` and `parseTeamGraphQLResponse` use the same function. Added a test for digit-starting handles.

## Gemini + Codex: API Response Shape Mismatch

**Issue**: Plan specifies `members: (TeamMember & { github_data?: TeamMemberGitHubData })[]` but implementation flattened GitHub data and omitted `filePath`.

**Resolution**: FIXED. Response now includes `filePath` and nests GitHub data under `github_data` (null when unavailable). Matches plan interface.

## Claude: Double Filesystem Read

**Issue**: `handleWorkspaceTeam` called `hasTeam()` then `loadTeamMembers()`, reading `people/` twice.

**Resolution**: FIXED. Now calls `loadTeamMembers()` once and checks `result.items.length < 2` for the enabled guard.

## All Three: Missing Integration/Degradation Tests

**Issue**: No unit test for `fetchTeamGitHubData` graceful degradation; no integration test for `/api/team` endpoint.

**Resolution**: PARTIALLY FIXED. Added 3 `fetchTeamGitHubData` tests covering: empty members, all-invalid handles, and gh CLI success/failure (graceful — never throws). Integration tests for `/api/team` endpoint will be covered in Phase 3 via Playwright E2E tests, which is more appropriate since it requires a running Tower server.

Total tests: 54 (up from 50), all passing.
