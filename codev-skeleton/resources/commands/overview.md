# Codev CLI Command Reference

Codev provides three CLI tools for AI-assisted software development:

| Tool | Description |
|------|-------------|
| `codev` | Project setup, maintenance, and framework commands |
| `afx` | Agent Farm - multi-agent orchestration for development |
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

This installs all three commands globally: `codev`, `afx`, and `consult`.

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
