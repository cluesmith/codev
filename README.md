# Codev: Context-First Development

A development methodology that treats natural language context as code. Instead of writing code first and documenting later, you start with clear specifications that both humans and AI agents can understand and execute.

## Installation

Install Codev globally via npm:

```bash
npm install -g @cluesmith/codev
```

This provides three CLI commands:
- `codev` - Main CLI (init, adopt, doctor, update, tower)
- `af` - Agent-farm CLI for parallel development
- `consult` - Multi-agent consultation tool

See the **[CLI Command Reference](codev/docs/commands/overview.md)** for complete documentation.

### Initialize a New Project

```bash
mkdir my-project && cd my-project
codev init
```

### Adopt Codev in an Existing Project

```bash
cd existing-project
codev adopt
```

### Verify Installation

```bash
codev doctor
```

This checks all dependencies and provides installation instructions for anything missing.

## Prerequisites

Codev requires several dependencies. See **[DEPENDENCIES.md](codev-skeleton/DEPENDENCIES.md)** for complete installation instructions.

**Quick summary:**

| Dependency | Min Version | macOS | Purpose |
|------------|-------------|-------|---------|
| Node.js | 18.0 | `brew install node` | Runtime |
| tmux | 3.0 | `brew install tmux` | Terminal multiplexer |
| ttyd | 1.7 | `brew install ttyd` | Web terminal |
| git | 2.5 | (pre-installed) | Worktrees |
| gh | latest | `brew install gh` | GitHub CLI |
| AI CLI | - | See below | At least one required |

**AI CLI Options** (install at least one):
- Claude Code: `npm install -g @anthropic-ai/claude-code`
- Gemini CLI: [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- Codex CLI: `npm install -g @openai/codex`

## Get Started

Once installed, tell your AI agent:
```
I want to build X using the SPIDER protocol
```

Or ask to learn more about Codev. 

## Learn about Codev

### 📺 Quick Introduction (5 minutes)
[![Codev Introduction](https://img.youtube.com/vi/vq_dmfyMHRA/0.jpg)](https://youtu.be/vq_dmfyMHRA)

Watch a brief overview of what Codev is and how it works.

*Generated using [NotebookLM](https://notebooklm.google.com/notebook/e8055d06-869a-40e0-ab76-81ecbfebd634) - Visit the notebook to ask questions about Codev and learn more.*

### 💬 Participate

Join the conversation in [GitHub Discussions](https://github.com/ansari-project/codev/discussions)! Share your specs, ask questions, and learn from the community.

**Get notified of new discussions**: Click the **Watch** button at the top of this repo → **Custom** → check **Discussions**.

### 📺 Extended Overview (Full Version)
[![Codev Extended Overview](https://img.youtube.com/vi/8KTHoh4Q6ww/0.jpg)](https://www.youtube.com/watch?v=8KTHoh4Q6ww)

A comprehensive walkthrough of the Codev methodology and its benefits.

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

**Framework files are provided at runtime** by the `@cluesmith/codev` package. This includes:
- Protocols (SPIDER, TICK, EXPERIMENT, MAINTAIN)
- Roles (architect, builder, consultant)
- Templates and agents

### Customizing Framework Files

If you need to customize any framework file, create it in your local `codev/` directory. **Local files always take precedence** over the embedded skeleton:

```bash
# Example: Customize the SPIDER protocol
mkdir -p codev/protocols/spider
cp $(npm root -g)/@cluesmith/codev/skeleton/protocols/spider/protocol.md codev/protocols/spider/

# Example: Customize a role
mkdir -p codev/roles
cp $(npm root -g)/@cluesmith/codev/skeleton/roles/consultant.md codev/roles/
```

This approach keeps your project clean while allowing full customization when needed.

## Key Features

### 📄 Documents Are First-Class Citizens
- Specifications, plans, and lessons all tracked
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

### 📊 Automated Multi-Agent Analysis

**Note**: This comparison was generated through automated analysis by 3 independent AI agents (Claude, GPT-5, and Gemini Pro), not human review. The findings below represent their consensus assessment:

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

**VIBE Implementation:**
- ❌ **3 files total** - Just Next.js boilerplate
- ❌ **0% functionality** - No todo features implemented
- ❌ **0 tests** - No validation or quality assurance
- ❌ **No database** - No data persistence
- ❌ **No API routes** - No backend functionality
- ❌ **No components** - Just default Next.js template

**SPIDER Implementation:**
- ✅ **32 source files** - Complete application structure
- ✅ **100% functionality** - Full CRUD operations
- ✅ **5 test suites** - API, components, database, MCP coverage
- ✅ **SQLite + Drizzle ORM** - Proper data persistence
- ✅ **Complete API** - RESTful endpoints for all operations
- ✅ **Component architecture** - TodoForm, TodoList, TodoItem, ConversationalInterface
- ✅ **MCP integration** - AI-ready with server wrapper
- ✅ **Type safety** - TypeScript + Zod validation
- ✅ **Error handling** - Boundaries and optimistic updates
- ✅ **Documentation** - Specs, plans, and lessons learned

#### Why SPIDER Won

As GPT-5 noted: *"SPIDER's methodology clearly outperformed... Plan-first approach with defined scope, iterative verification, and delivery mindset"*

Gemini Pro explained: *"SPIDER correctly inferred the user's intent... It saves hours, if not days, of setup... It builds code the way a professional team would"*

The verdict from all 3 agents: **Context-driven development ensures completeness**, while conversational approaches can miss the mark entirely despite identical prompts and AI models.

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

### Test Infrastructure

Our comprehensive test suite (64 tests) validates the Codev installation process:

- **Framework**: Shell-based testing with bats-core (zero dependencies)
- **Coverage**: SPIDER protocol, CLAUDE.md preservation, agent installation
- **Isolation**: XDG sandboxing ensures tests never touch real user directories
- **CI/CD Ready**: Tests run in seconds with clear TAP output
- **Multi-Platform**: Works on macOS and Linux without modification
- **Pre-commit Hook**: Automatically runs tests before commits

Run tests locally:
```bash
# Fast tests (< 30 seconds)
./scripts/run-tests.sh

# All tests including Claude CLI integration
./scripts/run-all-tests.sh
```

Install pre-commit hook for development:
```bash
# Install git hooks (runs tests before each commit)
./scripts/install-hooks.sh
```

See `tests/README.md` for detailed test documentation.

## Installation

Ask your AI agent to:
```
Install Codev by following the instructions at https://github.com/ansari-project/codev/blob/main/INSTALL.md
```

The agent will:
1. Create the codev/ directory structure
2. Install the SPIDER protocol
3. Set up or update your CLAUDE.md file

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

## AI Agents

Codev includes three specialized AI agents to enhance your development workflow (requires Claude Code with the Task tool):

### 🔄 Codev-Updater Agent

Keep your Codev installation up-to-date with the latest protocols and improvements:

```bash
# Update your Codev framework
"Please update my codev framework to the latest version"
```

The agent will:
1. Check for updates to protocols (SPIDER, TICK, etc.)
2. Update agents and templates
3. **Preserve your specs, plans, and reviews**
4. Create backups before updating
5. Provide rollback instructions

### 🏗️ Architecture-Documenter Agent

Automatically maintains comprehensive architecture documentation:

```bash
# Invoked automatically at the end of TICK protocol reviews
# Or manually: "Update the architecture documentation"
```

The agent maintains `codev/resources/arch.md` with:
- Complete directory structure
- All utility functions and helpers
- Key architectural patterns
- Component relationships
- Technology stack details

### 🕷️ Spider-Protocol-Updater Agent

Learn from SPIDER implementations across the community:

```bash
# Check a repository for SPIDER improvements
"Check [repository-url] for SPIDER improvements"
```

The agent will:
1. Analyze the repository's SPIDER implementation
2. Compare against current protocol
3. Identify improvements and lessons learned
4. Suggest protocol updates with justification

Example repositories to monitor:
- `ansari-project/todo-manager-spider` - SPIDER implementation with lessons
- Your own SPIDER projects with discovered patterns

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

Support for other AI CLIs (Gemini CLI, Codex CLI) is planned for future releases.

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

## Contributing

We welcome contributions! Please help us improve Codev:

### Filing Issues
- **Bug Reports**: [Open an issue](https://github.com/ansari-project/codev/issues) with clear reproduction steps
- **Feature Requests**: Share your ideas for new features or improvements
- **Documentation**: Report unclear or missing documentation
- **Questions**: Ask for clarification or help with implementation

### Contributing Code
- New protocols beyond SP(IDE)R
- Improved templates
- Integration tools
- Case studies
- SPIDER protocol improvements from your implementations

## License

MIT - See LICENSE file for details

---

*Built with Codev - where context drives code*
