# Codev CLI Command Reference

Codev provides three CLI tools for AI-assisted software development:

| Tool | Description |
|------|-------------|
| `codev` | Project setup, maintenance, and framework commands |
| `af` | Agent Farm - multi-agent orchestration for development |
| `consult` | AI consultation with external models (Gemini, Codex, Claude) |

## Quick Start

```bash
# Create a new project
codev init my-project

# Or add codev to an existing project
codev adopt

# Check your environment
codev doctor

# Start the architect dashboard
af dash start

# Consult an AI model about a spec
consult -m gemini spec 42
```

## Installation

```bash
npm install -g @cluesmith/codev
```

This installs all three commands globally: `codev`, `af`, and `consult`.

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
| `af dash start` | Start the architect dashboard |
| `af dash stop` | Stop all agent farm processes |
| `af spawn` | Spawn a new builder |
| `af status` | Show status of all agents |
| `af cleanup` | Clean up a builder worktree |
| `af send` | Send instructions to a builder |
| `af open` | Open file annotation viewer |
| `af shell` | Spawn a utility shell |
| `af tower` | Cross-project dashboard |

See [agent-farm.md](agent-farm.md) for full documentation.

### consult - AI Consultation

| Subcommand | Description |
|------------|-------------|
| `consult pr <num>` | Review a pull request |
| `consult spec <num>` | Review a specification |
| `consult plan <num>` | Review an implementation plan |
| `consult general "<query>"` | General consultation |

See [consult.md](consult.md) for full documentation.

## Global Options

All codev commands support:

```bash
--version    Show version number
--help       Show help for any command
```

## Configuration

Agent Farm is configured via `af-config.json` at the project root. Created during `codev init` or `codev adopt`. Override via CLI flags: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`.

## Related Documentation

- [SPIR Protocol](../protocols/spir/protocol.md) - Multi-phase development workflow
- [TICK Protocol](../protocols/tick/protocol.md) - Fast amendment workflow
- [Architect Role](../roles/architect.md) - Architect responsibilities
- [Builder Role](../roles/builder.md) - Builder responsibilities
