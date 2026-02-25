# Codev CLI Command Reference

Codev provides four CLI tools for AI-assisted software development:

| Tool | Description |
|------|-------------|
| `codev` | Project setup, maintenance, and framework commands |
| `af` | Agent Farm - multi-agent orchestration for development |
| `porch` | Protocol orchestrator - drives SPIR/ASPIR/TICK/BUGFIX state machines |
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
af workspace start

# Consult an AI model about a spec
consult -m gemini --protocol spir --type spec
```

## Installation

```bash
npm install -g @cluesmith/codev
```

This installs all four commands globally: `codev`, `af`, `porch`, and `consult`.

## Command Summaries

### codev - Project Management

| Command | Description |
|---------|-------------|
| `codev init [name]` | Create a new codev project |
| `codev adopt` | Add codev to an existing project |
| `codev doctor` | Check system dependencies |
| `codev update` | Update codev templates and protocols |
| `codev import <source>` | AI-assisted protocol import from other projects |

See [codev.md](codev.md) for full documentation.

### af - Agent Farm

| Command | Description |
|---------|-------------|
| `af workspace start` | Start the workspace |
| `af workspace stop` | Stop all agent farm processes |
| `af spawn` | Spawn a new builder |
| `af status` | Show status of all agents |
| `af cleanup` | Clean up a builder worktree |
| `af send` | Send instructions to a builder |
| `af open` | Open file annotation viewer |
| `af shell` | Spawn a utility shell |
| `af tower` | Cross-project dashboard |

See [agent-farm.md](agent-farm.md) for full documentation.

### porch - Protocol Orchestrator

| Command | Description |
|---------|-------------|
| `porch status <id>` | Show project protocol status |
| `porch run <id>` | Run the next protocol phase |
| `porch approve <id> <gate>` | Approve a human gate |
| `porch pending` | List all pending gates across projects |

Porch drives SPIR, ASPIR, TICK, and BUGFIX protocols via a state machine. It's used automatically by `af spawn` (strict mode) or manually by builders (soft mode).

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

Customize agent-farm commands via `af-config.json` (project root):

```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": "claude --model sonnet",
    "shell": "bash"
  }
}
```

## Related Documentation

- [SPIR Protocol](../protocols/spir/protocol.md) - Multi-phase development workflow
- [TICK Protocol](../protocols/tick/protocol.md) - Fast amendment workflow
- [Architect Role](../roles/architect.md) - Architect responsibilities
- [Builder Role](../roles/builder.md) - Builder responsibilities
