# af - Agent Farm CLI

The `af` (agent-farm) command manages multi-agent orchestration for software development. It spawns and manages builders in isolated git worktrees.

## Synopsis

```
af <command> [options]
```

## Global Options

```
--architect-cmd <command>    Override architect command
--builder-cmd <command>      Override builder command
--shell-cmd <command>        Override shell command
```

## Commands

### af start

Start the architect dashboard.

```bash
af start [options]
```

**Options:**
- `-c, --cmd <command>` - Command to run in architect terminal
- `-p, --port <port>` - Port for architect terminal
- `--no-role` - Skip loading architect role prompt

**Description:**

Starts the agent-farm dashboard with:
- Architect terminal (Claude session with architect role)
- Web-based UI for monitoring builders
- tmux session management

The dashboard is accessible via browser at `http://localhost:<port>`.

**Examples:**

```bash
# Start with defaults
af start

# Start with custom port
af start -p 4300

# Start with specific command
af start -c "claude --model opus"
```

---

### af stop

Stop all agent farm processes.

```bash
af stop
```

**Description:**

Stops all running agent-farm processes including:
- tmux sessions
- ttyd processes
- Dashboard servers

Does NOT clean up worktrees - use `af cleanup` for that.

---

### af spawn

Spawn a new builder.

```bash
af spawn [options]
```

**Options:**
- `-p, --project <id>` - Spawn builder for a spec (e.g., `0042`)
- `--task <text>` - Spawn builder with a task description
- `--protocol <name>` - Spawn builder to run a protocol
- `--shell` - Spawn a bare Claude session
- `--worktree` - Spawn worktree session
- `--files <files>` - Context files (comma-separated)
- `--no-role` - Skip loading role prompt

**Description:**

Creates a new builder in an isolated git worktree. The builder gets:
- Its own branch (`builder/<project>-<name>`)
- A dedicated terminal in the dashboard
- The builder role prompt loaded automatically

**Examples:**

```bash
# Spawn builder for spec 0042
af spawn -p 0042

# Spawn with task description
af spawn --task "Fix login bug in auth module"

# Spawn bare Claude session
af spawn --shell

# Spawn with context files
af spawn -p 0042 --files "src/auth.ts,tests/auth.test.ts"
```

---

### af status

Show status of all agents.

```bash
af status
```

**Description:**

Displays the current state of all builders and the architect:

```
┌────────┬──────────────┬─────────────┬─────────┐
│ ID     │ Name         │ Status      │ Branch  │
├────────┼──────────────┼─────────────┼─────────┤
│ arch   │ Architect    │ running     │ main    │
│ 0042   │ auth-feature │ implementing│ builder/0042-auth │
│ 0043   │ api-refactor │ pr-ready    │ builder/0043-api  │
└────────┴──────────────┴─────────────┴─────────┘
```

Status values:
- `spawning` - Worktree created, builder starting
- `implementing` - Actively working
- `blocked` - Stuck, needs architect help
- `pr-ready` - Implementation complete
- `complete` - Merged, can be cleaned up

---

### af cleanup

Clean up a builder worktree and branch.

```bash
af cleanup -p <id> [options]
```

**Options:**
- `-p, --project <id>` - Builder ID to clean up (required)
- `-f, --force` - Force cleanup even if branch not merged

**Description:**

Removes a builder's worktree and associated resources. By default, refuses to delete worktrees with uncommitted changes or unmerged branches.

**Examples:**

```bash
# Clean up completed builder
af cleanup -p 0042

# Force cleanup (may lose work)
af cleanup -p 0042 --force
```

---

### af send

Send instructions to a running builder.

```bash
af send [builder] [message] [options]
```

**Arguments:**
- `builder` - Builder ID (e.g., `0042`)
- `message` - Message to send

**Options:**
- `--all` - Send to all builders
- `--file <path>` - Include file content in message
- `--interrupt` - Send Ctrl+C first
- `--raw` - Skip structured message formatting
- `--no-enter` - Do not send Enter after message

**Description:**

Sends text to a builder's terminal. Useful for:
- Providing guidance when builder is blocked
- Interrupting long-running processes
- Sending instructions or context

**Examples:**

```bash
# Send message to builder
af send 0042 "Focus on the auth module first"

# Interrupt and send new instructions
af send 0042 --interrupt "Stop that. Try a different approach."

# Send to all builders
af send --all "Time to wrap up, create PRs"

# Include file content
af send 0042 --file src/api.ts "Review this implementation"
```

---

### af open

Open file annotation viewer.

```bash
af open <file>
```

**Arguments:**
- `file` - Path to file to open

**Description:**

Opens a web-based viewer for annotating files with review comments. Comments use the `// REVIEW:` format and are stored directly in the source file.

**Example:**

```bash
af open src/auth/login.ts
```

---

### af util

Spawn a utility shell terminal.

```bash
af util [options]
```

**Aliases:** `af shell`

**Options:**
- `-n, --name <name>` - Name for the shell terminal

**Description:**

Opens a general-purpose shell terminal in the dashboard. Useful for:
- Running tests
- Git operations
- Manual debugging

**Examples:**

```bash
# Open utility shell
af util

# Open with custom name
af util -n "test-runner"
```

---

### af rename

Rename a builder or utility terminal.

```bash
af rename <id> <name>
```

**Arguments:**
- `id` - Builder or terminal ID
- `name` - New name

**Example:**

```bash
af rename 0042 "auth-rework"
```

---

### af tutorial

Interactive tutorial for new users.

```bash
af tutorial [options]
```

**Options:**
- `--reset` - Start tutorial fresh
- `--skip` - Skip current step
- `--status` - Show tutorial progress

**Description:**

Walks through the basics of using agent-farm with guided steps.

---

### af ports

Manage global port registry.

#### af ports list

List all port allocations.

```bash
af ports list
```

Shows port blocks allocated to different projects:
```
Port Allocations
4200-4299: /Users/me/project-a
4300-4399: /Users/me/project-b
```

#### af ports cleanup

Remove stale port allocations.

```bash
af ports cleanup
```

Removes entries for projects that no longer exist.

---

### af tower

Manage the tower dashboard.

#### af tower start

Start the tower dashboard.

```bash
af tower start [options]
```

**Options:**
- `-p, --port <port>` - Port to run on (default: 4100)

#### af tower stop

Stop the tower dashboard.

```bash
af tower stop [options]
```

**Options:**
- `-p, --port <port>` - Port to stop (default: 4100)

---

### af db

Database debugging and maintenance commands.

#### af db dump

Export all tables to JSON.

```bash
af db dump [options]
```

**Options:**
- `--global` - Dump global.db instead of project db

#### af db query

Run a SELECT query.

```bash
af db query <sql> [options]
```

**Options:**
- `--global` - Query global.db

**Example:**

```bash
af db query "SELECT * FROM builders WHERE status = 'implementing'"
```

#### af db reset

Delete database and start fresh.

```bash
af db reset [options]
```

**Options:**
- `--global` - Reset global.db
- `--force` - Skip confirmation

#### af db stats

Show database statistics.

```bash
af db stats [options]
```

**Options:**
- `--global` - Show stats for global.db

---

## Configuration

Customize commands via `codev/config.json`:

```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": "claude --model sonnet",
    "shell": "bash"
  }
}
```

Or override via CLI flags:

```bash
af start --architect-cmd "claude --model opus"
af spawn -p 0042 --builder-cmd "claude --model haiku"
```

---

## Files

| File | Description |
|------|-------------|
| `.agent-farm/state.json` | Project runtime state |
| `~/.agent-farm/ports.json` | Global port registry |
| `codev/config.json` | Project configuration |

---

## See Also

- [codev](codev.md) - Project management commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
