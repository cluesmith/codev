---
approved: 2026-02-17
validated: [architect]
---

# Spec 399: af cron — Scheduled Workspace Tasks

## Problem

Automated monitoring tasks that should run periodically (CI health checks, builder status sweeps, stale PR detection) currently require the architect to remember to check manually. Today's CI failure streak (50 consecutive red builds) went unnoticed because nothing was watching.

## Solution

Add a lightweight cron scheduler to Tower that runs workspace-defined tasks on a schedule and delivers results via `af send` to the architect.

### Design Decision: Tower-Resident Scheduler

**Why not system cron?** We evaluated wrapping system crontab but rejected it:
- **Environment**: System cron runs with minimal env — no user PATH, no `GITHUB_TOKEN`, no `gh` in PATH. Tasks would fail silently.
- **Sync friction**: Every YAML add/edit/remove requires `af cron install`. Forgotten syncs = stale/broken crontab entries.
- **Lifecycle mismatch**: System cron keeps firing when Tower is down, producing zombie executions that can't deliver.

**Why Tower-resident**: Tower already runs interval-based patterns (rate limit cleanup, shellper cleanup). The scheduler follows the same pattern — zero setup, inherits Tower's full environment, auto-detects YAML changes, and stops when Tower stops. The "reimplementing cron" concern is minimal: the isDue check is ~20 lines, not a general-purpose scheduler.

### Architecture

```
Tower Server
├── existing intervals (rate limit, shellper cleanup)
└── CronScheduler (new)
    ├── loads task definitions from .af-cron/ per workspace
    ├── tracks last-run timestamps in SQLite
    └── executes tasks async → sends results via af send to architect
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
| `schedule` | yes | Cron expression (standard 5-field) |
| `enabled` | no | Default `true`. Set `false` to disable without deleting |
| `command` | yes | Shell command to execute |
| `condition` | no | JS expression evaluated against `output` (string). If omitted, always notifies |
| `message` | yes | Message template. `${output}` is replaced with command stdout |
| `target` | no | Default `architect`. Could also be a builder ID |
| `timeout` | no | Command timeout in seconds. Default 30 |
| `cwd` | no | Working directory. Default is workspace root |

### Schedule Parsing

Standard 5-field cron: `minute hour day-of-month month day-of-week`

Shortcuts:
- `@hourly` — `0 * * * *`
- `@daily` — `0 9 * * *` (9am, not midnight)
- `@startup` — run once when Tower starts

No need for a full cron library — a minimal parser handling `*`, `*/N`, and fixed values covers the use cases.

### Execution Model

1. **Tick interval**: Scheduler checks every 60 seconds
2. **Per-workspace**: Loads `.af-cron/*.yaml` from each known workspace
3. **Deduplication**: Tracks `last_run` per task in SQLite — only runs if schedule says it's due
4. **Execution**: Spawns shell command via async `child_process.exec` (non-blocking, with timeout). Does NOT use `execSync` — the Node.js event loop stays responsive while tasks run.
5. **Condition check**: If `condition` is set, evaluates it. If falsy, skip notification
6. **Delivery**: Sends message via the shared send mechanism (format + write + broadcast) to target terminal
7. **Logging**: Results logged to Tower log file

### SQLite Schema

```sql
CREATE TABLE cron_tasks (
  id TEXT PRIMARY KEY,              -- workspace_path + task_name hash
  workspace_path TEXT NOT NULL,
  task_name TEXT NOT NULL,
  last_run INTEGER,                 -- unix timestamp
  last_result TEXT,                 -- 'success' | 'failure' | 'skipped'
  last_output TEXT,                 -- truncated stdout (max 4KB)
  enabled INTEGER NOT NULL DEFAULT 1, -- CLI enable/disable override
  UNIQUE(workspace_path, task_name)
);
```

### CLI Commands

```bash
af cron list                    # List all cron tasks for current workspace
af cron list --all              # List across all workspaces
af cron status                  # Show last run times and results
af cron run <task-name>         # Manually trigger a task now
af cron enable <task-name>      # Enable a disabled task
af cron disable <task-name>     # Disable without deleting
```

### Tower API Routes

```
GET  /api/cron/tasks              # List tasks (optional ?workspace= filter)
GET  /api/cron/tasks/:name/status # Get task status and history
POST /api/cron/tasks/:name/run    # Manually trigger a task
POST /api/cron/tasks/:name/enable # Enable a task
POST /api/cron/tasks/:name/disable # Disable a task
```

### Dashboard Integration

Add a "Cron" section to the workspace overview showing:
- Task name, schedule, last run, last result
- Manual "Run Now" button
- Enable/disable toggle

This is optional and can be a follow-up.

## What Changes

1. **New module**: `packages/codev/src/agent-farm/servers/tower-cron.ts` — scheduler, task loading, execution
2. **New module**: `packages/codev/src/agent-farm/servers/tower-cron-parser.ts` — minimal cron expression parser
3. **Tower server**: Start scheduler in listen callback, stop in gracefulShutdown
4. **Tower routes**: Add `/api/cron/*` routes
5. **SQLite migrations**: Add `cron_tasks` table
6. **AF CLI**: Add `af cron` subcommand
7. **Skeleton**: Add example `.af-cron/` task files

## What Stays The Same

- `af send` mechanism (reused via shared send utility)
- Workspace detection
- Tower startup/shutdown lifecycle (just adds one more interval)
- No changes to builder or architect roles

## Scope

- Cron parser: minimal, no external dependencies
- Execution: async shell commands with timeout (non-blocking)
- No retry logic — if a task fails, it reports the failure and waits for next schedule
- Dashboard integration deferred to follow-up

## Acceptance Criteria

- [ ] `.af-cron/*.yaml` files are loaded per workspace
- [ ] Tasks execute on schedule and deliver messages via `af send`
- [ ] Task execution is non-blocking (async `exec`, not `execSync`)
- [ ] Conditional notifications work (only alert when condition is true)
- [ ] `af cron list` shows configured tasks
- [ ] `af cron status` shows last run times and results
- [ ] `af cron run <name>` triggers immediate execution
- [ ] Task state persists across Tower restarts (SQLite)
- [ ] Disabled tasks are skipped
- [ ] Command timeouts work (don't hang Tower)
- [ ] Tower log shows cron activity
