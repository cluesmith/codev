# Plan: Support Non-GitHub Repositories

## Metadata
- **ID**: 589-non-github-repository-support
- **Status**: draft
- **Specification**: codev/specs/589-non-github-repository-support.md
- **Created**: 2026-03-08

## Executive Summary

Implement a concept command architecture that decouples codev from direct `gh` CLI calls. Each forge operation becomes a configurable command with a JSON output contract. Default commands wrap `gh` for backward compatibility; projects override via `af-config.json`. The implementation proceeds incrementally: infrastructure first, then migrate one functional area at a time, keeping the codebase functional at every step.

## Success Metrics
- [ ] All specification success criteria met
- [ ] All existing tests continue to pass
- [ ] New tests cover concept command dispatch, overrides, null concepts, default fallback, malformed output
- [ ] Zero behavior change for GitHub-hosted projects with no config overrides
- [ ] No new runtime dependencies

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "concept-infrastructure", "title": "Concept Command Infrastructure"},
    {"id": "core-github-refactor", "title": "Core GitHub Function Migration"},
    {"id": "spawn-migration", "title": "Spawn Worktree Migration"},
    {"id": "overview-analytics-migration", "title": "Overview & Analytics Migration"},
    {"id": "porch-protocol-migration", "title": "Porch & Protocol Migration"},
    {"id": "team-doctor-docs", "title": "Team, Doctor, and Documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Concept Command Infrastructure
**Dependencies**: None

#### Objectives
- Create the concept command dispatcher that executes configured commands via `sh -c` with `CODEV_*` environment variables
- Extend `af-config.json` schema and loading to support the `forge` section
- Define JSON output contracts for all 15 concepts

#### Deliverables
- [ ] New file: `packages/codev/src/lib/forge.ts` — concept command dispatcher
- [ ] Modified: `packages/codev/src/agent-farm/utils/config.ts` — add `forge` section to `UserConfig` type and config loading
- [ ] New file: `packages/codev/src/lib/forge-contracts.ts` — TypeScript interfaces for each concept's JSON output
- [ ] New file: `packages/codev/src/__tests__/forge.test.ts` — unit tests for dispatcher
- [ ] Tests for this phase

#### Implementation Details

**`forge.ts`** — Core dispatcher:
- `executeForgeCommand(concept: string, env?: Record<string, string>, cwd?: string): Promise<unknown | null>` — Execute concept command, parse JSON stdout, return `null` on failure
- `getForgeCommand(concept: string, config?: UserConfig): string | null` — Resolve command: user override > default `gh` command > `null` (disabled)
- `isConceptDisabled(concept: string, config?: UserConfig): boolean` — Check if concept explicitly set to `null`
- Uses `child_process.exec` with `sh -c` semantics (not `execFile`) for shell expansion support
- Sets `CODEV_*` environment variables before invocation
- Parses stdout as JSON; returns `null` on non-zero exit or invalid JSON
- Logs concept unavailability at debug level

**Default command map** — Built-in `gh`-based commands for all 15 concepts:
```typescript
const DEFAULT_COMMANDS: Record<string, string> = {
  // Core issue/PR concepts (from spec)
  'issue-view': 'gh issue view $CODEV_ISSUE_ID --json title,body,state,comments',
  'pr-list': 'gh pr list --json number,title,url,reviewDecision,body,createdAt',
  'issue-list': 'gh issue list --limit 200 --json number,title,url,labels,createdAt',
  'issue-comment': 'gh issue comment $CODEV_ISSUE_ID --body "$CODEV_COMMENT_BODY"',
  'pr-exists': 'gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number --jq "length > 0"',
  'recently-closed': 'gh issue list --state closed --search "closed:>$CODEV_SINCE_DATE" --json number,title,url,labels,createdAt,closedAt',
  'recently-merged': 'gh pr list --state merged --search "merged:>$CODEV_SINCE_DATE" --json number,title,url,body,createdAt,mergedAt,headRefName',
  'user-identity': 'gh api user --jq .login',
  'team-activity': 'gh api graphql -f query="$CODEV_GRAPHQL_QUERY"',
  'on-it-timestamps': 'gh api graphql -f query="$CODEV_GRAPHQL_QUERY"',
  'pr-merge': 'gh pr merge $CODEV_PR_NUMBER --merge',
  // Additional concepts found during review
  'pr-search': 'gh pr list --search "$CODEV_SEARCH_QUERY" --json number,headRefName',
  'pr-view': 'gh pr view $CODEV_PR_NUMBER --json title,body,state,author,baseRefName,headRefName,additions,deletions',
  'pr-diff': 'gh pr diff $CODEV_PR_NUMBER',
  'gh-auth-status': 'gh auth status',
};
```

**Synchronous variant**: Some callers (e.g., `team.ts`, `consult/index.ts`) use `execSync`. The dispatcher must provide both async and sync execution:
- `executeForgeCommand(concept, env?, cwd?)` — async (primary)
- `executeForgeCommandSync(concept, env?, cwd?)` — sync (for callers that need synchronous results)

**Config extension** — Add to `UserConfig` interface:
```typescript
forge?: Record<string, string | null>;
```

#### Acceptance Criteria
- [ ] `executeForgeCommand` correctly executes configured command and parses JSON stdout
- [ ] `executeForgeCommand` returns `null` on non-zero exit, invalid JSON, or missing command
- [ ] User overrides in `af-config.json` take precedence over defaults
- [ ] Concepts set to `null` are skipped (return `null` immediately, no exec)
- [ ] Environment variables are set correctly for each invocation
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: Command resolution (default, override, null), JSON parsing (valid, invalid, empty), env var injection, error handling (non-zero exit, timeout, missing executable)
- **Integration Tests**: End-to-end concept command execution with mock scripts

#### Rollback Strategy
New files only; no existing code modified. Delete the new files to roll back.

#### Risks
- **Risk**: Shell execution introduces injection surface from env var values
  - **Mitigation**: Same trust model as git hooks; documented in spec security section

---

### Phase 2: Core GitHub Function Migration
**Dependencies**: Phase 1

#### Objectives
- Refactor `lib/github.ts` functions to route through concept command dispatch
- Maintain identical return types and behavior for callers
- Keep `parseLinkedIssue` and `parseLabelDefaults` as-is (not forge operations)

#### Deliverables
- [ ] Modified: `packages/codev/src/lib/github.ts` — refactor `fetchGitHubIssue`, `fetchPRList`, `fetchIssueList`, `fetchRecentlyClosed`, `fetchRecentMergedPRs`, `fetchMergedPRs`, `fetchClosedIssues` to use `executeForgeCommand`
- [ ] Modified: `packages/codev/src/__tests__/github.test.ts` — update tests for concept command dispatch
- [ ] Tests for concept command routing

#### Implementation Details

Each function in `github.ts` that currently calls `execFileAsync('gh', ...)` will be refactored to call `executeForgeCommand(conceptName, envVars, cwd)` instead. The function signatures and return types remain unchanged — callers see no difference.

**Migration pattern for each function**:
```typescript
// Before:
export async function fetchPRList(cwd?: string): Promise<GitHubPR[] | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--json', ...]);
    return JSON.parse(stdout);
  } catch { return null; }
}

// After:
export async function fetchPRList(cwd?: string): Promise<GitHubPR[] | null> {
  return executeForgeCommand('pr-list', {}, cwd) as Promise<GitHubPR[] | null>;
}
```

**Functions to migrate** (7 functions):
1. `fetchGitHubIssue` → `issue-view` concept
2. `fetchPRList` → `pr-list` concept
3. `fetchIssueList` → `issue-list` concept
4. `fetchRecentlyClosed` → `recently-closed` concept
5. `fetchRecentMergedPRs` → `recently-merged` concept (with `CODEV_SINCE_DATE` = 24h ago)
6. `fetchMergedPRs` → `recently-merged` concept (with `CODEV_SINCE_DATE` param)
7. `fetchClosedIssues` → `recently-closed` concept (with `CODEV_SINCE_DATE` param)

**Functions NOT migrated** (kept as-is):
- `parseLinkedIssue` / `parseAllLinkedIssues` — PR body parsing, not forge API calls
- `parseLabelDefaults` — Label parsing utility
- `fetchGitHubIssueOrThrow` — Thin wrapper, will call migrated `fetchGitHubIssue`

**Issue ID type handling**: `fetchGitHubIssue` currently takes `number`. Change signature to `string | number` and pass as `CODEV_ISSUE_ID` string. Internal callers pass numbers as before (backward compatible).

#### Acceptance Criteria
- [ ] All 7 functions route through `executeForgeCommand`
- [ ] No direct `execFileAsync('gh', ...)` calls remain for these 7 functions
- [ ] Existing tests pass with no changes to test assertions (same behavior)
- [ ] `fetchGitHubIssue` accepts `string | number` for issue ID

#### Test Plan
- **Unit Tests**: Mock `executeForgeCommand` and verify correct concept name and env vars passed
- **Integration Tests**: Verify default `gh` commands produce identical output format

#### Rollback Strategy
Revert changes to `github.ts`; concept command infrastructure remains available.

#### Risks
- **Risk**: Subtle differences in JSON parsing between direct `gh` output and concept command output
  - **Mitigation**: Default commands produce identical output; test with real `gh` CLI

---

### Phase 3: Spawn Worktree Migration
**Dependencies**: Phase 2

#### Objectives
- Migrate spawn collision detection and "On it!" commenting to concept commands
- Ensure spawn works when forge concepts are unavailable (fail with helpful error for `issue-view`, gracefully skip collision detection and commenting)

#### Deliverables
- [ ] Modified: `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — use concept commands for issue fetch, collision detection, PR search, "On it!" commenting
- [ ] Modified: `packages/codev/src/agent-farm/commands/spawn.ts` — migrate `gh issue comment` at line 642 to `issue-comment` concept
- [ ] Modified: `packages/codev/src/agent-farm/commands/cleanup.ts` — migrate `gh pr list --head` at lines 335, 339 to `pr-exists` concept (with branch-specific status check)
- [ ] Modified: `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` — update tests
- [ ] Tests for spawn with unavailable concepts

#### Implementation Details

**`fetchGitHubIssue` in spawn-worktree.ts** (line ~107):
- Currently calls `fetchGitHubIssueOrThrow` which throws on failure
- After migration: still throws if `issue-view` concept command fails — spawn requires issue context
- Error message updated to suggest configuring `issue-view` concept in `af-config.json`

**`checkBugfixCollisions` (lines ~140-185)**:
- "On it!" comment check: reads `issue.comments` — depends on `issue-view` returning comments array. If concept doesn't return comments, skip collision check gracefully.
- PR search (`gh pr list --search`): migrate to `pr-search` concept with `CODEV_SEARCH_QUERY` env var. Skip if concept unavailable.
- "On it!" comment posting: migrate to `issue-comment` concept. If concept is `null` or unavailable, skip silently.

**`spawn.ts` line 642** — Legacy spawn path:
- `gh issue comment ${issueNumber} --body "On it!..."` → use `issue-comment` concept
- If concept unavailable, skip silently (same as spawn-worktree behavior)

**`cleanup.ts` lines 335, 339** — PR merge/open status check:
- `gh pr list --head "${branch}" --state merged` → use `pr-search` concept with `CODEV_SEARCH_QUERY` including branch and state
- `gh pr list --head "${branch}" --state open` → same concept, different query
- If concept unavailable, skip PR status check and warn user to verify manually

**`executePreSpawnHooks`**:
- `collision-check` hook: use concept commands instead of direct `gh` calls
- `comment-on-issue` hook: use `issue-comment` concept

#### Acceptance Criteria
- [ ] Spawn works with default `gh` concepts (identical behavior)
- [ ] Spawn fails with helpful error when `issue-view` unavailable
- [ ] Collision detection skips gracefully when PR/comment concepts unavailable
- [ ] "On it!" commenting skips gracefully when `issue-comment` is `null`
- [ ] All existing spawn tests pass

#### Test Plan
- **Unit Tests**: Mock concept commands for each spawn scenario (all available, some unavailable, all unavailable)
- **Manual Testing**: Spawn a builder with `issue-view` disabled in `af-config.json`

#### Rollback Strategy
Revert spawn-worktree.ts changes; Phase 2 functions continue to work.

#### Risks
- **Risk**: Spawn behavior change could break existing builder workflows
  - **Mitigation**: Default commands produce identical behavior; only overrides change behavior

---

### Phase 4: Analytics & On-It-Timestamps Migration
**Dependencies**: Phase 2

#### Objectives
- Migrate `fetchOnItTimestamps` to concept command (the one core github.ts function not covered in Phase 2 due to its batched GraphQL complexity)
- Verify overview and analytics render correctly with concept commands
- Add explicit tests for empty/null forge data rendering

Note: Overview (`overview.ts`) requires no code changes — it calls functions already migrated in Phase 2. This phase focuses on analytics-specific migration and verification testing.

#### Deliverables
- [ ] Modified: `packages/codev/src/lib/github.ts` — migrate `fetchOnItTimestamps` to `on-it-timestamps` concept
- [ ] Modified: `packages/codev/src/agent-farm/servers/analytics.ts` — ensure fallback when `on-it-timestamps` unavailable
- [ ] Modified: `packages/codev/src/agent-farm/__tests__/overview.test.ts` — add tests for empty forge data
- [ ] Modified: `packages/codev/src/agent-farm/__tests__/analytics.test.ts` — update tests
- [ ] Tests for rendering with empty forge data

#### Implementation Details

**`fetchOnItTimestamps`** (`github.ts`):
- Currently a batched GraphQL query via `gh api graphql`
- Migrate to `on-it-timestamps` concept command: receives `CODEV_ISSUE_NUMBERS` (comma-separated) and returns a JSON map `{"42": "2026-03-01T...", "43": "2026-03-02T..."}`
- When concept unavailable, analytics falls back to PR `createdAt` for wall-clock time (already partially handled)

**Verification testing**:
- Verify overview renders with all concepts returning null (builders + local state visible)
- Verify analytics renders with all concepts returning null (git-derived metrics shown)
- Verify `parseLinkedIssue` / `parseLabelDefaults` still work correctly with concept command output

#### Acceptance Criteria
- [ ] Work view renders correctly with default `gh` concepts
- [ ] Work view renders without errors when all forge concepts return null (shows builders + local state)
- [ ] Analytics renders correctly with default `gh` concepts
- [ ] Analytics renders without errors when forge concepts return null (git-derived metrics shown)
- [ ] `on-it-timestamps` concept properly migrated with fallback

#### Test Plan
- **Unit Tests**: Overview and analytics with mocked concept commands (all available, some unavailable, all unavailable)
- **Manual Testing**: View Work tab and Analytics tab with forge concepts disabled

#### Rollback Strategy
Revert overview.ts and analytics.ts changes; Phase 2 functions still work.

#### Risks
- **Risk**: Analytics accuracy degrades without `on-it-timestamps`
  - **Mitigation**: Documented graceful degradation; falls back to PR createdAt

---

### Phase 5: Porch & Protocol Migration
**Dependencies**: Phase 1

#### Objectives
- Update porch to intercept `pr_exists` checks and route through concept command dispatch
- Update merge instructions in `porch/next.ts` to use `pr-merge` concept
- Keep protocol JSON templates unchanged

#### Deliverables
- [ ] Modified: `packages/codev/src/commands/porch/next.ts` — use `pr-merge` concept for merge instructions
- [ ] Modified: porch check execution logic — intercept `pr_exists` and route through forge concept
- [ ] Tests for porch with custom `pr-exists` and `pr-merge` concepts

#### Implementation Details

**`pr_exists` check interception**:
- Porch currently executes `pr_exists` as a raw shell command from protocol.json
- Add interception: when executing a check named `pr_exists`, route it through `executeForgeCommand('pr-exists', { CODEV_BRANCH_NAME: currentBranch })` instead of running the protocol.json command
- This keeps protocol.json unchanged while allowing per-project forge configuration
- The concept command returns JSON boolean on stdout (`true`/`false`); porch interprets this

**Merge instructions** (next.ts lines ~260-262):
- Replace hardcoded `gh pr merge --merge` with concept-aware instruction
- If `pr-merge` concept is configured, use it; otherwise fall back to `gh pr merge --merge`
- The merge instruction text should reference the configured command

**Porch check execution** — find where porch runs protocol checks:
- Look for the check runner that executes `command` from protocol.json `checks` section
- Add a mapping: if `checkName === 'pr_exists'`, use forge concept instead of raw command

#### Acceptance Criteria
- [ ] `porch done` with default `gh` concepts works identically
- [ ] `porch done` with custom `pr-exists` concept uses the configured command
- [ ] Merge instructions reference the configured `pr-merge` concept
- [ ] Protocol JSON files are NOT modified
- [ ] All porch tests pass

#### Test Plan
- **Unit Tests**: Mock forge concept for `pr-exists` check, verify porch uses it
- **Integration Tests**: Run `porch done` with overridden `pr-exists` concept

#### Rollback Strategy
Revert next.ts and check execution changes.

#### Risks
- **Risk**: Intercepting porch checks may have unexpected side effects
  - **Mitigation**: Only intercept `pr_exists` by name; all other checks pass through unchanged

---

### Phase 6: Team, Consult, Doctor, and Documentation
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Migrate team GitHub functions to concept commands
- Migrate consult PR review `gh` calls to concept commands
- Update `codev doctor` to validate forge concepts and make `gh auth status` conditional
- Create user documentation for the override system

#### Deliverables
- [ ] Modified: `packages/codev/src/lib/team-github.ts` — use `team-activity` and `user-identity` concepts
- [ ] Modified: `packages/codev/src/agent-farm/commands/team.ts` — migrate `gh api user` (line 17) to `user-identity` concept (sync variant)
- [ ] Modified: `packages/codev/src/commands/consult/index.ts` — migrate `gh pr view`, `gh pr diff`, `gh pr list --search` (lines 747-769, 1054, 1075) to `pr-view`, `pr-diff`, `pr-search` concepts (sync variant)
- [ ] Modified: `packages/codev/src/commands/doctor.ts` — make `gh auth status` (line 201) conditional on forge config; add concept command validation
- [ ] Modified: `packages/codev/src/__tests__/team-github.test.ts` — update tests
- [ ] New/modified: user documentation for forge concept overrides
- [ ] E2E test for "no `gh` installed" scenario (`codev adopt` succeeds)
- [ ] Tests for team and consult functions with unavailable concepts

#### Implementation Details

**Team GitHub** (`team-github.ts`):
- `fetchTeamGitHubData` → `team-activity` concept. This is the most complex concept (batched GraphQL). The concept command receives `CODEV_GRAPHQL_QUERY` and returns the raw GraphQL response. Codev still handles response parsing.
- `getRepoInfo` → `user-identity` concept for username; repo info derived from git remote
- When `team-activity` is `null`, team tab shows members without GitHub enrichment

**Team command** (`team.ts` line 17):
- `execSync('gh api user --jq .login')` → `executeForgeCommandSync('user-identity')`
- If unavailable, display a message that user identity requires forge configuration

**Consult** (`consult/index.ts`):
- Line 747: `gh pr view $N --json ...` → `executeForgeCommandSync('pr-view', { CODEV_PR_NUMBER: N })`
- Line 748: `gh pr diff $N --name-only` → `executeForgeCommandSync('pr-diff', { CODEV_PR_NUMBER: N, CODEV_DIFF_NAME_ONLY: '1' })`
- Line 753: `gh pr view $N --comments` → include in `pr-view` concept output
- Line 769: `gh pr diff $N` → `executeForgeCommandSync('pr-diff', { CODEV_PR_NUMBER: N })`
- Lines 1054, 1075: `gh pr list --head/--search` → `executeForgeCommandSync('pr-search', { CODEV_SEARCH_QUERY: ... })`
- When concepts unavailable, consult skips PR context gathering and reviews based on available local data (git diff, file contents)

**Doctor** (`doctor.ts`):
- Line 201: `gh auth status` → wrap in conditional: only run if no custom forge config or if `gh-auth-status` concept is configured
- New check: for each concept in `af-config.json` `forge` section, verify the executable exists and is runnable (`which` or `stat` + executable bit)
- Report: "Forge concept 'pr-list' configured as 'glab mr list ...' — executable 'glab' found" or "not found"

**Documentation**:
- Add user-facing docs explaining the concept command override system
- Include worked examples for two concepts using GitLab (`glab`)
- Document all 15 concept JSON output contracts
- Link from README.md

**E2E Test**: Test that `codev adopt` succeeds on a repository with no GitHub remote and no `gh` installed (spec success criterion)

#### Acceptance Criteria
- [ ] Team tab works with default `gh` concepts
- [ ] Team tab renders without errors when `team-activity` is `null`
- [ ] `codev doctor` validates configured forge concept commands
- [ ] Documentation covers override system with GitLab examples
- [ ] All existing tests pass

#### Test Plan
- **Unit Tests**: Team functions with mocked concepts, doctor validation logic
- **Manual Testing**: `codev doctor` with valid and invalid forge config

#### Rollback Strategy
Revert team-github.ts and doctor changes.

#### Risks
- **Risk**: `team-activity` concept is complex (GraphQL); hard for non-GitHub forges
  - **Mitigation**: Concept can be set to `null` to disable; team tab still shows local member data

## Dependency Map
```
Phase 1 (Infrastructure) ──→ Phase 2 (Core GitHub) ──→ Phase 3 (Spawn)
         │                            │
         │                            └──→ Phase 4 (Overview/Analytics)
         │                            │
         │                            └──→ Phase 6 (Team/Doctor/Docs)
         │
         └──→ Phase 5 (Porch/Protocol)
```

## Resource Requirements
### Development Resources
- **Engineers**: TypeScript, shell scripting, understanding of `gh` CLI
- **Environment**: Node.js, git, `gh` CLI for testing default commands

### Infrastructure
- No database changes
- No new services
- `af-config.json` extended with `forge` section
- No new monitoring

## Integration Points
### External Systems
- **`gh` CLI**: Default concept command implementation. Fallback when no override configured.
  - **Integration Type**: Process exec (shell)
  - **Phase**: All phases
  - **Fallback**: Graceful degradation (return null)

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Shell execution injection surface | Low | Medium | Same trust model as git hooks; documented |
| JSON output contract drift | Medium | Medium | Version contracts; document in stable reference |
| Regression in existing GitHub workflows | Low | High | Default commands identical to current; existing tests catch regressions |
| Large refactor scope | Medium | High | Phased approach; each phase independently testable and committable |

## Validation Checkpoints
1. **After Phase 1**: Concept command dispatcher works with test scripts
2. **After Phase 2**: All existing `github.ts` tests pass through concept dispatch
3. **After Phase 3+4**: Spawn, overview, analytics work with default and disabled concepts
4. **After Phase 5**: Porch checks work with custom `pr-exists` concept
5. **After Phase 6**: Full end-to-end with non-GitHub config

## Documentation Updates Required
- [ ] User guide for forge concept command overrides (with GitLab examples)
- [ ] JSON output contract reference for all 15 concepts
- [ ] README.md link to forge documentation
- [ ] Architecture docs updated (codev/resources/arch.md)

## Post-Implementation Tasks
- [ ] Verify zero behavior change for GitHub-hosted projects
- [ ] Test with `af-config.json` forge overrides disabled
- [ ] Verify `codev adopt` succeeds without `gh` installed

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-03-08 | Initial draft | Created from spec 589 | Builder |

## Notes

The phased approach ensures the codebase stays functional at every step. Phase 1 creates infrastructure with no existing code changes. Phase 2 migrates core functions with zero caller changes. Phases 3-6 migrate consumers incrementally. Each phase can be committed, tested, and rolled back independently.

Key design decision: concept commands execute via `sh -c` (not `execFile`) to support pipes, redirects, and variable expansion in user-configured commands. This matches the trust model of git hooks and `$EDITOR`.

---

## Amendment History

This section tracks all TICK amendments to this plan.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
