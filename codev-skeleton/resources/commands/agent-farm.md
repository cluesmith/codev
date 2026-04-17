# afx - Agent Farm CLI

The `afx` (agent-farm) command manages multi-agent orchestration for software development. It spawns and manages builders in isolated git worktrees.

## Synopsis

```
afx <command> [options]
```

## Global Options

```
--architect-cmd <command>    Override architect command
--builder-cmd <command>      Override builder command
--shell-cmd <command>        Override shell command
```

## Commands

### afx workspace

Workspace commands - start/stop the workspace for this project.

> **Deprecation note:** `afx dash` is a deprecated alias for `afx workspace`. It still works but prints a deprecation warning.

#### afx workspace start

Start the workspace.

```bash
afx workspace start [options]
```

**Options:**
- `-c, --cmd <command>` - Command to run in architect terminal
- `-p, --port <port>` - Port for architect terminal
- `--no-role` - Skip loading architect role prompt
- `--no-browser` - Skip opening browser after start
- `-r, --remote <target>` - Start Agent Farm on remote machine (see below)
- `--allow-insecure-remote` - Bind to 0.0.0.0 for remote access (deprecated)

**Description:**

Starts the workspace with:
- Architect terminal (Claude session with architect role)
- Web-based UI for monitoring builders
- Terminal session management (shellper processes)

The workspace overview is accessible via browser at `http://localhost:<port>`.

**Examples:**

```bash
# Start with defaults
afx workspace start

# Start with custom port
afx workspace start -p 4300

# Start with specific command
afx workspace start -c "claude --model opus"

# Start on remote machine
afx workspace start --remote user@host
```

#### Remote Access

Start Agent Farm on a remote machine and access it from your local workstation with a single command:

```bash
# On your local machine - one command does everything:
afx workspace start --remote user@remote-host

# Or with explicit project path:
afx workspace start --remote user@remote-host:/path/to/project

# With custom port:
afx workspace start --remote user@remote-host --port 4300
```

This single command:
1. Checks passwordless SSH is configured
2. Verifies CLI versions match between local and remote
3. SSHs into the remote machine
4. Starts Agent Farm there with matching port
5. Sets up SSH tunnel back to your local machine
6. Opens the workspace overview in your browser

The workspace and all terminals work identically to local development. Press Ctrl+C to disconnect.

**Port Selection:**

The port is determined by the global port registry (`afx ports list`). Each project gets a consistent 100-port block (e.g., 4200-4299, 4600-4699). The same port is used on both local and remote ends for the SSH tunnel.

```bash
# Check your project's port allocation
afx ports list
```

**Prerequisites:**
- SSH server must be running on the remote machine
- Agent Farm (`afx`) must be installed on the remote machine
- **Passwordless SSH required** - set up with `ssh-copy-id user@host`
- Same version of codev on both machines (warnings shown if mismatched)

**Troubleshooting:**

If the remote can't find `claude` or other commands, ensure they're in your PATH for non-interactive shells. Add to `~/.profile` on the remote:
```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Limitation**: File annotation tabs (`afx open`) use separate ports and won't work through the tunnel. Use terminals for file viewing, or forward additional ports manually.

**Legacy mode** (deprecated):

```bash
# DEPRECATED: Exposes workspace without authentication
afx workspace start --allow-insecure-remote
```

The `--allow-insecure-remote` flag binds to `0.0.0.0` with no authentication. Use `--remote` instead for secure access via SSH.

#### afx workspace stop

Stop all agent farm processes for this project.

```bash
afx workspace stop
```

**Description:**

Stops all running agent-farm processes including:
- Terminal sessions (shellper processes)
- Workspace servers

Does NOT clean up worktrees - use `afx cleanup` for that.

---

### afx spawn

Spawn a new builder.

```bash
afx spawn [issue-number] --protocol <name> [options]
```

**Arguments:**
- `issue-number` - Issue number to build (positional, e.g., `42`)

**Required:**
- `--protocol <name>` - Protocol to use: spir, aspir, air, bugfix, maintain, experiment. **REQUIRED** for all numbered spawns. Only `--task`, `--shell`, and `--worktree` spawns skip this flag.

**Options:**
- `--task <text>` - Spawn builder with a task description (no `--protocol` needed)
- `--shell` - Spawn a bare Claude session (no `--protocol` needed)
- `--worktree` - Spawn worktree session (no `--protocol` needed)
- `--files <files>` - Context files (comma-separated)
- `--no-role` - Skip loading role prompt

**Preconditions:**

The spawn command requires a **clean git worktree**. Before spawning:

1. Run `git status` to check for uncommitted changes
2. Commit any pending changes — builders branch from HEAD, so uncommitted specs/plans are invisible to the builder
3. The command will refuse to spawn if the worktree is dirty (override with `--force`, but the builder won't see your uncommitted files)

**Description:**

Creates a new builder in an isolated git worktree. The builder gets:
- Its own branch (`builder/<project>-<name>`)
- A dedicated terminal in the workspace overview
- The builder role prompt loaded automatically

**Examples:**

```bash
# Spawn builder for issue #42 — --protocol is REQUIRED
afx spawn 42 --protocol spir

# Spawn builder for a bugfix
afx spawn 42 --protocol bugfix

# Spawn with task description (no --protocol needed)
afx spawn --task "Fix login bug in auth module"

# Spawn bare Claude session (no --protocol needed)
afx spawn --shell

# Spawn with context files
afx spawn 42 --protocol spir --files "src/auth.ts,tests/auth.test.ts"
```

**Common Errors:**

| Error | Cause | Fix |
|-------|-------|-----|
| "Missing required flag: --protocol" | Forgot `--protocol` | Add `--protocol spir` (or bugfix, air, etc.) |
| "Dirty worktree" | Uncommitted changes | Run `git status`, commit changes, retry |
| "Builder already exists" | Worktree collision | Use `--resume` to resume, or `afx cleanup` first |

---

### afx status

Show status of all agents.

```bash
afx status
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

### afx cleanup

Clean up a builder worktree and branch.

```bash
afx cleanup -p <id> [options]
```

**Options:**
- `-p, --project <id>` - Builder ID to clean up (required)
- `-f, --force` - Force cleanup even if branch not merged

**Description:**

Removes a builder's worktree and associated resources. By default, refuses to delete worktrees with uncommitted changes or unmerged branches.

**Examples:**

```bash
# Clean up completed builder
afx cleanup -p 42

# Force cleanup (may lose work)
afx cleanup -p 42 --force
```

---

### afx send

Send instructions to a running builder.

```bash
afx send [builder] [message] [options]
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
afx send 42 "Focus on the auth module first"

# Interrupt and send new instructions
afx send 42 --interrupt "Stop that. Try a different approach."

# Send to all builders
afx send --all "Time to wrap up, create PRs"

# Include file content
afx send 42 --file src/api.ts "Review this implementation"
```

---

### afx open

Open file annotation viewer.

```bash
afx open <file>
```

**Arguments:**
- `file` - Path to file to open

**Description:**

Opens a web-based viewer for annotating files with review comments. Comments use the `// REVIEW:` format and are stored directly in the source file.

**Example:**

```bash
afx open src/auth/login.ts
```

---

### afx shell

Spawn a utility shell terminal.

```bash
afx shell [options]
```

**Options:**
- `-n, --name <name>` - Name for the shell terminal

**Description:**

Opens a general-purpose shell terminal in the workspace overview. Useful for:
- Running tests
- Git operations
- Manual debugging

**Examples:**

```bash
# Open utility shell
afx shell

# Open with custom name
afx shell -n "test-runner"
```

---

### afx rename

Rename a builder or utility terminal.

```bash
afx rename <id> <name>
```

**Arguments:**
- `id` - Builder or terminal ID
- `name` - New name

**Example:**

```bash
afx rename 42 "auth-rework"
```

---

### afx ports

Manage global port registry.

#### afx ports list

List all port allocations.

```bash
afx ports list
```

Shows port blocks allocated to different projects:
```
Port Allocations
4200-4299: /Users/me/project-a
4300-4399: /Users/me/project-b
```

#### afx ports cleanup

Remove stale port allocations.

```bash
afx ports cleanup
```

Removes entries for projects that no longer exist.

---

### afx tower

Manage the cross-project tower dashboard. Tower shows all agent-farm instances across projects and provides cloud connectivity via codevos.ai.

#### afx tower start

Start the tower dashboard.

```bash
afx tower start [options]
```

**Options:**
- `-p, --port <port>` - Port to run on (default: 4100)

#### afx tower stop

Stop the tower dashboard.

```bash
afx tower stop [options]
```

**Options:**
- `-p, --port <port>` - Port to stop (default: 4100)

#### afx tower register

Register this tower with codevos.ai for remote access.

```bash
afx tower register [options]
```

**Options:**
- `--reauth` - Re-authenticate without changing tower name
- `-p, --port <port>` - Tower port to signal after registration (default: 4100)

#### afx tower deregister

Remove this tower's registration from codevos.ai.

```bash
afx tower deregister [options]
```

**Options:**
- `-p, --port <port>` - Tower port to signal after deregistration (default: 4100)

#### afx tower status

Show tower status including cloud connection info.

```bash
afx tower status [options]
```

**Options:**
- `-p, --port <port>` - Tower port (default: 4100)

**Environment Variables:**
- `CODEVOS_URL` - Override the codevos.ai server URL (default: `https://codevos.ai`). Useful for local development or staging.

---

### afx db

Database debugging and maintenance commands.

#### afx db dump

Export all tables to JSON.

```bash
afx db dump [options]
```

**Options:**
- `--global` - Dump global.db instead of project db

#### afx db query

Run a SELECT query.

```bash
afx db query <sql> [options]
```

**Options:**
- `--global` - Query global.db

**Example:**

```bash
afx db query "SELECT * FROM builders WHERE status = 'implementing'"
```

#### afx db reset

Delete database and start fresh.

```bash
afx db reset [options]
```

**Options:**
- `--global` - Reset global.db
- `--force` - Skip confirmation

#### afx db stats

Show database statistics.

```bash
afx db stats [options]
```

**Options:**
- `--global` - Show stats for global.db

---

## Configuration

Customize commands via `.codev/config.json` at the project root:

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
afx workspace start --architect-cmd "claude --model opus"
afx spawn 42 --protocol spir --builder-cmd "claude --model haiku"
```

---

## Files

| File | Description |
|------|-------------|
| `.agent-farm/state.db` | Project runtime state (SQLite) |
| `~/.agent-farm/global.db` | Global port registry (SQLite) |
| `.codev/config.json` | Agent Farm configuration (project root) |

---

## See Also

- [codev](codev.md) - Project management commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
