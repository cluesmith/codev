# Review: Team Tab in Tower Right Panel

## Metadata
- **ID**: review-587
- **Specification**: codev/specs/587-team-tab-in-tower-right-panel.md
- **Plan**: codev/plans/587-team-tab-in-tower-right-panel.md
- **Created**: 2026-03-08

## Summary

Implemented the Team tab feature across 5 phases: team directory infrastructure, backend API with GitHub integration, frontend Team tab, `af team` CLI commands, and automatic hourly updates via cron. The feature adds team visibility to the Tower dashboard — team member cards with GitHub activity data, a message log for team communication, and automatic activity summaries.

**Total diff**: ~2,100 LOC across 17 files (11 new, 6 modified)
**Tests added**: 76 (38 team core + 16 GitHub + 8 CLI + 10 auto-updates + 4 E2E)
**Test suite**: 2031 total (2018 passing, 13 pre-existing skips), zero regressions

## Spec Compliance

All success criteria from spec-587 are met:

- [x] `codev/team/people/` directory convention with documented file format
- [x] Team tab appears only when 2+ valid member files exist
- [x] Tab loads and displays parsed frontmatter (name, role, GitHub handle)
- [x] Per-member GitHub data (assigned issues, open PRs, recent activity)
- [x] `codev/team/messages.md` parsed and displayed in Team tab
- [x] `af team message` CLI command appends timestamped messages
- [x] `af team list` CLI command displays team members
- [x] Communication channel abstraction (`MessageChannel` interface, `FileMessageChannel`)
- [x] Automatic hourly team updates via cron
- [x] Manual refresh button works
- [x] Tab follows existing UI patterns
- [x] >90% test coverage across all layers
- [x] No regression in existing Tower functionality

## Deviations from Plan

1. **YAML parser**: Used `js-yaml` with manual `---` splitting instead of `gray-matter` (which is not a project dependency). Plan was already corrected for this during consultation.

2. **GraphQL query construction**: Plan specified `$owner`/`$name` as GraphQL variables. Changed to JS-level string interpolation because GitHub's `search()` query field doesn't support variable substitution inside search string literals. Variables are JS params to `buildTeamGraphQLQuery()`.

3. **GraphQL alias prefix**: Added `u_` prefix to aliases via `toAlias()` helper because GitHub handles starting with digits produce invalid GraphQL aliases (identifiers can't start with digits).

4. **`handleWorkspaceTeam` optimization**: Plan called `hasTeam()` then `loadTeamMembers()` (two filesystem reads). Optimized to single `loadTeamMembers()` call, checking `result.items.length >= 2` directly.

5. **`loadTeamMembers` return shape**: Plan specified `{ members, warnings }` but implementation uses `{ items, warnings }` to follow the existing codebase pattern for collection returns.

## Consultation Feedback Summary

### Phase 1 (team_directory) — All APPROVE
Clean implementation, no blocking issues.

### Phase 2 (backend_api) — Gemini: REQUEST_CHANGES, Codex: REQUEST_CHANGES, Claude: COMMENT
- **GraphQL variables in search strings**: Both Gemini and Codex caught that `$owner/$name` can't be used inside `search()` string literals. Fixed by using JS params.
- **GraphQL alias digit issue**: Gemini flagged handles starting with digits. Fixed with `u_` prefix.
- **Double filesystem read**: Claude flagged `hasTeam()` + `loadTeamMembers()` redundancy. Optimized.
- **Response shape**: Codex flagged flattened `github_data`. Fixed to nest under `github_data`.

### Phase 3 (frontend_tab) — All APPROVE
Clean implementation. Codex suggested keyboard shortcuts (deferred to future).

### Phase 4 (af_team_cli) — All APPROVE
Clean implementation. Suggestions for `--json` flag and `--channel` option deferred to future.

### Phase 5 (auto_updates) — Gemini: REQUEST_CHANGES, Codex: REQUEST_CHANGES, Claude: COMMENT
- **git log OR semantics**: Multiple `--grep` creates OR without `--all-match`. Fixed to single `--grep="spawn"` with two-step parsing.
- **Spawn regex alternation**: `(?:spawn|#(\d+))` matches "spawn" first, leaving capture undefined. Fixed with separate regex steps.
- **gh pr list --state with --search**: Incompatible flags. Fixed to use `is:merged` in search string.
- **Loose gate check**: `content.includes('approved')` matches substrings. Fixed with `/^approved:\s*true/m` regex.
- **Day-level merge granularity**: GitHub search only supports date-level `merged:>=`. Fixed by fetching `mergedAt` and filtering by timestamp in code.

## Architecture Updates

### New modules
| Module | Location | Purpose |
|--------|----------|---------|
| `team.ts` | `packages/codev/src/lib/team.ts` | Team directory parsing, message log, `MessageChannel` interface |
| `team-github.ts` | `packages/codev/src/lib/team-github.ts` | Batched GraphQL for per-member GitHub data |
| `team.ts` (CLI) | `packages/codev/src/agent-farm/commands/team.ts` | `af team list` and `af team message` commands |
| `team-update.ts` | `packages/codev/src/agent-farm/commands/team-update.ts` | Hourly activity collection and summary |
| `TeamView.tsx` | `packages/codev/dashboard/src/components/TeamView.tsx` | Team tab UI component |
| `useTeam.ts` | `packages/codev/dashboard/src/hooks/useTeam.ts` | Fetch-on-activation hook for team data |

### Modified modules
- `tower-routes.ts`: Added `/api/team` endpoint and `teamEnabled` to `DashboardState`
- `useTabs.ts`: Added `'team'` to tab type union, conditional tab in `buildTabs()`
- `TabBar.tsx`: Added team icon
- `App.tsx`: Added TeamView rendering
- `api.ts`: Added team types and `fetchTeam()`
- `cli.ts`: Added `af team` command group with list/message/update subcommands

### New data flow
```
codev/team/people/*.md  →  team.ts (parse)  →  tower-routes.ts (/api/team)
codev/team/messages.md  →  team.ts (parse)  ↗         ↓
gh api graphql          →  team-github.ts   ↗    Dashboard (useTeam → TeamView)
```

### New conventions
- `codev/team/people/<handle>.md` — per-member file with YAML frontmatter (`name`, `github`, `role`)
- `codev/team/messages.md` — append-only message log with `---`-separated entries
- `.af-cron/team-update.yaml` — hourly cron task for activity summaries

## Lessons Learned Updates

### GraphQL variables don't work inside string literals
GitHub's `search()` query takes a `query` string argument. GraphQL variable substitution (`$var`) only works for proper GraphQL variable positions, not inside string literals. When building search queries dynamically, pass values as JS/TS function parameters and interpolate at the string level.

### GraphQL alias naming constraints
GraphQL aliases follow identifier rules — they cannot start with a digit. When using external data (like GitHub handles) as alias names, always add a safe prefix (e.g., `u_`) to avoid silent query failures.

### git log --grep with multiple patterns defaults to OR
Using multiple `--grep` flags without `--all-match` creates an OR condition, matching far more commits than intended. For precise filtering: use a single `--grep`, then filter results in code.

### gh CLI --state and --search are mutually exclusive
`gh pr list --state merged --search "..."` fails silently in a catch block. Use `is:merged` within the `--search` string instead of combining `--state` with `--search`.

### GitHub search date granularity
GitHub's `merged:>=YYYY-MM-DD` only has day-level precision. For hour-level windows, fetch the timestamp field (`mergedAt`) via `--json` and filter in code.

## Flaky Tests

None. All 76 new tests are deterministic. The 4 E2E tests use filesystem-based team data (no GitHub API dependency in tests).

## Follow-up Items

1. **Skeleton update**: Add `codev/team/` directory convention to `codev-skeleton/` template so new projects get the structure
2. **Keyboard shortcuts**: Add keyboard shortcut to switch to Team tab (suggested by Codex)
3. **`--json` output**: Add `--json` flag to `af team list` for machine-readable output
4. **`--channel` option**: Add channel selector to `af team message` when additional channels are implemented
5. **Server-side caching**: Cache GitHub data to reduce API calls for large teams (deferred from spec)
