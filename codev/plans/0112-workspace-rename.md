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

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Types, Config & Schema Foundation"},
    {"id": "phase_2", "title": "Database Migration"},
    {"id": "phase_3", "title": "Tower Server"},
    {"id": "phase_4", "title": "Tower Client, CLI Commands & Utilities"},
    {"id": "phase_5", "title": "Dashboard"},
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

#### Acceptance Criteria
- [ ] Migration v9 runs without error on existing global.db
- [ ] New tables have correct column names
- [ ] Data preserved through migration

---

### Phase 3: Tower Server
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Rename all repo-meaning identifiers in Tower server files and update URL paths

#### Files to Modify
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — Map variable, function names (`projectTerminals` → `workspaceTerminals`, `getProjectTerminals` → `getWorkspaceTerminals`, etc.), SQL query strings (`project_path` → `workspace_path`), `config.projectRoot` → `config.workspaceRoot`
- `packages/codev/src/agent-farm/servers/tower-instances.ts` — `registerKnownProject` → `registerKnownWorkspace`, `getKnownProjectPaths` → `getKnownWorkspacePaths`, `InstanceDeps` fields, `isProject` → `isWorkspace`, URL `/project/` → `/workspace/`
- `packages/codev/src/agent-farm/servers/tower-utils.ts` — `normalizeProjectPath` → `normalizeWorkspacePath`, `getProjectName` → `getWorkspaceName`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — All `handleProject*` → `handleWorkspace*` functions, `projectPath` params → `workspacePath`, URL paths `/project/` → `/workspace/` and `/api/projects/` → `/api/workspaces/`
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` — URL path `/project/` → `/workspace/` in route matching and comments

#### Key Risk: SQL String Literals
- SQL queries in tower-terminals.ts reference `project_path` as column names — these MUST be updated to `workspace_path` (TypeScript compiler won't catch these)
- Grep for `project_path` in all `.ts` files after this phase to verify none are missed

#### Acceptance Criteria
- [ ] All Tower server files use workspace vocabulary
- [ ] URL patterns use `/workspace/` and `/api/workspaces/`
- [ ] SQL query strings updated to `workspace_path`

---

### Phase 4: Tower Client, CLI Commands & Utilities
**Dependencies**: Phase 1, Phase 3

#### Objectives
- Rename identifiers in tower-client, all CLI commands, agent-farm utilities, and non-agent-farm files that reference `config.projectRoot`

#### Files to Modify

**Tower Client:**
- `packages/codev/src/agent-farm/lib/tower-client.ts` — `TowerProject` → `TowerWorkspace`, `TowerProjectStatus` → `TowerWorkspaceStatus`, `encodeProjectPath` → `encodeWorkspacePath`, URL paths `/project/` → `/workspace/` and `/api/projects/` → `/api/workspaces/`, all function renames

**Agent Farm Utilities:**
- `packages/codev/src/agent-farm/utils/session.ts` — `config.projectRoot` → `config.workspaceRoot`
- `packages/codev/src/agent-farm/utils/notifications.ts` — `projectRoot` params → `workspaceRoot`, `projectPath` in notification objects → `workspacePath`
- `packages/codev/src/agent-farm/utils/file-tabs.ts` — `projectPath` → `workspacePath`
- `packages/codev/src/agent-farm/utils/gate-status.ts` — `getGateStatusForProject` → `getGateStatusForWorkspace`, `projectPath` → `workspacePath`
- `packages/codev/src/agent-farm/hq-connector.ts` — `projectRoot` local var → `workspaceRoot`

**CLI Commands (simple renames — `config.projectRoot` → `config.workspaceRoot`, method call renames):**
- `packages/codev/src/agent-farm/commands/start.ts`
- `packages/codev/src/agent-farm/commands/stop.ts`
- `packages/codev/src/agent-farm/commands/status.ts` — Also update output label `"Project:"` → `"Workspace:"`
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
- `packages/codev/src/commands/doctor.ts`
- `packages/codev/src/commands/import.ts` — `findProjectRoot` → `findWorkspaceRoot`, local var
- `packages/codev/src/terminal/pty-manager.ts` — `PtyManagerConfig.projectRoot` → `workspaceRoot`, `config.projectRoot` → `config.workspaceRoot`
- `packages/codev/src/lib/skeleton.ts`

#### Acceptance Criteria
- [ ] All CLI commands use workspace vocabulary for repo paths
- [ ] Ambiguous files correctly preserve work-unit "project" identifiers
- [ ] `af status` output shows "Workspace:" for repo path, "Project XXXX" for work-unit IDs
- [ ] Non-agent-farm files updated consistently

---

### Phase 5: Dashboard
**Dependencies**: Phase 3 (needs updated API responses)

#### Files to Modify
- `packages/codev/dashboard/src/lib/api.ts` — `DashboardState.projectName` → `workspaceName`, `/project/` prefix detection → `/workspace/`
- `packages/codev/dashboard/src/components/App.tsx` — `state.projectName` → `state.workspaceName` in document title
- `packages/codev/dashboard/src/components/StatusPanel.tsx` — `projectName` in header → `workspaceName`. Keep "Projects" group label for work-unit list

#### Acceptance Criteria
- [ ] Dashboard header shows workspace name
- [ ] Document title uses workspace name
- [ ] Work-unit "Projects" list label preserved

---

### Phase 6: Tests & Verification
**Dependencies**: All previous phases

#### Objectives
- Update all test files to match renamed identifiers, verify build and tests pass, run grep verification

#### Files to Modify
- `packages/codev/src/agent-farm/__tests__/types.test.ts`
- `packages/codev/src/agent-farm/__tests__/config.test.ts`
- `packages/codev/src/agent-farm/__tests__/status-gate.test.ts`
- `packages/codev/src/agent-farm/__tests__/spawn-roles.test.ts`
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts`
- `packages/codev/src/agent-farm/__tests__/session-utils.test.ts`
- `packages/codev/src/agent-farm/__tests__/clipboard.test.ts`
- `packages/codev/src/agent-farm/__tests__/attach.test.ts`
- `packages/codev/src/agent-farm/__tests__/bugfix-195-attach.test.ts`
- `packages/codev/src/agent-farm/__tests__/bugfix-213-architect-restart.test.ts`
- `packages/codev/src/terminal/__tests__/pty-manager.test.ts`
- `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts`
- `packages/codev/dashboard/__tests__/api-url-resolution.test.ts` — Update `/project/` → `/workspace/` in URL fixtures
- `packages/codev/dashboard/__tests__/StatusPanel.test.ts`
- `packages/codev/dashboard/__tests__/App.terminal-persistence.test.tsx`
- Any other test files that fail `npm run build`

#### Verification Steps
1. `npm run build` — zero TypeScript errors
2. `npm test` — all tests pass
3. Grep verification: `grep -rn 'projectPath\|projectTerminals\|ProjectTerminals\|projectName\|getProjectUrl\|projectRoot' packages/codev/src/` — confirm only work-unit uses remain
4. Verify `projectId` unchanged in porch files

#### Acceptance Criteria
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Grep verification confirms no repo-meaning "project" identifiers remain
- [ ] Work-unit identifiers (`projectId`, etc.) preserved

---

## Dependency Map
```
Phase 1 (Types & Config) ──→ Phase 2 (Migration) ──→ Phase 3 (Tower Server) ──→ Phase 4 (Client & CLI)
                                                       │                          │
                                                       └──→ Phase 5 (Dashboard) ──┘
                                                                                   │
                                                                              Phase 6 (Tests)
```

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| SQL string literals missed by compiler | Medium | High | Grep for `project_path` in all .ts files after Phase 3 |
| Ambiguous files: wrong identifier renamed | Low | High | Spec provides line-level guidance; verify with careful diff review |
| Migration corrupts data | Low | High | Follow exact v7/v8 pattern; test on copy of existing db |
| Dashboard URL hardcoding | Low | Medium | Search dashboard for all `/project/` string literals |
