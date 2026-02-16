# Review: Project Management Rework (Spec 0126)

## Summary

Replaced `projectlist.md` as the project tracking registry with GitHub Issues. Reworked `af spawn` CLI to use positional arguments + `--protocol` flag. Added a Tower `/api/overview` endpoint that aggregates builder state from the filesystem with PR/issue data from GitHub. Built a new Dashboard "Work" view that replaces the old StatusPanel with three sections: Active Builders, Pending PRs, and Backlog & Open Bugs. Updated skeleton distribution docs to remove all projectlist references. Synced AGENTS.md to match CLAUDE.md.

**Net diff**: ~+4,800 / -2,900 lines across 80+ files (including tests, docs, skeleton updates, and consultation artifacts).

## Phase Timeline

| Phase | Commits | Key Deliverables |
|-------|---------|-----------------|
| **Plan** | 2 commits | Initial plan + multi-agent review feedback |
| **Phase 1: github_integration** | 3 commits | `github.ts` shared utility, `getProjectSummary()` with 3-tier fallback, 34 tests |
| **Phase 2: spawn_cli** | 3 commits | Positional arg + `--protocol`, removed `-p`/`--issue`, TICK `--amends`, 86 spawn tests |
| **Phase 3: scaffold_cleanup** | 2 commits | `codev init`/`adopt` no longer create projectlist.md, `codev doctor` checks `gh auth`, 14 doctor tests |
| **Phase 4: tower_endpoint** | 1 commit | `GET /api/overview`, `POST /api/overview/refresh`, `OverviewCache` with 60s TTL, 24 overview tests + 6 route tests |
| **Phase 5: work_view** | 3 commits | `WorkView.tsx`, `BuilderCard`, `PRList`, `BacklogList`, `useOverview` hook, CSS |
| **Phase 6: cleanup** | 3 commits | StatusPanel deleted, projectlist functions removed, all docs updated, spawn syntax fixed |
| **Review** | 6 commits | E2E test fixes, Codex feedback fixes, architect pre-merge fixes, skeleton docs, AGENTS.md sync |

## Spec Compliance

| Requirement | Status | Notes |
|------------|--------|-------|
| GitHub as project registry | Done | `github.ts` with `fetchGitHubIssue`, `fetchPRList`, `fetchIssueList`, PR-to-issue linkage |
| Spawn CLI rework | Done | Positional arg + `--protocol`; old flags show migration errors |
| `--soft` without `--protocol` defaults | Done | SPIR if spec exists, bugfix if no spec |
| Scaffold cleanup | Done | `codev init`/`adopt` no longer create projectlist.md |
| Tower `/api/overview` endpoint | Done | Cached endpoint with degraded mode when `gh` unavailable |
| Dashboard Work view | Done | Three-section layout replacing StatusPanel |
| Dead code removal | Done | StatusPanel deleted, projectlist functions removed, legacy CSS cleaned |
| Documentation updates | Done | CLAUDE.md, AGENTS.md (synced), arch.md, agent-farm.md, workflow-reference.md, cheatsheet.md |
| Skeleton docs updated | Done | All 12+ projectlist references replaced across 8 skeleton files |
| AGENTS.md = CLAUDE.md | Done | Build sequence, worktree protection, af open all synced |

## Changes Made Due to 3-Way Consultation Feedback

### Phase 1 (github_integration) Consultation
- **All three approved** — no changes needed.

### Phase 2 (spawn_cli) Consultation
- **Fixed**: Zero-padded ID handling in `findSpecFile()` — `stripLeadingZeros()` comparison
- **Fixed**: Old `-p`/`--issue` flags now show clear migration error messages instead of silently failing
- **Fixed**: TICK `--amends` flag validation and documentation
- **Fixed**: GitHub issue context (title, body) passed through to builder prompts

### Phase 3 (scaffold_cleanup) Consultation
- **Fixed**: Improved `gh auth` error messaging in `codev doctor`
- **Fixed**: Added tests for auth failure scenarios

### Phase 4 (tower_endpoint) Consultation
- **All three approved** — no changes needed.

### Phase 5 (work_view) Consultation
- **Critical fix**: Workspace-scoped overview route was not passing `workspacePath` to `handleOverview()` — dashboard would have been completely broken (caught by Claude)
- **Fixed**: Backlog grouping — separate sections for feature requests and bugs
- **Fixed**: Gate badges — show gate status on builder cards
- **Fixed**: File panel search input behavior
- **Rebutted**: Playwright tests (no Tower infrastructure in builder worktree)
- **Rebutted**: YAML parsing approach (regex is appropriate for machine-generated flat YAML)
- **Rebutted**: PR linked issue clickability (needs repo URL from additional API call)

### Phase 6 (cleanup) Consultation
- **Fixed**: Spawn syntax updated across all active docs (CLAUDE.md, AGENTS.md, arch.md, workflow-reference.md, agent-farm.md, cheatsheet.md, SKILL.md)
- **Rebutted**: Excluded test files (E2E tests were excluded from suite, later fixed during review phase)
- **Rebutted**: Skeleton files (deferred to coordinated update, later fixed per architect request)
- **Rebutted**: CLAUDE.md ≠ AGENTS.md (pre-existing divergence, later fixed per architect request)

### PR Consultation
- **Gemini**: APPROVE (HIGH confidence)
- **Claude**: APPROVE (HIGH confidence)
- **Codex**: REQUEST_CHANGES → 3 items fixed, 3 rebutted:
  - **Fixed**: Zero-padded spec file matching in `getProjectSummary()` (numeric prefix regex)
  - **Fixed**: Bugfix builder issue number extraction in `discoverBuilders()` (trailing digit regex)
  - **Fixed**: Terminal persistence test tab/panel IDs (`tab-dashboard` → `tab-work`)
  - **Rebutted**: `--resume` protocol inference (already handled correctly inside handler)
  - **Rebutted**: Heading-only summary (appropriate for one-line UI display)
  - **Rebutted**: Collapsed file panel search (intentional focus trigger pattern)

### Architect Pre-Merge Feedback
- **Fixed**: `init.test.ts` projectlist assertion flipped to `toBe(false)`
- **Fixed**: `--soft` without `--protocol` now defaults to SPIR if spec exists, bugfix otherwise
- **Fixed**: All 12+ skeleton doc projectlist references updated across 8 files
- **Fixed**: AGENTS.md synced to match CLAUDE.md (build sequence, worktree protection, af open)

## Deviations from Plan

- **PR linked issue not clickable**: The spec says "Linked issue click opens GitHub issue in new tab." The implementation shows linked issue as text because the GitHub repo URL is not available in the overview API response. Would require an additional `gh repo view` call.
- **Playwright tests not written**: Builder worktree lacks Tower infrastructure for E2E tests. Server-side tests (overview + route tests) cover the API layer. Component rendering validated by build.
- **YAML parsing uses regex instead of js-yaml**: `status.yaml` files are machine-generated by porch with a flat structure. Regex parser is simpler and avoids adding a runtime dependency.

## Test Coverage

**1420 tests pass** (main suite, 73 files) + **72 CLI tests pass** (6 files).

New tests added by this project:
- `github.test.ts` — 24 tests (parseLinkedIssue, parseLabelDefaults, fetchGitHubIssue)
- `project-summary.test.ts` — 10 tests (3-tier fallback, zero-padded IDs, dot separators)
- `overview.test.ts` — 24 tests (parseStatusYaml, discoverBuilders, deriveBacklog, OverviewCache)
- `doctor.test.ts` — 14 tests (gh auth checks, AI model verification)
- `spawn.test.ts` — 86 tests (positional arg, --protocol, --amends, --soft, --resume, migration errors)
- `tower-routes.test.ts` — 42 tests (overview route, workspace-scoped dispatch)
- `spawn-roles.test.ts` — 19 tests (findSpecFile, zero-padded matching)
- `scaffold.test.ts` — 21 tests (no-projectlist regression)
- CLI E2E: `init.e2e.test.ts`, `adopt.e2e.test.ts`, `af.e2e.test.ts` updated for new behavior

## Lessons Learned

### What Went Well
- **Six-phase plan worked**: Dependency ordering (GitHub layer → spawn CLI → scaffold → tower endpoint → work view → cleanup) meant each phase built cleanly on the previous
- **3-way consultation caught a critical bug**: Claude's Phase 5 review identified that `/api/overview` was only registered as a global Tower route, not a workspace-scoped route — the dashboard would have been completely broken
- **Degraded mode design**: Building the overview endpoint to work even when `gh` is unavailable (showing builders but empty PR/backlog sections with error messages) was a good design choice
- **Test-first approach for spawn CLI**: Writing tests before refactoring the spawn command caught edge cases in the zero-padded ID handling and TICK amends flow
- **Skeleton doc cleanup was worth doing**: Initially rebutted as out-of-scope, but the architect correctly identified that shipping skeleton docs with stale projectlist references would confuse users of new projects

### Challenges Encountered
- **Workspace-scoped routing**: The Tower server has two routing layers (global and workspace-scoped) and it's easy to add a global route without realizing the dashboard fetches via workspace-scoped paths. This was caught by consultation but could have been prevented by better understanding of the routing architecture upfront.
- **Vitest 4 mock patterns**: `vi.fn().mockImplementation(...)` doesn't work as a constructor in Vitest 4. Had to use `class` syntax for OverviewCache mocks.
- **Context window pressure**: The session ran out of context twice — during Phase 5 consultation feedback and again during review phase — requiring continuation summaries.
- **Rebase conflict**: Main branch had added `findExistingBugfixWorktree()` to `spawn-worktree.ts` while this branch modified the same area. Required manual merge during rebase.

### What Would Be Done Differently
- **Read the Tower routing architecture first**: Before adding any Tower route, trace the full request path from dashboard fetch → workspace dispatch → global fallback
- **Keep phases smaller**: Phase 5 (Work view) was the largest and required the most consultation feedback. Splitting dashboard components into separate phases would have been more manageable
- **Update skeleton docs in the original plan**: Deferring skeleton updates was rebutted during cleanup consultation but the architect correctly required them. The plan should have included skeleton as a Phase 6 target.
- **Sync AGENTS.md proactively**: The divergence between CLAUDE.md and AGENTS.md predated this project but should have been caught and fixed during the cleanup phase rather than waiting for architect feedback.

## Technical Debt

- **Excluded unit test still references projectlist.md**: `init.test.ts` (the flaky unit test, not the E2E) is excluded from the test suite. Should be updated when un-excluded.
- **PR linked issue not clickable**: Needs repo URL added to the overview API response.
- **No Playwright tests for Work view**: Should be added to the integration test suite post-merge.

## Follow-up Items

- Add Playwright tests for Work view (requires Tower infrastructure)
- Consider adding repo URL to overview API for clickable PR linked issues
- Un-exclude and fix `init.test.ts` unit test for new scaffold behavior
