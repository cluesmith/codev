---
approved: 2026-02-17
validated: [architect]
---

# Spec 399: af cron — Scheduled Workspace Tasks

## Problem

Automated monitoring tasks that should run periodically (CI health checks, builder status sweeps, stale PR detection) currently require the architect to remember to check manually. Today's CI failure streak (50 consecutive red builds) went unnoticed because nothing was watching.

## Solution

Provide a way to define periodic monitoring tasks per workspace that execute on a schedule and deliver conditional notifications via `af send` to the architect.

### Design Decision: System Cron vs Custom Scheduler

**Chosen approach: System cron + `af cron` CLI tools.**

The scheduling problem is already solved by the OS — crontab (macOS/Linux) handles when to run. `af cron` handles the unique value: declarative task definition, conditional notification, and delivery via `af send`.

| | Custom Tower Scheduler | System Cron (chosen) |
|---|---|---|
| Scheduling | Reimplements cron in Node.js | Uses battle-tested OS scheduler |
| Tower coupling | Scheduler lives in Tower process | Scheduling independent of Tower |
| Event loop risk | `execSync` blocks Tower | Tasks run in separate processes |
| Setup | Zero — just create YAML | One command: `af cron install` |
| Lifecycle | Tied to Tower start/stop | Persistent — survives Tower restarts |

**Why system cron**: Scheduling is not our unique value — task definition, condition checking, and `af send` delivery are. Tower already runs `af send` delivery via its HTTP API; system cron just triggers the execution. This keeps Tower simple (no scheduler loop, no event loop blocking) and leverages infrastructure the OS already provides.

**Constraint**: `af send` requires Tower to be running. If Tower is down when a cron task fires, `af cron exec` logs the failure and exits silently (no cron error emails). Tasks that fire while Tower is down are simply missed — the next scheduled run will catch the issue.

### Architecture

```
System crontab
└── af cron exec <task> --workspace <path>    (triggered by OS cron)
    ├── reads .af-cron/<task>.yaml
    ├── runs shell command (with timeout)
    ├── evaluates condition against output
    ├── if condition met: calls af send → Tower → architect terminal
    └── updates SQLite with result

af cron install     reads .af-cron/*.yaml → writes tagged crontab entries
af cron uninstall   removes tagged crontab entries
af cron list/status reads YAML + SQLite → displays task info
```

### Task Definition Format

Each workspace can have a `.af-cron/` directory with YAML task files:

```yaml
# .af-cron/ci-health.yaml
name: CI Health Check
schedule: "*/30 * * * *"    # every 30 minutes
enabled: true
command: gh run list --limit 5 --json status,conclusion --jq '[.[] | select(.conclusion == "failure")] | length'
condition: "output != '0'"  # only notify if failures found
message: "CI Alert: ${output} recent failures. Run `gh run list --limit 5` to investigate."
target: architect           # who gets the af send
```

```yaml
# .af-cron/stale-prs.yaml
name: Stale PR Check
schedule: "0 */4 * * *"    # every 4 hours
enabled: true
command: gh pr list --json number,title,updatedAt --jq '[.[] | select((now - (.updatedAt | fromdateiso8601)) > 86400)] | length'
condition: "output != '0'"
message: "Stale PRs: ${output} PRs haven't been updated in 24+ hours."
target: architect
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Human-readable task name |
| `schedule` | yes | Cron expression (standard 5-field) or shortcut |
| `enabled` | no | Default `true`. Set `false` to disable without deleting |
| `command` | yes | Shell command to execute |
| `condition` | no | JS expression evaluated against `output` (string). If omitted, always notifies |
| `message` | yes | Message template. `${output}` is replaced with command stdout |
| `target` | no | Default `architect`. Could also be a builder ID |
| `timeout` | no | Command timeout in seconds. Default 30 |
| `cwd` | no | Working directory. Default is workspace root |

### Schedule Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

Shortcuts (expanded by `af cron install`):
- `@hourly` — `0 * * * *`
- `@daily` — `0 9 * * *` (9am, not midnight — developer-friendly default)

No `@startup` shortcut — system cron doesn't support it. If needed, use launchd's `RunAtLoad` or a Tower startup hook in a follow-up.

### Execution Model

1. **System cron** fires at the scheduled time
2. **`af cron exec`** runs as a CLI command in a separate process:
   a. Reads the task YAML file
   b. Checks if task is enabled (YAML `enabled` field + SQLite override)
   c. Runs shell command via `child_process.execSync` (with timeout)
   d. Evaluates condition against output (if condition set)
   e. If condition met (or no condition): calls `af send` via TowerClient HTTP API
   f. Updates SQLite with last_run, last_result, last_output
3. **If Tower is down**: `af cron exec` detects this (TowerClient connection fails), logs to stderr, updates SQLite with `last_result = 'tower_down'`, exits 0 (silent failure — don't generate cron error emails)

### Crontab Management

`af cron install` reads all `.af-cron/*.yaml` files and generates crontab entries:

```
# af-cron:start:/Users/mwk/myproject
*/30 * * * * af cron exec ci-health --workspace /Users/mwk/myproject 2>/dev/null
0 */4 * * * af cron exec stale-prs --workspace /Users/mwk/myproject 2>/dev/null
# af-cron:end:/Users/mwk/myproject
```

Key behaviors:
- Tagged blocks (`af-cron:start/end`) allow safe add/remove without affecting other crontab entries
- `af cron install` is idempotent — replaces existing block for the workspace
- `af cron uninstall` removes the tagged block
- `2>/dev/null` suppresses stderr to avoid cron mail on transient failures
- Disabled tasks (`enabled: false`) are excluded from crontab generation
- `af cron install` must be re-run when YAML files change (explicit, predictable)

### SQLite Schema

```sql
CREATE TABLE cron_tasks (
  id TEXT PRIMARY KEY,              -- workspace_path + task_name hash
  workspace_path TEXT NOT NULL,
  task_name TEXT NOT NULL,
  last_run INTEGER,                 -- unix timestamp
  last_result TEXT,                 -- 'success' | 'failure' | 'skipped' | 'tower_down'
  last_output TEXT,                 -- truncated stdout (max 4KB)
  enabled INTEGER NOT NULL DEFAULT 1, -- CLI enable/disable override
  UNIQUE(workspace_path, task_name)
);
```

### CLI Commands

```bash
af cron install                 # Sync .af-cron/*.yaml → system crontab
af cron uninstall               # Remove af-cron entries from crontab
af cron list                    # List all cron tasks for current workspace
af cron list --all              # List across all workspaces
af cron status                  # Show last run times and results
af cron run <task-name>         # Manually trigger a task now (same as af cron exec)
af cron enable <task-name>      # Enable a disabled task (SQLite override)
af cron disable <task-name>     # Disable without deleting (SQLite override)
af cron exec <task-name>        # Execute a task (called by crontab, not typically by user)
  --workspace <path>            # Required: workspace root path
```

### Tower API Routes

```
GET  /api/cron/tasks              # List tasks (optional ?workspace= filter)
GET  /api/cron/tasks/:name/status # Get task status and history
POST /api/cron/tasks/:name/run    # Manually trigger a task
POST /api/cron/tasks/:name/enable # Enable a task
POST /api/cron/tasks/:name/disable # Disable a task
```

These are thin wrappers: list/status read from YAML + SQLite, run calls `executeTask()` inline, enable/disable update SQLite.

### Dashboard Integration

Deferred to follow-up. Same as before: task name, schedule, last run, result, manual run button, enable/disable toggle.

## What Changes

1. **AF CLI**: Add `af cron` subcommand group (install, uninstall, list, status, run, enable, disable, exec)
2. **New module**: `packages/codev/src/agent-farm/commands/cron.ts` — CLI handlers and task execution logic
3. **SQLite migrations**: Add `cron_tasks` table to global.db
4. **Tower routes**: Add `/api/cron/*` read/write routes
5. **Skeleton**: Add `.af-cron/` example files

## What Stays The Same

- `af send` mechanism (reused via TowerClient HTTP API)
- Tower startup/shutdown lifecycle (no new intervals or schedulers)
- Tower server code (no CronScheduler module)
- Workspace detection
- No changes to builder or architect roles

## Scope

- Crontab management: tagged block approach (no full crontab parser needed)
- Execution: synchronous shell commands with timeout in separate process
- No retry logic — if a task fails, it reports the failure and waits for next schedule
- No `@startup` — system cron limitation; can be added via Tower hooks in follow-up
- Dashboard integration deferred to follow-up

## Acceptance Criteria

- [ ] `.af-cron/*.yaml` files define tasks per workspace
- [ ] `af cron install` generates correct crontab entries from YAML files
- [ ] `af cron uninstall` cleanly removes crontab entries
- [ ] `af cron exec` runs command, evaluates condition, delivers via `af send`
- [ ] `af cron exec` handles Tower-down gracefully (exit 0, log to SQLite)
- [ ] Conditional notifications work (only alert when condition is true)
- [ ] `af cron list` shows configured tasks
- [ ] `af cron status` shows last run times and results
- [ ] `af cron run <name>` triggers immediate execution
- [ ] Task state persists in SQLite (survives Tower restarts)
- [ ] Disabled tasks are skipped (both YAML and SQLite override)
- [ ] Command timeouts work (don't hang the cron process)
- [ ] Crontab entries are idempotent (install is safe to re-run)
