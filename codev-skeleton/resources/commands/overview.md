# Codev CLI Command Reference

Codev provides four core CLI tools for AI-assisted software development:

| Tool | Description |
|------|-------------|
| `codev` | Project setup, maintenance, and framework commands |
| `afx` | Agent Farm - multi-agent orchestration for development |
| `porch` | Protocol orchestrator - drives each protocol's state machine |
| `consult` | AI consultation with external models (Gemini, Codex, Claude) |

## Quick Start

```bash
# Create a new project
codev init my-project

# Or add codev to an existing project
codev adopt

# Check your environment
codev doctor

# Start the workspace
afx workspace start

# Consult an AI model about a spec
consult -m gemini --protocol spir --type spec
```

## Installation

```bash
npm install -g @cluesmith/codev
```

This installs the commands globally: `codev`, `afx`, `porch` and `consult` (plus `team` and `generate-image`).

## Command Summaries

### codev - Project Management

| Command | Description |
|---------|-------------|
| `codev init [name]` | Create a new codev project |
| `codev adopt` | Add codev to an existing project |
| `codev bootstrap-docs` | Draft the governance docs from an existing codebase |
| `codev doctor` | Check system dependencies |
| `codev update` | Update codev templates and protocols |
| `codev import <source>` | AI-assisted protocol import from other projects |
| `codev check pr <N>` | Read-only merge readiness of a PR: head, state, mergeability, trial merge, CI on the code, attribution, watched files, size, files to read |
| `codev check deploy <N>...` | Read-only: whether merged PRs reached the deploy branch and the latest green deploy run |
| `codev check worktree <id\|path>` | Read-only: whether removing a builder worktree would lose data, and whether its PR is finished |

See [codev.md](codev.md) for full documentation.

### afx - Agent Farm

| Command | Description |
|---------|-------------|
| `afx workspace start` | Start the workspace |
| `afx workspace stop` | Stop all agent farm processes |
| `afx spawn` | Spawn a new builder (`--max-load <n>` refuses with exit 75 while the machine is loaded) |
| `afx status` | Show status of all agents |
| `afx cleanup` | Clean up a builder worktree (`--keep-ignored` copies its untracked and kept ignored files out first) |
| `afx send` | Send instructions to a builder (`--message-file`, opt-in `--exit-code`, safe `--retry`) |
| `afx inbox` | List/show/dismiss held (undelivered) messages |
| `afx open` | Open file annotation viewer |
| `afx shell` | Spawn a utility shell |
| `afx tower` | Cross-project dashboard |

See [agent-farm.md](agent-farm.md) for full documentation.

### porch - Protocol Orchestrator

| Command | Description |
|---------|-------------|
| `porch next [id]` | Emit the next tasks as JSON (the strict-mode loop) |
| `porch done [id]` | Signal the current phase complete: run its checks and advance |
| `porch status [id]` | Show project protocol status |
| `porch approve <id> <gate> --a-human-explicitly-approved-this` | Record a human's gate decision (run by the builder, after the architect relays it) |
| `porch pending` | List live pending gates across projects (stale records on finished/advanced projects hidden; `--all` shows them) |
| `porch verify <id> --skip "reason"` | Skip post-merge verification and mark the project verified |
| `porch -C <dir> <command>` | Run any command as if porch was started in `<dir>`, like `git -C` — no `cd` into a builder worktree. Grants nothing: `approve` still needs its flag. |

Porch drives every protocol's state machine (SPIR, ASPIR, AIR, BUGFIX, PIR, MAINTAIN, RESEARCH, EXPERIMENT). `afx spawn` starts builders in strict mode, where the builder runs the `porch next` / `porch done` loop; soft-mode builders follow the protocol document themselves.

### consult - AI Consultation

| Command | Description |
|---------|-------------|
| `consult -m <model> --prompt "text"` | General consultation |
| `consult -m <model> --protocol spir --type spec` | Protocol-based review |
| `consult stats` | View consultation statistics |

See [consult.md](consult.md) for full documentation.

## Global Options

All codev commands support:

```bash
--version    Show version number
--help       Show help for any command
```

## Configuration

Agent Farm is configured via `.codev/config.json` at the project root. Created during `codev init` or `codev adopt`. Override via CLI flags: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`.

## Related Documentation

- [SPIR Protocol](../protocols/spir/protocol.md) - Multi-phase development workflow
- [Architect Role](../roles/architect.md) - Architect responsibilities
- [Builder Role](../roles/builder.md) - Builder responsibilities
