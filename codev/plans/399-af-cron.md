# Plan: af cron — Scheduled Workspace Tasks

## Metadata
- **Specification**: codev/specs/399-af-cron.md
- **Created**: 2026-02-17

## Executive Summary

Implement a lightweight cron scheduler for Tower that loads task definitions from `.af-cron/*.yaml` per workspace, executes them on schedule, and delivers notifications via the existing `af send` mechanism. The plan is split into four phases: database schema, core scheduler module, Tower API routes, and CLI commands.

## Success Metrics
- [ ] All specification acceptance criteria met
- [ ] Test coverage >90% for new modules
- [ ] No impact on Tower startup time (< 100ms added)
- [ ] Command timeouts prevent scheduler from hanging Tower

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Database Schema and Cron Parser"},
    {"id": "phase_2", "title": "Core Scheduler Module"},
    {"id": "phase_3", "title": "Tower Integration and API Routes"},
    {"id": "phase_4", "title": "CLI Commands and Skeleton Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Database Schema and Cron Parser
**Dependencies**: None

#### Objectives
- Add `cron_tasks` table to global.db for persisting task state across Tower restarts
- Implement a minimal cron expression parser (no external dependencies)

#### Deliverables
- [ ] Global DB migration v10 adding `cron_tasks` table
- [ ] `GLOBAL_SCHEMA` updated with `cron_tasks` table for fresh installs
- [ ] `GLOBAL_CURRENT_VERSION` bumped to 10
- [ ] Cron parser module supporting standard 5-field expressions plus `@hourly`, `@daily`, `@startup` shortcuts
- [ ] Unit tests for cron parser and migration

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
- The `enabled` column persists enable/disable state from CLI commands (not in original spec schema but needed for `af cron enable/disable`)
- `id` is a deterministic hash of `workspace_path + task_name`

**Schema** (`packages/codev/src/agent-farm/db/schema.ts`):
- Add the `cron_tasks` CREATE TABLE to `GLOBAL_SCHEMA` string

**Cron Parser** (`packages/codev/src/agent-farm/servers/tower-cron-parser.ts`):
- New module, ~80 lines
- `parseCronExpression(expr: string): CronSchedule` — parses 5-field cron or shortcuts
- `isDue(schedule: CronSchedule, now: Date, lastRun: number | null): boolean` — returns true if the task should run now
- Supports: `*`, `*/N`, fixed values, comma-separated lists
- Shortcuts: `@hourly` → `0 * * * *`, `@daily` → `0 9 * * *`, `@startup` → special flag
- No ranges (`1-5`) needed per spec ("minimal parser handling `*`, `*/N`, and fixed values covers the use cases")

#### Acceptance Criteria
- [ ] Fresh install creates `cron_tasks` table via GLOBAL_SCHEMA
- [ ] Existing install creates `cron_tasks` table via migration v10
- [ ] Cron parser correctly handles `*/30 * * * *`, `0 */4 * * *`, `@hourly`, `@daily`, `@startup`
- [ ] `isDue()` correctly determines when a task should fire based on schedule and last run time

#### Test Plan
- **Unit Tests**: Cron parser — test each field type (`*`, `*/N`, fixed, comma lists), shortcuts, `isDue()` logic with various time/lastRun combinations
- **Unit Tests**: Migration — verify table creation on fresh and existing databases

#### Risks
- **Risk**: Cron time matching edge cases (minute boundaries, timezone)
  - **Mitigation**: Match against current minute only (not second-level), use UTC consistently

---

### Phase 2: Core Scheduler Module
**Dependencies**: Phase 1

#### Objectives
- Implement the `CronScheduler` class that loads YAML task definitions, executes due tasks, and delivers results via the Tower send mechanism

#### Deliverables
- [ ] `tower-cron.ts` module with `CronScheduler` class
- [ ] YAML task loading from `.af-cron/*.yaml` per workspace
- [ ] Task execution via `child_process.execSync` with timeout
- [ ] Condition evaluation against command output
- [ ] Message delivery to target terminal via `resolveTarget` + `session.write`
- [ ] SQLite state tracking (last_run, last_result, last_output)
- [ ] Unit tests for scheduler logic

#### Implementation Details

**Scheduler Module** (`packages/codev/src/agent-farm/servers/tower-cron.ts`):

```typescript
interface CronTask {
  name: string;
  schedule: string;
  enabled: boolean;
  command: string;
  condition?: string;
  message: string;
  target: string;    // default 'architect'
  timeout: number;   // default 30 (seconds)
  cwd?: string;
  workspacePath: string;
}

interface CronDeps {
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  getKnownWorkspacePaths: () => string[];
  resolveTarget: typeof import('./tower-messages.js').resolveTarget;
  getTerminalManager: typeof import('./tower-terminals.js').getTerminalManager;
}
```

Key functions:
- `initCron(deps: CronDeps): void` — starts the 60-second tick interval, runs `@startup` tasks
- `shutdownCron(): void` — clears the interval
- `loadWorkspaceTasks(workspacePath: string): CronTask[]` — reads `.af-cron/*.yaml`, validates fields, returns task list
- `tick(): void` — called every 60s; iterates all workspaces, loads tasks, checks `isDue()`, executes due tasks
- `executeTask(task: CronTask): void` — runs command, evaluates condition, sends message if condition met, updates SQLite
- `getTaskId(workspacePath: string, taskName: string): string` — deterministic ID generation

**YAML Loading**:
- Use `js-yaml` (already a dependency via porch/consult)
- Read `.af-cron/` directory per workspace
- Skip files that don't parse or are missing required fields
- Log warnings for malformed files

**Condition Evaluation**:
- `condition` field is a simple JS expression string with `output` as the variable
- Use `new Function('output', 'return ' + condition)` with a try/catch
- Return value is truthy/falsy — if truthy, send notification
- If no condition, always notify

**Message Delivery**:
- Call `resolveTarget(task.target, task.workspacePath)` to get terminal ID
- Get session via `getTerminalManager().getSession(terminalId)`
- Format as builder message (from `af-cron`) and write to session
- If target terminal not found, log warning and skip (don't fail the whole tick)

#### Acceptance Criteria
- [ ] `.af-cron/*.yaml` files are loaded per workspace on each tick
- [ ] Tasks execute on schedule based on `isDue()` check
- [ ] Command output is captured and condition is evaluated
- [ ] Messages are delivered to target terminal via session.write
- [ ] SQLite is updated with last_run, last_result, last_output
- [ ] Disabled tasks (both YAML `enabled: false` and DB `enabled = 0`) are skipped
- [ ] Command timeouts work (don't hang Tower)
- [ ] `@startup` tasks run once at init time

#### Test Plan
- **Unit Tests**: `loadWorkspaceTasks` — test with valid/invalid YAML, missing fields, disabled tasks
- **Unit Tests**: `executeTask` — mock `child_process.execSync`, test condition evaluation, message delivery
- **Unit Tests**: `tick` — mock workspace paths and task files, verify only due tasks execute
- **Integration Tests**: End-to-end: create `.af-cron/` files, run tick, verify SQLite state and message delivery

#### Risks
- **Risk**: `execSync` blocking the event loop during task execution
  - **Mitigation**: Timeout is enforced (default 30s). Tasks run sequentially per tick — acceptable for lightweight monitoring commands. If this becomes an issue, switch to `execFile` with async in a follow-up.
- **Risk**: `new Function` for condition evaluation is a code injection surface
  - **Mitigation**: Conditions are defined in local YAML files that the workspace owner controls (same trust level as shell commands). Log a warning if condition evaluation throws.

---

### Phase 3: Tower Integration and API Routes
**Dependencies**: Phase 2

#### Objectives
- Wire the `CronScheduler` into Tower's startup/shutdown lifecycle
- Add REST API routes for cron task management

#### Deliverables
- [ ] Tower server calls `initCron()` in listen callback and `shutdownCron()` in graceful shutdown
- [ ] `GET /api/cron/tasks` route — list tasks with optional `?workspace=` filter
- [ ] `GET /api/cron/tasks/:name/status` route — task status and last run info
- [ ] `POST /api/cron/tasks/:name/run` route — manually trigger a task
- [ ] Tower logs cron activity

#### Implementation Details

**Tower Server** (`packages/codev/src/agent-farm/servers/tower-server.ts`):
- Import `initCron`, `shutdownCron` from `./tower-cron.js`
- In `server.listen` callback (after `initInstances`): call `initCron({ log, getKnownWorkspacePaths, resolveTarget, getTerminalManager })`
- In `gracefulShutdown`: call `shutdownCron()` (before shutdownInstances)

**Tower Routes** (`packages/codev/src/agent-farm/servers/tower-routes.ts`):
- Add to `ROUTES` dispatch table:
  - `'GET /api/cron/tasks'` → `handleCronList`
  - `'POST /api/cron/tasks/run'` → `handleCronRun` (uses body `{ name, workspace }`)
- Add pattern-based route for:
  - `/api/cron/tasks/:name/status` → `handleCronTaskStatus`

**Route Handlers** (in `tower-routes.ts` or a new `tower-cron-routes.ts`):
- `handleCronList`: Query `.af-cron/` across workspaces + join with SQLite state. Return JSON array of tasks with name, schedule, enabled, last_run, last_result.
- `handleCronTaskStatus`: Return detailed status for a single task including last_output.
- `handleCronRun`: Call `executeTask()` directly for the named task, return result.

#### Acceptance Criteria
- [ ] Tower starts and stops the cron scheduler without errors
- [ ] `GET /api/cron/tasks` returns task list with SQLite state merged
- [ ] `GET /api/cron/tasks/:name/status` returns individual task details
- [ ] `POST /api/cron/tasks/:name/run` triggers immediate execution and returns result
- [ ] Tower log shows cron initialization and task execution activity

#### Test Plan
- **Unit Tests**: Route handlers with mocked scheduler functions
- **Integration Tests**: Start Tower, verify cron scheduler initializes, hit API routes, verify responses

#### Risks
- **Risk**: API routes for manual trigger could interfere with scheduled execution
  - **Mitigation**: Manual trigger updates `last_run` in SQLite, so the scheduled tick won't re-execute until the next due time

---

### Phase 4: CLI Commands and Skeleton Updates
**Dependencies**: Phase 3

#### Objectives
- Add `af cron` CLI subcommand group with list, status, run, enable, disable commands
- Update skeleton `.gitignore` template with `.af-cron/` exclusion

#### Deliverables
- [ ] `af cron list` command — shows configured tasks for current workspace
- [ ] `af cron list --all` — shows tasks across all workspaces
- [ ] `af cron status` — shows last run times and results
- [ ] `af cron run <name>` — triggers immediate task execution
- [ ] `af cron enable <name>` — enables a disabled task
- [ ] `af cron disable <name>` — disables a task without deleting
- [ ] Skeleton `.gitignore` updated
- [ ] Example `.af-cron/` task files in skeleton or documentation

#### Implementation Details

**CLI** (`packages/codev/src/agent-farm/cli.ts`):
- Add `program.command('cron')` subcommand group (same pattern as `db` and `tower` groups)
- Each subcommand dynamically imports handler from `./commands/cron.js`

**CLI Handler** (`packages/codev/src/agent-farm/commands/cron.ts`):
- New module with functions: `cronList`, `cronStatus`, `cronRun`, `cronEnable`, `cronDisable`
- Uses `TowerClient` to call the Tower API routes (`GET /api/cron/tasks`, `POST /api/cron/tasks/run`, etc.)
- `enable`/`disable` call a new `POST /api/cron/tasks/:name/toggle` route or directly update SQLite via a dedicated API endpoint
- Format output using `logger` utility (table format for list/status)

**Tower API** (addition to Phase 3 routes):
- `POST /api/cron/tasks/:name/enable` and `POST /api/cron/tasks/:name/disable` — toggle task enabled state in SQLite

**Skeleton** (`codev-skeleton/`):
- Add `.af-cron/` to `.gitignore` template
- Add an example task file at `codev-skeleton/.af-cron/ci-health.yaml.example`

#### Acceptance Criteria
- [ ] `af cron list` displays tasks for current workspace in table format
- [ ] `af cron list --all` displays tasks across all workspaces
- [ ] `af cron status` shows last run, result, and enabled state per task
- [ ] `af cron run <name>` triggers and returns result
- [ ] `af cron enable/disable <name>` toggles task state
- [ ] Disabled tasks show as disabled in list/status output
- [ ] Skeleton `.gitignore` includes `.af-cron/`

#### Test Plan
- **Unit Tests**: CLI handler functions with mocked TowerClient
- **Integration Tests**: CLI → Tower API round-trip for each command
- **Manual Testing**: Create `.af-cron/` task files, run `af cron list`, `af cron status`, `af cron run`

#### Risks
- **Risk**: Tower not running when CLI commands are called
  - **Mitigation**: TowerClient already handles connection failures with clear error messages. No special handling needed.

---

## Dependency Map
```
Phase 1 (Schema + Parser) ──→ Phase 2 (Scheduler) ──→ Phase 3 (Tower + API) ──→ Phase 4 (CLI + Skeleton)
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `execSync` blocking event loop | L | M | Timeout enforced; monitoring commands are fast |
| Cron parser edge cases | L | L | Thorough unit tests; match on minute granularity only |
| `new Function` for conditions | L | L | Same trust level as shell commands in YAML |
| YAML parsing errors crashing tick | M | M | Wrap in try/catch, log warning, skip bad files |

## Validation Checkpoints
1. **After Phase 1**: Verify migration works on fresh and existing DBs; cron parser passes all unit tests
2. **After Phase 2**: Verify scheduler loads tasks, executes on schedule, delivers messages
3. **After Phase 3**: Verify Tower lifecycle integration; API routes return correct data
4. **After Phase 4**: Full end-to-end: create tasks, list via CLI, verify scheduled execution

## Files Created/Modified

### New Files
- `packages/codev/src/agent-farm/servers/tower-cron-parser.ts` — Cron expression parser
- `packages/codev/src/agent-farm/servers/tower-cron.ts` — CronScheduler class
- `packages/codev/src/agent-farm/commands/cron.ts` — CLI handlers
- `packages/codev/tests/unit/tower-cron-parser.test.ts` — Parser tests
- `packages/codev/tests/unit/tower-cron.test.ts` — Scheduler tests

### Modified Files
- `packages/codev/src/agent-farm/db/schema.ts` — Add cron_tasks to GLOBAL_SCHEMA
- `packages/codev/src/agent-farm/db/index.ts` — Add migration v10, bump GLOBAL_CURRENT_VERSION
- `packages/codev/src/agent-farm/servers/tower-server.ts` — Wire initCron/shutdownCron
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — Add /api/cron/* routes
- `packages/codev/src/agent-farm/cli.ts` — Add cron subcommand group
- `codev-skeleton/.gitignore` (or template) — Add .af-cron/ exclusion
