---
approved: 2026-02-15
validated: [gemini, codex, claude]
---

# Spec 0112: Rename "Project" → "Workspace" for Repository Concept

## Problem

The word "project" is used for two different things in the codebase:

1. **Repository/codebase** (Tower, dashboard, CLI): `projectPath`, `projectTerminals`, `known_projects`, `getProjectUrl()` — refers to a git repository managed by Tower (e.g., `codev-public`, `todo-app`)

2. **Work-unit** (porch, projectlist, specs): `projectId`, `af spawn -p 0108`, `projectlist.md` — refers to a tracked unit of work with a spec/plan/review lifecycle

This causes real confusion. An architect spent 20 minutes in the wrong file because "project" was ambiguous. The upcoming Spec 0110 (Messaging Infrastructure) introduces a `project:agent` addressing format that makes the collision even worse.

### Consultation

Three-way consultation (Gemini, Codex, Claude) unanimously recommended:
- **"workspace"** for the repository/codebase concept (VS Code precedent, natural hierarchy)
- **"project"** stays for work-units (right scale from bugfixes to platform rewrites)

## Solution

Rename all uses of "project" that mean "repository/codebase" to **"workspace"** throughout Tower, Agent Farm, dashboard, and CLI code. Keep "project" for work-units (porch, projectlist, specs).

### Vocabulary

| Term | Means | Examples |
|------|-------|---------|
| **Workspace** | A git repository managed by Tower | `codev-public`, `todo-app` |
| **Project** | A tracked unit of work (spec/plan/review) | `0108`, `0110`, `0111` |

### Rename Map

#### Database Schema (`db/schema.ts` + migrations)

| Before | After |
|--------|-------|
| `terminal_sessions.project_path` | `terminal_sessions.workspace_path` |
| `file_tabs.project_path` | `file_tabs.workspace_path` |
| `known_projects` table | `known_workspaces` table |
| `known_projects.project_path` | `known_workspaces.workspace_path` |
| `idx_terminal_sessions_project` | `idx_terminal_sessions_workspace` |
| `idx_file_tabs_project` | `idx_file_tabs_workspace` |

**Migration**: Add migration **v9** to `global.db` (the only database with affected tables; `state.db` is unaffected). SQLite requires CREATE-new, INSERT-SELECT, DROP-old for table renames with column renames. Follow the existing pattern used in v7/v8 migrations.

**Schema comments**: Update inline comments in `GLOBAL_SCHEMA` (e.g., `"-- project this terminal belongs to"` → `"-- workspace this terminal belongs to"`, `"across all projects"` → `"across all workspaces"`).

#### Type Definitions (`tower-types.ts`)

| Before | After |
|--------|-------|
| `ProjectTerminals` | `WorkspaceTerminals` |
| `DbTerminalSession.project_path` | `DbTerminalSession.workspace_path` |
| `InstanceStatus.projectPath` | `InstanceStatus.workspacePath` |
| `InstanceStatus.projectName` | `InstanceStatus.workspaceName` |

#### Tower Terminals (`tower-terminals.ts`)

| Before | After |
|--------|-------|
| `projectTerminals` Map | `workspaceTerminals` Map |
| `getProjectTerminals()` | `getWorkspaceTerminals()` |
| `getProjectTerminalsEntry()` | `getWorkspaceTerminalsEntry()` |
| `saveTerminalSession(_, projectPath, ...)` | `saveTerminalSession(_, workspacePath, ...)` |
| `deleteProjectTerminalSessions()` | `deleteWorkspaceTerminalSessions()` |
| `getTerminalSessionsForProject()` | `getTerminalSessionsForWorkspace()` |
| `loadFileTabsForProject()` | `loadFileTabsForWorkspace()` |
| `getTerminalsForProject()` | `getTerminalsForWorkspace()` |

#### Tower Instances (`tower-instances.ts`)

| Before | After |
|--------|-------|
| `registerKnownProject()` | `registerKnownWorkspace()` |
| `getKnownProjectPaths()` | `getKnownWorkspacePaths()` |
| `InstanceDeps.projectTerminals` | `InstanceDeps.workspaceTerminals` |
| `InstanceDeps.getProjectTerminalsEntry` | `InstanceDeps.getWorkspaceTerminalsEntry` |
| `InstanceDeps.deleteProjectTerminalSessions` | `InstanceDeps.deleteWorkspaceTerminalSessions` |
| `InstanceDeps.getTerminalsForProject` | `InstanceDeps.getTerminalsForWorkspace` |
| `isProject` in directory suggestions | `isWorkspace` |

#### Tower Routes (`tower-routes.ts`)

| Before | After |
|--------|-------|
| `handleProjectAction()` | `handleWorkspaceAction()` |
| `handleProjectRoutes()` | `handleWorkspaceRoutes()` |
| `handleProjectState()` | `handleWorkspaceState()` |
| `handleProjectShellCreate()` | `handleWorkspaceShellCreate()` |
| `handleProjectFileTabCreate()` | `handleWorkspaceFileTabCreate()` |
| `handleProjectFileGet()` | `handleWorkspaceFileGet()` |
| `handleProjectFileRaw()` | `handleWorkspaceFileRaw()` |
| `handleProjectFileSave()` | `handleWorkspaceFileSave()` |
| `handleProjectTabDelete()` | `handleWorkspaceTabDelete()` |
| `handleProjectStopAll()` | `handleWorkspaceStopAll()` |
| `handleProjectFiles()` | `handleWorkspaceFiles()` |
| `handleProjectGitStatus()` | `handleWorkspaceGitStatus()` |
| `handleProjectRecentFiles()` | `handleWorkspaceRecentFiles()` |
| `handleProjectAnnotate()` | `handleWorkspaceAnnotate()` |
| `projectPath` param (throughout) | `workspacePath` param |

**URL patterns**: Rename `/project/` → `/workspace/` and `/api/projects/` → `/api/workspaces/` throughout:

| File | Before | After |
|------|--------|-------|
| `tower-routes.ts` | `/api/projects/:path/activate` | `/api/workspaces/:path/activate` |
| `tower-routes.ts` | `/api/projects/:path/deactivate` | `/api/workspaces/:path/deactivate` |
| `tower-routes.ts` | `/api/projects/:path/status` | `/api/workspaces/:path/status` |
| `tower-routes.ts` | `/project/:base64urlPath/*` | `/workspace/:base64urlPath/*` |
| `tower-instances.ts` | `/project/${encodedPath}/` | `/workspace/${encodedPath}/` |
| `tower-websocket.ts` | `/project/:encodedPath/ws/terminal/:id` | `/workspace/:encodedPath/ws/terminal/:id` |
| `tower-client.ts` | `/api/projects/${encoded}/activate` etc. | `/api/workspaces/${encoded}/activate` etc. |
| `tower-client.ts` | `/project/${encoded}/` | `/workspace/${encoded}/` |
| `dashboard/src/lib/api.ts` | `/project/` prefix detection | `/workspace/` prefix detection |
| Dashboard tests | `/project/` in URL test fixtures | `/workspace/` |

#### Tower Utils (`tower-utils.ts`)

| Before | After |
|--------|-------|
| `normalizeProjectPath()` | `normalizeWorkspacePath()` |
| `getProjectName()` | `getWorkspaceName()` |

#### Tower Client (`lib/tower-client.ts`)

| Before | After |
|--------|-------|
| `TowerProject` | `TowerWorkspace` |
| `TowerProjectStatus` | `TowerWorkspaceStatus` |
| `encodeProjectPath()` | `encodeWorkspacePath()` |
| `decodeProjectPath()` | `decodeWorkspacePath()` |
| `activateProject()` | `activateWorkspace()` |
| `deactivateProject()` | `deactivateWorkspace()` |
| `getProjectStatus()` | `getWorkspaceStatus()` |
| `getProjectUrl()` | `getWorkspaceUrl()` |

#### CLI Commands

| File | Before | After |
|------|--------|-------|
| `start.ts` | `projectPath` local var | `workspacePath` |
| `stop.ts` | `projectPath` local var | `workspacePath` |
| `status.ts` | `projectPath`, `projectStatus` | `workspacePath`, `workspaceStatus` |
| `open.ts` | `projectPath` param | `workspacePath` |
| `shell.ts` | `projectPath` param | `workspacePath` |
| `architect.ts` | `projectPath` usage | `workspacePath` |
| `attach.ts` | `projectPath` usage | `workspacePath` |
| `send.ts` | `getProjectStatus` call | `getWorkspaceStatus` |

**Note**: `config.projectRoot` → `config.workspaceRoot` everywhere in CLI commands (see Config section below).

#### Config (`utils/config.ts` + `types.ts`)

| Before | After |
|--------|-------|
| `Config.projectRoot` | `Config.workspaceRoot` |
| `findProjectRoot()` | `findWorkspaceRoot()` |
| `getConfig()` returns `projectRoot` | `getConfig()` returns `workspaceRoot` |
| All `config.projectRoot` usages (~39 files) | `config.workspaceRoot` |

#### File Tabs Utility (`utils/file-tabs.ts`)

| Before | After |
|--------|-------|
| `projectPath` param | `workspacePath` param |

#### Gate Status Utility (`utils/gate-status.ts`)

| Before | After |
|--------|-------|
| `getGateStatusForProject()` | `getGateStatusForWorkspace()` |
| `projectPath` param | `workspacePath` param |

#### Dashboard (`dashboard/src/`)

| File | Before | After |
|------|--------|-------|
| `lib/api.ts` | `DashboardState.projectName` | `DashboardState.workspaceName` |
| `components/App.tsx` | `state.projectName` (document title) | `state.workspaceName` |
| `components/StatusPanel.tsx` | `projectName` in header bar | `workspaceName` |
| Display references to "Project" | "Workspace" where referring to repo | Keep "Projects" for work-unit list |

#### Spawn/Cleanup (Ambiguous Files — Handle Carefully)

These files use BOTH meanings. Only rename the repo-meaning uses:

| File | Keep (work-unit) | Rename (repo) |
|------|-------------------|---------------|
| `spawn.ts` | `projectId`, `options.project` | `config.projectRoot` → `config.workspaceRoot`; `{ projectPath: ... }` → `{ workspacePath: ... }` in registration objects |
| `cleanup.ts` | `projectId`, `options.project` | `config.projectRoot` → `config.workspaceRoot` |
| `spawn-worktree.ts` | `projectId` param | `config.projectRoot` → `config.workspaceRoot`; `{ projectPath: ... }` → `{ workspacePath: ... }` in registration objects |
| `spawn-roles.ts` | `projectId` param | (none — all uses are work-unit) |

**`config.projectRoot` → `config.workspaceRoot`**: Rename throughout. This property holds the path to the git repository (workspace), so it should use the workspace vocabulary. This affects the `Config` interface in `types.ts`, `getConfig()` in `config.ts`, `findProjectRoot()` → `findWorkspaceRoot()`, and all ~39 files that reference `config.projectRoot`.

### What NOT to Rename

- **`projectId`** in porch — this is a work-unit ID (correct usage)
- **`projectlist.md`** — this tracks work-unit projects (correct usage)
- **`codev/projects/`** directory — porch runtime state for work-unit projects (correct usage)
- **`-p` / `--project` CLI flag** in `af spawn` — refers to work-unit (correct usage)
- **User-facing dashboard text** saying "Projects" group label — keep for work-unit list. But "Project: codev-public" in header → "Workspace: codev-public"

### Tests

Update all test files that reference renamed identifiers. The TypeScript compiler will catch every missed rename at build time.

### Ambiguity Points — Double-Check These

These locations use BOTH meanings of "project" in close proximity. The builder must carefully distinguish which occurrences to rename and which to keep:

1. **`spawn.ts` lines ~140-180**: `projectId` (work-unit "0108") sits next to `config.workspaceRoot` (repo path, renamed) and `registration.workspacePath` (repo path, renamed). Only rename the repo-meaning ones.

2. **`cleanup.ts` lines ~120-135**: `projectId = options.project` is work-unit, but `config.workspaceRoot` (formerly `config.projectRoot`) on line ~92 is repo (renamed). The `options.project` CLI flag is work-unit — do NOT rename.

3. **`spawn-worktree.ts` lines ~75-86 and ~260-345**: `projectId` parameter is work-unit (for porch init), but `registration.workspacePath` (formerly `registration.projectPath`) on line ~262 is repo (renamed). Same function, different meanings.

4. **`gate-status.ts`**: `getGateStatusForProject(projectPath)` takes a repo path (→ rename to `workspacePath`), but inside it reads `codev/projects/<id>/` which are work-unit directories (→ keep "projects" in path).

5. **`tower-routes.ts` handleTerminalCreate**: `body.projectPath` from the API request means repo path (→ rename in handler). But the terminal might be spawned for a builder working on a "project" (work-unit). Only the path variable changes.

6. **`status.ts` CLI output**: Currently prints `Project: /path/to/repo`. Should print `Workspace: /path/to/repo`. But `af status` also shows builder IDs which are work-unit project IDs — those stay as "Project 0108".

7. **Dashboard `StatusPanel.tsx`**: The "Projects" group header refers to work-unit projects listed in `projectlist.md` — keep as "Projects". But `projectName` in the header bar refers to the repo name — rename to `workspaceName`.

8. **`config.workspaceRoot`** (formerly `config.projectRoot`): Renamed throughout. The function `findProjectRoot()` → `findWorkspaceRoot()` and all ~39 files that reference `config.projectRoot` must be updated. The function's internal logic (looking for `codev/` directory, `.git`, etc.) stays the same.

## Scope

- ~600+ identifier renames across ~40 TypeScript source files
- 1 database migration v9 on `global.db` (column + table renames)
- ~5 dashboard component updates
- URL path renames (`/project/` → `/workspace/`, `/api/projects/` → `/api/workspaces/`)
- `config.projectRoot` → `config.workspaceRoot` across ~39 files
- Test file updates (compiler-guided)
- No changes to porch, projectlist, or work-unit terminology

## Acceptance Criteria

1. `npm run build` passes with zero TypeScript errors
2. `npm test` passes
3. No remaining uses of "project" meaning "repository" in Tower code (grep verification)
4. `projectId` and work-unit "project" terminology unchanged in porch
5. Database migration cleanly upgrades existing `global.db`
6. Dashboard displays "Workspace" where referring to repository
