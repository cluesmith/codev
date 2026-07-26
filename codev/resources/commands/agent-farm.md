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
- Shellper session management

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
- Terminal sessions (Shellper processes)
- Workspace servers
- All architect terminals (`main` plus any sibling architects registered via `afx workspace add-architect`)

Does NOT clean up worktrees - use `afx cleanup` for that.

---

#### afx workspace add-architect

Register an additional named architect terminal in an active workspace (Spec 755).

```bash
afx workspace add-architect [--name <name>]
```

**Options:**

- `--name <name>` - Explicit architect name. Must match `[a-z][a-z0-9-]*` and be at most 64 characters. If omitted, the next available auto-numbered name is assigned (`architect-2`, `architect-3`, ...).

**Description:**

Multi-architect support lets the same workspace host more than one architect terminal so that each architect's builders can route their `afx send architect` messages back to that specific architect — instead of every message landing at the lone singleton.

The first architect started in a workspace (by `afx workspace start`) is named `main` by default. Use `afx workspace add-architect` to register additional architects.

**Naming rules:**

- Names match `[a-z][a-z0-9-]*`, max 64 characters.
- Empty `--name` is rejected (use no `--name` to auto-number).
- Reusing an already-registered name in the same workspace is rejected.
- `main` is reserved (Spec 786) — the validator rejects it explicitly. `main` is the workspace's default architect, created by `afx workspace start`.

**Auto-numbering (Spec 755):**

When `--name` is omitted, Tower picks the smallest unused integer ≥ 2 from the existing `architect-<N>` set:

- `{}` → `architect-2`
- `{main}` → `architect-2`
- `{main, architect-2}` → `architect-3`
- `{main, architect-3}` → `architect-2` (fills the gap)
- Custom names (e.g. `sibling`) don't participate in the numbering sequence.

Removing a numbered architect leaves a gap that the next auto-add fills (no renumbering of existing architects).

**Examples:**

```bash
# Auto-numbered second architect (becomes architect-2):
afx workspace add-architect

# Explicit name:
afx workspace add-architect --name sibling
```

**Related**:

- Every architect terminal Tower starts has `CODEV_ARCHITECT_NAME` injected into its environment. `afx spawn` reads this variable to tag each new builder row with the spawning architect's name (`spawnedByArchitect`). Builders running in an architect terminal therefore inherit that architect's identity transparently. Spec 786 Phase 2 also re-injects this variable when shellper auto-restarts an architect's PTY, so identity is preserved across crash recovery.

---

#### afx workspace remove-architect

Remove a previously-added sibling architect from an active workspace (Spec 786 Phase 4).

```bash
afx workspace remove-architect <name>
```

**Arguments:**

- `<name>` - The architect to remove. The default `main` architect cannot be removed.

**Description:**

Removes the named sibling architect from Tower's in-memory map, terminates its PTY cleanly, and deletes its row from `state.db.architect`. Removing an architect with in-flight builders is allowed — those builders' subsequent `afx send architect` calls fall back to `main` via the existing routing chain (Spec 786 OQ-A).

**Examples:**

```bash
# Remove a sibling:
afx workspace remove-architect sibling

# Refuses to remove main:
afx workspace remove-architect main
# ✗ Cannot remove the default 'main' architect.
```

**Available surfaces:**

- CLI (this command)
- Dashboard: click the X on a sibling architect's tab → confirmation modal lists any in-flight builders (informational; remove proceeds regardless per OQ-A).
- VSCode extension: right-click a sibling under the "Architects" tree section → "Remove Architect" → modal confirmation.

---

#### Architect address grammar

`afx send architect[:<name>]` routes messages to the named architect's PTY (Spec 755).

- `architect` (no name) — resolves to the SPAWNING architect when the sender is a builder (`spawnedByArchitect`); falls back to `main` when the spawning architect is gone or the sender isn't a builder. This is the headline value prop of multi-architect support.
- `architect:<name>` — explicit target. Works from any sender, including architect-to-architect messaging (e.g. `main` sending to `architect:sibling`).
- Names containing `:` are rejected by the validator (collides with the grammar).

**Example:**

```bash
# Inside main's terminal, send to sibling:
afx send architect:sibling "Please check this"

# Inside a builder spawned by sibling, send back to it:
afx send architect "Status update"
```

---

#### Persistence and recovery

Spec 786 Phase 3 added graceful-restart persistence for sibling architects; Bugfix #826 extended it with workspace scoping via a schema change — `state.db.architect` now has `workspace_path` as part of the composite primary key, so architects registered in workspace A cannot appear in queries scoped to workspace B.

- **`afx workspace stop` → `afx workspace start`**: sibling architects survive. Tower's `stopInstance` marks the workspace as "intentionally stopping" so the cascaded architect exit handlers skip the `setArchitectByName(workspacePath, name, null)` call, preserving rows in `state.db.architect`. On next start, `launchInstance` creates `main` and then re-spawns persisted siblings via `addArchitect` — `getArchitects(resolvedPath)` returns only this workspace's rows (Bugfix #826).
- **Tower crash**: `terminal_sessions` rows + shellper processes survive. Tower's `reconcileTerminalSessions()` reconnects on startup.
- **Permanent exit (max-restart exhaustion, `remove-architect`)**: rows are auto-deleted from `state.db.architect` (Spec 786 OQ-B — keeps state.db an accurate mirror of reality).
- **Dashboard "Stop All"** (or `POST /workspace/<base64>/api/stop` directly): full wipe, including sibling rows. Per-workspace `state.db.architect` rows are removed pre-emptively in the route handler. Use this when you want to start over from scratch. There is no `afx workspace stop-all` CLI today — the full-wipe path is currently API-only via the dashboard.

---

### afx spawn

Spawn a new builder.

```bash
afx spawn [number] --protocol <name> [options]
```

**Arguments:**
- `[number]` - Issue number (positional)

**Required:**
- `--protocol <name>` - Protocol to use: spir, bugfix, tick, maintain, experiment. **REQUIRED** for all numbered spawns. Only `--task`, `--shell`, and `--worktree` spawns skip this flag.

**Options:**
- `--task <text>` - Spawn builder with a task description (no `--protocol` needed)
- `--amends <number>` - Original spec number for TICK amendments
- `--shell` - Spawn a bare Claude session (no `--protocol` needed)
- `--worktree` - Spawn worktree session (no `--protocol` needed)
- `--files <files>` - Context files (comma-separated)
- `--soft` - Use soft mode (AI follows protocol, you verify compliance)
- `--strict` - Use strict mode (porch orchestrates, default)
- `--resume` - Resume an existing builder worktree
- `--force` - Skip safety checks (dirty worktree, collision detection)
- `--no-role` - Skip loading role prompt

**Preconditions:**

The spawn command requires a **clean git worktree**. Before spawning:

1. Run `git status` to check for uncommitted changes
2. Commit any pending changes — builders branch from HEAD, so uncommitted specs/plans/codev updates are invisible to the builder
3. The command will refuse to spawn if the worktree is dirty (override with `--force`, but the builder won't see your uncommitted files)

**Description:**

Creates a new builder in an isolated git worktree. The builder gets:
- Its own branch (`builder/<project>-<name>`)
- A dedicated terminal in the workspace overview
- The builder role prompt loaded automatically

**Examples:**

```bash
# Spawn builder for SPIR project (issue #42) — --protocol is REQUIRED
afx spawn 42 --protocol spir

# Spawn builder for a bugfix
afx spawn 42 --protocol bugfix

# Spawn TICK amendment to spec 30
afx spawn 42 --protocol tick --amends 30

# Spawn with task description (no --protocol needed)
afx spawn --task "Fix login bug in auth module"

# Spawn bare Claude session (no --protocol needed)
afx spawn --shell

# Spawn with context files
afx spawn 42 --protocol spir --files "src/auth.ts,tests/auth.test.ts"

# Resume an existing builder
afx spawn 42 --resume
```

**Common Errors:**

| Error | Cause | Fix |
|-------|-------|-----|
| "Missing required flag: --protocol" | Forgot `--protocol` | Add `--protocol spir` (or bugfix, tick, etc.) |
| "Dirty worktree" | Uncommitted changes | Run `git status`, commit changes, retry |
| "Builder already exists" | Worktree collision | Use `--resume` to resume, or `afx cleanup` first |

---

### afx status

Show status of all agents.

```bash
afx status
```

**Description:**

Displays the current state of Tower, the registered architects (one per
sibling — Spec 786 Phase 5 replaces the pre-786 single-row collapse), and the
running builders.

**Example output (Tower running):**

```
Agent Farm Status
  Tower: running
    Uptime: 1342s
    Active Workspaces: 1
    Memory: 87MB

  Workspace: my-project
    Status: active
    Terminals: 3

  Architects:
    main      (pid=12345 terminal=sess-abc-123)
    ob-refine (pid=12346 terminal=sess-def-456)

  Terminals:
    builder - builder-spir-0042 (active)
```

**Example output (Tower not running — fallback mode):**

```
Agent Farm Status
  Tower: not running
  Run 'afx tower start' to start the tower daemon

  Architects: 2 registered
    (Tower not running — PID/port not available)
    main:      cmd=claude started=2026-05-22T10:00:00Z
    ob-refine: cmd=claude started=2026-05-22T11:00:00Z

  Builders: none
```

Builder status values:
- `spawning` - Worktree created, builder starting
- `implementing` - Actively working
- `blocked` - Stuck, needs architect help
- `pr` - Implementation complete
- `complete` - Merged, can be cleaned up

---

### afx whoami

Report this terminal's agent identity — workspace, type, and name — from
Tower/global.db's perspective.

```bash
afx whoami
afx whoami --json
```

**Description:**

Resolves who the current terminal's agent is. Identity precedence:

1. **Builder worktree** — when CWD is inside `.builders/<id>/`, the canonical
   builder id is verified against `global.db` (the same resolution `afx send`
   uses). An unverifiable worktree identity is an error, never a fallthrough
   to the next signal.
2. **`CODEV_ARCHITECT_NAME`** — the env var Tower injects into architect
   terminals.
3. **Unknown** — exits non-zero with an explanation. There is no implicit
   fallback to `main` (issue #1094: unverified identities misroute messages).

Works without Tower running (reads `global.db` read-only).

**Example output (architect terminal):**

```
workspace: codev
type: architect
name: main
```

**Example output (builder worktree):**

```
workspace: codev
type: builder
name: builder-spir-984
architect: main
```

The `architect:` line is the builder's spawning architect; it is omitted when
not recorded (legacy rows).

**JSON output:**

```bash
afx whoami --json
# {"workspace":"codev","type":"builder","name":"builder-spir-984","architect":"main"}
```

On failure, `--json` prints `{"error":"..."}` to stdout (the human-readable
explanation still goes to stderr) and exits 1.

**Exit codes:** `0` identity resolved; `1` identity unknown or unverifiable.

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
afx cleanup -p 0042

# Force cleanup (may lose work)
afx cleanup -p 0042 --force
```

---

### afx send

Send instructions to a running builder.

```bash
afx send [builder] [message] [options]
```

**Arguments:**
- `builder` - Target terminal. Can be:
  - Builder ID: `0042`
  - Named target: `architect` (from a builder, routes to the spawning architect via affinity per Spec 755; from any other sender, routes to the architect named `main` if present, else the first registered architect)
  - `architect:<name>` — a specific architect by name (e.g., `architect:ob-refine`). From a builder, only allowed when `<name>` matches the builder's spawning architect (spoofing check at `tower-messages.ts:213-218`).
  - **Cross-workspace**: `workspace:target` (e.g., `marketmaker:architect`, `codev-public:0042`)
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
- Communicating across workspaces (e.g., notifying another project's architect)

**Examples:**

```bash
# Send message to builder in current workspace
afx send 0042 "Focus on the auth module first"

# Send to architect in current workspace
afx send architect "PR #42 has been merged"

# Inter-architect messaging (Spec 755 / 823): from main to a sibling architect.
# Sibling architects are added via `afx workspace add-architect --name <name>`
# (e.g., `afx workspace add-architect --name ob-refine`). The `architect:<name>`
# address grammar lets architects message each other directly. Builders are
# constrained to their spawning architect by the spoofing check.
afx send architect:ob-refine "PR-iter-2 feedback ready"

# Send to another workspace's architect (cross-workspace)
afx send marketmaker:architect "R4 report updated with cost analysis"

# Interrupt and send new instructions
afx send 0042 --interrupt "Stop that. Try a different approach."

# Send to all builders
afx send --all "Time to wrap up, create PRs"

# Include file content
afx send 0042 --file src/api.ts "Review this implementation"
```

**Discovering active agents** (Spec 823):

- `afx status` lists all architects alongside builders, with names, terminal IDs, and PIDs where available.
- Each active builder maintains a free-text narrative log at `codev/state/<builder-id>_thread.md` (relative to its worktree, so `.builders/<id>/codev/state/<id>_thread.md` from the main workspace root). **In-flight discovery**: `ls .builders/*/codev/state/*.md` and `cat .builders/<id>/codev/state/<id>_thread.md`. **Post-merge discovery**: after a builder's PR merges, its thread lands in `codev/state/` on `main`, alongside `codev/reviews/` — list with `ls codev/state/` and read with `cat codev/state/<builder-id>_thread.md` from the main checkout.

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

Rename the current shell session (Spec 468).

```bash
afx rename <name>
```

**Arguments:**
- `name` - New display name for the shell tab (1-100 characters)

**Description:**

Renames the current utility shell session. Must be run from inside a shell created by `afx shell`. The new name appears in the dashboard tab and persists across Tower restarts.

- Only utility shell sessions can be renamed (not architect or builder terminals)
- Duplicate names are auto-deduplicated with a `-N` suffix
- Control characters are stripped from the name

**Examples:**

```bash
# Rename current shell
afx rename "monitoring"

# Name will be deduped if it conflicts
afx rename "testing"   # → "testing-1" if "testing" already exists
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

**Environment Variables:**
- `BRIDGE_MODE=1` — Enable non-localhost binding (required). Without this flag, Tower only binds to `127.0.0.1`.
- `BRIDGE_TOWER_HOST` — Bind address when bridge mode is enabled (default: `127.0.0.1`). Only consulted when `BRIDGE_MODE=1`. Set to `0.0.0.0` for all network interfaces. Accepts IP literals only (no hostnames). Note: `BRIDGE_TOWER_HOST` has no effect unless `BRIDGE_MODE=1`.

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

**Description:**

Opens a browser to codevos.ai for authentication, then exchanges the token for an API key. If the browser callback times out, falls back to manual token paste. Writes credentials to `~/.agent-farm/cloud-config.json` and signals the running tower daemon to connect.

**Examples:**

```bash
# Register tower
afx tower register

# Re-authenticate existing registration
afx tower register --reauth

# Register and signal tower on custom port
afx tower register -p 4300
```

#### afx tower deregister

Remove this tower's registration from codevos.ai.

```bash
afx tower deregister [options]
```

**Options:**
- `-p, --port <port>` - Tower port to signal after deregistration (default: 4100)

**Description:**

Calls the codevos.ai API to delete the tower, removes local credentials from `~/.agent-farm/cloud-config.json`, and signals the tower daemon to disconnect.

#### afx tower status

Show tower status including cloud connection info.

```bash
afx tower status [options]
```

**Options:**
- `-p, --port <port>` - Tower port (default: 4100)

**Description:**

Displays local tower status plus cloud registration details: tower name, ID, connection state, uptime, and access URL. If the tower daemon is not running, shows config-based info. The tower dashboard also includes a CloudStatus UI component showing this information.

**Environment Variables:**
- `CODEVOS_URL` - Override the codevos.ai server URL (default: `https://codevos.ai`). Useful for local development or staging environments.

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

### Porch Gate Artifact Auto-Open

When Porch requests a specification, plan, or review gate, it automatically
opens the phase artifact in Tower. This is enabled when the setting is unset or
`true`. Set `porch.autoOpenArtifacts` to `false` to prevent that automatic
`afx open` action:

```json
{
  "porch": {
    "autoOpenArtifacts": false
  }
}
```

This setting controls only Porch's automatic gate artifact opens. A manual
`afx open <path>` still creates a Tower file tab and follows the dashboard's
normal focus behavior.

You can set the preference globally in `~/.codev/config.json`, for the team in
the project's committed `.codev/config.json`, or per engineer and project in
the gitignored `.codev/config.local.json`. Project settings override global
settings, and project-local settings override both.

When the main workspace has `.codev/config.local.json`, Agent Farm copies it
into each builder during spawn and `afx setup`. The builder receives a managed
regular-file snapshot rather than a write-through symlink, so builder edits
cannot change the main workspace's personal config. Running `afx setup` again
refreshes the snapshot from the main workspace.

### Language-Agnostic Porch Checks

By default, porch protocol checks use `npm run build` and `npm test`. Non-Node.js projects can override these via the `porch.checks` section in `.codev/config.json`:

```json
{
  "porch": {
    "checks": {
      "build": { "command": "cargo build" },
      "tests": { "command": "cargo test" },
      "e2e_tests": { "skip": true }
    }
  }
}
```

**Override fields:**
- `command` — Replace the protocol's check command with a custom shell command
- `cwd` — Override the working directory for this check (relative to project root)
- `skip: true` — Omit this check entirely (for checks that don't apply to your project)

Porch logs a visible warning for each overridden or skipped check so the change is always visible.

**Examples by language stack:**

Python (uv + pytest):
```json
{
  "porch": {
    "checks": {
      "build": { "command": "uv run pytest --co -q" },
      "tests": { "command": "uv run pytest" },
      "build_succeeds": { "command": "uv run pytest --co -q 2>&1" },
      "tests_pass": { "command": "uv run pytest 2>&1" },
      "e2e_tests": { "skip": true }
    }
  }
}
```

Rust (cargo):
```json
{
  "porch": {
    "checks": {
      "build": { "command": "cargo build" },
      "tests": { "command": "cargo test" },
      "build_succeeds": { "command": "cargo build 2>&1" },
      "tests_pass": { "command": "cargo test 2>&1" },
      "e2e_tests": { "skip": true }
    }
  }
}
```

Go:
```json
{
  "porch": {
    "checks": {
      "build": { "command": "go build ./..." },
      "tests": { "command": "go test ./..." },
      "build_succeeds": { "command": "go build ./... 2>&1" },
      "tests_pass": { "command": "go test ./... 2>&1" },
      "e2e_tests": { "skip": true }
    }
  }
}
```

**Notes:**
- Check names must match exactly the names defined in the protocol's `checks` section (e.g., `build`, `tests`, `e2e_tests`, `build_succeeds`, `tests_pass`)
- Unknown check names in the override emit a yellow warning (typo detection)
- Overrides in `.codev/config.json` survive `codev update` — they are not in `protocol.json`
- Skipping a `phase_completion` check (e.g., `build_succeeds`, `tests_pass`) removes that gating condition; it does NOT auto-pass

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
| `.codev/config.json` | Project configuration |

---

## Environment Variables

Codev reserves the `CODEV_*` prefix. Tower injects these variables into the architect terminals it starts; users should not set them manually.

| Variable | Set by | Read by | Purpose |
|----------|--------|---------|---------|
| `CODEV_ARCHITECT_NAME` | Tower (at architect-terminal start) | `afx spawn` | Identifies the spawning architect so each new builder records `spawnedByArchitect` on its row. Defaults to `main` when absent (i.e., `afx spawn` was invoked outside any architect terminal). Spec 755. |
| `TOWER_ARCHITECT_CMD` | User (optional) | Tower (at architect-terminal start) | Overrides the architect command. Useful for CI / testing. |

---

## See Also

- [codev](codev.md) - Project management commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
