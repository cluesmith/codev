# Codev Architecture Documentation

## Overview

Codev is a context-driven development methodology framework that treats natural language specifications as first-class code. This repository serves a dual purpose: it is both the canonical source of the Codev framework AND a self-hosted instance where Codev uses its own methodology to develop itself.

## Technology Stack

### Core Technologies
- **TypeScript/Node.js**: Primary language for agent-farm orchestration CLI
- **Shell/Bash**: Thin wrappers and installation scripting
- **Markdown**: Documentation format for specs, plans, reviews, and agent definitions
- **Git**: Version control with worktree support for isolated builder environments
- **YAML**: Configuration format for protocol manifests
- **JSON**: Configuration format for agent-farm (`config.json`) and state management

### Agent-Farm CLI (TypeScript)
- **commander.js**: CLI argument parsing and command structure
- **better-sqlite3**: SQLite database for atomic state management (WAL mode)
- **tree-kill**: Process cleanup and termination
- **tmux**: Session persistence for builder terminals
- **ttyd**: Web-based terminal interface

### Testing Framework
- **bats-core**: Bash Automated Testing System (vendored in `tests/lib/`)
- **bats-support**: Helper functions for bats tests
- **bats-assert**: Assertion helpers for test validation
- **bats-file**: File system assertion helpers
- **Vitest**: TypeScript unit testing for packages/codev

### External Tools (Required)
- **git**: Version control with worktree support for isolated builder environments
- **gh**: GitHub CLI for PR creation and management
- **At least one AI CLI**:
  - **claude** (Claude Code): Primary builder CLI
  - **gemini** (Gemini CLI): Consultation and review
  - **codex** (Codex CLI): Consultation and review

### Supported Platforms
- macOS (Darwin)
- Linux (GNU/Linux)
- Requires: Node.js 18+, Bash 4.0+, Git 2.5+ (worktree support), standard Unix utilities
- Optional: tmux (session persistence), ttyd (web terminals)

## Repository Dual Nature

This repository has a unique dual structure:

### 1. `codev/` - Our Instance (Self-Hosted Development)
This is where the Codev project uses Codev to develop itself:
- **Purpose**: Development of Codev features using Codev methodology
- **Contains**:
  - `specs/` - Feature specifications for Codev itself
  - `plans/` - Implementation plans for Codev features
  - `reviews/` - Lessons learned from Codev development
  - `resources/` - Reference materials (this file, llms.txt, etc.)
  - `protocols/` - Working copies of protocols for development
  - `agents/` - Agent definitions (canonical location)
  - `roles/` - Role definitions for architect-builder pattern
  - `templates/` - HTML templates for Agent Farm (`af`) dashboard and annotation viewer
  - `config.json` - Shell command configuration for agent-farm
  - `bin/agent-farm` - Thin wrapper script to invoke TypeScript CLI

**Example**: `codev/specs/0001-test-infrastructure.md` documents the test infrastructure feature we built for Codev.

### 2. `codev-skeleton/` - Template for Other Projects
This is what gets distributed to users when they install Codev:
- **Purpose**: Clean template for new Codev installations
- **Contains**:
  - `protocols/` - Protocol definitions (SPIDER, TICK, EXPERIMENT, MAINTAIN)
  - `specs/` - Empty directory (users create their own)
  - `plans/` - Empty directory (users create their own)
  - `reviews/` - Empty directory (users create their own)
  - `resources/` - Empty directory (users add their own)
  - `agents/` - Agent definitions (copied during installation)
  - `roles/` - Role definitions for architect and builder
  - `templates/` - HTML templates for Agent Farm (`af`) dashboard UI
  - `config.json` - Default shell command configuration
  - `bin/agent-farm` - Thin wrapper script

**Key Distinction**: `codev-skeleton/` provides templates for other projects to use when they install Codev. Our own `codev/` directory has nearly identical structure but contains our actual specs, plans, and reviews. The skeleton's empty placeholder directories become populated with real content in each project that adopts Codev.

### 3. `packages/codev/` - The npm Package
This is the `@cluesmith/codev` npm package containing all CLI tools:
- **Purpose**: Published npm package with codev, af, and consult CLIs
- **Contains**:
  - `src/` - TypeScript source code
  - `src/agent-farm/` - Agent Farm orchestration (af command)
  - `src/commands/` - codev subcommands (init, adopt, doctor, update, eject, tower)
  - `src/commands/consult/` - Multi-agent consultation (consult command)
  - `bin/` - CLI entry points (codev.js, af.js, consult.js)
  - `skeleton/` - Embedded copy of codev-skeleton (built during `npm run build`)
  - `templates/` - HTML templates for Agent Farm (`af`) dashboard and annotator
  - `dist/` - Compiled JavaScript

**Key Distinction**: packages/codev is the published npm package; codev-skeleton/ is the template embedded within it.

**Note on skeleton/**: During `npm run build`, the codev-skeleton/ directory is copied into packages/codev/skeleton/. This embedded skeleton is what gets installed when users run `codev init`. Local files in a user's codev/ directory take precedence over the embedded skeleton.

## Complete Directory Structure

```
codev/                                  # Project root (git repository)
├── packages/codev/                     # @cluesmith/codev npm package
│   ├── src/                            # TypeScript source code
│   │   ├── cli.ts                      # Main CLI entry point
│   │   ├── commands/                   # codev subcommands
│   │   │   ├── init.ts                 # codev init
│   │   │   ├── adopt.ts                # codev adopt
│   │   │   ├── doctor.ts               # codev doctor
│   │   │   ├── update.ts               # codev update
│   │   │   ├── eject.ts                # codev eject
│   │   │   ├── tower.ts                # codev tower
│   │   │   └── consult/                # consult command
│   │   │       └── index.ts            # Multi-agent consultation
│   │   ├── agent-farm/                 # af subcommands
│   │   │   ├── cli.ts                  # af CLI entry point
│   │   │   ├── index.ts                # Core orchestration
│   │   │   ├── state.ts                # SQLite state management
│   │   │   ├── types.ts                # Type definitions
│   │   │   ├── commands/               # af CLI commands
│   │   │   │   ├── start.ts            # Start architect dashboard
│   │   │   │   ├── stop.ts             # Stop all processes
│   │   │   │   ├── spawn.ts            # Spawn builder
│   │   │   │   ├── status.ts           # Show status
│   │   │   │   ├── cleanup.ts          # Clean up builder
│   │   │   │   ├── util.ts             # Utility shell
│   │   │   │   ├── open.ts             # File annotation viewer
│   │   │   │   ├── send.ts             # Send message to builder
│   │   │   │   └── rename.ts           # Rename builder/util
│   │   │   ├── servers/                # Web servers
│   │   │   │   ├── dashboard-server.ts # Dashboard HTTP server
│   │   │   │   ├── tower-server.ts     # Multi-project overview
│   │   │   │   └── open-server.ts      # File annotation viewer
│   │   │   ├── db/                     # SQLite database layer
│   │   │   │   ├── index.ts            # Database operations
│   │   │   │   ├── schema.ts           # Table definitions
│   │   │   │   └── migrate.ts          # JSON → SQLite migration
│   │   │   └── __tests__/              # Vitest unit tests
│   │   └── lib/                        # Shared library code
│   │       ├── templates.ts            # Template file handling
│   │       └── projectlist-parser.ts   # Parse projectlist.md
│   ├── bin/                            # CLI entry points
│   │   ├── codev.js                    # codev command
│   │   ├── af.js                       # af command
│   │   └── consult.js                  # consult command
│   ├── skeleton/                       # Embedded codev-skeleton (built)
│   ├── templates/                      # HTML templates
│   │   ├── dashboard.html              # Split-pane dashboard
│   │   └── annotate.html               # File annotation viewer
│   ├── dist/                           # Compiled JavaScript
│   ├── package.json                    # npm package config
│   └── tsconfig.json                   # TypeScript configuration
├── codev/                              # Our self-hosted instance
│   ├── bin/                            # CLI wrapper scripts
│   │   └── agent-farm                  # Thin wrapper → node agent-farm/dist/index.js
│   ├── config.json                     # Shell command configuration
│   ├── roles/                          # Role definitions
│   │   ├── architect.md                # Architect role and commands
│   │   └── builder.md                  # Builder role and status lifecycle
│   ├── templates/                      # HTML templates
│   │   ├── dashboard.html              # Basic dashboard
│   │   ├── dashboard-split.html        # Split-pane tabbed dashboard
│   │   └── annotate.html               # File annotation viewer
│   ├── protocols/                      # Working copies for development
│   │   ├── spider/                     # Multi-phase with consultation
│   │   │   ├── protocol.md
│   │   │   ├── templates/
│   │   │   └── manifest.yaml
│   │   ├── tick/                       # Fast autonomous protocol
│   │   ├── experiment/                 # Disciplined experimentation
│   │   └── maintain/                   # Codebase maintenance
│   ├── specs/                          # Our feature specifications
│   ├── plans/                          # Our implementation plans
│   ├── reviews/                        # Our lessons learned
│   ├── resources/                      # Reference materials
│   │   ├── arch.md                     # This file
│   │   └── llms.txt                    # LLM-friendly documentation
│   ├── agents/                         # Agent definitions (canonical)
│   │   ├── spider-protocol-updater.md
│   │   ├── architecture-documenter.md
│   │   └── codev-updater.md
│   └── projectlist.md                  # Master project tracking
├── codev-skeleton/                     # Template for distribution
│   ├── bin/                            # CLI wrapper
│   │   └── agent-farm                  # Thin wrapper script
│   ├── config.json                     # Default configuration
│   ├── roles/                          # Role definitions
│   │   ├── architect.md
│   │   └── builder.md
│   ├── templates/                      # HTML templates
│   │   ├── dashboard.html
│   │   ├── dashboard-split.html
│   │   └── annotate.html
│   ├── protocols/                      # Protocol definitions
│   │   ├── spider/
│   │   ├── tick/
│   │   ├── experiment/
│   │   └── maintain/
│   ├── specs/                          # Empty (placeholder)
│   ├── plans/                          # Empty (placeholder)
│   ├── reviews/                        # Empty (placeholder)
│   ├── resources/                      # Empty (placeholder)
│   ├── agents/                         # Agent templates
│   └── projectlist.md                  # Template project list
├── .agent-farm/                        # Project-scoped state (gitignored)
│   └── state.db                        # SQLite database for architect/builder/util status
├── ~/.agent-farm/                      # Global registry (user home)
│   └── global.db                       # SQLite database for cross-project port allocations
├── .claude/                            # Claude Code-specific directory
│   └── agents/                         # Agents for Claude Code
├── tests/                              # Test infrastructure
│   ├── lib/                            # Vendored bats frameworks
│   ├── helpers/                        # Test utilities
│   ├── fixtures/                       # Test data
│   └── *.bats                          # Test files
├── scripts/                            # Utility scripts
│   ├── run-tests.sh                    # Fast tests
│   ├── run-integration-tests.sh        # All tests
│   └── install-hooks.sh                # Install git hooks
├── hooks/                              # Git hook templates
│   └── pre-commit                      # Pre-commit hook
├── examples/                           # Example projects
├── docs/                               # Additional documentation
├── AGENTS.md                           # Universal AI agent instructions
├── CLAUDE.md                           # Claude Code-specific
├── INSTALL.md                          # Installation instructions
├── README.md                           # Project overview
└── LICENSE                             # MIT license
```

## Core Components

### 1. Development Protocols

#### SPIDER Protocol (`codev/protocols/spider/`)
**Purpose**: Multi-phase development with multi-agent consultation

**Phases**:
1. **Specify** - Define requirements with multi-agent review
2. **Plan** - Break work into phases with multi-agent review
3. **IDE Loop** (per phase):
   - **Implement** - Build the code
   - **Defend** - Write comprehensive tests
   - **Evaluate** - Verify requirements and get approval
4. **Review** - Document lessons learned with multi-agent consultation

**Key Features**:
- Multi-agent consultation at each major checkpoint
- Default models: Gemini 3 Pro + GPT-5
- Multiple user approval points
- Comprehensive documentation requirements
- Suitable for complex features (>300 lines)

**Files**:
- `protocol.md` - Complete protocol specification
- `templates/spec.md` - Specification template
- `templates/plan.md` - Planning template
- `templates/review.md` - Review template

#### TICK Protocol (`codev/protocols/tick/`)
**Purpose**: **T**ask **I**dentification, **C**oding, **K**ickout - Fast autonomous implementation

**Workflow**:
1. **Specification** (autonomous) - Define task
2. **Planning** (autonomous) - Create single-phase plan
3. **Implementation** (autonomous) - Execute plan
4. **Review** (with multi-agent consultation) - Document and validate

**Key Features**:
- Single autonomous execution from spec to implementation
- Multi-agent consultation ONLY at review phase
- Two user checkpoints: start and end
- Suitable for simple tasks (<300 lines)
- Architecture documentation updated automatically at review

**Selection Criteria**:
- Use TICK for: Bug fixes, simple features, utilities, configuration
- Use SPIDER for: Complex features, architecture changes, unclear requirements

### 2. Agent System

Codev includes specialized AI agents for workflow automation. Agents are installed conditionally based on the development environment:

#### Agent Installation Architecture

Codev uses **tool-agnostic agent installation** that detects the development environment and installs agents to the appropriate location for optimal integration.

**Conditional Installation Logic** (from `INSTALL.md`):
```bash
# Detect Claude Code and install to appropriate location
if command -v claude &> /dev/null; then
    # Claude Code detected - install to .claude/agents/
    mkdir -p .claude/agents
    cp -r codev-skeleton/agents/* ./.claude/agents/
    echo "✓ Agents installed to .claude/agents/ (Claude Code detected)"
else
    # Other tools - agents remain in codev/agents/
    # (already present from skeleton copy)
    echo "✓ Agents installed to codev/agents/ (universal location)"
fi
```

**Agent Locations by Environment**:
- **Claude Code users**: `.claude/agents/` (native integration via Claude Code's agent system)
- **Other tools** (Cursor, Copilot, etc.): `codev/agents/` (universal location via AGENTS.md standard)
- **Canonical source**: `codev/agents/` in this repository (self-hosted development)

**Design Rationale**:
1. **Native integration when available** - Claude Code's `.claude/agents/` provides built-in agent execution
2. **Universal fallback** - Other tools can reference `codev/agents/` via AGENTS.md standard
3. **Single source of truth** - All agents originate from `codev/agents/` in the main repository
4. **No tool lock-in** - Works with any AI coding assistant that supports AGENTS.md standard

#### Available Agents

##### spider-protocol-updater
**Purpose**: Protocol evolution through community learning

**Capabilities**:
- Analyzes SPIDER implementations in other repositories
- Compares remote implementations with canonical protocol
- Reviews lessons learned across projects
- Classifies improvements (Universal, Domain-specific, Experimental, Anti-pattern)
- Recommends protocol updates with justification

**Location**: `codev/agents/spider-protocol-updater.md`

**Usage**:
```
"Check the ansari-project/webapp repo for SPIDER improvements"
"Scan recent SPIDER implementations for protocol enhancements"
```

##### architecture-documenter
**Purpose**: Maintain comprehensive architecture documentation

**Capabilities**:
- Reviews specs, plans, and reviews for architectural information
- Scans implementation to verify documented structure matches reality
- Maintains `codev/resources/arch.md` (this file)
- Documents directory structure, utilities, patterns, and components
- Automatically invoked at end of TICK protocol reviews

**Location**: `codev/agents/architecture-documenter.md`

**Usage**:
- Automatically triggered by TICK protocol
- Manually: "Update the architecture documentation"

**What it maintains**:
- Complete directory structure
- All utility functions and helpers
- Key architectural patterns
- Component relationships
- Technology stack details

##### codev-updater
**Purpose**: Framework updates with safety and preservation

**Capabilities**:
- Checks for updates to protocols, agents, and templates
- Creates timestamped backups before updating
- Updates framework components from main repository
- Preserves user specs, plans, reviews (never modified)
- Provides rollback instructions

**Location**: `codev/agents/codev-updater.md`

**Usage**:
```
"Please update my codev framework to the latest version"
"Are there any updates available for codev?"
```

**Safety Features**:
- Backups created before any changes
- User work never modified
- CLAUDE.md customizations preserved
- Clear rollback procedures
- Verification before completion

### 3. Agent-Farm CLI (Orchestration Engine)

**Location**: `agent-farm/`

**Purpose**: TypeScript-based multi-agent orchestration for the architect-builder pattern

**Architecture**:
- **Single canonical implementation** - All bash scripts deleted, TypeScript is the source of truth
- **Thin wrapper invocation** - `af` command from npm package (installed globally)
- **Project-scoped state** - `.agent-farm/state.db` (SQLite) tracks current session
- **Global port registry** - `~/.agent-farm/global.db` (SQLite) prevents cross-project port conflicts

#### CLI Commands

```bash
# af command is installed globally via: npm install -g @cluesmith/codev

# Starting/stopping
af start                      # Start architect dashboard
af stop                       # Stop all agent-farm processes

# Managing builders
af spawn --project 0003       # Spawn a builder for spec 0003
af spawn -p 0003              # Short form
af status                     # Check all agent status
af cleanup --project 0003     # Clean up builder (checks for uncommitted work)
af cleanup -p 0003 --force    # Force cleanup (lose uncommitted work)

# Utilities
af util                       # Open a utility shell terminal
af shell                      # Alias for util
af open src/file.ts           # Open file annotation viewer

# Port management (multi-project support)
af ports list                 # List port allocations
af ports cleanup              # Remove stale allocations

# Command overrides
af start --architect-cmd "claude --model opus"
af spawn -p 0003 --builder-cmd "claude --model sonnet"
```

#### Configuration (`codev/config.json`)

```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": ["claude", "--model", "sonnet"],
    "shell": "bash"
  },
  "templates": {
    "dir": "codev/templates"
  },
  "roles": {
    "dir": "codev/roles"
  }
}
```

**Configuration Hierarchy**: CLI args > config.json > Defaults

**Features**:
- Commands can be strings OR arrays (arrays avoid shell-escaping issues)
- Environment variables expanded at runtime (`${VAR}` and `$VAR` syntax)
- CLI overrides: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`
- Early validation: on startup, verify commands exist and directories resolve

#### Global Port Registry (`~/.agent-farm/global.db`)

**Purpose**: Prevent port conflicts when running multiple architects across different repos

**Port Block Allocation**:
- First repo gets port block 4200-4299
- Second repo gets 4300-4399
- Each block provides 100 ports per project:
  - Dashboard: base+0 (e.g., 4200)
  - Architect: base+1 (e.g., 4201)
  - Builders: base+10 to base+29 (20 slots)
  - Utilities: base+30 to base+49 (20 slots)
  - Annotations: base+50 to base+69 (20 slots)

**Registry Structure**:
```json
{
  "version": 1,
  "entries": {
    "/Users/me/project-a": {
      "basePort": 4200,
      "registered": "2024-12-02T...",
      "lastUsed": "2024-12-03T...",
      "pid": 12345
    }
  }
}
```

**Safety Features**:
- File locking with stale lock detection (30-second timeout)
- Schema versioning for future compatibility
- PID tracking for process ownership
- Automatic cleanup of stale entries (deleted projects)

#### Role Files

**Location**: `codev/roles/`

**architect.md** - Comprehensive architect role:
- Responsibilities: decompose work, spawn builders, monitor progress, review and integrate
- Execution strategy: Modified SPIDER with delegation
- Communication patterns with builders
- Full `af` command reference

**builder.md** - Builder role with status lifecycle:
- Status definitions: spawning, implementing, blocked, pr-ready, complete
- Working in isolated git worktrees
- When and how to report blocked status
- Deliverables and constraints

#### Thin Wrapper Script

**Location**: `codev/bin/agent-farm`

```bash
#!/bin/bash
# Thin wrapper - forwards all commands to agent-farm TypeScript
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
exec node "$PROJECT_ROOT/agent-farm/dist/index.js" "$@"
```

**Features**:
- Symlink-safe (uses `readlink -f` with fallbacks)
- Portable across macOS and Linux
- No npm distribution required

### 4. Test Infrastructure

**Location**: `tests/`

**Framework**: bats-core (Bash Automated Testing System)

**Architecture**:
- **Zero external dependencies** - All frameworks vendored locally
- **Platform portable** - Works on macOS and Linux without changes
- **XDG sandboxing** - Tests never touch real user directories
- **Graceful degradation** - Skips tests when dependencies unavailable

#### Test Organization

**Framework Tests (00-09)**:
- Core framework validation
- Runner behavior verification
- Helper function tests

**Protocol Tests (10-19)**:
- SPIDER protocol installation
- CLAUDE.md preservation and updates
- Directory structure validation
- Protocol content verification

**Integration Tests (20+)**:
- Claude CLI execution with isolation flags
- Real agent invocation tests
- Codev updater validation

**Total Coverage**: 64 tests, ~2000 lines of test code

#### Test Helpers (`tests/helpers/`)

##### common.bash
**Purpose**: Shared test utilities and assertions

**Key Functions**:
- `setup_test_project()` - Creates isolated temporary test directory
- `teardown_test_project()` - Cleans up test artifacts (guaranteed via trap)
- `install_from_local()` - Installs Codev from local skeleton
- `create_claude_md()` - Creates CLAUDE.md with specified content
- `assert_codev_structure()` - Validates directory structure
- `assert_spider_protocol()` - Validates SPIDER protocol files
- `file_contains()` - Checks file for literal string match

**Agent Installation Logic**:
```bash
# Mimics INSTALL.md conditional agent installation
# This test helper replicates production behavior
if command -v claude &> /dev/null; then
    # Claude Code present - install agents to .claude/agents/
    mkdir -p "$target_dir/.claude/agents"
    cp "$source_dir/agents/"*.md "$target_dir/.claude/agents/" 2>/dev/null || true
fi
# Note: For non-Claude Code environments, agents remain in codev/agents/
# from the skeleton copy (universal location for AGENTS.md-compatible tools)
```

**Implementation Details**:
- Detects Claude Code via `command -v claude` check
- Installs agents conditionally based on detection result
- Handles both Claude Code and non-Claude Code environments gracefully
- Never overwrites existing agent files (2>/dev/null || true pattern)

##### mock_mcp.bash
**Purpose**: Test isolation utilities for PATH manipulation

**Key Functions**:
- `mock_mcp_present()` - Simulates MCP command availability
- `mock_mcp_absent()` - Simulates MCP command unavailability
- `remove_mcp_from_path()` - Removes MCP from PATH
- `restore_path()` - Restores original PATH

**Strategy**: Uses failing shims instead of PATH removal for realistic testing

#### Test Execution

**Fast Tests** (excludes integration):
```bash
./scripts/run-tests.sh
```
- Runs in <30 seconds
- No Claude CLI required
- Core functionality validation

**All Tests** (includes integration):
```bash
./scripts/run-all-tests.sh
```
- Includes Claude CLI tests
- Requires `claude` command
- Full end-to-end validation

#### Test Isolation Strategy

**XDG Sandboxing** (prevents touching real user config):
```bash
export XDG_CONFIG_HOME="$TEST_PROJECT/.xdg"
export XDG_DATA_HOME="$TEST_PROJECT/.local/share"
export XDG_CACHE_HOME="$TEST_PROJECT/.cache"
```

**Claude CLI Isolation**:
```bash
claude --strict-mcp-config --mcp-config '[]' --settings '{}'
```
- `--strict-mcp-config` - Enforces strict MCP configuration
- `--mcp-config '[]'` - No MCP servers
- `--settings '{}'` - No user preferences

**Temporary Directories**:
- Each test gets isolated `mktemp -d` directory
- Cleanup guaranteed via `teardown()` trap
- No persistence between tests

## Installation Architecture

**Entry Point**: `INSTALL.md` - Instructions for AI agents to install Codev

**Installation Flow**:
1. **Prerequisite Check**: Verify consult CLI availability
2. **Directory Creation**: Create `codev/` structure in target project
4. **Skeleton Copy**: Copy protocol definitions, templates, and agents
5. **Conditional Agent Installation**:
   - Detect if Claude Code is available (`command -v claude`)
   - If yes: Install agents to `.claude/agents/`
   - If no: Agents remain in `codev/agents/` (universal location)
6. **AGENTS.md/CLAUDE.md Creation/Update**:
   - Check if files exist
   - Append Codev sections to existing files
   - Create new files if needed (both AGENTS.md and CLAUDE.md)
   - Both files contain identical content
7. **Verification**: Validate installation completeness

**Key Principles**:
- All Codev files go INSIDE `codev/` directory (not project root)
- Agents installed conditionally based on tool detection
- AGENTS.md follows [AGENTS.md standard](https://agents.md/) for cross-tool compatibility
- CLAUDE.md provides native Claude Code support (identical content)
- Uses local skeleton (no network dependency)
- Preserves existing CLAUDE.md content

## Data Flow

### Specification → Plan → Implementation → Review

**Document Flow**:
1. **Specification** (`codev/specs/####-feature.md`)
   - Defines WHAT to build
   - Created by developer or AI agent
   - Multi-agent reviewed (SPIDER with consultation)
   - Committed before planning

2. **Plan** (`codev/plans/####-feature.md`)
   - Defines HOW to build
   - Breaks specification into phases (SPIDER) or single phase (TICK)
   - Lists files to create/modify
   - Multi-agent reviewed (SPIDER with consultation)
   - Committed before implementation

3. **Implementation** (actual code in project)
   - Follows plan phases
   - Each phase: Implement → Defend (tests) → Evaluate
   - Committed per phase (SPIDER) or single commit (TICK)
   - Multi-agent consultation at checkpoints (SPIDER) or review only (TICK)

4. **Review** (`codev/reviews/####-feature.md`)
   - Documents lessons learned
   - Identifies systematic issues
   - Updates protocol if needed
   - Multi-agent reviewed (both SPIDER and TICK)
   - Triggers architecture documentation update (TICK)
   - Final commit in feature workflow

**File Naming Convention**:
```
codev/specs/####-descriptive-name.md
codev/plans/####-descriptive-name.md
codev/reviews/####-descriptive-name.md
```
- Sequential numbering shared across all protocols
- Same identifier for spec, plan, review

## Git Commit Strategy

### SPIDER Protocol
**Commits per Feature**:
1. `[Spec ####] Initial specification draft`
2. `[Spec ####] Specification with multi-agent review`
3. `[Plan ####] Initial implementation plan`
4. `[Plan ####] Plan with multi-agent review`
5. Per Phase:
   - `[Spec ####][Phase: name] feat: Implementation`
   - `[Spec ####][Phase: name] test: Defend phase tests`
   - `[Spec ####][Phase: name] docs: Evaluation complete`
6. `[Spec ####] Review document with lessons learned`

### TICK Protocol
**Commits per Task**:
1. `TICK Spec: [descriptive-name]`
2. `TICK Plan: [descriptive-name]`
3. `TICK Impl: [descriptive-name]`
4. `TICK Review: [descriptive-name]` (includes multi-agent consultation)

Additional:
- `TICK Fixes: [descriptive-name]` (if changes requested)

## Development Infrastructure

### Pre-Commit Hooks

**Location**: `hooks/pre-commit`

**Purpose**: Automated quality assurance through test execution before commits

**Installation**:
```bash
./scripts/install-hooks.sh
```

**Behavior**:
- Runs fast test suite (via `./scripts/run-tests.sh`) before allowing commits
- Exits with error if any tests fail
- Provides clear feedback on test status
- Can be bypassed with `git commit --no-verify` (not recommended)

**Design Rationale**:
1. **Catch regressions early** - Find issues before they reach the repository
2. **Maintain quality** - Ensure all commits pass the test suite
3. **Fast feedback** - Uses fast tests (not integration tests) for quick iteration
4. **Optional but recommended** - Manual installation respects developer choice

**Installation Script** (`scripts/install-hooks.sh`):
- Copies `hooks/pre-commit` to `.git/hooks/pre-commit`
- Makes hook executable
- Provides clear feedback on installation success
- Safe to run multiple times (idempotent)

### Test-Driven Development

Codev itself follows test-driven development practices:
- **64 comprehensive tests** covering all functionality
- **Fast test suite** (<30 seconds) for rapid iteration
- **Integration tests** for end-to-end validation
- **Platform compatibility** testing (macOS and Linux)
- **Pre-commit hooks** for continuous quality assurance

**Test Organization Philosophy**:
- Framework tests (00-09) validate core infrastructure
- Protocol tests (10-19) verify installation and configuration
- Integration tests (20+) validate real-world usage
- All tests hermetic and isolated (XDG sandboxing)

## Key Design Decisions

### 1. Context-First Philosophy
**Decision**: Natural language specifications are first-class artifacts

**Rationale**:
- AI agents understand natural language natively
- Human-AI collaboration requires shared context
- Specifications are more maintainable than code comments
- Enables multi-agent consultation on intent, not just implementation

### 2. Self-Hosted Development
**Decision**: Codev uses Codev to develop itself

**Rationale**:
- Real-world usage validates methodology
- Pain points are experienced by maintainers first
- Continuous improvement from actual use cases
- Documentation reflects reality, not theory

### 3. Dual Repository Structure
**Decision**: Separate `codev/` (our work) from `codev-skeleton/` (template)

**Rationale**:
- Clear separation of concerns
- Users get clean template without our development artifacts
- We can evolve protocols while using them
- No risk of user specs polluting template

### 4. Vendored Test Dependencies
**Decision**: Include bats-core and helpers directly in repository

**Rationale**:
- Zero installation dependencies for contributors
- Consistent test environment across systems
- No dependency on external package managers
- Version control ensures stability

### 5. XDG Sandboxing for Tests
**Decision**: All tests use XDG environment variables to isolate configuration

**Rationale**:
- Prevents accidental modification of user directories
- Tests are hermetic and reproducible
- No side effects on host system
- Safety-first testing approach

### 6. Shell-Based Testing
**Decision**: Use bash/bats instead of Python/pytest

**Rationale**:
- Tests the actual shell commands from INSTALL.md
- No language dependencies beyond bash
- Directly validates installation instructions
- Simple for shell-savvy developers to understand

### 7. Tool-Agnostic Agent Installation
**Decision**: Conditional installation - `.claude/agents/` (Claude Code) OR `codev/agents/` (other tools)

**Rationale**:
- **Environment detection** - Automatically adapts to available tooling
- **Native integration** - Claude Code gets `.claude/agents/` for built-in agent execution
- **Universal fallback** - Other tools (Cursor, Copilot) use `codev/agents/` via AGENTS.md
- **Single source** - `codev/agents/` is canonical in this repository (self-hosted)
- **No lock-in** - Works with any AI coding assistant supporting AGENTS.md standard
- **Graceful degradation** - Installation succeeds regardless of environment

**Implementation Details**:
- Detection via `command -v claude &> /dev/null`
- Silent error handling (`2>/dev/null || true`) for missing agents
- Clear user feedback on installation location
- Test infrastructure mirrors production behavior

### 8. AGENTS.md Standard + CLAUDE.md Synchronization
**Decision**: Maintain both AGENTS.md (universal) and CLAUDE.md (Claude Code-specific) with identical content

**Rationale**:
- AGENTS.md follows [AGENTS.md standard](https://agents.md/) for cross-tool compatibility
- CLAUDE.md provides native Claude Code support
- Identical content ensures consistent behavior across tools
- Users of any AI coding assistant get appropriate file format

### 9. Multi-Agent Consultation by Default
**Decision**: SPIDER and TICK default to consulting GPT-5 and Gemini 3 Pro

**Rationale**:
- Multiple perspectives catch issues single agent misses
- Prevents blind spots and confirmation bias
- Improves code quality and completeness
- User must explicitly disable (opt-out, not opt-in)

### 10. TICK Protocol for Fast Iteration
**Decision**: Create lightweight protocol for simple tasks

**Rationale**:
- SPIDER is excellent but heavy for simple tasks
- Fast iteration needed for bug fixes and utilities
- Single autonomous execution reduces overhead
- Multi-agent review at end maintains quality
- Fills gap between informal changes and full SPIDER

### 11. Pre-Commit Hooks for Quality Assurance
**Decision**: Provide optional pre-commit hooks that run test suite

**Rationale**:
- **Early detection** - Catch regressions before they reach repository
- **Continuous quality** - Ensure all commits pass tests
- **Fast feedback** - Use fast tests (not integration) for quick iteration
- **Developer choice** - Manual installation respects autonomy
- **Escape hatch** - Can bypass with --no-verify when needed
- **Self-hosting validation** - Codev validates itself before commits

**Implementation**:
- Hooks stored in `hooks/` directory (not `.git/hooks/` - not tracked)
- Installation script (`scripts/install-hooks.sh`) copies to `.git/hooks/`
- Runs `./scripts/run-tests.sh` (fast tests, ~30 seconds)
- Clear feedback on pass/fail
- Instructions for bypassing when necessary

### 12. Single Canonical Implementation (TypeScript agent-farm)
**Decision**: Delete all bash architect scripts; TypeScript agent-farm is the single source of truth

**Rationale**:
- **Eliminate brittleness** - Triple implementation (bash + duplicate bash + TypeScript) caused divergent behavior
- **Single maintenance point** - Bug fixes only needed once
- **Type safety** - TypeScript catches errors at compile time
- **Rich features** - Easier to implement complex features (port registry, state locking)
- **Thin wrapper pattern** - Bash wrappers just call `node agent-farm/dist/index.js`

**What was deleted**:
- `codev/bin/architect` (713-line bash script)
- `codev-skeleton/bin/architect` (duplicate)
- `agent-farm/templates/` (now uses codev/templates/)
- `codev/builders.md` (legacy state file)

### 13. Global Port Registry for Multi-Architect Support
**Decision**: Use `~/.agent-farm/global.db` (SQLite) to allocate deterministic port blocks per repository

**Rationale**:
- **Cross-project coordination** - Multiple repos can run architects simultaneously
- **Deterministic allocation** - Port assignments stable across restarts
- **100-port blocks** - Ample room for dashboard, architect, 20 builders, utilities, annotations
- **File locking** - Prevents race conditions during concurrent registration
- **Stale cleanup** - Automatically removes entries for deleted projects

**Port Block Layout**:
```
base+0:     Dashboard
base+1:     Architect terminal
base+10-29: Builder terminals (20 slots)
base+30-49: Utility terminals (20 slots)
base+50-69: Annotation viewers (20 slots)
base+70-99: Reserved for future use
```

### 14. config.json for Shell Command Customization
**Decision**: Replace bash wrapper customization with JSON configuration file

**Rationale**:
- **Declarative configuration** - Easy to understand and modify
- **Array-form commands** - Avoids shell escaping issues
- **Environment variable expansion** - `${VAR}` syntax for secrets
- **Configuration hierarchy** - CLI args > config.json > defaults
- **Early validation** - Fail fast if commands or directories invalid

### 15. Clean Slate with Safety Checks
**Decision**: When consolidating, nuke old state but protect uncommitted work

**Rationale**:
- **No migration complexity** - Delete old artifacts rather than migrating
- **Dirty worktree protection** - Refuse to delete worktrees with uncommitted changes
- **Force flag requirement** - `--force` required to override safety checks
- **Orphaned session handling** - Detect and handle stale tmux sessions on startup

## Integration Points

### External Services
- **GitHub**: Repository hosting, version control
- **AI Model Providers**:
  - Anthropic Claude (Sonnet, Opus)
  - OpenAI GPT-5
  - Google Gemini 3 Pro

### External Tools
- **Claude Code**: Native integration via `.claude/agents/`
- **Cursor**: Via AGENTS.md standard
- **GitHub Copilot**: Via AGENTS.md standard
- **Other AI coding assistants**: Via AGENTS.md standard
- **Consult CLI**: For multi-agent consultation (installed with @cluesmith/codev)

### Internal Dependencies
- **Git**: Version control, worktrees for builder isolation
- **Node.js**: Runtime for agent-farm TypeScript CLI
- **Bash**: Thin wrapper scripts and test infrastructure
- **Markdown**: All documentation format
- **YAML**: Protocol configuration
- **JSON**: State management and configuration

### Optional Dependencies (Agent-Farm)
- **tmux**: Session persistence for builder terminals (recommended)
- **ttyd**: Web-based terminal interface (required for dashboard)

## Development Patterns

### 1. Protocol-Driven Development
Every feature follows a protocol (SPIDER, TICK, EXPERIMENT, or MAINTAIN):
- Start with specification (WHAT)
- Create plan (HOW)
- Implement in phases or single execution
- Document lessons learned

### 2. Multi-Agent Consultation
Default consultation pattern:
```
1. Agent performs work
2. STOP - consult GPT-5 and Gemini Pro
3. Apply feedback
4. Get FINAL approval from experts
5. THEN present to user
```

### 3. Fail-Fast Principle
From `CLAUDE.md`:
- Fast failures are MANDATORY
- NEVER implement fallbacks
- When condition can't be met, fail immediately with clear error
- Error messages explain what failed and why

### 4. Explicit File Staging
Git workflow:
```bash
# ✅ CORRECT - Always specify exact files
git add codev/specs/0001-feature.md
git add src/components/TodoList.tsx

# ❌ FORBIDDEN
git add -A
git add .
git add --all
```

**Rationale**: Prevents accidental commit of sensitive files, API keys, or large data files

### 5. Document Naming Convention
```
####-descriptive-name.md
```
- Four-digit sequential number
- Kebab-case descriptive name
- Shared across spec, plan, review
- Numbers never reused

## File Naming Conventions

### Specification Files
```
codev/specs/####-feature-name.md
```

### Plan Files
```
codev/plans/####-feature-name.md
```

### Review Files
```
codev/reviews/####-feature-name.md
```

### Test Files
```
tests/##_description.bats
```
- Two-digit prefix for ordering
- Underscore separator
- Descriptive name
- .bats extension

### Agent Files
```
codev/agents/agent-name.md
```
- Kebab-case names
- .md extension (markdown format)
- Agent frontmatter with name, description, model, color

## Utility Functions & Helpers

### Test Helpers (`tests/helpers/common.bash`)

#### setup_test_project()
**Purpose**: Create isolated temporary test directory

**Returns**: Path to test directory

**Usage**:
```bash
TEST_PROJECT=$(setup_test_project)
```

#### teardown_test_project(directory)
**Purpose**: Clean up test artifacts

**Parameters**:
- `directory` - Path to test directory

**Usage**:
```bash
teardown_test_project "$TEST_PROJECT"
```

#### install_from_local(target_dir)
**Purpose**: Install Codev from local skeleton with conditional agent installation

**Parameters**:
- `target_dir` - Installation target directory

**Returns**: 0 on success, 1 on failure

**Behavior**:
- Copies `codev-skeleton/` to `target_dir/codev/`
- Conditionally installs agents based on Claude Code detection
- Verifies installation success

**Usage**:
```bash
install_from_local "$TEST_PROJECT"
```

#### create_claude_md(directory, content)
**Purpose**: Create CLAUDE.md with specified content

**Parameters**:
- `directory` - Target directory
- `content` - CLAUDE.md content

**Usage**:
```bash
create_claude_md "$TEST_PROJECT" "# My Project\n\nInstructions..."
```

#### assert_codev_structure(directory)
**Purpose**: Validate Codev directory structure exists

**Parameters**:
- `directory` - Directory to check

**Usage**:
```bash
assert_codev_structure "$TEST_PROJECT"
```

#### file_contains(file, text)
**Purpose**: Check if file contains literal string

**Parameters**:
- `file` - File path
- `text` - Text to search for (literal match)

**Returns**: 0 if found, 1 if not found

**Usage**:
```bash
file_contains "$TEST_PROJECT/CLAUDE.md" "Codev Methodology"
```

### Test Helpers (`tests/helpers/mock_mcp.bash`)

#### mock_mcp_present()
**Purpose**: Simulate MCP command availability (for test isolation)

**Usage**:
```bash
mock_mcp_present
```

#### mock_mcp_absent()
**Purpose**: Simulate MCP command unavailability (for test isolation)

**Usage**:
```bash
mock_mcp_absent
```

## Cross-Tool Compatibility

### AGENTS.md Standard
Codev supports the [AGENTS.md standard](https://agents.md/) for universal AI coding assistant compatibility:

**Supported Tools**:
- Claude Code (via CLAUDE.md)
- Cursor (via AGENTS.md)
- GitHub Copilot (via AGENTS.md)
- Continue.dev (via AGENTS.md)
- Other AGENTS.md-compatible tools

**File Synchronization**:
- Both `AGENTS.md` and `CLAUDE.md` maintained
- Identical content in both files
- AGENTS.md is canonical for non-Claude Code tools
- CLAUDE.md provides native Claude Code support

### Agent Location Strategy
**Detection and Installation**:
```bash
if command -v claude &> /dev/null; then
    # Claude Code: Install to .claude/agents/
    AGENT_DIR=".claude/agents"
else
    # Other tools: Use codev/agents/
    AGENT_DIR="codev/agents"
fi
```

**Benefits**:
- Tool-agnostic architecture
- Native integration where available
- Fallback to universal location
- No tool lock-in

## Platform Compatibility

### macOS Specific
- Uses BSD `stat` command: `stat -f "%Lp"`
- gtimeout from coreutils for timeout support
- Default mktemp behavior compatible

### Linux Specific
- Uses GNU `stat` command: `stat -c "%a"`
- Native `timeout` command available
- Standard mktemp available

### Portable Patterns
```bash
# Platform-agnostic permission checking
if [[ "$OSTYPE" == "darwin"* ]]; then
  perms=$(stat -f "%Lp" "$file")
else
  perms=$(stat -c "%a" "$file")
fi

# Timeout command detection
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
fi
```

## Security Considerations

### Test Isolation
- XDG sandboxing prevents touching real user directories
- Temporary directories isolated per test
- No persistent state between tests
- Cleanup guaranteed via teardown traps

### Git Commit Safety
- Explicit file staging required (no `git add -A` or `git add .`)
- Prevents accidental commit of sensitive files
- Clear file-by-file staging

### Claude CLI Isolation
- `--strict-mcp-config` prevents MCP server loading
- `--mcp-config '[]'` ensures no external servers
- `--settings '{}'` prevents user settings leakage
- API keys explicitly unset during testing

### Codev Updater Safety
- Always creates backups before updating
- Never modifies user specs, plans, or reviews
- Provides rollback instructions
- Verifies successful update before completing

## Performance Characteristics

### Test Suite
- **Fast Tests**: <30 seconds (no Claude CLI)
- **All Tests**: ~2-5 minutes (with Claude CLI integration)
- **Total Tests**: 64 tests, ~2000 lines
- **Coverage**: Framework validation, protocol installation, agent testing, updater validation
- **Parallelization**: Tests are independent and can run in parallel
- **Execution Speed**: Average ~0.5 seconds per test (fast suite)

### Protocol Execution Times
- **TICK**: ~4 minutes for simple tasks
- **SPIDER** (without consultation): ~15-30 minutes depending on complexity
- **SPIDER** (with consultation): ~30-60 minutes depending on complexity

### Installation
- **Network**: Not required (uses local skeleton)
- **Time**: <1 minute for basic installation
- **Space**: ~500KB for protocols and templates

## Troubleshooting

### Common Issues

#### Tests Hanging
**Cause**: Missing timeout utility for Claude tests

**Solution**:
```bash
brew install coreutils  # macOS
```

#### Permission Errors
**Cause**: Test directories not writable

**Solution**:
```bash
chmod -R u+w /tmp/codev-test.*
```

#### Agent Not Found
**Cause**: Wrong agent location for tool

**Solution**:
- Claude Code: Check `.claude/agents/`
- Other tools: Check `codev/agents/`

#### CLAUDE.md Not Updated
**Cause**: Installation didn't detect existing file

**Solution**: Manually append Codev section from INSTALL.md

## Maintenance

### Regular Tasks
1. **Update arch.md** - After significant changes (via architecture-documenter agent)
2. **Sync AGENTS.md and CLAUDE.md** - Keep content identical
3. **Update protocols** - Based on lessons learned
4. **Run tests** - Before committing changes (automated via pre-commit hook)
5. **Update skeleton** - Keep template current with protocol changes

### Pre-Commit Hook Maintenance
1. **Keep hooks in sync** - `hooks/pre-commit` should match `.git/hooks/pre-commit`
2. **Test hook behavior** - Verify hook runs correctly before committing hook changes
3. **Update installation script** - Modify `scripts/install-hooks.sh` if hook changes
4. **Document bypass cases** - Update README with when `--no-verify` is acceptable

### Versioning
- Protocols have version numbers in manifest.yaml
- Agents have version history in git
- Framework version tracked via git tags

## Contributing

### Adding New Protocols
1. Create directory in `codev-skeleton/protocols/new-protocol/`
2. Write `protocol.md` with complete specification
3. Create templates in `templates/` subdirectory
4. Add manifest.yaml with metadata
5. Update INSTALL.md to reference new protocol
6. Test installation with new protocol
7. Document in README.md

### Adding New Tests
1. Create `.bats` file in `tests/` directory
2. Use appropriate numbering prefix (00-09, 10-19, 20+)
3. Include setup/teardown with XDG sandboxing
4. Use test helpers from `helpers/`
5. Document any special requirements
6. Ensure test is hermetic and isolated

### Updating Agents
1. Modify agent file in `codev/agents/`
2. Sync changes to `codev-skeleton/agents/`
3. Update agent documentation in AGENTS.md/CLAUDE.md
4. Test agent invocation
5. Document changes in git commit

## Success Metrics

A well-maintained Codev architecture should enable:
- **Quick Understanding**: New developers understand structure in <15 minutes
- **Fast Location**: Find relevant files in <2 minutes
- **Easy Extension**: Add new protocols or agents in <1 hour
- **Reliable Testing**: Tests pass consistently on all platforms
- **Safe Updates**: Framework updates never break user work

---

## Recent Infrastructure Changes (2024-12-03)

### Architecture Consolidation (Spec 0008)

The architect-builder system was consolidated to eliminate brittleness from triple implementation.

#### Agent-Farm TypeScript CLI
- **Single canonical implementation** in `packages/codev/src/agent-farm/`
- **Global CLI commands** - `af`, `codev`, and `consult` installed via npm
- **CLI commands**: start, stop, status, spawn, util, open, cleanup, ports

#### Global Port Registry
- **Location**: `~/.agent-farm/global.db` (SQLite)
- **Purpose**: Cross-project port coordination for multiple simultaneous architects
- **Port blocks**: 100 ports per project (4200-4299, 4300-4399, etc.)
- **Features**:
  - SQLite WAL mode for concurrent access
  - PID tracking for process ownership
  - Stale entry cleanup for deleted projects

**Port Allocation per Project**:
- Dashboard: base+0 (e.g., 4200)
- Architect: base+1 (e.g., 4201)
- Builders: base+10 to base+29 (20 slots)
- Utilities: base+30 to base+49 (20 slots)
- Annotations: base+50 to base+69 (20 slots)

#### config.json Configuration
- **Location**: `codev/config.json`
- **Purpose**: Shell command customization without modifying scripts
- **Hierarchy**: CLI args > config.json > defaults

**Structure**:
```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": ["claude", "--model", "sonnet"],
    "shell": "bash"
  },
  "templates": { "dir": "codev/templates" },
  "roles": { "dir": "codev/roles" }
}
```

**Features**:
- String or array command formats
- Environment variable expansion (`${VAR}` and `$VAR`)
- CLI overrides: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`

#### Deleted Duplicates
- **Removed**: `codev/bin/architect` (713-line bash script)
- **Removed**: `codev-skeleton/bin/architect`
- **Removed**: `agent-farm/templates/` (uses codev/templates/)
- **Removed**: `codev/builders.md` (legacy state file)

#### Role Files Created
- **`codev/roles/architect.md`** - Comprehensive architect role with af commands
- **`codev/roles/builder.md`** - Builder role with status management
- **Synced to**: `codev-skeleton/roles/`

#### Clean Slate Safety
- **Dirty worktree detection** before deletion
- **`--force` flag** required for uncommitted changes
- **Orphaned tmux session** detection on startup
- **Stale artifact warnings** for legacy files

### Previous Changes (2025-10-20)

#### Test Infrastructure Completion
- **Total tests**: 31 passing (agent-farm TypeScript tests)
- **Framework**: Vitest for TypeScript, bats-core for shell

#### Agent Installation
- **Tool-agnostic installation** with conditional logic
- **Dual paths**: `.claude/agents/` (Claude Code) or `codev/agents/` (universal)

#### Pre-Commit Hooks
- **`hooks/pre-commit`** - Runs test suite before commits
- **`scripts/install-hooks.sh`** - Installation script

### Tab Bar Status Indicators (Spec 0019)

Added visual status indicators to builder tabs for at-a-glance monitoring.

#### Status Indicator System
- **Location**: `codev/templates/dashboard-split.html`
- **Purpose**: Display builder status via color-coded dots in the tab bar
- **Features**:
  - Color-coded status dots using CSS variables
  - Pulse animation for waiting/blocked states (WCAG 2.3.3 compliant)
  - Diamond shape for blocked status (additional accessibility indicator)
  - Tooltips on hover with ARIA labels
  - prefers-reduced-motion support for accessibility

#### CSS Variables (Status Colors)
```css
--status-active: #22c55e;    /* Green: spawning, implementing */
--status-waiting: #eab308;   /* Yellow: pr-ready (waiting for review) */
--status-error: #ef4444;     /* Red: blocked */
--status-complete: #9e9e9e;  /* Gray: complete */
```

#### Status Configuration
```javascript
const STATUS_CONFIG = {
  'spawning':     { color: 'var(--status-active)',   label: 'Spawning',     shape: 'circle',  animation: 'pulse' },
  'implementing': { color: 'var(--status-active)',   label: 'Implementing', shape: 'circle',  animation: 'pulse' },
  'blocked':      { color: 'var(--status-error)',    label: 'Blocked',      shape: 'diamond', animation: 'blink-fast' },
  'pr-ready':     { color: 'var(--status-waiting)',  label: 'PR Ready',     shape: 'ring',    animation: 'blink-slow' },
  'complete':     { color: 'var(--status-complete)', label: 'Complete',     shape: 'circle',  animation: null }
};
```

#### Status Dot Rendering (`getStatusDot()` function)
- Returns HTML `<span>` with status indicator
- Adds CSS classes based on config:
  - `status-dot` (always)
  - `status-dot--diamond` (blocked - rotated square)
  - `status-dot--ring` (pr-ready - hollow circle)
  - `status-dot--pulse` (active states - gentle pulse)
  - `status-dot--blink-slow` (pr-ready - slow blink)
  - `status-dot--blink-fast` (blocked - fast blink)
- Sets inline background color from CSS variable
- Includes title attribute for tooltip and ARIA label
- Uses `role="img"` to avoid screen reader chatter on polling updates
- Output example: `<span class="status-dot status-dot--ring status-dot--blink-slow" style="background: var(--status-waiting)" title="PR Ready" role="img" aria-label="PR Ready"></span>`

#### Accessibility Features
1. **Color + Shape + Animation**: Each status has distinct visual cues
   - Active: solid circle + pulse animation
   - Waiting: ring (hollow circle) + slow blink
   - Blocked: diamond shape + fast blink
   - Complete: solid circle, static
2. **Reduced Motion**: `@media (prefers-reduced-motion: reduce)` disables all animations while keeping shape differentiators
3. **Tooltips**: Hover reveals status label
4. **Screen Readers**: ARIA labels and role="img" for proper semantics

#### Integration with Dashboard
- Status dots appear in builder tabs next to builder name
- Updates via existing 1-second polling mechanism (`refresh()` called via `setInterval`)
- No backend changes required (uses existing state.db status field)
- Status automatically updates when builder status changes

#### CSS Classes
```css
/* Shape classes */
.status-dot                 /* 6x6px circle (default) */
.status-dot--diamond        /* Rotated 45deg for diamond shape (blocked) */
.status-dot--ring           /* Hollow circle via box-shadow (pr-ready) */

/* Animation classes */
.status-dot--pulse          /* Gentle pulse 2s (active states) */
.status-dot--blink-slow     /* Slow blink 3s (pr-ready) */
.status-dot--blink-fast     /* Fast blink 0.8s (blocked) */

@keyframes status-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(0.9); }
}

@keyframes status-blink-slow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

@keyframes status-blink-fast {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}
```

### Terminal File Click to Annotate (Spec 0009)

Added clickable file paths in terminal output that open in the annotation viewer.

#### Custom ttyd Index (`codev/templates/ttyd-index.html`)
- **Purpose**: Custom xterm.js client with file path link detection
- **Features**:
  - Registers link provider with xterm.js for file path detection
  - Supports patterns: relative (`./foo.ts`), src-relative (`src/bar.js:42`), absolute (`/path/to/file.ts`)
  - Supports line numbers (`:42`) and column numbers (`:42:10`)
  - Underlines paths on hover with tooltip
  - Opens `/open-file` route when clicked

**Supported Extensions**: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.md`, `.json`, `.yaml`, `.yml`, `.sh`, `.bash`, `.html`, `.css`, `.scss`, `.go`, `.rs`, `.rb`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`

#### Dashboard `/open-file` Route
- **Location**: `agent-farm/src/servers/dashboard-server.ts`
- **URL**: `GET /open-file?path=<path>&line=<line>`
- **Flow**:
  1. Validates path is within project root (security check)
  2. Serves small HTML page that:
     - Uses BroadcastChannel to message dashboard
     - Calls `/api/tabs/file` to create annotation tab
     - Closes itself after 500ms

#### BroadcastChannel Communication
- **Channel name**: `agent-farm`
- **Message format**: `{ type: 'openFile', path: string, line: number | null }`
- **Dashboard listener** in `dashboard-split.html`:
  - Receives message via `setupBroadcastChannel()`
  - Opens file in annotation viewer via `openFileFromMessage()`
  - Switches to the new tab

#### ttyd Integration
- **Flag**: `-I <path>` (custom index HTML)
- **Updated files**:
  - `agent-farm/src/commands/start.ts` - Architect terminal
  - `agent-farm/src/commands/spawn.ts` - Builder terminals
  - `agent-farm/src/servers/dashboard-server.ts` - Utility shells

#### Known Issues (from Multi-Agent Consultation)
1. **Hardcoded port**: `const DASHBOARD_PORT = 4200` in ttyd-index.html
2. **Builder path resolution**: Relative paths resolve against project root, not builder worktree
3. **Double API calls**: Both popup and dashboard POST to `/api/tabs/file`

**Files Added**:
- `codev/templates/ttyd-index.html`
- `codev-skeleton/templates/ttyd-index.html`

**Files Modified**:
- `agent-farm/src/servers/dashboard-server.ts` (+103 lines)
- `agent-farm/src/commands/start.ts` (+11 lines)
- `agent-farm/src/commands/spawn.ts` (+11 lines)
- `codev/templates/dashboard-split.html` (+54 lines)
- `codev-skeleton/templates/dashboard-split.html` (+54 lines)

### Tab Bar Status Indicators (Spec 0019)

Added visual status indicators to the dashboard tab bar for at-a-glance builder monitoring.

#### Dashboard UI Changes
- **Location**: `codev/templates/dashboard-split.html`
- **Change Type**: CSS + JavaScript enhancement

#### CSS Status Color Variables
```css
--status-active: #22c55e;      /* Green: spawning, implementing */
--status-waiting: #eab308;     /* Yellow: pr-ready (waiting for review) */
--status-error: #ef4444;       /* Red: blocked */
--status-complete: #9e9e9e;    /* Gray: complete */
```

#### New JavaScript Components

**STATUS_CONFIG constant** - Maps builder status to visual properties:
```javascript
const STATUS_CONFIG = {
  'spawning':     { color: 'var(--status-active)',   label: 'Spawning',     shape: 'circle',  animation: 'pulse' },
  'implementing': { color: 'var(--status-active)',   label: 'Implementing', shape: 'circle',  animation: 'pulse' },
  'blocked':      { color: 'var(--status-error)',    label: 'Blocked',      shape: 'diamond', animation: 'blink-fast' },
  'pr-ready':     { color: 'var(--status-waiting)',  label: 'PR Ready',     shape: 'ring',    animation: 'blink-slow' },
  'complete':     { color: 'var(--status-complete)', label: 'Complete',     shape: 'circle',  animation: null }
};
```

**getStatusDot() function** - Renders status indicators with accessibility:
- Generates HTML for status dot with appropriate CSS classes
- Shape classes: `status-dot--diamond` (blocked), `status-dot--ring` (pr-ready)
- Animation classes: `status-dot--pulse`, `status-dot--blink-slow`, `status-dot--blink-fast`
- Sets inline color from CSS variables
- Adds title tooltips and ARIA labels
- Uses `role="img"` to prevent screen reader chatter on polling
- Returns: `<span class="status-dot status-dot--ring status-dot--blink-slow" style="background: ..." title="..." role="img" aria-label="..."></span>`

#### CSS Accessibility Features
- **Distinct shapes** - Circle (active/complete), Ring/hollow (pr-ready), Diamond (blocked)
- **Distinct animations** - Pulse (active), slow blink (waiting), fast blink (blocked), static (complete)
- **Reduced motion support** - `@media (prefers-reduced-motion: reduce)` disables animations but keeps shape differentiators
- **Tooltips** - Hover reveals status label
- **Screen reader support** - ARIA labels on all indicators

#### Integration Pattern
- Status dots render in tab bar via `renderTabs()` function
- Uses `getStatusDot(tab.status)` to generate HTML
- Status field comes from builder tab object (populated from state.db)
- Updates via existing 1-second polling mechanism (`refresh()` → `buildTabsFromState()` → `renderTabs()`)
- No backend changes - uses existing builder status field

#### Implementation Details
- Hoisted `STATUS_CONFIG` for performance (consulted in every render cycle)
- Changed from `role="status"` to `role="img"` to avoid screen reader chatter
- CSS classes use BEM naming: `.status-dot`, `.status-dot--diamond`, `.status-dot--pulse`
- Animation uses CSS custom properties for color consistency

**Files Modified**:
- `codev/templates/dashboard-split.html` - CSS variables, animations, getStatusDot() function
- `codev-skeleton/templates/dashboard-split.html` - Synced with codev/ version

---

**Last Updated**: 2025-12-04 (Spec 0019 implementation)
**Version**: Post-tab-bar-status-indicators
**Next Review**: After next significant feature implementation
