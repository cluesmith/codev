# Plan: Rename "Project" to "Workspace" for Repository Concept

## Metadata
- **Specification**: codev/specs/0112-workspace-rename.md
- **Created**: 2026-02-15

## Executive Summary

Systematic rename of all "project" identifiers that mean "repository/codebase" to "workspace" throughout the codebase. The approach follows the TypeScript compiler: rename types and interfaces first, then let compile errors guide the remaining changes. Each phase builds on the previous, progressively fixing compile errors until the full build passes.

## Success Metrics
- [ ] `npm run build` passes with zero TypeScript errors
- [ ] `npm test` passes
- [ ] No remaining uses of "project" meaning "repository" in Tower/Agent Farm code (grep verification)
- [ ] `projectId` and work-unit "project" terminology unchanged in porch
- [ ] Database migration v9 cleanly upgrades existing `global.db`
- [ ] Dashboard displays "Workspace" where referring to repository
- [ ] `codev-hq` wire protocol updated consistently with connector changes

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Types, Config & Schema Foundation"},
    {"id": "phase_2", "title": "Database Migration"},
    {"id": "phase_3", "title": "Tower Server"},
    {"id": "phase_4", "title": "Tower Client, CLI Commands & Utilities"},
    {"id": "phase_5", "title": "Dashboard & HQ Package"},
    {"id": "phase_6", "title": "Tests & Verification"}
  ]
}
```

## Phase Breakdown

### Phase 1: Types, Config & Schema Foundation
**Dependencies**: None

#### Objectives
- Rename all foundational type definitions and config interfaces so downstream code gets clear compiler errors

#### Files to Modify
- `packages/codev/src/agent-farm/types.ts` — `Config.projectRoot` → `Config.workspaceRoot`
- `packages/codev/src/agent-farm/utils/config.ts` — `findProjectRoot()` → `findWorkspaceRoot()`, `getConfig()` return value, `getResolvedCommands()` parameter, `getRolesDir()` parameter, `loadUserConfig()` parameter
- `packages/codev/src/agent-farm/servers/tower-types.ts` — `ProjectTerminals` → `WorkspaceTerminals`, `DbTerminalSession.project_path` → `workspace_path`, `InstanceStatus.projectPath` → `workspacePath`, `InstanceStatus.projectName` → `workspaceName`
- `packages/codev/src/agent-farm/db/schema.ts` — Update inline comments only (`"across all projects"` → `"across all workspaces"`, `"project this terminal belongs to"` → `"workspace this terminal belongs to"`)
- `packages/codev/src/agent-farm/lib/tower-client.ts` — Type definitions only: `TowerProject` → `TowerWorkspace`, `TowerProjectStatus` → `TowerWorkspaceStatus`, `activeProjects` → `activeWorkspaces`, `totalProjects` → `totalWorkspaces` in health type

#### Acceptance Criteria
- [ ] Type definitions compile (types may be unused until downstream fixes)
- [ ] All interfaces/types use "workspace" vocabulary for repo concept

---

### Phase 2: Database Migration
**Dependencies**: Phase 1

#### Objectives
- Add v9 migration to `global.db` that renames columns and the `known_projects` table

#### Files to Modify
- `packages/codev/src/agent-farm/db/index.ts` — Add migration v9 using CREATE-INSERT-DROP pattern (matching v7/v8 style) for:
  - `terminal_sessions.project_path` → `workspace_path` (rebuild table + index)
  - `file_tabs.project_path` → `workspace_path` (rebuild table + index)
  - `known_projects` → `known_workspaces` with `project_path` → `workspace_path`

#### Implementation Notes
- Follow existing v7/v8 migration pattern exactly (CREATE new table, INSERT-SELECT from old, DROP old, ALTER RENAME)
- Update version constant to 9
- Existing `GLOBAL_SCHEMA` string references old column names used by earlier migrations — do NOT modify migration v1-v8 SQL strings

#### Migration Validation
After migration runs, verify:
- Row counts match pre-migration counts for all three tables
- New column names exist (`workspace_path` in `terminal_sessions`, `file_tabs`, `known_workspaces`)
- Indexes exist (`idx_terminal_sessions_workspace`, `idx_file_tabs_workspace`)
- Old tables/columns are gone (`known_projects` dropped, no `project_path` columns)

#### Acceptance Criteria
- [ ] Migration v9 runs without error on existing global.db
- [ ] New tables have correct column names
- [ ] Data preserved through migration
- [ ] Validation checks pass

---

### Phase 3: Tower Server
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Rename all repo-meaning identifiers in Tower server files and update URL paths

#### Files to Modify
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — Map variable, function names (`projectTerminals` → `workspaceTerminals`, `getProjectTerminals` → `getWorkspaceTerminals`, etc.), SQL query strings (`project_path` → `workspace_path`), `config.projectRoot` → `config.workspaceRoot`
- `packages/codev/src/agent-farm/servers/tower-instances.ts` — `registerKnownProject` → `registerKnownWorkspace`, `getKnownProjectPaths` → `getKnownWorkspacePaths`, `InstanceDeps` fields, `isProject` → `isWorkspace`, URL `/project/` → `/workspace/`
- `packages/codev/src/agent-farm/servers/tower-utils.ts` — `normalizeProjectPath` → `normalizeWorkspacePath`, `getProjectName` → `getWorkspaceName`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — All `handleProject*` → `handleWorkspace*` functions, `projectPath` params → `workspacePath`, URL paths `/project/` → `/workspace/` and `/api/projects/` → `/api/workspaces/`, `activeProjects` → `activeWorkspaces` / `totalProjects` → `totalWorkspaces` in health endpoint response
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` — URL path `/project/` → `/workspace/` in route matching and comments
- `packages/codev/src/agent-farm/servers/tower-server.ts` — Wiring file: `getProjectTerminals` → `getWorkspaceTerminals`, `getProjectTerminalsEntry` → `getWorkspaceTerminalsEntry`, `projectTerminals` → `workspaceTerminals` in dependency injection
- `packages/codev/src/agent-farm/servers/tower-tunnel.ts` — `ProjectTerminals` import → `WorkspaceTerminals`, `projectTerminals` map → `workspaceTerminals`, `projectPath` → `workspacePath`, `projectName` → `workspaceName`

#### Key Risk: SQL String Literals
- SQL queries in tower-terminals.ts reference `project_path` as column names — these MUST be updated to `workspace_path` (TypeScript compiler won't catch these)
- Grep for `project_path` in all `.ts` files after this phase to verify none are missed

#### Acceptance Criteria
- [ ] All Tower server files use workspace vocabulary
- [ ] URL patterns use `/workspace/` and `/api/workspaces/`
- [ ] SQL query strings updated to `workspace_path`
- [ ] `tower-server.ts` and `tower-tunnel.ts` updated consistently

---

### Phase 4: Tower Client, CLI Commands & Utilities
**Dependencies**: Phase 1, Phase 3

#### Objectives
- Rename identifiers in tower-client, all CLI commands, agent-farm utilities, and non-agent-farm files that reference `config.projectRoot`

#### Files to Modify

**Tower Client:**
- `packages/codev/src/agent-farm/lib/tower-client.ts` — `encodeProjectPath` → `encodeWorkspacePath`, `decodeProjectPath` → `decodeWorkspacePath`, URL paths `/project/` → `/workspace/` and `/api/projects/` → `/api/workspaces/`, all function renames (`activateProject` → `activateWorkspace`, `deactivateProject` → `deactivateWorkspace`, `getProjectStatus` → `getWorkspaceStatus`, `getProjectUrl` → `getWorkspaceUrl`), `activeProjects` → `activeWorkspaces` / `totalProjects` → `totalWorkspaces` in health response handling

**Tunnel Client:**
- `packages/codev/src/agent-farm/lib/tunnel-client.ts` — `projectPath` → `workspacePath` in terminal array type

**Agent Farm Utilities:**
- `packages/codev/src/agent-farm/utils/session.ts` — `config.projectRoot` → `config.workspaceRoot`
- `packages/codev/src/agent-farm/utils/notifications.ts` — `projectRoot` params → `workspaceRoot`, `projectPath` in notification objects → `workspacePath`
- `packages/codev/src/agent-farm/utils/file-tabs.ts` — `projectPath` → `workspacePath`
- `packages/codev/src/agent-farm/utils/gate-status.ts` — `getGateStatusForProject` → `getGateStatusForWorkspace`, `projectPath` → `workspacePath`
- `packages/codev/src/agent-farm/hq-connector.ts` — `ProjectInfo` → `WorkspaceInfo`, `projectRoot` local var → `workspaceRoot`, wire protocol fields: `project_path` → `workspace_path` in status update and builder update payloads, `projects` → `workspaces` in registration payload

**CLI Commands (simple renames — `config.projectRoot` → `config.workspaceRoot`, method call renames):**
- `packages/codev/src/agent-farm/commands/start.ts`
- `packages/codev/src/agent-farm/commands/stop.ts`
- `packages/codev/src/agent-farm/commands/status.ts` — Also update output labels: `"Project:"` → `"Workspace:"`, `"Active Projects"` → `"Active Workspaces"`
- `packages/codev/src/agent-farm/commands/open.ts`
- `packages/codev/src/agent-farm/commands/shell.ts`
- `packages/codev/src/agent-farm/commands/architect.ts`
- `packages/codev/src/agent-farm/commands/attach.ts`
- `packages/codev/src/agent-farm/commands/send.ts`

**Ambiguous Files (CAREFUL — both meanings present):**
- `packages/codev/src/agent-farm/commands/spawn.ts` — `config.projectRoot` → `config.workspaceRoot`, `{ projectPath: ... }` → `{ workspacePath: ... }` in registration objects. Keep `projectId`, `options.project`
- `packages/codev/src/agent-farm/commands/cleanup.ts` — `config.projectRoot` → `config.workspaceRoot`. Keep `projectId`, `options.project`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — `config.projectRoot` → `config.workspaceRoot`, `{ projectPath: ... }` → `{ workspacePath: ... }` in registration objects. Keep `projectId` param
- `packages/codev/src/agent-farm/commands/spawn-roles.ts` — Keep all as-is (all work-unit), only `config.projectRoot` → `config.workspaceRoot` if present

**Non-Agent-Farm Files (config.projectRoot → config.workspaceRoot + local variable renames):**
- `packages/codev/src/commands/porch/prompts.ts`
- `packages/codev/src/commands/porch/protocol.ts`
- `packages/codev/src/commands/porch/state.ts`
- `packages/codev/src/commands/porch/index.ts`
- `packages/codev/src/commands/porch/next.ts`
- `packages/codev/src/commands/porch/plan.ts`
- `packages/codev/src/commands/consult/index.ts` — Rename `projectRoot` function parameters → `workspaceRoot`
- `packages/codev/src/commands/doctor.ts` — Has its own local `findProjectRoot()` function (distinct from `config.ts` and `skeleton.ts`); rename to `findWorkspaceRoot()`
- `packages/codev/src/commands/import.ts` — `findProjectRoot` → `findWorkspaceRoot`, local var
- `packages/codev/src/terminal/pty-manager.ts` — `PtyManagerConfig.projectRoot` → `workspaceRoot`, `config.projectRoot` → `config.workspaceRoot`
- `packages/codev/src/lib/skeleton.ts` — Has its own `findProjectRoot()` (distinct from `config.ts`); rename to `findWorkspaceRoot()`. Note: `import.ts` and `consult/index.ts` import from this file, not from `config.ts`

#### Acceptance Criteria
- [ ] All CLI commands use workspace vocabulary for repo paths
- [ ] Ambiguous files correctly preserve work-unit "project" identifiers
- [ ] `af status` output shows "Workspace:" for repo path, "Project XXXX" for work-unit IDs
- [ ] Non-agent-farm files updated consistently
- [ ] HQ connector wire protocol fields renamed consistently

---

### Phase 5: Dashboard & HQ Package
**Dependencies**: Phase 3, Phase 4 (needs updated API responses and wire protocol)

#### Dashboard Files to Modify
- `packages/codev/dashboard/src/lib/api.ts` — `DashboardState.projectName` → `workspaceName`, `/project/` prefix detection → `/workspace/`
- `packages/codev/dashboard/src/components/App.tsx` — `state.projectName` → `state.workspaceName` in document title
- `packages/codev/dashboard/src/components/StatusPanel.tsx` — `projectName` in header → `workspaceName`. Keep "Projects" group label for work-unit list

#### HQ Package Files to Modify
The `codev-hq` package shares a wire protocol with `hq-connector.ts`. Since Phase 4 renames the wire protocol fields, `codev-hq` must match:

- `packages/codev-hq/src/types.ts` — `ProjectInfo` → `WorkspaceInfo`, `project_path` → `workspace_path` in all message types, `projects` → `workspaces` in registration types
- `packages/codev-hq/src/state.ts` — `ProjectInfo` import → `WorkspaceInfo`, `projects` params → `workspaces`, `project_path` → `workspace_path` in all state methods and event types
- `packages/codev-hq/src/handlers.ts` — `project_path` → `workspace_path` in payload validation and handler logic
- `packages/codev-hq/src/server.ts` — `project_path` → `workspace_path` in gate approval handler

#### Acceptance Criteria
- [ ] Dashboard header shows workspace name
- [ ] Document title uses workspace name
- [ ] Work-unit "Projects" list label preserved
- [ ] HQ wire protocol uses `workspace_path` consistently with connector
- [ ] HQ types, state, and handlers all use workspace vocabulary

---

### Phase 6: Tests & Verification
**Dependencies**: All previous phases

#### Objectives
- Update all test files to match renamed identifiers, verify build and tests pass, run grep verification

#### Files to Modify

**Agent Farm Tests (17 files with project-related identifiers):**
- `packages/codev/src/agent-farm/__tests__/types.test.ts`
- `packages/codev/src/agent-farm/__tests__/config.test.ts`
- `packages/codev/src/agent-farm/__tests__/status-gate.test.ts` — `activeProjects` → `activeWorkspaces`, `totalProjects` → `totalWorkspaces`
- `packages/codev/src/agent-farm/__tests__/spawn-roles.test.ts`
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts`
- `packages/codev/src/agent-farm/__tests__/session-utils.test.ts`
- `packages/codev/src/agent-farm/__tests__/attach.test.ts`
- `packages/codev/src/agent-farm/__tests__/bugfix-195-attach.test.ts`
- `packages/codev/src/agent-farm/__tests__/bugfix-213-architect-restart.test.ts`
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` — `activeProjects` → `activeWorkspaces`, `totalProjects` → `totalWorkspaces`, URL patterns
- `packages/codev/src/agent-farm/__tests__/tower-instances.test.ts` — `known_projects`, `ProjectTerminals`, `projectPath`
- `packages/codev/src/agent-farm/__tests__/tower-tunnel.test.ts` — `projectTerminals`, `projectPath`, `projectName`
- `packages/codev/src/agent-farm/__tests__/terminal-sessions.test.ts` — `project_path` in SQL/fixtures
- `packages/codev/src/agent-farm/__tests__/file-path-resolution.test.ts` — `projectPath`
- `packages/codev/src/agent-farm/__tests__/file-tab-persistence.test.ts` — `projectPath`, `project_path`
- `packages/codev/src/agent-farm/__tests__/tunnel-client.integration.test.ts` — `projectPath`
- `packages/codev/src/agent-farm/__tests__/tunnel-integration.test.ts` — `projectPath`
- `packages/codev/src/agent-farm/__tests__/helpers/tower-test-utils.ts` — Test helper: `projectPath`, `projectName` in test fixtures

**E2E Tests:**
- `packages/codev/src/agent-farm/__tests__/tower-api.e2e.test.ts` — `activeProjects`, `totalProjects`, URL patterns
- `packages/codev/src/agent-farm/__tests__/tower-baseline.e2e.test.ts` — `projectPath`, URL patterns
- `packages/codev/src/agent-farm/__tests__/cli-tower-mode.e2e.test.ts` — `activeProjects`, URL patterns
- `packages/codev/src/agent-farm/__tests__/bugfix-199-zombie-tab.e2e.test.ts` — `projectPath`
- `packages/codev/src/agent-farm/__tests__/bugfix-202-stale-temp-projects.e2e.test.ts` — `projectPath`, `known_projects`

**Terminal Tests:**
- `packages/codev/src/terminal/__tests__/pty-manager.test.ts`
- `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts`

**Dashboard Tests:**
- `packages/codev/dashboard/__tests__/api-url-resolution.test.ts` — Update `/project/` → `/workspace/` in URL fixtures
- `packages/codev/dashboard/__tests__/StatusPanel.test.tsx` — `projectName` → `workspaceName`
- `packages/codev/dashboard/__tests__/App.terminal-persistence.test.tsx`

**Playwright / E2E Dashboard Tests (`__tests__/e2e/` subdirectory — hardcoded `/project/` URL strings):**
- `packages/codev/src/agent-farm/__tests__/e2e/tower-integration.test.ts` — `/project/` URLs (10+ occurrences)
- `packages/codev/src/agent-farm/__tests__/e2e/dashboard-bugs.test.ts` — `/project/` URLs
- `packages/codev/src/agent-farm/__tests__/e2e/dashboard-terminals.test.ts` — WebSocket URLs with `/project/`
- `packages/codev/src/agent-farm/__tests__/e2e/clickable-file-paths.test.ts`
- `packages/codev/src/agent-farm/__tests__/e2e/cloud-status.test.ts`
- `packages/codev/src/agent-farm/__tests__/e2e/dashboard-gate-banner.test.ts`
- `packages/codev/src/agent-farm/__tests__/e2e/dashboard-autocopy.test.ts`
- `packages/codev/src/agent-farm/__tests__/e2e/dashboard-clipboard.test.ts`
- `packages/codev/src/agent-farm/__tests__/e2e/dashboard-video.test.ts`

**Additional test files (string literals + compiler-visible):**
- `packages/codev/src/agent-farm/__tests__/tower-utils.test.ts` — `getProjectName`, `normalizeProjectPath`
- `packages/codev/src/agent-farm/__tests__/tower-proxy.test.ts` — `/project/` path references
- `packages/codev/src/agent-farm/__tests__/tower-websocket.test.ts` — project-scoped URL paths
- `packages/codev/src/agent-farm/__tests__/clipboard.test.ts` — own `findProjectRoot()` helper
- `packages/codev/src/__tests__/skeleton.test.ts` — tests `findProjectRoot()` (9 occurrences)
- Any other test files importing renamed types or calling renamed functions

#### Verification Steps
1. `npm run build` — zero TypeScript errors
2. `npm test` — all unit and integration tests pass
3. Playwright E2E tests — run targeted Playwright suite to verify Tower routes and dashboard URL handling still work under `/workspace/` paths
4. Grep verification (expanded scope):
   ```bash
   # Check src/ for repo-meaning identifiers
   grep -rn 'projectPath\|projectTerminals\|ProjectTerminals\|projectName\|getProjectUrl\|projectRoot\|findProjectRoot\|encodeProjectPath\|activeProjects\|totalProjects\|TowerProject\b' packages/codev/src/
   # Check dashboard/ for leftover /project/ URLs
   grep -rn '/project/' packages/codev/dashboard/
   # Check for SQL column leftovers (EXCLUDE historical migrations v1-v8 in db/index.ts which intentionally use old names)
   grep -rn 'project_path' packages/codev/src/ --include='*.ts' | grep -v 'db/index.ts'
   # Separately verify db/index.ts: only migrations v1-v8 should still reference project_path
   grep -n 'project_path' packages/codev/src/agent-farm/db/index.ts
   # Check codev-hq for leftovers
   grep -rn 'project_path\|ProjectInfo' packages/codev-hq/src/
   # Check e2e tests for leftover /project/ URLs
   grep -rn '/project/' packages/codev/src/agent-farm/__tests__/e2e/
   ```
   **Allowed exceptions**: Historical migration SQL in `db/index.ts` (v1-v8) intentionally retains old column names — these must NOT be changed.
   Confirm only work-unit uses remain elsewhere (e.g., `projectId`, `projectlist`, `codev/projects/`)
5. Verify `projectId` unchanged in porch files

#### Acceptance Criteria
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Grep verification confirms no repo-meaning "project" identifiers remain in src/, dashboard/, or codev-hq/
- [ ] Work-unit identifiers (`projectId`, etc.) preserved

---

## Dependency Map
```
Phase 1 (Types & Config) ──→ Phase 2 (Migration) ──→ Phase 3 (Tower Server) ──→ Phase 4 (Client & CLI)
                                                       │                          │
                                                       └──→ Phase 5 (Dashboard + HQ) ──┘
                                                                                   │
                                                                              Phase 6 (Tests)
```

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| SQL string literals missed by compiler | Medium | High | Grep for `project_path` in all .ts files after Phase 3 |
| Ambiguous files: wrong identifier renamed | Low | High | Spec provides line-level guidance; verify with careful diff review |
| Migration corrupts data | Low | High | Follow exact v7/v8 pattern; validate row counts and indexes post-migration |
| Dashboard URL hardcoding | Low | Medium | Search dashboard for all `/project/` string literals |
| HQ wire protocol mismatch | Medium | High | Update codev-hq in same phase window as hq-connector; grep verify |
| Missing files not listed in plan | Low | Medium | TypeScript compiler catches type mismatches; full grep after each phase |
| `activeProjects`/`totalProjects` scope ambiguity | N/A | N/A | Explicitly in scope — these count workspaces, renamed to `activeWorkspaces`/`totalWorkspaces` |
