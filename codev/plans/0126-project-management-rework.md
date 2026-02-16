# Plan: Project Management Rework

## Metadata
- **ID**: 0126
- **Status**: draft
- **Specification**: codev/specs/0126-project-management-rework.md
- **Created**: 2026-02-16

## Executive Summary

Replace `projectlist.md` as the project tracking mechanism with GitHub Issues + filesystem-derived status. The implementation proceeds bottom-up: shared GitHub integration layer first, then CLI changes, then Tower endpoint, then dashboard UI. Each phase is independently testable and delivers incremental value.

## Success Metrics
- [ ] No code reads projectlist.md
- [ ] `af spawn <N>` works as positional arg
- [ ] Porch reads project summary from GitHub Issues (with spec-file fallback)
- [ ] Dashboard shows: active builders, blocked gates, pending PRs, backlog
- [ ] Status derived from filesystem + Tower state
- [ ] `codev init` no longer creates projectlist.md
- [ ] Existing numbered specs (0001-0124) still work
- [ ] Soft mode works with zero tracking infrastructure
- [ ] Test coverage >90% for new code
- [ ] Playwright tests for Work view

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "github_integration", "title": "GitHub Integration Layer"},
    {"id": "spawn_cli", "title": "Spawn CLI Rework"},
    {"id": "scaffold_cleanup", "title": "Scaffold & Doctor Cleanup"},
    {"id": "tower_endpoint", "title": "Tower /api/overview Endpoint"},
    {"id": "work_view", "title": "Dashboard Work View"},
    {"id": "cleanup", "title": "Dead Code Removal & Documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: GitHub Integration Layer
**Dependencies**: None

#### Objectives
- Extract `fetchGitHubIssue()` from spawn-worktree.ts into a shared utility
- Rewrite `getProjectSummary()` in porch to use GitHub Issues with spec-file fallback
- Establish the foundation that all subsequent phases build on

#### Deliverables
- [ ] Shared GitHub utility module
- [ ] Rewritten `getProjectSummary()` with three-tier fallback
- [ ] Unit tests for summary resolution
- [ ] PR-to-issue linkage parser (used later by Tower endpoint)

#### Implementation Details

**New file**: `packages/codev/src/lib/github.ts`
- Extract `fetchGitHubIssue()` from `spawn-worktree.ts` (lines 126-134)
- Export `GitHubIssue` interface (currently in spawn-worktree.ts lines 100-109)
- Add `fetchPRList()` — calls `gh pr list --json number,title,reviewDecision,body`
- Add `fetchIssueList()` — calls `gh issue list --json number,title,labels,createdAt`
- Add `parseLinkedIssue(prBody, prTitle)` — parses `Fixes #N`, `Closes #N`, `[Spec N]`, `[Bugfix #N]`
- Add `parseLabelDefaults(labels)` — extracts type (default: feature) and priority (default: medium)
- Non-fatal error handling: return `null` instead of calling `fatal()` for network/auth failures

**Modify**: `packages/codev/src/commands/porch/prompts.ts`
- Rewrite `getProjectSummary()` (lines 29-57):
  1. Try `fetchGitHubIssue(projectId)` → use `title` as summary
  2. Fallback: glob `codev/specs/<id>-*.md` → extract first heading + first paragraph
  3. Last resort: use project title from `status.yaml`
- Update `buildPhasePrompt()` to pass the richer issue context (body, comments) into the prompt template

**Modify**: `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
- Remove `fetchGitHubIssue()` function and `GitHubIssue` interface
- Import from `../../lib/github.js` instead

#### Acceptance Criteria
- [ ] `getProjectSummary()` returns GitHub issue title when issue exists
- [ ] `getProjectSummary()` falls back to spec file heading when no issue
- [ ] `getProjectSummary()` falls back to status.yaml title when neither exists
- [ ] `parseLinkedIssue()` correctly parses GitHub closing keywords and commit conventions
- [ ] `parseLabelDefaults()` returns correct defaults for missing labels
- [ ] spawn-worktree.ts still works with the shared import
- [ ] All existing porch tests pass

#### Test Plan
- **Unit Tests**: `getProjectSummary()` with mocked `gh` responses (success, failure, empty body); `parseLinkedIssue()` with various PR body/title formats; `parseLabelDefaults()` with missing/multiple labels
- **Integration Tests**: Porch prompt generation with real spec files

#### Rollback Strategy
Revert to reading projectlist.md — the old `getProjectSummary()` code is in git history.

#### Risks
- **Risk**: `gh` CLI not available in test environments
  - **Mitigation**: Mock all `gh` calls in tests; shared utility returns `null` on failure

---

### Phase 2: Spawn CLI Rework
**Dependencies**: Phase 1 (shared GitHub utility)

#### Objectives
- Accept issue number as positional argument: `af spawn 315`
- Require `--protocol` flag explicitly (no auto-detection)
- Remove `-p` and `--issue` flags (no backward compat aliases)
- Unify spawn flow: positional arg + protocol flag drives the code path

#### Deliverables
- [ ] Positional argument support in spawn CLI
- [ ] `--protocol` flag required for non-alias invocations
- [ ] `-p` and `--issue` flags removed
- [ ] Legacy zero-padded spec matching (`af spawn 76` → `0076-*.md`)
- [ ] Unit tests for CLI argument resolution
- [ ] Integration tests for spawn with positional arg

#### Implementation Details

**Modify**: `packages/codev/src/agent-farm/types.ts`
- Update `SpawnOptions` interface:
  - Add `issueNumber?: number` (positional arg, replaces separate `project`/`issue`)
  - Remove `project` and `issue` fields (replaced by `issueNumber`)
  - Make `protocol` the canonical protocol field (deprecate `useProtocol`)

**Modify**: `packages/codev/src/agent-farm/cli.ts`
- Change Commander command definition from `.command('spawn')` to `.command('spawn').argument('[number]', 'Issue number')`
- Note: this changes the `.action()` signature from `(options) => ...` to `(number, options) => ...`
- Add `--protocol` option (required when using positional arg)
- Remove `-p` and `--issue` flags entirely
- Add `--amends` option for TICK protocol

**Modify**: `packages/codev/src/agent-farm/types.ts`
- Add `amends?: number` to `SpawnOptions` interface for TICK `--amends` flag

**Modify**: `packages/codev/src/agent-farm/commands/spawn.ts`
- Update `validateSpawnOptions()` (line 76) to handle unified `issueNumber`
- Update `getSpawnMode()` (line 121): protocol flag drives mode selection, not the presence of spec vs issue
- **`--resume` handling**: When `--resume` is specified, protocol is NOT required — it's read from the existing worktree's `status.yaml` (already initialized). No implicit detection needed.
- **`--soft` handling**: `--soft` is a mode modifier, not a protocol. It still requires `--protocol` to be specified (e.g., `af spawn 315 --protocol spir --soft`). The spec example `af spawn 315 --soft` is shorthand for `af spawn 315 --protocol spir --soft` (SPIR is the default for `--soft` when a spec file exists).
- Update `spawnSpec()` to use `issueNumber` + `--protocol`
- Merge relevant parts of `spawnBugfix()` into a unified flow
- The spawn flow becomes:
  1. Validate: `--protocol` required (unless using `--task`, `--shell`, `--worktree`)
  2. Resolve spec: glob `codev/specs/<N>-*.md` (with `stripLeadingZeros()`)
  3. Fetch context: `fetchGitHubIssue(N)` from shared utility (non-fatal)
  4. Dispatch: protocol drives code path (SPIR → porch, BUGFIX → bugfix flow, TICK → tick flow)

#### Acceptance Criteria
- [ ] `af spawn 315 --protocol spir` finds spec and starts SPIR builder
- [ ] `af spawn 315 --protocol bugfix` starts bugfix builder
- [ ] `af spawn 320 --protocol tick --amends 315` starts TICK builder
- [ ] `af spawn -p` and `af spawn --issue` give clear "removed, use positional arg" error
- [ ] `af spawn 76 --protocol spir` finds `0076-*.md` (legacy zero-padded matching)
- [ ] `af spawn 315` without `--protocol` gives clear error message
- [ ] `af spawn 315 --resume` works (reads protocol from existing worktree, no `--protocol` needed)
- [ ] `af spawn 315 --soft` works (defaults to SPIR when spec file exists)
- [ ] `af spawn --task "fix bug"` still works (no positional arg needed)
- [ ] `af spawn --shell` still works
- [ ] `af spawn --protocol maintain` still works (no positional arg needed)

#### Test Plan
- **Unit Tests**: Argument parsing, option validation, mode determination, legacy alias mapping
- **Integration Tests**: Full spawn flow with mocked Tower (positional arg + protocol, legacy flags, error cases)

#### Rollback Strategy
Old `-p`/`--issue` flags are removed but give a clear error message pointing to the new syntax. Rollback: re-add the flags if needed (code is in git history).

#### Risks
- **Risk**: Breaking existing `af spawn -p` workflows
  - **Mitigation**: Clear error messages for removed flags; integration tests cover new syntax

---

### Phase 3: Scaffold & Doctor Cleanup
**Dependencies**: None (can run in parallel with Phase 2)

#### Objectives
- Stop creating `projectlist.md` and `projectlist-archive.md` in new projects
- Add `gh` CLI authentication check to `codev doctor`
- Clean, minimal change with no migration step needed

#### Deliverables
- [ ] `codev init` no longer creates projectlist files
- [ ] `codev adopt` no longer creates projectlist files
- [ ] `codev doctor` checks `gh` CLI authentication
- [ ] Unit tests for doctor checks

#### Implementation Details

**Modify**: `packages/codev/src/lib/scaffold.ts`
- Remove `copyProjectlist()` function call from the scaffold flow (lines 107-128)
- Remove `copyProjectlistArchive()` function call (lines 139-158)
- Keep the functions themselves (dead code removal in Phase 6)
- Remove `PROJECTLIST_FALLBACK` constant (lines 38-57)

**Modify**: `packages/codev/src/commands/doctor.ts` (or equivalent)
- Add check: run `gh auth status` and verify exit code
- Report: "GitHub CLI: authenticated as <username>" or "GitHub CLI: not authenticated (run `gh auth login`)"
- Non-fatal: doctor reports the issue but doesn't block

**Modify**: `codev-skeleton/templates/` (template directory)
- Remove `projectlist.md` template file if it exists in the skeleton

#### Acceptance Criteria
- [ ] `codev init` in a fresh directory does not create `projectlist.md`
- [ ] `codev adopt` does not create `projectlist.md`
- [ ] `codev doctor` reports `gh` auth status
- [ ] Existing repos with `projectlist.md` are unaffected (file stays, no warnings)

#### Test Plan
- **Unit Tests**: Scaffold file creation list (verify projectlist not included); doctor check for gh auth (mocked)
- **Manual Testing**: Run `codev init` in a temp directory, verify no projectlist

#### Rollback Strategy
Re-add the two function calls in scaffold.ts. Zero-risk change since it only affects new project creation.

#### Risks
- **Risk**: Users expect projectlist.md to exist
  - **Mitigation**: Dead file, no code reads it. CLAUDE.md/AGENTS.md will be updated in Phase 6.

---

### Phase 4: Tower /api/overview Endpoint
**Dependencies**: Phase 1 (shared GitHub utility)

#### Objectives
- Add `GET /api/overview` endpoint that aggregates builder state, cached PR list, and cached backlog
- Implement in-memory cache with 60s TTL for GitHub data
- Add `POST /api/overview/refresh` for manual cache invalidation
- Support degraded mode when `gh` is unavailable

#### Deliverables
- [ ] `GET /api/overview` endpoint returning builders, pendingPRs, backlog
- [ ] `POST /api/overview/refresh` endpoint
- [ ] In-memory cache layer for GitHub data
- [ ] Degraded mode (builders shown, GitHub sections empty with error)
- [ ] Unit tests for endpoint logic
- [ ] Integration tests with mocked `gh` output

#### Implementation Details

**New file**: `packages/codev/src/agent-farm/servers/overview.ts`
- `OverviewCache` class:
  - `private prCache: { data: PR[], fetchedAt: number }`
  - `private issueCache: { data: Issue[], fetchedAt: number }`
  - `private readonly TTL = 60_000`
  - `async getOverview(workspaceRoot: string): Promise<OverviewData>`
  - `invalidate(): void`
- `buildOverviewResponse()`:
  - **builders**: Read from Tower workspace state (existing `handleWorkspaceState()` logic)
    - For each builder: read `status.yaml` from its worktree for phase/gate info
    - For soft mode builders: show as "running" with no phase detail
  - **pendingPRs**: Call `fetchPRList()` from shared utility, parse linked issues
  - **backlog**: Call `fetchIssueList()`, cross-reference with `codev/specs/` glob and `.builders/` to derive status
- Degraded mode: wrap GitHub calls in try/catch, return `{ error: "..." }` fields

**Modify**: `packages/codev/src/agent-farm/servers/tower-routes.ts`
- Add route: `GET /api/overview` → `handleOverview()`
- Add route: `POST /api/overview/refresh` → `handleOverviewRefresh()`
- Instantiate `OverviewCache` in the route context

**Types** (in overview.ts or shared types):
```typescript
interface OverviewData {
  builders: BuilderOverview[];
  pendingPRs: PROverview[];
  backlog: BacklogItem[];
  errors?: { prs?: string; issues?: string };
}
```

#### Acceptance Criteria
- [ ] `GET /api/overview` returns valid JSON matching the spec schema
- [ ] Subsequent requests within 60s return cached data (no `gh` calls)
- [ ] `POST /api/overview/refresh` invalidates cache
- [ ] When `gh` fails, endpoint returns builders but empty PRs/backlog with error message
- [ ] Builder phase info comes from `status.yaml` in active worktrees
- [ ] Soft mode builders show as "running" with no phase

#### Test Plan
- **Unit Tests**: Cache TTL behavior, degraded mode, PR linkage parsing, backlog derivation logic
- **Integration Tests**: Endpoint with mocked `gh` output, cache invalidation
- **Manual Testing**: Hit endpoint while Tower is running, verify response matches active builders

#### Rollback Strategy
Remove the two routes from tower-routes.ts. No existing functionality is modified.

#### Risks
- **Risk**: `status.yaml` read from worktrees could be slow with many builders
  - **Mitigation**: Builders are typically 1-5; filesystem reads are fast. Cache prevents repeated reads.

---

### Phase 5: Dashboard Work View
**Dependencies**: Phase 4 (Tower /api/overview endpoint)

#### Objectives
- Replace Projects/Terminals/Files tabs with a unified Work tab
- Implement the Work view with Active Builders, Pending PRs, and Backlog sections
- Move file panel to collapsible bottom panel within Work tab
- Responsive layout for mobile use

#### Deliverables
- [ ] New `WorkView` component with three sections
- [ ] Builder cards with "Open" button, phase, gate indicators
- [ ] Pending PRs section with review status
- [ ] Backlog/Open Bugs section with derived status
- [ ] Collapsible file panel (bottom 1/3)
- [ ] `+ Shell` button in Work view header
- [ ] Mobile-responsive layout
- [ ] Playwright tests for layout and interactions

#### Implementation Details

**New file**: `packages/codev/dashboard/src/components/WorkView.tsx`
- Main component with three sections stacked vertically in top 2/3
- Uses `GET /api/overview` (polled every 5s, same as current StatusPanel)
- `+ Shell` button in header (reuses existing shell creation logic)
- **Info header removed**: The old `.projects-info` div (StatusPanel.tsx lines 352-371) with explanatory text and doc links is NOT replicated in WorkView. The Work view is self-explanatory.
- **Relationship to `/api/state`**: The existing `/api/state` endpoint (polled every 1s by `useBuilderStatus`) continues to power terminal tab management and the architect panel. `/api/overview` is a separate, slower (5s) poll that adds GitHub-derived data (PRs, backlog) and enriches builder data with porch phase/gate info. The Work view consumes both: `/api/state` for tab structure, `/api/overview` for the Work view sections. No duplication — different data at different cadences.

**Rewrite**: `packages/codev/dashboard/src/components/BuilderCard.tsx` (file already exists with different interface)
- Rewrite to show: builder ID, issue title, phase, mode (strict/soft)
- Gate indicators: inline badges for pending/passed gates
- "Open" button: opens builder terminal as new tab in dashboard tab bar
- Soft mode: shows "running" with no phase detail

**New file**: `packages/codev/dashboard/src/components/PRList.tsx`
- Shows: PR title, review status badge, linked issue number
- Linked issue click → opens GitHub issue in new browser tab

**New file**: `packages/codev/dashboard/src/components/BacklogList.tsx`
- Shows: issue title, type badge (feature/bug), priority badge, age
- Groups: "Ready to start" (has spec, no builder) above "Backlog" (no spec)

**Modify**: `packages/codev/dashboard/src/hooks/useTabs.ts`
- Replace `'dashboard'` tab type with `'work'`
- Remove dedicated `'files'` tab creation (file viewing integrated into Work view)
- Keep `'file'` type for individual file tabs opened via `af open`

**Modify**: `packages/codev/dashboard/src/components/App.tsx`
- Render `WorkView` when `activeTab.type === 'work'` (replaces StatusPanel)
- Update tab bar to show "Work" instead of "Dashboard"
- Remove separate Files tab button from navigation

**Modify**: `packages/codev/dashboard/src/components/FilePanel.tsx` (or create new)
- Collapsible panel: shows file search bar when collapsed, full file viewer when expanded
- Takes bottom 1/3 when expanded, just the search bar when collapsed

#### Acceptance Criteria
- [ ] Work tab shows in navigation (replaces Dashboard/Projects/Terminals/Files)
- [ ] Active builders section shows running builders with phase and gates
- [ ] "Open" button on builder card opens terminal tab
- [ ] Pending PRs section shows open PRs with review status
- [ ] Backlog section shows open issues with derived status
- [ ] File panel collapses/expands correctly
- [ ] Layout is responsive on mobile viewports
- [ ] Soft mode builders show as "running" with no phase detail
- [ ] "GitHub unavailable" message shown when API fails

#### Test Plan
- **Playwright Tests**: Work view renders, builder card click opens terminal, file panel collapse/expand, responsive layout at mobile breakpoints, degraded mode display
- **Manual Testing**: Full workflow with active builders and real GitHub data

#### Rollback Strategy
Revert App.tsx and useTabs.ts changes; old StatusPanel.tsx is still in git history.

#### Risks
- **Risk**: Complex UI with many data sources could be slow
  - **Mitigation**: Single endpoint (`/api/overview`) pre-aggregates all data; 5s polling is same as current
- **Risk**: Mobile responsiveness may need iteration
  - **Mitigation**: Use existing MobileLayout patterns from current dashboard

---

### Phase 6: Dead Code Removal & Documentation
**Dependencies**: Phases 1-5

#### Objectives
- Remove all dead code that read/wrote projectlist.md
- Update CLAUDE.md, AGENTS.md, and architecture docs
- Update the builder role definition and workflow references

#### Deliverables
- [ ] Dead code removed (StatusPanel.tsx, projectlist parsing, scaffold functions)
- [ ] CLAUDE.md and AGENTS.md updated (remove projectlist references, document new workflow)
- [ ] `codev/resources/arch.md` updated with new architecture
- [ ] Info header removal from dashboard confirmed
- [ ] All tests pass

#### Implementation Details

**Delete**: `packages/codev/dashboard/src/components/StatusPanel.tsx`
- Remove the entire file (replaced by WorkView in Phase 5)

**Modify**: `packages/codev/src/lib/scaffold.ts`
- Remove `copyProjectlist()` function body
- Remove `copyProjectlistArchive()` function body
- Remove `PROJECTLIST_FALLBACK` constant
- Remove the `projectlist.md` template from `codev-skeleton/` if present

**Modify**: `CLAUDE.md` and `AGENTS.md`
- Remove all references to `projectlist.md`
- Update "Project Tracking" section to describe issue-first workflow
- Update `af spawn` examples to use positional arg + `--protocol`
- Update dashboard description (Work tab replaces Projects/Terminals/Files)

**Modify**: `codev/resources/arch.md`
- Update architecture to reflect new GitHub integration layer
- Document `/api/overview` endpoint
- Document Work view component structure

**Modify**: `codev/resources/workflow-reference.md`
- Update spawn examples
- Remove projectlist.md references

**Modify**: `codev/resources/commands/agent-farm.md`
- Update `af spawn` syntax to show positional arg + `--protocol`
- Document `--amends` flag for TICK
- Update examples

**Modify**: `codev/resources/commands/overview.md`
- Update spawn quick reference
- Remove projectlist.md mentions

**Modify**: `codev/resources/commands/codev.md`
- Update `codev init` description (no longer creates projectlist.md)
- Update `codev doctor` description (new `gh` auth check)

#### Acceptance Criteria
- [ ] No code references to projectlist.md remain (grep confirms)
- [ ] All tests pass
- [ ] CLAUDE.md/AGENTS.md reflect the new workflow
- [ ] `codev doctor` no longer mentions projectlist

#### Test Plan
- **Verification**: `grep -r "projectlist" packages/codev/src/` returns zero results
- **All Tests**: Full test suite passes (unit + integration + Playwright)
- **Manual Testing**: Read through CLAUDE.md, verify accuracy

#### Rollback Strategy
N/A — this is cleanup. Individual file changes can be reverted independently.

#### Risks
- **Risk**: Missing a reference to projectlist.md
  - **Mitigation**: grep verification in acceptance criteria

---

## Dependency Map
```
Phase 1 (GitHub Integration) ──→ Phase 2 (Spawn CLI)
         │                                  │
         │                                  ↓
         ├──→ Phase 4 (Tower Endpoint) ──→ Phase 5 (Work View)
         │                                  │
Phase 3 (Scaffold) ────────────────────────→ Phase 6 (Cleanup)
```

Phases 1 and 3 can start in parallel.
Phases 2 and 4 can start in parallel (both depend on Phase 1).
Phase 5 depends on Phase 4.
Phase 6 depends on all other phases.

## Integration Points

### External Systems
- **GitHub API** (via `gh` CLI):
  - **Integration Type**: CLI subprocess (`gh issue view`, `gh pr list`, `gh issue list`)
  - **Phase**: Phase 1 (shared utility), Phase 4 (Tower caching)
  - **Fallback**: Degraded mode — builders shown, GitHub sections empty with error

### Internal Systems
- **Tower Server**: Phase 4 adds new endpoint, Phase 5 consumes it
- **Porch Orchestrator**: Phase 1 modifies prompt generation
- **Dashboard React App**: Phase 5 replaces UI components

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `gh` CLI not in PATH or not authenticated | Medium | Medium | Doctor check + graceful degradation |
| Dashboard regressions from Work view rewrite | Medium | Medium | Playwright tests + manual testing |
| Spawn CLI breakage for users of old flags | Low | Medium | Clear error messages pointing to new syntax |
| Cache staleness causing stale UI | Low | Low | 60s TTL + manual refresh button |

## Validation Checkpoints
1. **After Phase 1**: Porch can generate prompts without reading projectlist.md
2. **After Phase 2**: `af spawn 315 --protocol spir` works end-to-end
3. **After Phase 4**: `GET /api/overview` returns valid data with active builders
4. **After Phase 5**: Dashboard Work view is functional with real data
5. **After Phase 6**: Zero references to projectlist.md in codebase

## Documentation Updates Required
- [ ] CLAUDE.md — new workflow, spawn syntax, Work tab
- [ ] AGENTS.md — same as CLAUDE.md (keep in sync)
- [ ] codev/resources/arch.md — new GitHub layer, overview endpoint, Work view
- [ ] codev/resources/workflow-reference.md — updated spawn examples
- [ ] codev/resources/commands/agent-farm.md — `af spawn` CLI reference
- [ ] codev/resources/commands/overview.md — spawn quick reference
- [ ] codev/resources/commands/codev.md — init/doctor changes
- [ ] Builder role definition — updated spawn instructions

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-02-16 | Initial plan draft | Created from spec 0126 | Builder |
