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
- `--delay <seconds>` - Deliver after N seconds instead of immediately

**Delayed delivery (`--delay`):**

Tower holds the message and delivers it after the stated delay, so the sending process is
free to exit in the meantime. That is the point: a session can schedule a message to
*itself* for after something that destroys it.

- **Authorised at request time, delivered later.** Target resolution and the
  builder-spoofing check run when the command is issued, exactly as for an immediate send.
  A delayed send cannot defer a check past the conditions that would fail it.
- **Bounds:** a whole number of seconds, 1–3600, rejected at both the CLI and server
  boundaries — a bad value silently changes *when* (or whether) a message arrives rather
  than failing loudly.
- **Persisted and durable (Spec 1313).** The message is written to Tower's durable mailbox at
  request time with a due time (`not_before`), so a pending delayed send **survives a Tower
  restart** — the render gate still guarantees it only lands on a clean, verified-empty prompt
  when it comes due (this reverses Spec 1307's original drop-on-restart behaviour; the gate now
  provides the protection that behaviour wanted). A pre-due delayed send is listable — and
  cancellable — via `afx inbox`.
- **Ordering:** a delayed message never overtakes one already queued for that session — its
  durable row is created at request time, and the mailbox delivers the oldest *eligible* row
  first, so a pre-due message does not block a later message that is already due, and concurrent
  deliveries to one agent do not interleave. Request order across *differing* delays is **not**
  preserved — `--delay 30` then `--delay 5` delivers the 5-second one first, because that is what
  `--delay` means.
- **Reporting:** the CLI says "scheduled", not "sent", and returns the mailbox id of the
  persisted row.
- `--interrupt` is combinable (the Ctrl+C defers *with* the message); the API's `escape`
  option is not (an ESC bypasses buffering precisely so it interrupts the *current* turn).

```bash
# Deliver in 15 seconds; this shell can exit immediately
afx send architect:main --delay 15 --raw '/arch-init main'
```

**Description:**

Sends text to a builder's terminal. Useful for:
- Providing guidance when builder is blocked
- Interrupting long-running processes
- Sending instructions or context

**Outcome (Spec 1313 — mailbox-first delivery):**

`afx send` reports the real first outcome instead of an unconditional "delivered":

- **delivered** — the message was written to the recipient's prompt after a clean render-gate pass (an empty, render-verified prompt).
- **held** — the prompt was not clear, so the message is persisted in Tower's durable mailbox and **delivers automatically** the moment the recipient's prompt is clean (after a submit, on output quiescence, or a poll backstop). The response carries a **why-held reason** and a mailbox id:
  - `busy` — the prompt is occupied. `afx inbox` qualifies it with the gate's own detail:
    `busy:user-text` (a draft, menu, dialog, or wrapper screen), `busy:recent-input` (the
    terminal received input within the last fraction of a second — a keystroke, a click, or an
    ungated `--interrupt`/`--escape` write — so the composer may be changing under the gate; it
    clears by itself a moment after the input stops), `busy:composer-redraw` (the composer is
    empty but its rendered region moved a moment ago — a turn-end redraw, a rotating
    placeholder, a resize; also self-clearing, about a quarter second after it stops moving), or
    `busy:no-region-end` / `busy:no-composer-marker` (the classifier could not verify the
    composer at all — the one hold class that does NOT clear on its own);
  - `no-profile` — the target app has no render-gate classifier profile (only `claude`, `codex`, and `agy` are modeled);
  - `no-live-pty` — the recipient agent has no live terminal right now (it delivers when the agent respawns — rows address agents, not PTYs).

**A recipient that is simply TALKING does not hold mail** (Issue #1664). claude and codex accept
input during a turn and queue it for the next one, so a message written onto their empty composer
mid-turn is safe and lands as one message when the turn ends — the gate waits only on the
*composer*, never on the spinner or the streaming transcript above it. Before that, mail queued
behind whole turns: measured over 24 h, 227 deliveries waited more than 2 s, averaging 54 s and
peaking at 561 s.

A held message is **never force-injected** onto a busy line: a message body is only ever written to a verified-empty prompt, so it cannot fuse with a draft the gate can see, and held rows survive Tower restart/shutdown (no shutdown force-flush). Two signals make a draft visible (Issue #1473) — the composer classifier reads it off the rendered screen, and every write that reaches the PTY **through Tower** (browser and VS Code keystrokes, the terminal input API, an ungated `--interrupt`/`--escape`) is observed there — whatever survives the terminal-reply filter bumps an input counter the gate folds into its change token, so even a keystroke the app has not echoed yet holds the message, while a chunk that is nothing but a DA/DSR/CPR answer moves nothing. **`afx attach` is the one exception:** it pipes your keystrokes straight to the shellper socket, never through Tower's `PtySession.write()`, so they move no counter — a draft typed under `afx attach` is seen only once the app has echoed it and the classifier can read it off the screen. See held mail with `afx inbox`, read one (including its body) with `afx inbox show <id>`, and clear one with `afx inbox dismiss <id>`. `--interrupt` is the explicit, deliberate bypass: it interrupts the agent and writes without holding (unchanged semantics).

**How a body is typed (Issue #1567):** a frame under 4 lines and at most 256 bytes is one write plus
Enter, as always. Anything longer is written as **one explicit bracketed paste** (`ESC[200~ … ESC[201~`,
in ≤512-byte pieces 5 ms apart) with the Enter as a separate write after a short settle. This is the fix
for the delivery-side head loss where a >1 KB single write was split by the PTY input queue and the
recipient's paste heuristic discarded the first chunk (only the tail arrived, with `delivered` at the
sender). While it sits in the composer, claude shows the paste as `[Pasted text #N +M lines]` and codex
as `[Pasted Content N chars]`; the echo verification behind the `(unverified — …)` suffix accepts a new
placard as well as the header, so a correct long delivery is reported verified. agy keeps the older
line-by-line shape (also chunked) because its paste handling has not been measured.

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

# Show one message including its body (works for any status, held or resolved)
afx inbox show 5f3c9a2b-1e4d-4c7a-9f21-8b6d0e2a1c33

# Dismiss a held message by id (never delivers it)
afx inbox dismiss 5f3c9a2b-1e4d-4c7a-9f21-8b6d0e2a1c33
```

Dismissal is CLI-only; the dashboard and VSCode held-count indicators surface the count but are read-only (Spec 1313 decision 8).

---

### afx decisions init

Turn on the dashboard's Decisions tab (Issue #1840).

```bash
afx decisions init [--path <file>]
```

**Options:**
- `--path <file>` - File to create, relative to the workspace root (default: `dashboard.decisionsFile`, else `codev/state/pending-decisions.md`)

Creates the decisions file from its template and prints the sentence to tell the main architect. It never replaces an existing file, and refuses a path outside the workspace. See [Decisions tab](#decisions-tab).

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

### afx refresh

Refresh a builder's context: have it save its working state, clear the conversation, then re-orient it.

```bash
afx refresh <builder> [options]
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

**Deprecated alias:** `afx reset` still runs this command and prints a one-line notice to stderr.
It will be removed in a future release — use `afx refresh`.

**Description:**

Long-running builders exhaust their context window. `afx spawn --resume` reattaches the *same*
conversation, so a deep session resumes deep — it does not give the builder a fresh window. `afx refresh`
does, without losing what the builder knows.

The sequence:

1. Assemble the re-orientation and write it to `.builder-reorient.md` in the worktree.
2. Ask the builder to write its complete working state to `.builder-state.md`, stamped with a one-time
   nonce.
3. Wait for that file and **verify** it: correct nonce (not a stale file from an earlier refresh),
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
afx refresh 0042 --dry-run

# Standard refresh
afx refresh 0042

# Add context that post-dates the builder's saved state
afx refresh 0042 --note "PR #90 merged while you were mid-phase. Rebase before continuing."

# The builder is wedged mid-turn and not reading messages
afx refresh 0042 --interrupt-first

# A builder that legitimately needs longer to write its state
afx refresh 0042 --timeout 600
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

### afx ide

Manage the Codev IDE server: a Codev-branded VS Code server-web build that Tower spawns, owns,
and forwards at the `/ide/` prefix. One server serves any folder; open a workspace at
`http://localhost:4100/ide/?folder=<absolute path>`. These commands drive Tower's local-only
`/api/ide` endpoint, so Tower must be running.

**Install:** `npm i -g @cluesmith/codev @cluesmith/codev-ide` (or `afx ide install` for the
second package). `@cluesmith/codev` carries the Codev sidebar extension; `@cluesmith/codev-ide`
carries the server binary `codev-ide-server` for your platform.

#### afx ide install

Install the IDE server package.

```bash
afx ide install
```

Runs `npm i -g @cluesmith/codev-ide` in your shell with npm's output shown, and exits with npm's
status. On success it reports the server it now finds and its version. Running it again upgrades
the server in place; a server that is already running keeps the old version until it is
restarted (`afx ide stop && afx ide start`).

#### afx ide start

Find the server and ask Tower to spawn it.

```bash
afx ide start [options]
```

**Options:**
- `--server-path <path>` - Path to the `codev-ide-server` binary (overrides discovery)
- `-p, --port <port>` - Port the server listens on (default: 8200, loopback only)

**Discovery** (without `--server-path`), first match wins:
1. `codev-ide-server` on `PATH`
2. `@cluesmith/codev-ide` installed next to the running `@cluesmith/codev`
3. `@cluesmith/codev-ide` under `npm root -g`

Discovery runs in the CLI, in your shell's environment, because Tower is a long-running daemon
whose `PATH` may predate the install. When nothing is found the command exits 1 without
contacting Tower and names `afx ide install` and `--server-path`. A `--server-path` that does
not exist fails the same way.

**What Tower does on every start, before spawning:**
1. **Version check.** Runs `codev-ide-server --version` and refuses a server older than the
   minimum Tower supports, naming the installed version, the minimum, and the upgrade command.
2. **Sidebar install.** Installs the sidebar vsix embedded in `@cluesmith/codev` into
   `~/.agent-farm/ide-extensions` with the server's own `--install-extension`. Skipped when that
   version is already installed. Other extensions in the directory are left alone. If the
   installed codev package has no embedded sidebar, Tower warns and starts the server without it.
3. **Spawn** with `--extensions-dir ~/.agent-farm/ide-extensions`.

A failed check or install refuses the start and leaves any running server untouched. The first
start can take a minute or more.

The server loads extensions only from `~/.agent-farm/ide-extensions`, so anything installed into
its default extensions directory is no longer loaded. Install additional extensions there:
`codev-ide-server --install-extension <id-or-vsix> --extensions-dir ~/.agent-farm/ide-extensions`.

If a server is already live on the port, `start` adopts it rather than killing it. When that
server predates the current start (a different binary, an older sidebar, or a server started
before this feature), the command prints a restart hint: `afx ide stop && afx ide start`.

On success it prints the prefix, port, PID, server version, and sidebar version.

#### afx ide stop

```bash
afx ide stop
```

Stops the server and clears Tower's record. Reports when no server was running.

#### afx ide status

```bash
afx ide status
```

Shows the prefix, port, server path, server version, extensions directory, sidebar version,
and whether the process is live. Records written before this feature
show `unknown` for the version and extensions fields.

**Files:**
- `~/.agent-farm/ide-server.json` - Tower's record of the running server
- `~/.agent-farm/ide-extensions/` - Tower-owned extensions directory (mode 0700)
- `~/.agent-farm/ide-connection-token` - Token guarding direct access to the server port

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

Or override via CLI flags:

```bash
afx workspace start --architect-cmd "claude --model opus"
afx spawn 42 --protocol spir --builder-cmd "claude --model haiku"
```

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

### Decisions tab

Turn the tab on with `afx decisions init`. It creates the decisions file from its template, prints where it went, and gives the one sentence to tell the main architect: "Route every ask for my word through the decisions file." It refuses a file that already exists, because that file holds the owner's rulings, and a path outside the workspace. `--path <file>` creates another file, relative to the workspace root; the tab shows it once `dashboard.decisionsFile` names it.

When a workspace has a pending-decisions file, the dashboard shows a **Decisions** tab (Spec 1819). The tab is a view of that file. Each item under `## Open` becomes a card with a click box per option (the first option, the recommended one, is marked) and a comment box. Submitting writes the chosen word, then the comment, on the lines right after the item's `**Your word:**` line, exactly as the owner would type them, and changes nothing else. `## Ruled` is shown below as a collapsed, read-only list. The file is the only state. While the tab is open it re-reads the file every 2 seconds, so edits made elsewhere appear without a reload, and an unsent draft survives them.

The file's format and the process around it are in [`decision-protocol.md`](../decision-protocol.md): one hub architect, `main`, is the only agent that edits the file, other architects send it their items, and the hub relays each ruling. The tab reads exactly the item format that document describes.

The file is `codev/state/pending-decisions.md` unless `dashboard.decisionsFile` names another:

```json
{
  "dashboard": {
    "decisionsFile": "codev/state/pending-decisions.md"
  }
}
```

- **Relative to the workspace root.** An absolute path, or anything but a non-empty string, is a configuration error: the tab does not appear, and Tower logs the error once.
- **Inside the workspace.** The path is resolved with symlinks followed on every read and write, and a path that leads outside the workspace (directly, through `..`, or through a symlink) is refused. A symlinked decisions file keeps its link: the ruling is written to its in-workspace target.
- **Layers.** Like the other settings, it can be set globally in `~/.codev/config.json`, for the team in the project's `.codev/config.json`, or per engineer in `.codev/config.local.json`. Project settings override global ones, and project-local settings override both.

The tab appears once the file exists (within about 5 seconds of a change to the setting), and then stays for the page session: if the file is deleted while the tab is open, the tab says so and keeps any unsent draft. A reload of a workspace without the file shows no tab. A submit is refused, with a message on the card and the draft kept, when the item has changed or been ruled since the tab showed it. Tower applies one write to a file at a time and replaces the file atomically (a temporary file renamed over it).

After each ruling is written, Tower tells the workspace's hub architect, the one named `main`, in one mailbox message delivered like an `afx send architect`: `RULED <id>: <word>`, or `QUESTION <id>:` for a comment-only submit, with the comment on the lines after it, under a `[USER via Decisions tab]` header. Like any message it waits for a clear prompt, and it waits for `main` to come back if `main` is not running. A workspace with no architect named `main` gets no notice: Tower logs a warning naming the workspace and does not pick another architect. A failed send is logged and leaves the ruling as written: the file is still the source of truth, and a ruling typed into the file by hand reaches the hub only when it scans the file.

### Porch check overrides

Protocol checks default to the npm toolchain (`npm run build`, `npm test`). Override them per check name under `porch.checks` instead of forking `protocol.json`:

```json
{
  "porch": {
    "checks": {
      "build": { "command": "cargo build" },
      "tests": { "command": "cargo test", "timeout_ms": 900000 },
      "e2e_tests": { "skip": true }
    }
  }
}
```

**Override fields:**
- `command` — Replace the protocol's check command with a custom shell command
- `cwd` — Override the working directory for this check (relative to project root)
- `timeout_ms` — Kill the check after this many milliseconds (default 5 minutes; a protocol.json check can set it too). On timeout porch kills the check's whole process tree
- `skip: true` — Omit this check entirely (for checks that don't apply to your project)

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
