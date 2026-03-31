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
| `--protocol <name>` | Protocol: spir, aspir, air, bugfix, tick, maintain, experiment. **Required for numbered spawns.** |
| `--task <text>` | Ad-hoc task (no issue number needed) |
| `--shell` | Bare Claude session |
| `--worktree` | Bare worktree session |
| `--amends <number>` | Original spec number (TICK only) |
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
afx spawn 42 --protocol tick --amends 30  # TICK amendment to spec 30
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

## afx workspace

```bash
afx workspace start             # Start workspace for current project
afx workspace stop              # Stop workspace processes
```

`afx dash` is a deprecated alias — use `afx workspace` instead.

## afx cron

```bash
afx cron list                   # List all cron tasks
afx cron status <name>          # Check task status
afx cron run <name>             # Run immediately
afx cron enable <name>          # Enable
afx cron disable <name>         # Disable
```

There is NO `afx cron add` — create YAML files in `.af-cron/` directly.

## Other commands

```bash
afx open <file>                 # Open file in annotation viewer (NOT system open)
afx shell                       # Spawn utility shell
afx attach                      # Attach to running builder terminal
afx rename <name>               # Rename current shell session
afx architect                   # Start architect session in current terminal
```
