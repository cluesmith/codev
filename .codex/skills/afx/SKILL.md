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
| `--protocol <name>` | Protocol: spir, aspir, air, bugfix, pir, maintain, experiment. **Required for numbered spawns.** |
| `--task <text>` | Ad-hoc task (no issue number needed) |
| `--shell` | Bare Claude session |
| `--worktree` | Bare worktree session |
| `--files <files>` | Context files, comma-separated. **Requires `--task`.** |
| `--no-comment` | Skip commenting on the GitHub issue |
| `--force` | Skip dirty-worktree and collision checks |
| `--soft` | Soft mode (AI follows protocol, you verify) |
| `--strict` | Strict mode (porch orchestrates) — this is the default |
| `--resume` | Resume builder in existing worktree |
| `--branch <name>` | Build on an existing remote branch instead of creating one. **Requires `--protocol`.** |
| `--remote <name>` | Remote to fetch the `--branch` from (fork PRs) |
| `--no-role` | Skip loading role prompt |
| `--max-load <n>` | Refuse while the one-minute load average is ≥ N: exit 75, nothing created. Unsupported on native Windows (exits 1). |
| `--wait <seconds>` | With `--max-load`: re-check every 15s for up to this long, then spawn or exit 75 |

**There is NO `-t`, `--title`, or `--name` flag.** The worktree is `.builders/<protocol>-<id>` and the branch `builder/<protocol>-<id>`, unless `--branch` reuses an existing one.

**Examples:**
```bash
afx spawn 42 --protocol spir           # SPIR builder for issue #42
afx spawn 42 --protocol aspir          # ASPIR (no spec/plan gates)
afx spawn 42 --protocol air            # AIR (small features)
afx spawn 42 --protocol bugfix         # Bugfix
afx spawn 42 --protocol pir            # PIR (plan, dev and pr gates)
afx spawn 42 --protocol spir --branch fix/foo --remote fork   # Reuse a contributor's branch
afx spawn 42 --protocol spir --soft    # Soft mode
afx spawn 42 --resume                  # Resume existing builder
afx spawn --task "fix the flaky test"  # Ad-hoc task (no issue)
afx spawn 42 --protocol spir --force   # Skip dirty-worktree check
afx spawn 42 --protocol air --max-load 18 --wait 300   # Wait up to 5 min for load < 18
```

**Pre-spawn checklist:**
1. `git status` — worktree must be clean (or use `--force`)
2. Commit specs/plans first — builders branch from HEAD and can't see uncommitted files
3. `--protocol` is required for numbered spawns

## afx send

Sends a message to a builder or an architect (see the addressing forms below).

```
afx send [builder] [message]
```

| Flag | Description |
|------|-------------|
| `--all` | Send to all builders |
| `--file <path>` | Append a file's content to the message |
| `--message-file <path>` | Read the message body from a file — no shell quoting. Combines with `--file`; 48 KB limit on the result. |
| `--interrupt` | Send Ctrl+C first |
| `--raw` | Skip structured formatting |
| `--no-enter` | Don't press Enter after message |
| `--delay <seconds>` | Deliver after N seconds (persisted; survives a Tower restart, except a delayed `--interrupt` ^C) |
| `--exit-code` | Exit by outcome (below). Without it, a held message exits 0 like a delivered one. |
| `--retry <n>` | Up to N retries in total, only when the request provably never reached Tower (connection refused, Tower down). Never after held, refused or a timeout. |

```bash
afx send spir-42 "PR approved, please merge"
afx send 585 "check the test output" --file /tmp/test-results.txt
afx send architect --message-file /tmp/report.md --exit-code --retry 3
```

The reply is `delivered`, or `held` with a reason: a held message waits in Tower's mailbox and
delivers once the recipient's prompt is clear. See `afx inbox`. **Never resend a held message** —
it is persisted and will deliver; a resend arrives twice.

`--exit-code` (with `--all`, the worst across recipients; 1 if there are none):

| Exit | Outcome |
|------|---------|
| 0 | delivered, or scheduled by `--delay` |
| 1 | failed or refused |
| 3 | held |
| 4 | delivered but unverified — header not seen, input raced the write, or the write was not serialized. Recorded as delivered; not resent. |

**Addressing forms** — the recipient isn't only a builder ID:

| Form | Routes to |
|------|-----------|
| `afx send spir-585 "…"` | Builder `spir-585`. A bare `585` also works when exactly one builder id ends in it; leading zeros are ignored. |
| `afx send architect "…"` | From a builder: its spawning architect. From an architect: the `main` architect (else first registered). |
| `afx send architect:<name> "…"` | A specific named architect in your own workspace (sibling-architect messaging). Architects can address any architect; a builder may only use its own `spawnedByArchitect`. |
| `afx send <workspace>:architect "…"` | The **front door** of another workspace: its `main` architect, else the first registered. Any sender, builders included. |
| `afx send <workspace>:architect:<name> "…"` | A named architect in **another workspace** on this Tower. Architects and humans only: a builder is refused, and the error names the front door to use instead. (A builder may still write its own workspace's name in front of its own spawning architect; that is the same as `architect:<name>`.) |
| `afx send <workspace>:<builder-id> "…"` | A builder in another workspace. |
| `afx send afx://<tower>/<workspace>:architect "…"` | An agent on **another of your own Towers**, through Codev Cloud. After the slash, any `<workspace>:` form above but a shell. Needs remote messaging on at both Towers and a grant on the receiving one (`afx peer`). A builder may not name an architect there, only the front door. |

```bash
afx send architect:ob-refine "PR-iter-2 feedback ready"   # sibling architect, same workspace
afx send taqwabench:architect "use porch.checks, don't fork protocol.json"  # another workspace's front door
afx send codev-cloud:architect:tunnel "relay endpoint is on staging"         # a named architect in another workspace
afx send afx://devvm/codev:architect:local "CI is green on the tunnel branch"  # an architect on another of your Towers
```

**To another of your Towers.** Take the address from `afx peer show <tower>`. The reply is
`delivered`; `held on <tower>` (its prompt is not clear, or a grant there holds mail for a human's
release); `held on this Tower` (that Tower is offline or the cloud unreachable: it is sent once it
can be, in the order sent, within 30 days, and `afx inbox` lists it under Waiting for a peer —
never resend it); or `refused` with the reason, exit 1, nothing stored there (remote messaging off
at either end, no grant, a Tower that does not speak the protocol, a cloud with no relay). `--raw`,
`--interrupt`, `--no-enter` and `--delay` are refused for a recipient on another Tower.

**Find the address first: `afx workspace list`** — guessing fails with `NOT_FOUND`. It prints every
workspace on this Tower with its agents, each as an address ready to paste (see `afx workspace`
below). `<workspace>` is the workspace's directory name, or the name it was given with
`afx workspace name`. A named architect that is not registered fails, listing the workspace's
architects and its front door; nothing is rerouted. Mail to a registered architect with no live
terminal is held (`no-live-pty`), like any other, while its workspace is running; an address that
names a stopped workspace (one with no open terminal) is refused as not running.

**Replying to another workspace.** A message from another workspace names its sender by full
address, and its last line is the command that answers it. Run it as printed:

```
### [ARCHITECT codev:architect:review MESSAGE → tunnel | <time>] ###
hello
###############################  (reply: afx send codev:architect:review "…")
```

| Last line | Meaning |
|-----------|---------|
| `(reply: afx send <address> "…")` | The command that reaches the sender. A builder written to by an architect in another workspace is given that workspace's front door, and only when the front door reaches that architect. |
| `(reply through your architect: afx send architect "…")` | To a builder, when the front door would not reach the architect that wrote: ask your own architect to pass the answer on. |
| `(no reply address; the sender's workspace needs: afx workspace name <name>)` | The sender's workspace has no usable address name yet. |

A message from another of your Towers is marked remote and names that Tower; reply the same way:

```
### [REMOTE, your Tower · afx://mbp/codev:architect:main → local | <time>] ###
CI is green on the tunnel branch
###############################  (reply: afx send afx://mbp/codev:architect:main "…")
```

Only the Tower in that address (`mbp`) is verified, by Codev Cloud. The workspace and agent after
the slash are what that Tower says, and are worth what that Tower is worth.

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
afx interrupt spir-42
afx send spir-42 "That producer died — stop waiting and report."
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
afx refresh spir-42 --dry-run                # inspect first — touches nothing
afx refresh spir-42
afx refresh spir-42 --note "PR #90 merged while you were mid-phase. Rebase first."
afx refresh spir-42 --interrupt-first        # builder is wedged mid-turn
```

## afx self-refresh

A builder refreshes **its own** context at a protocol boundary: save state, verify it, clear,
re-orient. Two steps — `--begin` issues the challenge and prints what to save, then a second
call verifies the saved state and clears. Porch chooses the moment (a context-refresh task);
the `builder-refresh` skill carries the procedure.

| Flag | Description |
|------|-------------|
| `--begin` | Issue the challenge and print what to save (step 1 of 2) |
| `--boundary <id>` | Protocol boundary this refresh is for (e.g. `enter:review`) |
| `--note <text>` | Addendum appended to the re-orientation |
| `--dry-run` | Verify and assemble; send and clear nothing |
| `--delay <seconds>` | Seconds Tower holds the re-entry before delivering it |

## afx inbox

Held (undelivered) messages for this workspace, in three groups: waiting for a local agent, held
for release (mail from another Tower that a grant holds for a human), and waiting for a peer (mail
from here to another Tower, held on this Tower).

```bash
afx inbox                       # List held messages, by group
afx inbox show <id>             # One message, including its body; remote mail shows the sender's full address and owner
afx inbox release <id> --a-human-explicitly-approved-this   # Deliver one held for release (human only)
afx inbox dismiss <id>          # Mark it dismissed; it is never delivered (or, waiting for a peer, never sent)
```

## afx peer

Messaging between your own Towers through Codev Cloud. Both Towers are registered
(`afx tower connect`); one switch on each covers sending and receiving, and starts off.

```bash
afx peer list                   # The switch, and your other Towers: online or not, what each may message here
afx peer show <tower>           # What runs on <tower> that this Tower may message, as addresses to paste
afx peer on --a-human-explicitly-approved-this   # Turn remote messaging on (human only)
afx peer off                    # Turn it off: this Tower sends nothing to other Towers and accepts nothing
afx peer grants [<tower>]       # This Tower's grants
afx peer grant <tower> <address>... [--hold] --a-human-explicitly-approved-this   # Let <tower> message recipients here (human only)
afx peer revoke <tower> [<address>...]   # Remove those grants, or all of them for <tower>
afx peer log [--peer <tower>] [-n <count>]   # The record of cross-Tower attempts, in and out; never a body
afx peer limits                 # The limits this Tower enforces, and Codev Cloud's
```

- A grant names `codev:architect:local` (one architect), `codev:architect` (the front door),
  `--workspace codev` (every architect there) or `--all` (every architect and builder). Never a
  shell. `--hold` holds its mail for `afx inbox release`; where grants of both modes cover one
  recipient, hold wins.
- A round trip needs the switch on at both Towers and a grant on each receiving one.
- **Human only:** `afx peer on`, `afx peer grant` and `afx inbox release` let another machine write
  into an agent's prompt. An agent does not run them on its own initiative. Through Codev Cloud's
  browser proxy they are refused: they are done at the Tower's own machine.
- `afx peer off` and `afx peer revoke` refuse further mail at once; mail from that Tower accepted
  but not yet delivered moves to held for release.

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
| `--keep-ignored` | Before the worktree is removed, copy untracked files and keep-listed ignored files to `~/.agent-farm/kept/<workspace>/<builder-id>/` |

```bash
afx cleanup -p 585              # Clean up project 585
afx cleanup -p 585 -f           # Force (unmerged branch)
afx cleanup -i 42 --keep-ignored   # Keep review outputs, notes, tmp/ before removal
```

`--keep-ignored` keeps every untracked, non-ignored file plus ignored files matching
`cleanup.keepIgnored` in `.codev/config.json` (default `codev/projects/**`, `codev/state/**`,
`.builder-*`, `tmp/**`, `scratch/**`). Dependency and build output (`node_modules`, `dist`,
virtualenvs, …) and symlinks are never copied. Each copy is checksum-verified. It refuses if the
kept folder already exists, and any failure stops cleanup before the worktree, branch or builder
row is removed. Only bugfix and task cleanups remove a worktree; for others it keeps nothing.

**Note:** `afx cleanup -p` takes the plain number (`585`), not a zero-padded one (`0585`). `afx send` takes the full builder id (`spir-585`) or the bare number.

## afx status

```bash
afx status                      # Tower, workspace, architects and every builder
afx status --mine               # Only builders this architect spawned
afx status --activity           # Also: last transcript lines, API-error flag, running test/review processes (slower)
afx status --json               # Machine-readable (add --activity for the activity fields)
```

A `Remote messaging` line gives the switch, peers online, and this workspace's mail held for
release and waiting for a peer. Each builder row shows its live porch **Phase** and the **Gate** it waits at with its age (read from the builder's own worktree `status.yaml`), and **Last active** — time since its terminal last printed (`stopped` = no live session). A field that cannot be read shows `unknown`.

## afx whoami

```bash
afx whoami                      # Report this terminal's identity (workspace, type, name) and its address
afx whoami --json               # Same, as a single JSON object
```

Resolves identity from Tower/global.db's perspective: builder-worktree cwd
match first, then the Tower-injected `CODEV_ARCHITECT_NAME` env var. Exits 1
with an explanation when identity cannot be determined — it never guesses and
never defaults to `main` (issue #1094). Builders also get an `architect:`
field naming their spawning architect when recorded. Works without Tower.

The last line, `address:`, is this terminal's own address as another workspace on this Tower
types it (`codev:architect:review`, `codev:builder-spir-42`); `address` in `--json`. When there is
none it reads `address: none (<why, with the remedy>)` (`addressUnavailable` in `--json`): identity
and exit code are unaffected.

## afx tower

```bash
afx tower start                 # Start Tower on port 4100
afx tower stop                  # Stop Tower
afx tower log                   # Tail Tower logs
afx tower status                # Daemon and cloud connection; this Tower's name and remote messaging
afx tower connect               # Connect to Codev Cloud
afx tower connect --claim       # Re-register, taking the name back from your disconnected tower
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
afx workspace list [--json]     # Every workspace on this Tower and its agents, as addresses
afx workspace name <name>       # Give the current workspace an explicit address name
afx workspace name --clear      # Remove it: addressed by its directory name again
```

**`afx workspace list`** is how to find an address for `afx send`. One block per workspace, one
address a line:

```
$ afx workspace list
codev          /Users/ana/dev/codev
  codev:architect:main            live
  codev:architect:review          live
  codev:builder-spir-1940         live
codev-cloud    /Users/ana/dev/codev-cloud
  codev-cloud:architect:main      live
  codev-cloud:architect:tunnel    no live terminal
```

A line that is only an address and `live` / `no live terminal` is ready to paste; mail to an
agent with no live terminal is held until it has one. The listing is for the caller: an agent
you may not name carries `reach through <address>` (for a builder, another workspace's front
door). A workspace that is not running is listed with no agents. A workspace shown as
`(no address name)` says why on the next line, with the command that fixes it.

**`afx workspace name <name>`** sets the name other workspaces write before the colon. It is the
remedy when two workspaces share a directory name (neither can be addressed until one is named)
or when a directory name cannot be written in an address. Letters, digits, `.`, `_` and `-`,
starting with a letter or digit, stored lower-cased; `architect`, `arch` and `builder` are
reserved; a name another workspace already answers to is refused. Run it from the workspace to name (from a
builder worktree it names the builder's workspace).

These (`workspace list`, `workspace name`, the `address:` line of `whoami`, and
`afx send <workspace>:architect:<name>`) need a Tower of this version. Right after an upgrade the
running Tower is the old one: each says so, and `afx tower stop && afx tower start` fixes it.

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

The command runs through the platform shell — `/bin/sh` on macOS/Linux, `cmd.exe` on Windows. cmd.exe does not treat single quotes as quotes, so quote arguments with double quotes (`\"` for a quote inside one, e.g. `--jq "select(.conclusion == \"failure\")"`). But cmd.exe still counts every `"` as a quote toggle, so the text *between* an escaped `\"…\"` pair is unquoted to it: keep shell metacharacters (`|`, `&`, `<`, `>`, `^`) out of inner strings, and put anything that needs them in a script. A condition is evaluated on failed runs too, so a condition that inspects `output` should also require `exitCode == 0` — otherwise the command's own error text (tool missing, not authenticated, offline) reads as the alert.

## Other commands

```bash
afx open <file>                 # Open file in annotation viewer (NOT system open)
afx shell                       # Spawn utility shell
afx attach                      # Attach to running builder terminal
afx rename <name>               # Rename current shell session
afx decisions init              # Create the decisions file; turns on the Decisions tab
afx architect                   # Start architect session in current terminal
afx dev [builder-id]            # Run a builder's dev server (see the runnable-worktrees skill)
afx setup [builder-id]          # Re-run worktree.postSpawn for an existing builder
```
