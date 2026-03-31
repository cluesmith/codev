# Codev CLI Command Reference

Codev provides five CLI tools for AI-assisted software development:

| Tool | Description |
|------|-------------|
| `codev` | Project setup, maintenance, and framework commands |
| `afx` | Agent Farm - multi-agent orchestration for development |
| `porch` | Protocol orchestrator - drives SPIR/ASPIR/TICK/BUGFIX state machines |
| `consult` | AI consultation with external models (Gemini, Codex, Claude) |
| `team` | Team coordination - manage members and messages |

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

This installs all five commands globally: `codev`, `afx`, `porch`, `consult`, and `team`.

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

### afx - Agent Farm

| Command | Description |
|---------|-------------|
| `afx workspace start` | Start the workspace |
| `afx workspace stop` | Stop all agent farm processes |
| `afx spawn` | Spawn a new builder |
| `afx status` | Show status of all agents |
| `afx cleanup` | Clean up a builder worktree |
| `afx send` | Send instructions to a builder |
| `afx open` | Open file annotation viewer |
| `afx shell` | Spawn a utility shell |
| `afx tower` | Cross-project dashboard |

See [agent-farm.md](agent-farm.md) for full documentation.

### porch - Protocol Orchestrator

| Command | Description |
|---------|-------------|
| `porch status <id>` | Show project protocol status |
| `porch run <id>` | Run the next protocol phase |
| `porch approve <id> <gate>` | Approve a human gate |
| `porch pending` | List all pending gates across projects |

Porch drives SPIR, ASPIR, TICK, and BUGFIX protocols via a state machine. It's used automatically by `afx spawn` (strict mode) or manually by builders (soft mode).

### consult - AI Consultation

| Command | Description |
|---------|-------------|
| `consult -m <model> --prompt "text"` | General consultation |
| `consult -m <model> --protocol spir --type spec` | Protocol-based review |
| `consult stats` | View consultation statistics |

See [consult.md](consult.md) for full documentation.

### team - Team Coordination

| Command | Description |
|---------|-------------|
| `team list` | List team members |
| `team message <text>` | Post a message to the team log |
| `team update` | Post hourly activity summary |
| `team add <handle>` | Scaffold a new team member file |

See [team.md](team.md) for full documentation.

> **Note**: `afx team` commands still work but are deprecated. Use `team` directly.

## Global Options

All codev commands support:

```bash
--version    Show version number
--help       Show help for any command
```

## Configuration

Customize agent-farm commands via `.codev/config.json` (project root):

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
