# Plan: af cron — Scheduled Workspace Tasks

## Metadata
- **Specification**: codev/specs/399-af-cron.md
- **Created**: 2026-02-17

## Executive Summary

Implement `af cron` as a thin wrapper around system crontab. Task definitions live in `.af-cron/*.yaml` per workspace. `af cron install` syncs these to system crontab entries. Each crontab entry runs `af cron exec` which handles execution, condition checking, and delivery via `af send`. Tower gets read/write API routes for status and manual control. No custom scheduler in Tower.

## Success Metrics
- [ ] All specification acceptance criteria met
- [ ] Test coverage >90% for new modules
- [ ] Zero Tower code changes beyond API routes
- [ ] Crontab management is idempotent and safe

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Database Schema and Task Execution Core"},
    {"id": "phase_2", "title": "Crontab Management"},
    {"id": "phase_3", "title": "Tower API Routes"},
    {"id": "phase_4", "title": "CLI Commands and Skeleton Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Database Schema and Task Execution Core
**Dependencies**: None

#### Objectives
- Add `cron_tasks` table to global.db
- Implement the core task execution logic (`af cron exec`)

#### Deliverables
- [ ] Global DB migration v10 adding `cron_tasks` table
- [ ] `GLOBAL_SCHEMA` updated with `cron_tasks` table for fresh installs
- [ ] `GLOBAL_CURRENT_VERSION` bumped to 10
- [ ] Task execution module: YAML loading, command execution, condition evaluation, `af send` delivery
- [ ] Unit tests for task execution and migration

#### Implementation Details

**SQLite Migration** (`packages/codev/src/agent-farm/db/index.ts`):
- Add migration v10 gated by `SELECT version FROM _migrations WHERE version = 10`
- Create `cron_tasks` table:
  ```sql
  CREATE TABLE IF NOT EXISTS cron_tasks (
    id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    task_name TEXT NOT NULL,
    last_run INTEGER,
    last_result TEXT,
    last_output TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(workspace_path, task_name)
  );
  ```
- `id` is a deterministic hash of `workspace_path + task_name`
- `enabled` column persists CLI enable/disable state (overrides YAML)

**Schema** (`packages/codev/src/agent-farm/db/schema.ts`):
- Add the `cron_tasks` CREATE TABLE to `GLOBAL_SCHEMA` string

**Task Execution Module** (`packages/codev/src/agent-farm/commands/cron.ts`):

Core function `executeTask(taskName: string, workspacePath: string)`:
1. Read `.af-cron/<taskName>.yaml` from workspace
2. Validate required fields (name, schedule, command, message)
3. Check enabled state (YAML `enabled` field AND SQLite `enabled` column)
4. Run command via `child_process.execSync` with timeout (default 30s), cwd set to workspace root
5. Capture stdout, truncate to 4KB for storage
6. If `condition` set: evaluate via `new Function('output', 'return ' + condition)` with try/catch
7. If condition met (or no condition): deliver via TowerClient
   - Call `TowerClient.sendMessage({ to: task.target, message: formattedMessage, from: 'af-cron', workspace: workspacePath })`
   - This goes through Tower's `/api/send` → `handleSend` → full format+write+broadcast pipeline
8. Update SQLite: `last_run`, `last_result`, `last_output`
9. If Tower is down (TowerClient connection fails): set `last_result = 'tower_down'`, exit 0

**YAML Loading**:
- Use `js-yaml` (already a dependency)
- `loadTask(taskName: string, workspacePath: string): CronTask | null`
- `loadAllTasks(workspacePath: string): CronTask[]` — reads `.af-cron/` directory
- Skip files that don't parse or are missing required fields, log warnings

**Message Template**:
- Replace `${output}` in message string with command stdout before sending

#### Acceptance Criteria
- [ ] Fresh install creates `cron_tasks` table via GLOBAL_SCHEMA
- [ ] Existing install creates `cron_tasks` table via migration v10
- [ ] `executeTask` runs command, evaluates condition, sends via TowerClient
- [ ] `executeTask` handles Tower-down gracefully (exit 0, SQLite records 'tower_down')
- [ ] Command timeout enforced (doesn't hang)
- [ ] Output truncated to 4KB before SQLite storage
- [ ] `${output}` template replacement works in message field

#### Test Plan
- **Unit Tests**: YAML loading — valid/invalid files, missing fields, disabled tasks
- **Unit Tests**: Condition evaluation — truthy/falsy, malformed expressions, no condition
- **Unit Tests**: Task execution — mock `execSync` and TowerClient, verify full pipeline
- **Unit Tests**: Tower-down handling — mock TowerClient failure, verify graceful exit
- **Unit Tests**: Migration — verify table creation on fresh and existing databases

#### Risks
- **Risk**: `new Function` for condition evaluation is a code injection surface
  - **Mitigation**: Conditions are defined in local YAML files that the workspace owner controls (same trust level as shell commands)
- **Risk**: `execSync` in `af cron exec` blocks the process
  - **Mitigation**: This runs in a separate cron-spawned process, not inside Tower. Timeout prevents hangs.

---

### Phase 2: Crontab Management
**Dependencies**: Phase 1

#### Objectives
- Implement `af cron install` and `af cron uninstall` to sync YAML task definitions to system crontab

#### Deliverables
- [ ] `af cron install` — reads `.af-cron/*.yaml`, generates tagged crontab block, merges into system crontab
- [ ] `af cron uninstall` — removes tagged crontab block for current workspace
- [ ] Schedule shortcut expansion (`@hourly`, `@daily`)
- [ ] Unit tests for crontab generation and management

#### Implementation Details

**Crontab Management** (in `packages/codev/src/agent-farm/commands/cron.ts`):

`cronInstall(workspacePath: string)`:
1. Read all `.af-cron/*.yaml` files from workspace
2. Filter to enabled tasks only
3. Expand schedule shortcuts: `@hourly` → `0 * * * *`, `@daily` → `0 9 * * *`
4. Generate crontab entries:
   ```
   # af-cron:start:<workspacePath>
   */30 * * * * af cron exec ci-health --workspace /path/to/workspace 2>/dev/null
   0 */4 * * * af cron exec stale-prs --workspace /path/to/workspace 2>/dev/null
   # af-cron:end:<workspacePath>
   ```
5. Read current crontab via `crontab -l` (handle empty crontab gracefully)
6. Replace existing `af-cron:start/end` block for this workspace (or append if none)
7. Write updated crontab via `crontab -` (stdin pipe)

`cronUninstall(workspacePath: string)`:
1. Read current crontab via `crontab -l`
2. Remove lines between `af-cron:start:<workspacePath>` and `af-cron:end:<workspacePath>` (inclusive)
3. Write updated crontab via `crontab -`

**Crontab safety**:
- Always read-then-write (never blindly overwrite)
- Handle `crontab: no crontab for <user>` gracefully (treat as empty)
- `2>/dev/null` on each entry suppresses stderr from transient failures
- Idempotent: running `install` twice produces the same result

#### Acceptance Criteria
- [ ] `af cron install` generates correct crontab entries from YAML files
- [ ] `af cron install` is idempotent (safe to re-run)
- [ ] `af cron install` preserves existing non-af-cron crontab entries
- [ ] `af cron uninstall` removes only af-cron entries for the workspace
- [ ] Disabled tasks are excluded from crontab generation
- [ ] Schedule shortcuts (`@hourly`, `@daily`) are correctly expanded
- [ ] Empty crontab is handled gracefully

#### Test Plan
- **Unit Tests**: Crontab generation — test entry format, shortcut expansion, disabled task exclusion
- **Unit Tests**: Crontab merging — test append to empty, replace existing block, preserve other entries
- **Unit Tests**: Crontab uninstall — test removal of tagged block, no-op when no block exists
- **Integration Tests**: Full round-trip: create YAMLs, install, verify crontab, uninstall, verify clean

#### Risks
- **Risk**: Corrupting user's existing crontab entries
  - **Mitigation**: Tagged block approach (af-cron:start/end) ensures we only touch our entries. Read-then-write pattern prevents data loss.
- **Risk**: `crontab` command not available or restricted
  - **Mitigation**: Check `crontab -l` first and give clear error message if crontab is not available.

---

### Phase 3: Tower API Routes
**Dependencies**: Phase 1

#### Objectives
- Add REST API routes to Tower for cron task status, manual execution, and enable/disable

#### Deliverables
- [ ] `GET /api/cron/tasks` route — list tasks with optional `?workspace=` filter
- [ ] `GET /api/cron/tasks/:name/status` route — task status and last run info
- [ ] `POST /api/cron/tasks/:name/run` route — manually trigger a task
- [ ] `POST /api/cron/tasks/:name/enable` route — enable a disabled task
- [ ] `POST /api/cron/tasks/:name/disable` route — disable a task

#### Implementation Details

**Tower Routes** (`packages/codev/src/agent-farm/servers/tower-routes.ts`):
- Add to `ROUTES` dispatch table:
  - `'GET /api/cron/tasks'` → `handleCronList`
- Add pattern-based routes:
  - `GET /api/cron/tasks/:name/status` → `handleCronTaskStatus`
  - `POST /api/cron/tasks/:name/run` → `handleCronRun`
  - `POST /api/cron/tasks/:name/enable` → `handleCronEnable`
  - `POST /api/cron/tasks/:name/disable` → `handleCronDisable`

**Route Handlers**:
- `handleCronList`: Read `.af-cron/` across known workspaces + join with SQLite state. Return JSON array of tasks with name, schedule, enabled, last_run, last_result. Uses `getKnownWorkspacePaths()` for workspace discovery.
- `handleCronTaskStatus`: Return detailed status for a single task including last_output. Workspace from `?workspace=` query param.
- `handleCronRun`: Import and call `executeTask()` from `commands/cron.ts` for the named task. Return execution result as JSON.
- `handleCronEnable`/`handleCronDisable`: Update `enabled` column in `cron_tasks` SQLite table. Workspace from `?workspace=` query param or body.

**No Tower server lifecycle changes**: No `initCron`/`shutdownCron`. No intervals. Routes are stateless handlers that read YAML + SQLite.

#### Acceptance Criteria
- [ ] `GET /api/cron/tasks` returns task list with SQLite state merged
- [ ] `GET /api/cron/tasks/:name/status` returns individual task details
- [ ] `POST /api/cron/tasks/:name/run` triggers execution and returns result
- [ ] `POST /api/cron/tasks/:name/enable` and `disable` toggle task enabled state in SQLite
- [ ] No changes to Tower startup/shutdown lifecycle

#### Test Plan
- **Unit Tests**: Route handlers with mocked dependencies (YAML loading, SQLite, executeTask)
- **Integration Tests**: HTTP requests to routes, verify JSON responses

#### Risks
- **Risk**: `/api/cron/tasks/:name/run` blocking Tower's event loop during execution
  - **Mitigation**: The timeout (default 30s) is the max block time. For the manual trigger use case, this is acceptable. If needed, switch to async exec in follow-up.

---

### Phase 4: CLI Commands and Skeleton Updates
**Dependencies**: Phase 1, Phase 2, Phase 3

#### Objectives
- Add `af cron` CLI subcommand group with all user-facing commands
- Add example `.af-cron/` files to skeleton

#### Deliverables
- [ ] `af cron install` CLI command
- [ ] `af cron uninstall` CLI command
- [ ] `af cron list` / `af cron list --all` CLI commands
- [ ] `af cron status` CLI command
- [ ] `af cron run <name>` CLI command
- [ ] `af cron exec <name> --workspace <path>` CLI command (called by crontab)
- [ ] `af cron enable <name>` / `af cron disable <name>` CLI commands
- [ ] Example `.af-cron/` files in skeleton

#### Implementation Details

**CLI** (`packages/codev/src/agent-farm/cli.ts`):
- Add `program.command('cron')` subcommand group (same pattern as `db` and `tower` groups)
- Each subcommand dynamically imports handler from `./commands/cron.js`

**Subcommand mapping**:
| Command | Handler | Notes |
|---------|---------|-------|
| `af cron install` | `cronInstall()` | Reads YAML, writes crontab |
| `af cron uninstall` | `cronUninstall()` | Removes crontab entries |
| `af cron list [--all]` | TowerClient `GET /api/cron/tasks` | Table format output |
| `af cron status` | TowerClient `GET /api/cron/tasks` | Shows last_run, result |
| `af cron run <name>` | TowerClient `POST /api/cron/tasks/:name/run` | Manual trigger |
| `af cron exec <name>` | `executeTask()` directly | Called by crontab, not via Tower |
| `af cron enable <name>` | TowerClient `POST /api/cron/tasks/:name/enable` | SQLite toggle |
| `af cron disable <name>` | TowerClient `POST /api/cron/tasks/:name/disable` | SQLite toggle |

**Key distinction**: `exec` runs locally (no Tower needed for execution itself, only for `af send` delivery). `run` goes through Tower API. Both ultimately call `executeTask()`.

**Skeleton** (`codev-skeleton/`):
- Create `.af-cron/ci-health.yaml.example` with the CI health check example from spec
- Note: `codev-skeleton/.gitignore` doesn't exist — skip this; workspaces manage their own `.gitignore`

**Output formatting**: Use `logger` utility for table output (list, status commands).

#### Acceptance Criteria
- [ ] All CLI commands work and produce clear output
- [ ] `af cron exec` works standalone (called by crontab without Tower for execution)
- [ ] `af cron list/status` show table-formatted output
- [ ] `af cron run` triggers via Tower API
- [ ] `af cron enable/disable` toggle state
- [ ] Skeleton has example task file

#### Test Plan
- **Unit Tests**: CLI handler functions with mocked TowerClient
- **Integration Tests**: CLI → Tower API round-trip for list, status, run, enable, disable
- **Manual Testing**: Create `.af-cron/` task files, `af cron install`, verify crontab, `af cron list`, `af cron run`

#### Risks
- **Risk**: Tower not running when list/status/run commands are called
  - **Mitigation**: TowerClient already handles connection failures with clear error messages.

---

## Dependency Map
```
Phase 1 (Schema + Exec Core) ──→ Phase 2 (Crontab Mgmt)
                              └──→ Phase 3 (Tower API) ──→ Phase 4 (CLI + Skeleton)
```

Phase 2 and Phase 3 can technically run in parallel (both depend only on Phase 1), but are sequenced for simplicity. Phase 4 depends on all three.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Crontab corruption | L | H | Tagged block approach, read-then-write |
| `crontab` command unavailable | L | M | Check availability, clear error message |
| Tower down during cron exec | M | L | Graceful failure, SQLite records 'tower_down' |
| `new Function` condition injection | L | L | Same trust level as shell commands in YAML |
| Manual trigger blocking Tower | L | M | Timeout enforced; async exec in follow-up if needed |

## Validation Checkpoints
1. **After Phase 1**: Verify migration works; `executeTask` correctly runs commands, evaluates conditions, sends via TowerClient
2. **After Phase 2**: Verify crontab install/uninstall works, entries are correct, idempotent
3. **After Phase 3**: Verify Tower API routes return correct data, manual trigger works
4. **After Phase 4**: Full end-to-end: create tasks, install crontab, verify scheduled execution, CLI commands

## Files Created/Modified

### New Files
- `packages/codev/src/agent-farm/commands/cron.ts` — Task execution, crontab management, CLI handlers
- `packages/codev/tests/unit/cron.test.ts` — Unit tests
- `codev-skeleton/.af-cron/ci-health.yaml.example` — Example task file

### Modified Files
- `packages/codev/src/agent-farm/db/schema.ts` — Add cron_tasks to GLOBAL_SCHEMA
- `packages/codev/src/agent-farm/db/index.ts` — Add migration v10, bump GLOBAL_CURRENT_VERSION
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — Add /api/cron/* routes
- `packages/codev/src/agent-farm/cli.ts` — Add cron subcommand group

### NOT Modified (compared to previous plan)
- `packages/codev/src/agent-farm/servers/tower-server.ts` — No scheduler, no lifecycle changes
- No new `tower-cron.ts` or `tower-cron-parser.ts` — No Tower-resident scheduler
