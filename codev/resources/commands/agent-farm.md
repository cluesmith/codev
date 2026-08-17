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
- `--delay <seconds>` - Deliver after N seconds instead of immediately (Spec 1307)

**Delayed delivery (`--delay`):**

Tower holds the message and delivers it after the stated delay, so the sending process is
free to exit in the meantime. That is the point: a session can schedule a message to
*itself* for after something that destroys it — which is what `/arch-save` uses to send
`/arch-init` after a `/clear`.

- **Authorised at request time, delivered later.** Target resolution and the
  builder-spoofing check run when the command is issued, exactly as for an immediate send.
  A delayed send cannot defer a check past the conditions that would fail it.
- **Bounds:** a whole number of seconds, 1–3600. Rejected at the CLI *and* server
  boundaries, because a bad value silently changes *when* (or whether) the message arrives
  rather than failing loudly.
- **Persisted and durable (Spec 1313).** The message is written to Tower's durable mailbox at
  request time with a due time (`not_before`), so a pending delayed send now **survives a Tower
  restart** — the render gate still guarantees it only ever lands on a clean, verified-empty
  prompt when it comes due. This reverses Spec 1307's original drop-on-restart behaviour (the
  gate now provides the protection that behaviour wanted). A pre-due delayed send is listable —
  and cancellable — via `afx inbox` (its row shows a due-time countdown).
- **Ordering:** a delayed message never overtakes one already queued for that session — its
  durable row is created at request time, so it sorts after anything already waiting, and the
  mailbox delivers the oldest *eligible* row first. A pre-due delayed message does **not** block
  a later message that is already due (delivery is by eligibility, then oldest-first), and
  concurrent deliveries to one agent do not interleave. Request order across *differing* delays
  is **not** preserved — `--delay 30` followed by `--delay 5` delivers the 5-second one first,
  because that is what `--delay` means.
- **Reporting:** the CLI says "scheduled", not "sent", and returns the mailbox id of the
  persisted row. A message Tower is holding for later has not been delivered yet, and saying
  otherwise costs someone a debugging session.
- **Not combinable with the API's `escape` option** — an ESC bypasses buffering precisely
  so that it interrupts the *current* turn, which a delay contradicts. Refused rather than
  silently dropping one of the two. (`afx send` has no `--escape` flag; use `afx interrupt`.)
- `--interrupt` **is** combinable: the Ctrl+C is deferred *with* the message rather than
  firing immediately.

```bash
# Deliver in 15 seconds; this shell can exit immediately
afx send architect:main --delay 15 --raw '/arch-init main'
```

**Description:**

Sends text to a builder's terminal. Useful for:
- Providing guidance when builder is blocked
- Interrupting long-running processes
- Sending instructions or context
- Communicating across workspaces (e.g., notifying another project's architect)

**Outcome (Spec 1313 — mailbox-first delivery):**

`afx send` reports the real first outcome instead of an unconditional "delivered":

- **delivered** — the message was written to the recipient's prompt after a clean render-gate pass (an empty, render-verified prompt).
- **held** — the prompt was not clear, so the message is persisted in Tower's durable mailbox and **delivers automatically** the moment the recipient's prompt is clean (after a submit, on output quiescence, or a poll backstop). The response carries a **why-held reason** and a mailbox id:
  - `busy` — a draft, menu, dialog, or wrapper screen occupies the prompt;
  - `no-profile` — the target app has no render-gate classifier profile (only `claude`, `codex`, and `agy` are modeled);
  - `no-live-pty` — the recipient agent has no live terminal right now (it delivers when the agent respawns — rows address agents, not PTYs).

A held message is **never force-injected** onto a busy line: a message body is only ever written to a verified-empty prompt, so it cannot fuse with a half-typed draft, and held rows survive Tower restart/shutdown (no shutdown force-flush). See held mail with `afx inbox`, read one (including its body) with `afx inbox show <id>`, and clear one with `afx inbox dismiss <id>`. `--interrupt` is the explicit, deliberate bypass: it interrupts the agent and writes without holding (unchanged semantics).

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

### afx inbox

List, inspect, and dismiss **held** (undelivered) messages — the human-facing visibility surface for Spec 1313's mailbox. `afx send` persists a message it can't deliver immediately as a held row that delivers automatically once the recipient's prompt is clear; `afx inbox` lets a human see what is still waiting, read a specific message body, and clear rows — without reading Tower logs.

```bash
afx inbox [options]
afx inbox show <id> [options]
afx inbox dismiss <id> [options]
```

**`afx inbox`** — list every currently-held message in the workspace. Metadata only — message bodies are never shown in the list (or in logs); use `afx inbox show <id>` to read one:

| Column | Meaning |
|---|---|
| `ID` | Mailbox row id (pass to `show` / `dismiss`) |
| `AGE` | How long the message has been held (`5s`, `3m`, `2h`, `1d`) |
| `REASON` | Why-held: `busy`, `no-profile`, or `no-live-pty`; a trailing `!` marks a row past the escalation age |
| `FROM → TO` | Sender → recipient agent. An architect sender carries its name (`architect:main`); the column is sized to its content, so long ids are never truncated |
| `WORKSPACE` | Owning workspace |

**Options:**
- `-w, --workspace <path>` - Workspace to list (default: current workspace — `afx inbox` is workspace-scoped, not Tower-wide)
- `-p, --port <port>` - Tower port (default: 4100)

**`afx inbox show <id>`** — display a single message by id, **including its body**. This is the one CLI surface that surfaces a body: the redaction rule keeps bodies out of logs, diagnostics, and telemetry — not out of this local operator view, which travels over the same local Tower connection the message already uses. `show` works on a row of **any** status (held / delivered / superseded / dismissed), so a resolved row stays inspectable by id for audit until it is pruned. Prints the metadata (status, why-held reason, from → to, workspace, timestamps) followed by the raw body.

**Options:**
- `-p, --port <port>` - Tower port (default: 4100)

**`afx inbox dismiss <id>`** — mark a held message dismissed. A soft, auditable transition (the row is marked `dismissed`, not deleted) that **never delivers** the message. Any workspace operator may dismiss any held row (same local-human trust level as `afx send`).

**Options:**
- `-p, --port <port>` - Tower port (default: 4100)

**Examples:**

```bash
# List held messages in the current workspace
afx inbox

# List held messages for a different workspace
afx inbox --workspace /path/to/other/workspace

# Show one message including its body (works for any status, held or resolved)
afx inbox show 5f3c9a2b-1e4d-4c7a-9f21-8b6d0e2a1c33

# Dismiss a held message by id (never delivers it)
afx inbox dismiss 5f3c9a2b-1e4d-4c7a-9f21-8b6d0e2a1c33
```

Dismissal is CLI-only; the dashboard and VSCode held-count indicators surface the count but are read-only (Spec 1313 decision 8).

---

### afx interrupt

Interrupt a builder mid-turn by sending an ESC keystroke to its PTY.

```bash
afx interrupt <builder> [options]
```

**Arguments:**
- `builder` - Target builder. Same addressing as `afx send`.

**Options:**
- `--no-enter` - Send ESC alone, without the trailing Enter

**Description:**

This is the only recovery that reaches a builder **mid-turn**. When a builder chains foreground waits
inside a single turn, every `afx send` — including your order to stop — queues unread until that turn
ends. ESC interrupts the running tool and ends the turn, after which the queued messages process. The
trailing Enter (default) is what lets them through.

Distinct from `afx send --interrupt`, which sends Ctrl+C.

**Examples:**

```bash
# Builder is wedged on a foreground wait and not reading messages
afx interrupt 0042

# Then the queued instruction lands
afx send 0042 "That producer died — stop waiting and report."
```

---

### afx reset

Reset a builder's context: have it save its working state, clear the conversation, then re-orient it.

```bash
afx reset <builder> [options]
```

**Arguments:**
- `builder` - Target builder. Same addressing as `afx send`.

**Options:**
- `--note <text>` - Extra context appended to the re-orientation
- `--file <path>` - Append file content to the re-orientation (48KB max, read from *your* filesystem)
- `--dry-run` - Print the save request and both re-orientation payloads; write nothing to the builder
- `--interrupt-first` - Send ESC before the save request, for a builder already wedged mid-turn
- `--mode <strict|soft>` - Override the builder mode if it cannot be detected
- `--timeout <seconds>` - How long to wait for the save-state receipt (default 300)
- `--min-bytes <n>` - Minimum state-file size to accept as substantive (default 1000)
- `--quiet-window <ms>` - Terminal silence that counts as turn-ended (default 1500)

**Description:**

Long-running builders exhaust their context window. `afx spawn --resume` reattaches the *same*
conversation, so a deep session resumes deep — it does not give the builder a fresh window. `afx reset`
does, without losing what the builder knows.

The sequence:

1. Assemble the re-orientation and write it to `.builder-reorient.md` in the worktree.
2. Ask the builder to write its complete working state to `.builder-state.md`, stamped with a one-time
   nonce.
3. Wait for that file and **verify** it: correct nonce (not a stale file from an earlier reset),
   substantive size, and stable across two observations (not still being written).
4. Wait for the terminal to fall silent, so the clear is not typed mid-turn. If it does not settle, send
   **one** ESC and wait again.
5. Send `/clear`.
6. Deliver the re-orientation: role, protocol, mode, project, worktree, branch, the porch re-entry
   instruction, and a pointer to the state file.

**Every gate fails safe.** If the state file never arrives, carries the wrong nonce, is a stub, is still
growing, or the builder will not go quiet — the command **aborts without clearing** and exits non-zero,
naming the gate that failed. A builder whose context was not cleared has lost nothing.

Both worktree artifacts use the `.builder-` prefix, so `afx cleanup` still classifies the worktree as
clean, and both are untracked so `porch done`'s staged-file sweep cannot pick them up.

Requires a harness with in-session context reset (Claude Code). Other harnesses abort loudly rather than
substituting a different mechanism — use the boundary-recycle pattern instead (let the builder finish,
then `afx spawn <id> --resume`).

**Examples:**

```bash
# See exactly what would be sent, without touching the builder
afx reset 0042 --dry-run

# Standard reset
afx reset 0042

# Add context that post-dates the builder's saved state
afx reset 0042 --note "PR #90 merged while you were mid-phase. Rebase before continuing."

# The builder is wedged mid-turn and not reading messages
afx reset 0042 --interrupt-first

# A builder that legitimately needs longer to write its state
afx reset 0042 --timeout 600
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

### afx cron

Manage scheduled tasks defined as YAML files in `.af-cron/` at the workspace root. The Tower scheduler loads these every tick, runs due commands, and delivers messages through the normal send pipeline.

```bash
afx cron list                   # List all cron tasks
afx cron status <name>          # Check task status
afx cron run <name>             # Run immediately
afx cron enable <name>          # Enable
afx cron disable <name>         # Disable
```

There is NO `afx cron add` — create YAML files in `.af-cron/` directly.

**Task YAML format:**

```yaml
name: Service Health Check      # required, unique per workspace
schedule: "*/15 * * * *"        # required, cron expression (or @hourly/@daily/@startup)
command: ./health-check.sh      # required, run via shell
message: "Health alert: ${output}"  # required, ${output} = trimmed command output
condition: "exitCode != 0"      # optional JS expression, see below
target: architect               # optional, default architect
timeout: 30                     # optional, seconds, default 30
enabled: true                   # optional, default true
```

**Condition environment:** `condition` is a JavaScript expression evaluated with two variables in scope:

- `output` (string) — the command's trimmed output
- `exitCode` (number) — `0` on success, the command's exit code on non-zero exit, `124` on timeout, `-1` on spawn failure

With a `condition`, the message is delivered exactly when the expression evaluates truthy — including on failed runs, so `condition: "exitCode != 0"` alerts when the command fails. Without a `condition`, the message is delivered only when the command exits 0.

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

### Mailbox retention and escalation

`afx send`'s mailbox (Spec 1313) has two Tower-global knobs under a `mailbox` key:

```json
{
  "mailbox": {
    "retentionDays": 30,
    "escalationSeconds": 60
  }
}
```

- `mailbox.retentionDays` (default `30`) — how long a **terminal** mailbox row (delivered, superseded, or dismissed) is retained before Tower prunes it. **Held** rows are never pruned — they persist until they deliver, are superseded, or are dismissed via `afx inbox`.
- `mailbox.escalationSeconds` (default `60`) — how long a row may stay **held** before it crosses the escalation age. At that point the drainer marks the row `escalated`, emits the escalation broadcast, and moves the dashboard / VSCode held-count indicator into its attention state. This is **visibility only** — crossing the escalation age never triggers delivery (there is no force path; a held message still delivers only onto a verified-empty prompt).

Both are Tower-global (they apply to the whole Tower, not per-project) and optional — omit them to use the defaults above.

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
