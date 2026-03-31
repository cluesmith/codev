# Agent Farm CLI Reference

The `agent-farm` CLI (`afx`) orchestrates multi-agent development with git worktrees, persistent terminal sessions, and a web dashboard.

## Installation

The `afx` command is installed globally via npm:

```bash
npm install -g @cluesmith/codev
```

No aliases needed - `afx`, `consult`, and `codev` work from any directory.

## Commands

### Starting and Stopping

```bash
afx workspace start               # Start workspace
afx workspace start --port 4300   # Start on specific port
afx workspace stop                # Stop all agent-farm processes
afx status                   # Show status of all agents
```

### Spawning Builders

The `spawn` command supports five modes for different workflows:

```bash
# Spec mode (standard workflow)
afx spawn 9                          # Spawn builder for issue #9
afx spawn 9 --protocol spir          # Explicit protocol

# Task mode (ad-hoc tasks)
afx spawn --task "Fix the login bug"
afx spawn --task "Refactor auth" --files src/auth.ts,src/login.ts

# Protocol mode (run a protocol)
afx spawn --protocol cleanup         # Run cleanup protocol
afx spawn --protocol experiment      # Run experiment protocol

# Shell mode (bare session)
afx spawn --shell                    # Just Claude, no prompt/worktree

# Worktree mode (isolated branch, no prompt)
afx spawn --worktree                 # Worktree for quick fixes
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
afx send 0013 "Check PR 32 comments"
afx send 0013 --interrupt "Stop and check PR"    # Send Ctrl+C first
afx send 0013 --file src/auth.ts "Review this"   # Include file content

# Send to all builders
afx send --all "Sync with main branch"

# Send to architect (from a builder worktree)
afx send architect "Question about the spec..."
afx send arch "Blocked on auth helper"           # shorthand

# Raw mode (skip structured formatting)
afx send 0013 --raw "literal text"
afx send 0013 --no-enter "don't press enter"
```

**Options:**
- `--all` - Send to all builders
- `--file <path>` - Include file content in message
- `--interrupt` - Send Ctrl+C first to interrupt current activity
- `--raw` - Skip structured message formatting
- `--no-enter` - Do not send Enter after message

**Note:** Builders can send to architect using `afx send architect` from their worktree. The command auto-detects the builder ID.

### Cleanup

```bash
afx cleanup -p 0003              # Clean up builder (checks for uncommitted work)
afx cleanup -p 0003 --force      # Force cleanup (lose uncommitted work)
```

**Options:**
- `-p, --project <id>` - Builder ID to clean up
- `-f, --force` - Force cleanup even if branch not merged

### Utilities

```bash
afx util                         # Open a utility shell terminal
afx open src/file.ts             # Open file annotation viewer
afx rename 0013 "auth-builder"   # Rename a builder or utility
```

### Tower Dashboard

The tower provides a centralized view of all running agent-farm instances:

```bash
afx tower start                  # Start tower dashboard (default port 4100)
afx tower start --port 4150      # Start on specific port
afx tower stop                   # Stop the tower dashboard
```

### Port Management

For multi-project support, each project gets its own port block:

```bash
afx ports list                   # List all port allocations
afx ports cleanup                # Remove stale allocations
```

### Database Management

Debug and maintain the SQLite state databases:

```bash
# Local database (.agent-farm/state.db)
afx db stats                     # Show database statistics
afx db dump                      # Export all tables to JSON
afx db query "SELECT * FROM builders"  # Run a SELECT query
afx db reset                     # Delete database and start fresh (DESTRUCTIVE)

# Global database (~/.agent-farm/global.db)
afx db dump --global             # Dump global port registry
afx db query --global "SELECT * FROM ports"
```

### Tutorial

Interactive onboarding for new users:

```bash
afx tutorial                     # Start or continue tutorial
afx tutorial --status            # Show tutorial progress
afx tutorial --skip              # Skip current step
afx tutorial --reset             # Start tutorial fresh
```

## Configuration

Customize commands via `.codev/config.json` (project root):

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
- `.codev/config.json` - Project configuration
- `codev/templates/` - Dashboard and annotation templates
- `codev/roles/` - Architect and builder role prompts
