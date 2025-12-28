# Codev: A Human-Agent Software Development Operating System

[![npm version](https://img.shields.io/npm/v/@cluesmith/codev.svg)](https://www.npmjs.com/package/@cluesmith/codev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

![Agent Farm Dashboard](docs/assets/agent-farm-hero.png)

Codev is an operating system for structured human-AI collaboration. You write specs and plans that AI agents execute reliably.

> **Results**: In head-to-head comparison, SPIDER scored 92-95 vs VIBE's 12-15 on the same task. [See case study](#-example-implementations)

**Quick Links**: [FAQ](docs/faq.md) | [Tips](docs/tips.md) | [Cheatsheet](codev/resources/cheatsheet.md) | [CLI Reference](codev/resources/commands/overview.md) | [Why Codev?](docs/why.md) | [Discord](https://discord.gg/mJ92DhDa6n)

## Table of Contents

- [Quick Start](#quick-start)
- [Learn About Codev](#learn-about-codev)
- [What is Codev?](#what-is-codev)
- [The SPIDER Protocol](#the-spider-protocol)
- [Agent Farm](#agent-farm-optional)
- [Example Implementations](#-example-implementations)
- [Quick Start & Prerequisites](#quick-start)
- [Contributing](#contributing)

## Quick Start

```bash
# 1. Install
npm install -g @cluesmith/codev

# 2. Initialize a project
mkdir my-project && cd my-project
codev init

# 3. Verify setup
codev doctor

# 4. Start the dashboard (optional)
af start
```

Then tell your AI agent: *"I want to build X using the SPIDER protocol"*

**CLI Commands:**
- `codev` - Main CLI (init, adopt, doctor, update)
- `af` - Agent Farm for parallel AI builders
- `consult` - Multi-model consultation

See [CLI Reference](codev/resources/commands/overview.md) for details.

### Prerequisites

**Core (required):**

| Dependency | Install | Purpose |
|------------|---------|---------|
| Node.js 18+ | `brew install node` | Runtime |
| git 2.5+ | (pre-installed) | Version control |
| AI CLIs | See below | All three recommended |

**AI CLIs** (install all three for multi-model consultation):
- Claude Code: `npm install -g @anthropic-ai/claude-code`
- Gemini CLI: [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- Codex CLI: `npm install -g @openai/codex`

**Agent Farm (optional):**

| Dependency | Install | Purpose |
|------------|---------|---------|
| tmux 3.0+ | `brew install tmux` | Terminal multiplexer |
| ttyd 1.7+ | `brew install ttyd` | Web terminal |
| gh | `brew install gh` | GitHub CLI |

See [DEPENDENCIES.md](codev-skeleton/DEPENDENCIES.md) for complete details. 

## Learn about Codev

### ❓ FAQ

Common questions about Codev: **[FAQ](docs/faq.md)**

### 💡 Tips & Tricks

Practical tips for getting the most out of Codev: **[Tips & Tricks](docs/tips.md)**

### 📋 Cheatsheet

Quick reference for Codev's philosophies, concepts, and tools: **[Cheatsheet](codev/resources/cheatsheet.md)**

### 📺 Quick Introduction (5 minutes)
[![Codev Introduction](https://img.youtube.com/vi/vq_dmfyMHRA/0.jpg)](https://youtu.be/vq_dmfyMHRA)

Watch a brief overview of what Codev is and how it works.

*Generated using [NotebookLM](https://notebooklm.google.com/notebook/e8055d06-869a-40e0-ab76-81ecbfebd634) - Visit the notebook to ask questions about Codev and learn more.*

### 💬 Participate

Join the conversation in [GitHub Discussions](https://github.com/ansari-project/codev/discussions) or our [Discord community](https://discord.gg/mJ92DhDa6n)! Share your specs, ask questions, and learn from the community.

**Get notified of new discussions**: Click the **Watch** button at the top of this repo → **Custom** → check **Discussions**.

### 📺 Extended Overview (Full Version)
[![Codev Extended Overview](https://img.youtube.com/vi/8KTHoh4Q6ww/0.jpg)](https://www.youtube.com/watch?v=8KTHoh4Q6ww)

A comprehensive walkthrough of the Codev methodology and its benefits.

### 🛠️ Agent Farm Demo: Building a Feature with AI
[![Agent Farm Demo](https://img.youtube.com/vi/0OEhdk7-plE/0.jpg)](https://www.youtube.com/watch?v=0OEhdk7-plE)

Watch a real development session using Agent Farm - from spec to merged PR in 30 minutes. Demonstrates the Architect-Builder pattern with multi-model consultation.

### 🎯 Codev Tour - Building a Conversational Todo Manager
See Codev in action! Follow along as we use the SPIDER protocol to build a conversational todo list manager from scratch:

👉 [**Codev Demo Tour**](https://github.com/ansari-project/codev-demo/blob/main/codev-tour.md)

This tour demonstrates:
- How to write specifications that capture all requirements
- How the planning phase breaks work into manageable chunks
- The IDE loop in action (Implement → Defend → Evaluate)
- Multi-agent consultation with GPT-5 and Gemini Pro
- How lessons learned improve future development

## What is Codev?

Codev is a development methodology that treats **natural language context as code**. Instead of writing code first and documenting later, you start with clear specifications that both humans and AI agents can understand and execute.

📖 **Read the full story**: [Why We Created Codev: From Theory to Practice](docs/why.md) - Learn about our journey from theory to implementation and how we built a todo app without directly editing code.

### Core Philosophy

1. **Context Drives Code** - Context definitions flow from high-level specifications down to implementation details
2. **Human-AI Collaboration** - Designed for seamless cooperation between developers and AI agents
3. **Evolving Methodology** - The process itself evolves and improves with each project

## The SP(IDE)R Protocol

Our flagship protocol for structured development:

- **S**pecify - Define what to build in clear, unambiguous language
- **P**lan - Break specifications into executable phases
- **For each phase:** **I**mplement → **D**efend → **E**valuate
  - **Implement**: Build the code to meet phase objectives
  - **Defend**: Write comprehensive tests that protect your code—not just validation, but defensive fortifications against bugs and regressions
  - **Evaluate**: Verify requirements are met, get user approval, then commit
- **R**eview - Capture lessons and improve the methodology

## Project Structure

After running `codev init` or `codev adopt`, your project has a **minimal structure**:

```
your-project/
├── codev/
│   ├── specs/              # Feature specifications
│   ├── plans/              # Implementation plans
│   ├── reviews/            # Review and lessons learned
│   └── projectlist.md      # Project tracking
├── AGENTS.md               # AI agent instructions (AGENTS.md standard)
├── CLAUDE.md               # AI agent instructions (Claude Code)
└── [your code]
```

### Customizable and Extendable

Codev is designed to be customized for your project's needs. The `codev/` directory is yours to extend:

- **Add project-specific protocols** - For example, Codev itself has a `release` protocol specific to npm publishing
- **Customize existing protocols** - Modify SPIDER phases to match your team's workflow
- **Add new roles** - Define specialized consultant or reviewer roles

The framework provides defaults, but your local files always take precedence.

### Context Hierarchy

In much the same way an operating system has a memory hierarchy, Codev repos have a context hierarchy. The codev/ directory holds the top 3 layers. This allows both humans and agents to think about problems at different levels of detail.

![Context Hierarchy](codev/resources/context-hierarchy.png)

**Key insight**: We build from the top down, and we propagate information from the bottom up. We start with an entry in the project list, then spec and plan out the feature, generate the code, and then propagate what we learned through the reviews.

## Key Features

### 📄 Natural Language is the Primary Programming Language
- Specifications and plans drive implementation
- All decisions captured in version control
- Clear traceability from idea to implementation

### 🤖 AI-Native Workflow
- Structured formats that AI agents understand
- Multi-agent consultation support (GPT-5, Gemini Pro, etc.)
- Reduces back-and-forth from dozens of messages to 3-4 document reviews
- Supports both AGENTS.md standard (Cursor, Copilot, etc.) and CLAUDE.md (Claude Code)

### 🔄 Continuous Improvement
- Every project improves the methodology
- Lessons learned feed back into the process
- Templates evolve based on real experience

## 📚 Example Implementations

Both projects below were given **the exact same prompt** to build a Todo Manager application using **Claude Code with Opus**. The difference? The methodology used:

### [Todo Manager - VIBE](https://github.com/ansari-project/todo-manager-vibe)
- Built using a **VIBE-style prompt** approach
- Shows rapid prototyping with conversational AI interaction
- Demonstrates how a simple prompt can drive development
- Results in working code through chat-based iteration

### [Todo Manager - SPIDER](https://github.com/ansari-project/codev-demo)
- Built using the **SPIDER protocol** with full document-driven development
- Same requirements, but structured through formal specifications and plans
- Demonstrates all phases: Specify → Plan → (IDE Loop) → Review
- Complete with specs, plans, and review documents
- Multi-agent consultation throughout the process

<details>
<summary><strong>📊 Automated Multi-Agent Analysis</strong> (click to expand)</summary>

**Note**: This comparison was generated through automated analysis by 3 independent AI agents (Claude, GPT-5, and Gemini Pro), not human review.

#### Quality Scores (out of 100)
| Aspect | VIBE | SPIDER |
|--------|------|--------|
| **Overall Score** | **12-15** | **92-95** |
| Functionality | 0 | 100 |
| Test Coverage | 0 | 85 |
| Documentation | 0 | 95 |
| Architecture | N/A | 90 |
| Production Readiness | 0 | 85 |

#### Key Differences

**VIBE**: 3 files (boilerplate only), 0% functionality, 0 tests, no database, no API

**SPIDER**: 32 source files, 100% functionality, 5 test suites, SQLite + Drizzle ORM, complete REST API, full component architecture, MCP integration, TypeScript + Zod validation

#### Why SPIDER Won

As GPT-5 noted: *"SPIDER's methodology clearly outperformed... Plan-first approach with defined scope, iterative verification, and delivery mindset"*

The verdict: **Context-driven development ensures completeness**, while conversational approaches can miss the mark entirely despite identical prompts and AI models.

</details>

## 🐕 Eating Our Own Dog Food

Codev is **self-hosted** - we use Codev methodology to build Codev itself. This means:

- **Our test infrastructure** is specified in `codev/specs/0001-test-infrastructure.md`
- **Our development process** follows the SP(IDE)R protocol we advocate
- **Our improvements** come from lessons learned using our own methodology

This self-hosting approach ensures:
1. The methodology is battle-tested on real development
2. We experience the same workflow we recommend to users
3. Any pain points are felt by us first and fixed quickly
4. The framework evolves based on actual usage, not theory

You can see this in practice:
- Check `codev/specs/` for our feature specifications
- Review `codev/plans/` for how we break down work
- Learn from `codev/reviews/` to see what we've discovered

### Understanding This Repository's Structure

This repository has a dual nature:

1. **`codev/`** - Our instance of Codev for developing Codev itself
   - Contains our specs, plans, reviews, and resources
   - Example: `codev/specs/0001-test-infrastructure.md` documents how we built our test suite

2. **`codev-skeleton/`** - The template that gets installed in other projects
   - Contains protocol definitions, templates, and agents
   - What users get when they install Codev
   - Does NOT contain specs/plans/reviews (those are created by users)

**In short**: `codev/` is how we use Codev, `codev-skeleton/` is what we provide to others.

<details>
<summary><strong>Test Infrastructure</strong> (click to expand)</summary>

Our comprehensive test suite (64 tests) validates the Codev installation process:

- **Framework**: Shell-based testing with bats-core (zero dependencies)
- **Coverage**: SPIDER protocol, CLAUDE.md preservation, agent installation
- **Isolation**: XDG sandboxing ensures tests never touch real user directories
- **CI/CD Ready**: Tests run in seconds with clear TAP output

```bash
./scripts/run-tests.sh      # Fast tests (< 30 seconds)
./scripts/run-all-tests.sh  # All tests including Claude CLI
./scripts/install-hooks.sh  # Install pre-commit hook
```

See `tests/README.md` for details.

</details>

## Examples

### Todo Manager Tutorial

See `examples/todo-manager/` for a complete walkthrough showing:
- How specifications capture all requirements
- How plans break work into phases
- How the IDE loop ensures quality
- How lessons improve future development

## Configuration

### Customizing Templates

Templates in `codev/protocols/spider/templates/` can be modified to fit your team's needs:

- `spec.md` - Specification structure
- `plan.md` - Planning format
- `lessons.md` - Retrospective template

## Agent Farm (Optional)

Agent Farm is an optional companion tool for Codev that provides a web-based dashboard for managing multiple AI agents working in parallel. **You can use Codev without Agent Farm** - all protocols (SPIDER, TICK, etc.) work perfectly in any AI coding assistant.

**Why use Agent Farm?**
- **Web dashboard** for monitoring multiple builders at once
- **Protocol-aware** - knows about specs, plans, and Codev conventions
- **Git worktree management** - isolates each builder's changes
- **Automatic prompting** - builders start with instructions to implement their assigned spec

**Current limitations:**
- Currently optimized for **Claude Code** (uses `-p` flag, `--append-system-prompt`, etc.)
- Requires **ttyd** and **tmux** for terminal embedding
- macOS-focused (should work on Linux but less tested)

## Architect-Builder Pattern

For parallel AI-assisted development, Codev includes the Architect-Builder pattern:

- **Architect** (you + primary AI): Creates specs and plans, reviews work
- **Builders** (autonomous AI agents): Implement specs in isolated git worktrees

### Quick Start

```bash
# Start the architect dashboard
af start

# Spawn a builder for a spec
af spawn --project 0003

# Check status
af status

# Stop everything
af stop
```

The `af` command is globally available after installing `@cluesmith/codev`.

### Remote Access

Access Agent Farm from another device (iPad, laptop, etc.) via SSH tunnel:

```bash
# Step 1: Start Agent Farm
af start

# Step 2: Get SSH command (shows your local IPs)
af tunnel

# Step 3: Run the SSH command on your remote device
# Example output: ssh -L 4200:localhost:4200 youruser@192.168.1.50

# Step 4: Open http://localhost:4200 in your remote browser
```

The dashboard and all terminals work identically via the tunnel. SSH handles authentication and encryption. (File tabs use separate ports and won't load through the tunnel.)

**Note**: Requires SSH server on the dev machine. On Windows, enable OpenSSH Server or use WSL2.

**Legacy mode** (not recommended):
```bash
# DEPRECATED: Exposes dashboard without authentication
af start --allow-insecure-remote
```

See [CLI Reference](codev/resources/commands/agent-farm.md#remote-access) for full details.

### Autonomous Builder Flags

Builders need permission-skipping flags to run autonomously without human approval prompts:

| CLI Tool | Flag | Purpose |
|----------|------|---------|
| Claude Code | `--dangerously-skip-permissions` | Skip permission prompts for file/command operations |
| Gemini CLI | `--yolo` | Enable autonomous mode without confirmations |

Configure in `codev/config.json`:
```json
{
  "shell": {
    "architect": "claude --dangerously-skip-permissions",
    "builder": "claude --dangerously-skip-permissions"
  }
}
```

Or for Gemini:
```json
{
  "shell": {
    "architect": "gemini --yolo",
    "builder": "gemini --yolo"
  }
}
```

**Warning**: These flags allow the AI to execute commands and modify files without asking. Only use in development environments where you trust the AI's actions.

See [INSTALL.md](INSTALL.md#architect-builder-pattern-optional) for full documentation.

## Releases

Codev has a **release protocol** (`codev/protocols/release/`) that automates the entire release process. To release a new version:

```
Let's release v1.4.0
```

The AI guides you through: pre-flight checks, maintenance cycle, E2E tests, version bump, release notes, GitHub release, and npm publish.

Releases are named after great examples of architecture from around the world. See [Release Notes](docs/releases/) for version history.

## Contributing

We welcome contributions of any kind! Talk to us on [Discord](https://discord.gg/mJ92DhDa6n) or [open an issue](https://github.com/ansari-project/codev/issues).

We especially welcome contributions to **Agent Farm** - help us make it work with more AI CLIs and platforms.

## License

MIT - See LICENSE file for details

---

*Built with Codev - where context drives code*
