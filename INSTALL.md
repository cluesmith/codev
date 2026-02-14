# Codev Installation Guide

## Recommended: Install via npm

The easiest way to install Codev is through npm:

```bash
npm install -g @cluesmith/codev
```

This provides three CLI commands:
- `codev` - Main CLI (init, adopt, doctor, update, tower)
- `af` - Agent-farm CLI for parallel development
- `consult` - Multi-agent consultation tool

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

---

## How It Works: Embedded Skeleton with Local Overrides

When you install `@cluesmith/codev`, the package includes all framework files (protocols, roles, agents) as an **embedded skeleton**. This means:

1. **Minimal project structure**: `codev init` and `codev adopt` only create:
   - `codev/specs/` - Your feature specifications
   - `codev/plans/` - Your implementation plans
   - `codev/reviews/` - Your reviews and lessons learned
   - `codev/projectlist.md` - Project tracking
   - `CLAUDE.md` and `AGENTS.md` - AI agent instructions

2. **Framework files provided at runtime**: Protocols, roles, and templates are read from the installed npm package, not copied to your project. This keeps your project clean and makes updates seamless.

3. **Local overrides supported**: If you want to customize any framework file, simply create it in your local `codev/` directory. Local files always take precedence:
   - To customize the consultant role: create `codev/roles/consultant.md`
   - To modify SPIDER protocol: create `codev/protocols/spider/protocol.md`
   - To add custom templates: create files in `codev/templates/`

### Example: Customizing a Role

```bash
# Copy the default consultant role to your project for customization
mkdir -p codev/roles
cat $(npm root -g)/@cluesmith/codev/skeleton/roles/consultant.md > codev/roles/consultant.md

# Edit it to suit your needs
# The local version will now be used instead of the embedded one
```

---

## Alternative: Manual Installation for AI Agents

This section provides instructions for AI agents to manually install the Codev methodology framework. Most users should use `npm install -g @cluesmith/codev` instead.

### Core Principles
1. **Context Drives Code** - Context definitions flow from high-level specifications down to implementation details
2. **Human-AI Collaboration** - Designed for seamless cooperation between developers and AI agents
3. **Evolving Methodology** - The process itself evolves and improves with each project

## Manual Installation Process

### Step 1: Check Prerequisites

When a user requests Codev installation, check if the consultation tools are available:

```bash
# Check if consult CLI is available
command -v consult >/dev/null && echo "✓ consult CLI available" || echo "✗ consult CLI not found"
```

**Note**: The `consult` CLI is installed with `npm install -g @cluesmith/codev`. Multi-agent consultation requires at least one of: `claude`, `gemini-cli`, or `codex`.

### Step 2: Create and Populate the Codev Directory

**IMPORTANT**: All Codev files go INSIDE a `codev/` directory, not in the project root!

```bash
# Clone codev repository to temporary directory
TEMP_DIR=$(mktemp -d)
git clone --depth 1 https://github.com/ansari-project/codev.git "$TEMP_DIR"

# Copy skeleton structure to your project
mkdir -p codev
cp -r "$TEMP_DIR/codev-skeleton/"* ./codev/

# Detect if Claude Code is available and install agents to appropriate location
if command -v claude &> /dev/null; then
    # Claude Code detected - install agents to .claude/agents/
    mkdir -p .claude/agents
    cp -r "$TEMP_DIR/codev-skeleton/agents/"* ./.claude/agents/ 2>/dev/null || true
    echo "✓ Agents installed to .claude/agents/ (Claude Code detected)"
else
    # Non-Claude Code environment - agents already in codev/agents/ from skeleton
    echo "✓ Agents installed to codev/agents/ (universal location)"
fi

# Create required directories (ensures they exist even if skeleton is incomplete)
mkdir -p codev/specs
mkdir -p codev/plans

# Clean up
rm -rf "$TEMP_DIR"
```

**Directory Structure Should Be**:
```
project-root/
├── .ruler/             # Optional: Ruler-managed agent configs
│   ├── codev.md        # Codev-specific instructions (if using Ruler)
│   └── ruler.toml      # Ruler configuration
├── codev/              # All Codev files go here!
│   ├── protocols/      # Protocol definitions
│   ├── projectlist.md  # Master project tracking
│   ├── specs/          # Specifications
│   ├── plans/          # Implementation plans
│   ├── reviews/        # Reviews and lessons learned
│   └── resources/      # Reference materials and documentation
├── .claude/            # Claude Code-specific directory (if using Claude Code)
│   └── agents/         # Custom project agents
├── AGENTS.md           # Universal AI agent instructions (if NOT using Claude Code)
├── CLAUDE.md           # Claude Code-specific instructions (if using Claude Code)
└── [project files]     # Your actual code
```

**Note**:
- Agent configuration file is either `CLAUDE.md` (Claude Code) OR `AGENTS.md` (other tools), not both
- Custom project agents can be placed in `.claude/agents/` (Claude Code) or `codev/agents/` (other tools)

### Step 3: Protocol Selection

The entire `codev/protocols/` directory is copied with all available protocols. The active protocol is selected by modifying the agent configuration files to reference the appropriate protocol path:
- For **Ruler users**: Modify `.ruler/codev.md` and run `npx @intellectronica/ruler apply`
- For **direct management**: Modify `CLAUDE.md` (Claude Code) or `AGENTS.md` (other tools)

Available protocols:
- `codev/protocols/spider/` - Full SPIDER with multi-agent consultation
- `codev/protocols/tick/` - Fast autonomous implementation for simple tasks
- `codev/protocols/experiment/` - Disciplined experimentation for research and prototyping

### Step 4: Create or Update Agent Configuration Files

**IMPORTANT**: Check if the user is using Ruler for agent configuration management first!

AGENTS.md follows the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility (Cursor, GitHub Copilot, etc.), while CLAUDE.md provides native support for Claude Code.

```bash
# Check if Ruler is in use
if [ -d ".ruler" ] && [ -f ".ruler/ruler.toml" ]; then
    echo "Ruler detected. Adding Codev instructions via .ruler/codev.md..."

    # Create .ruler/codev.md with Codev-specific instructions
    # Run ruler apply to regenerate all tool-specific configs
    npx @intellectronica/ruler apply

    echo "✓ Codev instructions added to .ruler/codev.md and distributed via ruler"
else
    # No Ruler - use single-file approach based on detected environment
    echo "No Ruler detected. Using direct agent configuration..."

    # Detect environment and set target file
    if command -v claude &> /dev/null; then
        TARGET_FILE="CLAUDE.md"
        echo "Claude Code detected - using CLAUDE.md"
    else
        TARGET_FILE="AGENTS.md"
        echo "Other AI tool detected - using AGENTS.md"
    fi

    # Check if target file exists
    if [ -f "$TARGET_FILE" ]; then
        echo "Agent configuration file ($TARGET_FILE) exists. Updating to include Codev references..."
        # APPEND Codev-specific instructions to existing file
    else
        # Ask user for permission
        echo "No $TARGET_FILE found. May I create it? [y/n]"
        # If yes, create the appropriate file with Codev structure
        # Note: No template exists in skeleton - AI should create appropriate one based on project context
    fi
fi
```

**Content to add** (same for both approaches):

For Ruler users, create `.ruler/codev.md` with this content.
For direct management, AGENTS.md and CLAUDE.md should contain identical content - AGENTS.md follows the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility (Cursor, GitHub Copilot, etc.), while CLAUDE.md provides native support for Claude Code.

**When updating existing files**, add these sections:
```markdown
## Codev Methodology

This project uses the Codev context-driven development methodology.

### Active Protocol
- Protocol: SPIDER
- Location: codev/protocols/spider/protocol.md

### Directory Structure
- Specifications: codev/specs/
- Plans: codev/plans/
- Reviews: codev/reviews/
- Resources: codev/resources/

See codev/protocols/spider/protocol.md for full protocol details.
```

Key sections to verify:
- For **Ruler users**: Ensure content in `.ruler/codev.md` is correct before running `npx @intellectronica/ruler apply`
- For **direct management** (CLAUDE.md or AGENTS.md):
  - Active protocol path
  - Consultation guidelines (if using SPIDER)
  - File naming conventions (####-descriptive-name.md)

### Step 5: Verify Installation

**Run the Doctor Command**:

The easiest way to verify your installation is to run:

```bash
codev doctor
```

This checks:
- **Core dependencies**: Node.js, git (with versions)
- **AI CLI dependencies**: Claude Code, Gemini CLI, Codex CLI (at least one required)

If any required dependencies are missing, the doctor will show install instructions.

**Quick Codev Structure Verification**:
```bash
# 1. Verify codev/ directory exists
test -d codev && echo "✓ codev/ directory exists" || echo "✗ FAIL: codev/ directory missing"

# 2. Verify required subdirectories
test -d codev/protocols/spider && echo "✓ SPIDER protocol exists" || echo "✗ FAIL: SPIDER protocol missing"
test -d codev/protocols/tick && echo "✓ TICK protocol exists" || echo "✗ FAIL: TICK protocol missing"
test -d codev/specs && echo "✓ specs/ directory exists" || echo "✗ FAIL: specs/ directory missing"

# 3. Verify agents are installed in appropriate location
if command -v claude &> /dev/null; then
    test -d .claude/agents && echo "✓ .claude/agents/ directory exists (Claude Code)" || echo "✗ FAIL: .claude/agents/ directory missing"
else
    test -d codev/agents && echo "✓ codev/agents/ directory exists (universal)" || echo "✗ FAIL: codev/agents/ directory missing"
fi

# 4. Verify protocol is readable
test -r codev/protocols/spider/protocol.md && echo "✓ protocol.md is readable" || echo "✗ FAIL: Cannot read protocol.md"

# 5. Verify agent configuration exists and references codev
# Check for Ruler first, then fall back to single-file detection
if [ -d ".ruler" ] && [ -f ".ruler/ruler.toml" ]; then
    test -f .ruler/codev.md && echo "✓ .ruler/codev.md exists (Ruler setup)" || echo "✗ FAIL: .ruler/codev.md missing"
    grep -q "codev" .ruler/codev.md && echo "✓ .ruler/codev.md references codev" || echo "✗ FAIL: .ruler/codev.md missing codev references"
elif command -v claude &> /dev/null; then
    test -f CLAUDE.md && echo "✓ CLAUDE.md exists (Claude Code)" || echo "✗ FAIL: CLAUDE.md missing"
    grep -q "codev" CLAUDE.md && echo "✓ CLAUDE.md references codev" || echo "✗ FAIL: CLAUDE.md missing codev references"
else
    test -f AGENTS.md && echo "✓ AGENTS.md exists (universal)" || echo "✗ FAIL: AGENTS.md missing"
    grep -q "codev" AGENTS.md && echo "✓ AGENTS.md references codev" || echo "✗ FAIL: AGENTS.md missing codev references"
fi
```

**Detailed Structure Check**:
```bash
# View complete directory structure
find codev -type d -maxdepth 2 | sort

# Expected output:
# codev/
# codev/plans
# codev/protocols
# codev/protocols/spider
# codev/protocols/tick
# codev/reviews
# codev/resources
# codev/specs

# Verify protocol content
cat codev/protocols/spider/protocol.md | head -20
```

## Post-Installation Guidance

After installation, guide the user:

**Note for future changes**: To modify the active protocol or other agent instructions:
- **Ruler users**: Edit `.ruler/codev.md` and run `npx @intellectronica/ruler apply`
- **Direct management**: Edit both `AGENTS.md` and `CLAUDE.md` (keep them synchronized)

1. **First Specification**: "What would you like to build first? I can help create a specification using the SPIDER protocol."

2. **Explain the Flow**:
   - **Build in phases using the IDE loop**:
     - **I**mplement: Build the code
     - **D**efend: Write comprehensive tests
     - **E**valuate: Verify requirements are met
   - Each phase follows: Specification → Plan → IDE Loop → Review

3. **Document Naming**: Always use ####-descriptive-name.md format

4. **Git Integration**:
   - Each stage gets one pull request
   - Phases can have multiple commits
   - User approval required before PRs

## Troubleshooting

### Common Issues:

**Q: User wants multi-agent consultation but consult CLI isn't working**
- Try: "Let me verify the consult CLI and its dependencies are installed: `codev doctor`"
- Fallback: "You can run SPIDER with 'without consultation' to skip multi-agent reviews"

**Q: User has existing codev directory**
- If upgrading from a previous codev version, see **[MIGRATION-1.0.md](MIGRATION-1.0.md)** for upgrade instructions
- Ask: "You have an existing codev/ directory. Should I:"
  - "Upgrade to v1.0.x (preserves your specs, plans, and reviews)"
  - "Back it up and reinstall"
  - "Keep existing setup"

**Q: User wants a different protocol name**
- Protocols can be renamed, just ensure:
  - Directory name matches references in agent configuration file (AGENTS.md or CLAUDE.md)
  - All templates are present
  - manifest.yaml is updated

## Protocol Comparison

| Feature | SPIDER | TICK | EXPERIMENT |
|---------|--------|------|------------|
| Multi-agent consultation | ✓ (GPT-5 + Gemini Pro) | ✗ | ✗ |
| Prerequisites | consult CLI | None | None |
| Specification reviews | Multi-agent external | Minimal | N/A |
| Plan reviews | Multi-agent external | Minimal | N/A |
| Implementation reviews | Multi-agent per phase | Post-implementation | Results-focused |
| Best for | Production features | Small tasks / amendments | Research & prototyping |
| Speed | Thorough | Fast | Flexible |
| Output | Spec + Plan + Review | Spec + Plan + Review | notes.md per experiment |

**Note**: To skip multi-agent consultation in SPIDER, say "without consultation" when starting work.

## Protocol Import

Codev includes an AI-assisted command for importing protocol improvements from other codev projects.

**Usage**:
```bash
# Import from local directory
codev import /path/to/other-project

# Import from GitHub
codev import github:owner/repo
codev import https://github.com/owner/repo
```

**How it works**:
1. Fetches the source codev/ directory (local path or GitHub clone)
2. Spawns an interactive Claude session with source and target context
3. Claude analyzes differences and recommends imports
4. You interactively approve/reject each suggested change
5. Claude makes approved edits to your local codev/ files

**Focus areas**:
- Protocol improvements (new phases, better documentation)
- Lessons learned from other projects
- Architectural patterns and documentation structure
- New protocols not in your installation

**Requirements**:
- Claude CLI (`npm install -g @anthropic-ai/claude-code`)
- git (for GitHub imports)

## Architect-Builder Pattern (Optional)

For projects with parallelizable components, Codev includes the Architect-Builder pattern for running multiple AI agents simultaneously.

### Prerequisites

After installing `@cluesmith/codev` via npm, ensure these dependencies are installed:

- **Node.js** 18+ (includes node-pty for terminal sessions)
- **git** 2.5+ (with worktree support)

Check with:
```bash
codev doctor
```

### Setup

The architect-builder tools are available globally via the `af` command after installing `@cluesmith/codev`:

```bash
# Ensure .builders/ and .agent-farm/ are in your .gitignore
echo ".builders/" >> .gitignore
echo ".agent-farm/" >> .gitignore

# Verify the agent-farm CLI is available
af --help
```

### Configuration

Create `codev/config.json` to customize commands:

```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": "claude --model sonnet",
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

Override via CLI:
```bash
af dash start --architect-cmd "claude --model opus"
af spawn --project 0003 --builder-cmd "claude"
```

### Quick Start

```bash
# Start the architect dashboard
af dash start

# Spawn a builder for a spec
af spawn --project 0003

# Check status of all builders
af status

# Open a utility shell
af shell

# Open a file in annotation viewer
af open src/auth/login.ts

# Clean up a builder (checks for uncommitted changes first)
af cleanup --project 0003

# Force cleanup (WARNING: may lose uncommitted work)
af cleanup --project 0003 --force

# Stop the architect and all builders
af dash stop

# Manage port allocations (for multi-project support)
af ports list
af ports cleanup
```

### How It Works

1. **Architect** (you + primary AI) creates specs and plans
2. **Builders** (autonomous AI agents) implement specs in isolated git worktrees
3. Each builder runs in a **persistent terminal session** (shepherd process + node-pty) with web terminal access
4. **Review comments** are stored directly in files using `// REVIEW:` syntax
5. Builders create PRs when complete; architect reviews and merges

### Key Features

- **Multi-project support**: Each project gets its own port block (4200-4299, 4300-4399, etc.)
- **Safe cleanup**: Refuses to delete worktrees with uncommitted changes unless `--force` is used
- **Orphan detection**: Automatically cleans up stale sessions on startup
- **Configurable commands**: Customize architect, builder, and shell commands via `config.json`

### Key Files

- `.agent-farm/state.json` - Runtime state (builders, ports, processes)
- `~/.agent-farm/ports.json` - Global port registry (for multi-project support)
- `codev/config.json` - Project configuration
- `codev/templates/` - Dashboard and annotation HTML templates
- `codev/roles/` - Architect and builder role prompts

See `codev/specs/0002-architect-builder.md` for full documentation.

## Remember

- The goal is THREE documents per feature (spec, plan, review)
- Each stage gets one pull request
- Phases can have multiple commits within the PR
- User approval required before creating PRs
- Context drives development