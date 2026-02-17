# Agent Farm CLI Reference

The `agent-farm` CLI (`af`) orchestrates multi-agent development with git worktrees, persistent terminal sessions, and a web dashboard.

## Installation

The `af` command is installed globally via npm:

```bash
npm install -g @cluesmith/codev
```

No aliases needed - `af`, `consult`, and `codev` work from any directory.

## Commands

### Starting and Stopping

```bash
af dash start               # Start architect dashboard
af dash start --port 4300   # Start on specific port
af dash stop                # Stop all agent-farm processes
af status                   # Show status of all agents
```

### Spawning Builders

The `spawn` command supports five modes for different workflows:

```bash
# Spec mode (standard workflow)
af spawn 9                          # Spawn builder for issue #9
af spawn 9 --protocol spir          # Explicit protocol

# Task mode (ad-hoc tasks)
af spawn --task "Fix the login bug"
af spawn --task "Refactor auth" --files src/auth.ts,src/login.ts

# Protocol mode (run a protocol)
af spawn --protocol cleanup         # Run cleanup protocol
af spawn --protocol experiment      # Run experiment protocol

# Shell mode (bare session)
af spawn --shell                    # Just Claude, no prompt/worktree

# Worktree mode (isolated branch, no prompt)
af spawn --worktree                 # Worktree for quick fixes
```

**Options:**
- `-p, --project <id>` - Spawn for a spec (e.g., `-p 0009`)
- `--task <text>` - Spawn with a task description
- `--protocol <name>` - Run a protocol (cleanup, experiment)
- `--shell` - Bare Claude session (no prompt, no worktree)
- `--worktree` - Worktree session (worktree+branch, no prompt)
- `--files <files>` - Context files for task mode (comma-separated)
- `--no-role` - Skip loading role prompt

### Communication

```bash
# Send message to a builder (from architect)
af send 0013 "Check PR 32 comments"
af send 0013 --interrupt "Stop and check PR"    # Send Ctrl+C first
af send 0013 --file src/auth.ts "Review this"   # Include file content

# Send to all builders
af send --all "Sync with main branch"

# Send to architect (from a builder worktree)
af send architect "Question about the spec..."
af send arch "Blocked on auth helper"           # shorthand

# Raw mode (skip structured formatting)
af send 0013 --raw "literal text"
af send 0013 --no-enter "don't press enter"
```

**Options:**
- `--all` - Send to all builders
- `--file <path>` - Include file content in message
- `--interrupt` - Send Ctrl+C first to interrupt current activity
- `--raw` - Skip structured message formatting
- `--no-enter` - Do not send Enter after message

**Note:** Builders can send to architect using `af send architect` from their worktree. The command auto-detects the builder ID.

### Cleanup

```bash
af cleanup -p 0003              # Clean up builder (checks for uncommitted work)
af cleanup -p 0003 --force      # Force cleanup (lose uncommitted work)
```

**Options:**
- `-p, --project <id>` - Builder ID to clean up
- `-f, --force` - Force cleanup even if branch not merged

### Utilities

```bash
af util                         # Open a utility shell terminal
af open src/file.ts             # Open file annotation viewer
af rename 0013 "auth-builder"   # Rename a builder or utility
```

### Tower Dashboard

The tower provides a centralized view of all running agent-farm instances:

```bash
af tower start                  # Start tower dashboard (default port 4100)
af tower start --port 4150      # Start on specific port
af tower stop                   # Stop the tower dashboard
```

### Port Management

For multi-project support, each project gets its own port block:

```bash
af ports list                   # List all port allocations
af ports cleanup                # Remove stale allocations
```

### Database Management

Debug and maintain the SQLite state databases:

```bash
# Local database (.agent-farm/state.db)
af db stats                     # Show database statistics
af db dump                      # Export all tables to JSON
af db query "SELECT * FROM builders"  # Run a SELECT query
af db reset                     # Delete database and start fresh (DESTRUCTIVE)

# Global database (~/.agent-farm/global.db)
af db dump --global             # Dump global port registry
af db query --global "SELECT * FROM ports"
```

### Tutorial

Interactive onboarding for new users:

```bash
af tutorial                     # Start or continue tutorial
af tutorial --status            # Show tutorial progress
af tutorial --skip              # Skip current step
af tutorial --reset             # Start tutorial fresh
```

## Configuration

Customize commands via `af-config.json` (project root):

```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": "claude --model sonnet",
    "shell": "bash"
  }
}
```

Override via CLI flags:
- `--architect-cmd <command>` - Override architect command
- `--builder-cmd <command>` - Override builder command
- `--shell-cmd <command>` - Override shell command

## State Management

Agent-farm uses SQLite databases for state:

| Database | Location | Contents |
|----------|----------|----------|
| Local | `.agent-farm/state.db` | Architect, builders, utils, annotations |
| Global | `~/.agent-farm/global.db` | Port allocations across projects |

## Key Files

- `.agent-farm/state.db` - Local runtime state (SQLite)
- `~/.agent-farm/global.db` - Global port registry (SQLite)
- `af-config.json` - Project configuration
- `codev/templates/` - Dashboard and annotation templates
- `codev/roles/` - Architect and builder role prompts
