---
name: af
description: Agent Farm CLI quick reference. Use when running af commands to check correct syntax, subcommands, and flags. Prevents guessing at command names.
disable-model-invocation: false
---

# Agent Farm Quick Reference

## Tower (Dashboard Server)

```bash
af tower start             # Start Tower on port 4100
af tower stop              # Stop Tower
af tower log               # Tail Tower logs
af tower status            # Check if Tower is running
```

There is NO `af tower restart` — use `af tower stop && af tower start`.

## Workspace

```bash
af workspace start         # Start workspace for current project
af workspace stop          # Stop workspace for current project
```

> **Deprecated alias:** `af dash` still works but prints a deprecation warning.

## Builder Management

```bash
af spawn 3 --protocol spir     # Spawn builder for SPIR project
af spawn 3 --protocol spir --soft  # Spawn builder (soft mode)
af spawn 3 --protocol bugfix   # Spawn builder for a bugfix
af spawn 3 --resume            # Resume builder in existing worktree
af status                      # Check all builder status
af cleanup --project 3         # Clean up builder worktree (safe)
af cleanup --project 3 -f      # Force cleanup
```

### Resuming Builders

When a builder's Claude process dies but the worktree and porch state survive,
use `--resume` to restart it without recreating the worktree:

```bash
af spawn 3 --resume
```

This reuses the existing `.builders/3` worktree, creates a fresh terminal
session registered with the Tower (so it appears in the workspace overview), and lets
porch pick up from whatever phase the builder was in. Works with all spawn
modes: positional issue number, `--task`, `--protocol`, `--worktree`.

## Cron (Scheduled Tasks)

Cron tasks are YAML files in `.af-cron/` at the project root. Tower loads them automatically.

```bash
af cron list               # List all cron tasks
af cron status <name>      # Check status of a specific task
af cron run <name>         # Run a task immediately
af cron enable <name>      # Enable a disabled task
af cron disable <name>     # Disable a task
```

There is NO `af cron add` — create YAML files in `.af-cron/` directly. Example:

```yaml
# .af-cron/ci-health.yaml
name: CI Health Check
schedule: "*/30 * * * *"
enabled: true
command: gh run list --limit 5 --json status,conclusion --jq '...'
condition: "output != '0'"
message: "CI Alert: ${output} recent failure(s)"
target: architect
timeout: 30
```

## Utility

```bash
af util                    # Open utility shell
af open file.ts            # Open file in annotation viewer
af ports list              # List port allocations
af send <builder> "msg"    # Send message to a builder
```

## Configuration

Edit `af-config.json` at project root to customize shell commands.

```json
{
  "shell": {
    "architect": "claude",
    "builder": "claude",
    "shell": "bash"
  }
}
```

## Pre-Spawn Checklist

**Before every `af spawn`:**

1. **`git status`** — Check for uncommitted changes
2. **Commit if dirty** — Builders branch from HEAD; uncommitted specs/plans are invisible
3. **Include `--protocol`** — It is **REQUIRED** for all numbered spawns (e.g., `af spawn 42 --protocol spir`)

The spawn command will refuse if the worktree is dirty (override with `--force`,
but the builder won't see uncommitted files).

## Common Mistakes

- **Forgetting `--protocol`** — `af spawn 42` fails; use `af spawn 42 --protocol spir` (or bugfix, tick, etc.)
- **Spawning with uncommitted changes** — builder won't see specs, plans, or codev updates
- **Running `git pull` after spawn failure** — Usually unnecessary; check `git status` first, commit, then retry
- There is NO `codev tower` command — Tower is managed via `af tower`
- There is NO `restart` subcommand — stop then start
- There is NO `af start` for Tower — use `af tower start` or `af workspace start`
