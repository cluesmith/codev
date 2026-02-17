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

### af dash

Project dashboard commands - start/stop the architect dashboard for this project.

#### af dash start

Start the architect dashboard.

```bash
af dash start [options]
```

**Options:**
- `-c, --cmd <command>` - Command to run in architect terminal
- `-p, --port <port>` - Port for architect terminal
- `--no-role` - Skip loading architect role prompt
- `--no-browser` - Skip opening browser after start
- `-r, --remote <target>` - Start Agent Farm on remote machine (see below)
- `--allow-insecure-remote` - Bind to 0.0.0.0 for remote access (deprecated)

**Description:**

Starts the agent-farm dashboard with:
- Architect terminal (Claude session with architect role)
- Web-based UI for monitoring builders
- Terminal session management (shellper processes)

The dashboard is accessible via browser at `http://localhost:<port>`.

**Examples:**

```bash
# Start with defaults
af dash start

# Start with custom port
af dash start -p 4300

# Start with specific command
af dash start -c "claude --model opus"

# Start on remote machine
af dash start --remote user@host
```

#### Remote Access

Start Agent Farm on a remote machine and access it from your local workstation with a single command:

```bash
# On your local machine - one command does everything:
af dash start --remote user@remote-host

# Or with explicit project path:
af dash start --remote user@remote-host:/path/to/project

# With custom port:
af dash start --remote user@remote-host --port 4300
```

This single command:
1. Checks passwordless SSH is configured
2. Verifies CLI versions match between local and remote
3. SSHs into the remote machine
4. Starts Agent Farm there with matching port
5. Sets up SSH tunnel back to your local machine
6. Opens the dashboard in your browser

The dashboard and all terminals work identically to local development. Press Ctrl+C to disconnect.

**Port Selection:**

The port is determined by the global port registry (`af ports list`). Each project gets a consistent 100-port block (e.g., 4200-4299, 4600-4699). The same port is used on both local and remote ends for the SSH tunnel.

```bash
# Check your project's port allocation
af ports list
```

**Prerequisites:**
- SSH server must be running on the remote machine
- Agent Farm (`af`) must be installed on the remote machine
- **Passwordless SSH required** - set up with `ssh-copy-id user@host`
- Same version of codev on both machines (warnings shown if mismatched)

**Troubleshooting:**

If the remote can't find `claude` or other commands, ensure they're in your PATH for non-interactive shells. Add to `~/.profile` on the remote:
```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Limitation**: File annotation tabs (`af open`) use separate ports and won't work through the tunnel. Use terminals for file viewing, or forward additional ports manually.

**Legacy mode** (deprecated):

```bash
# DEPRECATED: Exposes dashboard without authentication
af dash start --allow-insecure-remote
```

The `--allow-insecure-remote` flag binds to `0.0.0.0` with no authentication. Use `--remote` instead for secure access via SSH.

#### af dash stop

Stop all agent farm processes for this project.

```bash
af dash stop
```

**Description:**

Stops all running agent-farm processes including:
- Terminal sessions (shellper processes)
- Dashboard servers

Does NOT clean up worktrees - use `af cleanup` for that.

---

### af spawn

Spawn a new builder.

```bash
af spawn [options]
```

**Options:**
- `-p, --project <id>` - Spawn builder for a spec (e.g., `42`)
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
# Spawn builder for spec 42
af spawn -p 42

# Spawn with task description
af spawn --task "Fix login bug in auth module"

# Spawn bare Claude session
af spawn --shell

# Spawn with context files
af spawn -p 42 --files "src/auth.ts,tests/auth.test.ts"
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
│ 42   │ auth-feature │ implementing│ builder/42-auth │
│ 43   │ api-refactor │ pr    │ builder/43-api  │
└────────┴──────────────┴─────────────┴─────────┘
```

Status values:
- `spawning` - Worktree created, builder starting
- `implementing` - Actively working
- `blocked` - Stuck, needs architect help
- `pr` - Implementation complete
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
af cleanup -p 42

# Force cleanup (may lose work)
af cleanup -p 42 --force
```

---

### af send

Send instructions to a running builder.

```bash
af send [builder] [message] [options]
```

**Arguments:**
- `builder` - Builder ID (e.g., `42`)
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
af send 42 "Focus on the auth module first"

# Interrupt and send new instructions
af send 42 --interrupt "Stop that. Try a different approach."

# Send to all builders
af send --all "Time to wrap up, create PRs"

# Include file content
af send 42 --file src/api.ts "Review this implementation"
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

### af shell

Spawn a utility shell terminal.

```bash
af shell [options]
```

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
af shell

# Open with custom name
af shell -n "test-runner"
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
af rename 42 "auth-rework"
```

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

Manage the cross-project tower dashboard. Tower shows all agent-farm instances across projects and provides cloud connectivity via codevos.ai.

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

#### af tower register

Register this tower with codevos.ai for remote access.

```bash
af tower register [options]
```

**Options:**
- `--reauth` - Re-authenticate without changing tower name
- `-p, --port <port>` - Tower port to signal after registration (default: 4100)

#### af tower deregister

Remove this tower's registration from codevos.ai.

```bash
af tower deregister [options]
```

**Options:**
- `-p, --port <port>` - Tower port to signal after deregistration (default: 4100)

#### af tower status

Show tower status including cloud connection info.

```bash
af tower status [options]
```

**Options:**
- `-p, --port <port>` - Tower port (default: 4100)

**Environment Variables:**
- `CODEVOS_URL` - Override the codevos.ai server URL (default: `https://codevos.ai`). Useful for local development or staging.

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

Customize commands via `af-config.json` at the project root:

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
af spawn -p 42 --builder-cmd "claude --model haiku"
```

---

## Files

| File | Description |
|------|-------------|
| `.agent-farm/state.json` | Project runtime state |
| `~/.agent-farm/ports.json` | Global port registry |
| `af-config.json` | Agent Farm configuration (project root) |

---

## See Also

- [codev](codev.md) - Project management commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
