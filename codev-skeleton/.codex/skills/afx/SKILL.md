---
name: afx
description: Agent Farm CLI — the tool for spawning builders, managing Tower, workspaces, and cron tasks. ALWAYS consult this skill BEFORE running any `afx` command to get the exact syntax. This prevents wasting time guessing flags that don't exist. Use this whenever you need to spawn a builder, check status, send messages, clean up worktrees, manage Tower, or run cron tasks. If you're about to type `afx` followed by anything, check here first.
---

# Agent Farm CLI

## afx spawn

Spawns a new builder in an isolated git worktree.

```
afx spawn [number] [options]
```

**The ONLY flags that exist:**

| Flag | Description |
|------|-------------|
| `--protocol <name>` | Protocol: spir, aspir, air, bugfix, maintain, experiment. **Required for numbered spawns.** |
| `--task <text>` | Ad-hoc task (no issue number needed) |
| `--shell` | Bare Claude session |
| `--worktree` | Bare worktree session |
| `--files <files>` | Context files, comma-separated. **Requires `--task`.** |
| `--no-comment` | Skip commenting on the GitHub issue |
| `--force` | Skip dirty-worktree and collision checks |
| `--soft` | Soft mode (AI follows protocol, you verify) |
| `--strict` | Strict mode (porch orchestrates) — this is the default |
| `--resume` | Resume builder in existing worktree |
| `--no-role` | Skip loading role prompt |

**There is NO `-t`, `--title`, `--name`, or `--branch` flag.** The branch name is auto-generated from the issue title.

**Examples:**
```bash
afx spawn 42 --protocol spir           # SPIR builder for issue #42
afx spawn 42 --protocol aspir          # ASPIR (autonomous, no human gates)
afx spawn 42 --protocol air            # AIR (small features)
afx spawn 42 --protocol bugfix         # Bugfix
afx spawn 42 --protocol spir --soft    # Soft mode
afx spawn 42 --resume                  # Resume existing builder
afx spawn --task "fix the flaky test"  # Ad-hoc task (no issue)
afx spawn 42 --protocol spir --force   # Skip dirty-worktree check
```

**Pre-spawn checklist:**
1. `git status` — worktree must be clean (or use `--force`)
2. Commit specs/plans first — builders branch from HEAD and can't see uncommitted files
3. `--protocol` is required for numbered spawns

## afx send

Sends a message to a running builder.

```
afx send [builder] [message]
```

| Flag | Description |
|------|-------------|
| `--all` | Send to all builders |
| `--file <path>` | Include file content |
| `--interrupt` | Send Ctrl+C first |
| `--raw` | Skip structured formatting |
| `--no-enter` | Don't press Enter after message |

```bash
afx send 0042 "PR approved, please merge"
afx send 0585 "check the test output" --file /tmp/test-results.txt
```

## afx interrupt

Sends an ESC keystroke to a builder's PTY — the only thing that reaches it **mid-turn**.

```
afx interrupt <builder>
```

| Flag | Description |
|------|-------------|
| `--no-enter` | Send ESC alone, without the trailing Enter |

A builder chaining foreground waits inside one turn queues every `afx send` unread — including your order
to stop. ESC ends the turn so the queue processes. Distinct from `afx send --interrupt` (Ctrl+C).

```bash
afx interrupt 0042
afx send 0042 "That producer died — stop waiting and report."
```

## afx refresh

Refreshes a builder's context: save working state → `/clear` → re-orient. Use when a builder's context window
is exhausted; `afx spawn --resume` reattaches the *same* conversation and does **not** give it a fresh one.

```
afx refresh <builder>
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Print what would be sent; write nothing to the builder |
| `--note <text>` | Extra context appended to the re-orientation |
| `--file <path>` | Append file content (48KB max, read from *your* filesystem) |
| `--interrupt-first` | ESC before the save request, for a builder already wedged |
| `--mode <strict\|soft>` | Override mode if it cannot be detected |
| `--timeout <seconds>` | Wait for the save-state receipt (default 300) |
| `--min-bytes <n>` | Minimum state-file size to accept (default 1000) |
| `--quiet-window <ms>` | Terminal silence counting as turn-ended (default 1500) |

Every gate fails safe: if the state file never arrives, carries a stale nonce, is a stub, is still being
written, or the builder will not go quiet, the command **aborts without clearing** and exits non-zero,
naming the gate. Requires a harness with in-session context clearing (Claude Code); others abort loudly.

`afx reset` is a deprecated alias: it still works, prints a one-line notice to stderr, and will be removed
in a future release.

```bash
afx refresh 0042 --dry-run                # inspect first — touches nothing
afx refresh 0042
afx refresh 0042 --note "PR #90 merged while you were mid-phase. Rebase first."
afx refresh 0042 --interrupt-first        # builder is wedged mid-turn
```

## afx cleanup

Removes a builder's worktree and branch after work is done.

```
afx cleanup [options]
```

| Flag | Description |
|------|-------------|
| `-p, --project <id>` | Builder project ID (no leading zeros: `585` not `0585`) |
| `-i, --issue <number>` | Cleanup bugfix builder by issue number |
| `-t, --task <id>` | Cleanup task builder (e.g., `task-bEPd`) |
| `-f, --force` | Force cleanup even if branch not merged |

```bash
afx cleanup -p 585              # Clean up project 585
afx cleanup -p 585 -f           # Force (unmerged branch)
```

**Note:** `afx cleanup` uses plain numbers (`585`), not zero-padded (`0585`). But `afx send` uses zero-padded IDs (`0585`).

## afx status

```bash
afx status                      # Show all builders and workspace status
```

No flags needed. Shows Tower status, workspace, and all active builders.

## afx whoami

```bash
afx whoami                      # Report this terminal's identity (workspace, type, name)
afx whoami --json               # Same, as a single JSON object
```

Resolves identity from Tower/global.db's perspective: builder-worktree cwd
match first, then the Tower-injected `CODEV_ARCHITECT_NAME` env var. Exits 1
with an explanation when identity cannot be determined — it never guesses and
never defaults to `main` (issue #1094). Builders also get an `architect:`
field naming their spawning architect when recorded. Works without Tower.

## afx tower

```bash
afx tower start                 # Start Tower on port 4100
afx tower stop                  # Stop Tower
afx tower log                   # Tail Tower logs
afx tower status                # Check daemon and cloud connection status
afx tower connect               # Connect to Codev Cloud
afx tower disconnect            # Disconnect from Codev Cloud
```

There is NO `afx tower restart` — use `afx tower stop && afx tower start`.

## afx ide

Manages the Codev IDE server (VS Code server-web) that Tower forwards at `/ide/`. Tower spawns
and owns the process; these commands drive it. Open a workspace at
`http://localhost:4100/ide/?folder=<abs path>`.

```bash
afx ide install                 # npm i -g @cluesmith/codev-ide, then report the installed version
afx ide start                   # Find codev-ide-server, ask Tower to spawn it (port 8200)
afx ide start --server-path <bin>   # Use this binary instead of discovery
afx ide start -p <port>         # Run the server on another port
afx ide stop                    # Stop the server
afx ide status                  # Port, PID, server path/version, extensions dir, sidebar version
```

**Discovery** (when `--server-path` is absent): `codev-ide-server` on `PATH`, then
`@cluesmith/codev-ide` next to the running codev install, then under `npm root -g`. Nothing
found exits 1 before Tower is contacted, naming `afx ide install` and `--server-path`.

**On every start** Tower checks `codev-ide-server --version` against a minimum (an older server
is refused with the installed version, the floor, and the upgrade command), installs the
sidebar vsix that ships inside `@cluesmith/codev` into `~/.agent-farm/ide-extensions` (skipped
when that version is already installed; other extensions in the directory are left alone), and
spawns the server with `--extensions-dir` pointing there. The first start can take a minute or more.

The server loads extensions only from `~/.agent-farm/ide-extensions`, so anything installed into
its default extensions directory is no longer loaded. Install additional extensions there:
`codev-ide-server --install-extension <id-or-vsix> --extensions-dir ~/.agent-farm/ide-extensions`.

A server that is already running is never killed by `start`. If it predates the current server
or sidebar, `start` warns: restart it with `afx ide stop && afx ide start`.

There is NO `afx ide restart` and NO `afx ide upgrade`. To upgrade, run `afx ide install`, then
`afx ide stop && afx ide start`.

## afx workspace

```bash
afx workspace start             # Start workspace for current project
afx workspace stop              # Stop workspace processes
afx workspace add-architect --name <name>   # Add a named sibling architect terminal
afx workspace remove-architect <name>       # Remove a sibling architect (cannot remove main)
afx workspace recover           # Revive builders whose shellper died (e.g. after reboot)
```

**Recreating a dead architect** (its process died while Tower kept the registration):
re-add it under the SAME name, then re-init its identity:

```bash
afx workspace add-architect --name <name>
afx send architect:<name> "/arch-init <name>"
```

Builder-to-architect affinity survives the death (builders keep their Owner), so a
same-name re-add restores routing with no worktree impact and no builder disruption.
`afx workspace recover` revives builders only, not architects.

`afx dash` is a deprecated alias — use `afx workspace` instead.

## afx cron

```bash
afx cron list                   # List all cron tasks
afx cron status <name>          # Check task status
afx cron run <name>             # Run immediately
afx cron enable <name>          # Enable
afx cron disable <name>         # Disable
```

There is NO `afx cron add` — create YAML files in `.af-cron/` directly:

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

`condition` is a JavaScript expression with two variables in scope: `output` (string — the command's trimmed output) and `exitCode` (number — 0 on success, the command's exit code on non-zero exit, 124 on timeout, -1 on spawn failure). With a `condition`, the message is delivered exactly when it evaluates truthy — including on failed runs (e.g. `exitCode != 0` alerts when the command fails). Without a `condition`, the message is delivered only when the command exits 0.

## Other commands

```bash
afx open <file>                 # Open file in annotation viewer (NOT system open)
afx shell                       # Spawn utility shell
afx attach                      # Attach to running builder terminal
afx rename <name>               # Rename current shell session
afx decisions init              # Create the decisions file; turns on the Decisions tab
afx architect                   # Start architect session in current terminal
```
