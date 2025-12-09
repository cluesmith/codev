# Codev Project Instructions for AI Agents

> **Note**: This file is specific to Claude Code. An identical [AGENTS.md](AGENTS.md) file is also maintained following the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility with Cursor, GitHub Copilot, and other AI coding assistants. Both files contain the same content and should be kept synchronized.

## Project Context

**THIS IS THE CODEV SOURCE REPOSITORY - WE ARE SELF-HOSTED**

This project IS Codev itself, and we use our own methodology for development. All new features and improvements to Codev should follow the SPIDER protocol defined in `codev/protocols/spider/protocol.md`.

### Important: Understanding This Repository's Structure

This repository has a dual nature that's important to understand:

1. **`codev/`** - This is OUR instance of Codev
   - This is where WE (the Codev project) keep our specs, plans, reviews, and resources
   - When working on Codev features, you work in this directory
   - Example: `codev/specs/0001-test-infrastructure.md` is a feature spec for Codev itself

2. **`codev-skeleton/`** - This is the template for OTHER projects
   - This is what gets copied to other projects when they install Codev
   - Contains the protocol definitions, templates, and agents
   - Does NOT contain specs/plans/reviews (those are created by users)
   - Think of it as "what Codev provides" vs "how Codev uses itself"

**When to modify each**:
- **Modify `codev/`**: When implementing features for Codev (specs, plans, reviews, our architecture docs)
- **Modify `codev-skeleton/`**: When updating protocols, templates, or agents that other projects will use

### Release Naming Convention

Codev releases are named after **great examples of architecture** from around the world. This reflects our core philosophy that software development, like architecture, requires careful planning, thoughtful design, and harmonious integration of components.

| Version | Codename | Inspiration |
|---------|----------|-------------|
| 1.0.0 | Alhambra | Moorish palace complex in Granada, Spain - intricate detail and harmonious design |

Future releases will continue this tradition, drawing from architectural wonders across cultures and eras.

## Quick Start

You are working in the Codev project itself, with multiple development protocols available:

**Available Protocols**:
- **SPIDER**: Multi-phase development with consultation - `codev/protocols/spider/protocol.md`
- **TICK**: Amendment workflow for existing specs - `codev/protocols/tick/protocol.md`
- **EXPERIMENT**: Disciplined experimentation - `codev/protocols/experiment/protocol.md`
- **MAINTAIN**: Codebase maintenance (code hygiene + documentation sync) - `codev/protocols/maintain/protocol.md`

Key locations:
- Protocol details: `codev/protocols/` (Choose appropriate protocol)
- **Project tracking**: `codev/projectlist.md` (Master list of all projects)
- Specifications go in: `codev/specs/`
- Plans go in: `codev/plans/`
- Reviews go in: `codev/reviews/`

### Project Tracking

**`codev/projectlist.md` is the canonical source of truth for all project information.**

When asked about project status, incomplete work, or what to work on next:
1. Read `codev/projectlist.md` first
2. It contains status, priority, dependencies, and notes for every project
3. Update it when project status changes (e.g., implementing → implemented)
4. Reserve project numbers there BEFORE creating spec files

**🚨 CRITICAL: Two human approval gates exist:**
- **conceived → specified**: AI creates spec, but ONLY the human can approve it
- **committed → integrated**: AI can merge PRs, but ONLY the human can validate production

AI agents must stop at `conceived` after writing a spec, and stop at `committed` after merging.

## Protocol Selection Guide

### Use TICK for (amendments to existing specs):
- **Amendments** to an existing SPIDER spec that is already `integrated`
- Small scope (< 300 lines of new/changed code)
- Clear requirements that extend existing functionality
- Examples:
  - Adding a feature to an existing system (e.g., "add password reset to user auth")
  - Bug fixes that extend existing functionality
  - Configuration changes with logic
  - Utility function additions to existing modules

**TICK modifies spec/plan in-place** and creates a new review file. Cannot be used for greenfield work.

### Use SPIDER for (new features):
- Creating a **new feature from scratch** (no existing spec to amend)
- New protocols or protocol variants
- Major changes to existing protocols
- Significant changes to installation process
- Complex features requiring multiple phases
- Architecture changes
- System design decisions

### Use EXPERIMENT for:
- Testing new approaches or techniques
- Evaluating models or libraries
- Proof-of-concept work
- Research spikes
- Prototyping before committing to implementation

### Use MAINTAIN for:
- Removing dead code and unused dependencies
- Quarterly codebase maintenance
- Before releases (clean slate for shipping)
- After major features complete
- Syncing documentation (arch.md, lessons-learned.md, CLAUDE.md/AGENTS.md)

### Skip formal protocols for:
- README typos or minor documentation fixes
- Small bug fixes in templates
- Dependency updates

## Core Workflow

1. **When asked to build NEW FEATURES FOR CODEV**: Start with the Specification phase
2. **Create exactly THREE documents per feature**: spec, plan, and lessons (all with same filename)
3. **Follow the SP(IDE)R phases**: Specify → Plan → (Implement → Defend → Evaluate) → Review
4. **Use multi-agent consultation by default** unless user says "without consultation"

### CRITICAL CONSULTATION CHECKPOINTS (DO NOT SKIP):
- After writing implementation code → STOP → Consult GPT-5 and Gemini Pro
- After writing tests → STOP → Consult GPT-5 and Gemini Pro
- ONLY THEN present results to user for evaluation

## Directory Structure
```
project-root/
├── codev/
│   ├── protocols/           # Development protocols
│   │   ├── spider/         # Multi-phase development with consultation
│   │   ├── tick/           # Fast autonomous implementation
│   │   ├── experiment/     # Disciplined experimentation
│   │   └── maintain/       # Codebase maintenance (code + docs)
│   ├── maintain/            # MAINTAIN protocol runtime artifacts
│   │   └── .trash/         # Soft-deleted files (gitignored, 30-day retention)
│   ├── projectlist.md      # Master project tracking (status, priority, dependencies)
│   ├── specs/              # Feature specifications (WHAT to build)
│   ├── plans/              # Implementation plans (HOW to build)
│   ├── reviews/            # Reviews and lessons learned from each feature
│   └── resources/          # Reference materials
│       ├── arch.md         # Architecture documentation (updated during MAINTAIN)
│       └── lessons-learned.md  # Extracted wisdom from reviews (generated during MAINTAIN)
├── .claude/
│   └── agents/             # AI agent definitions
│       ├── spider-protocol-updater.md
│       └── codev-updater.md
├── AGENTS.md              # Universal AI agent instructions (AGENTS.md standard)
├── CLAUDE.md              # This file (Claude Code-specific, identical to AGENTS.md)
└── [project code]
```

## File Naming Convention

Use sequential numbering with descriptive names:
- Specification: `codev/specs/0001-feature-name.md`
- Plan: `codev/plans/0001-feature-name.md`
- Review: `codev/reviews/0001-feature-name.md`

**Note**: Sequential numbering is shared across all protocols (SPIDER, TICK)

## Multi-Agent Consultation

**DEFAULT BEHAVIOR**: Consultation is ENABLED by default with:
- **Gemini 3 Pro** (gemini-3-pro-preview) for deep analysis
- **GPT-5 Codex** (gpt-5-codex) for coding and architecture perspective

To disable: User must explicitly say "without multi-agent consultation"

**Consultation Checkpoints**:
1. **Specification Phase**: After draft and after human review
2. **Planning Phase**: After plan creation and after human review
3. **Implementation Phase**: After code implementation
4. **Defend Phase**: After test creation
5. **Evaluation Phase**: After evaluation completion
6. **Review Phase**: After review document

## Spider Protocol Updater Agent

The `spider-protocol-updater` agent helps evolve the SPIDER protocol by analyzing implementations in other repositories and identifying improvements to incorporate back into the main protocol.

**When to use**:
- Periodic review of SPIDER implementations in other repositories
- When notified of significant SPIDER improvements in external projects
- To check if a specific repository has protocol enhancements worth adopting

**How to invoke**:
```bash
# Ask Claude to check a specific repository
"Check the ansari-project/webapp repo for any SPIDER improvements we should adopt"

# Or for periodic reviews
"It's been a month since we last checked for SPIDER improvements in other repos"
```

**What the agent does**:
1. Analyzes remote GitHub repositories implementing SPIDER
2. Compares their protocol.md with our canonical version
3. Reviews their lessons learned and review documents
4. Classifies improvements as Universal, Domain-specific, Experimental, or Anti-pattern
5. Recommends specific protocol updates with justification

**Agent location**: `.claude/agents/spider-protocol-updater.md`

## Codev Updater Agent

The `codev-updater` agent keeps your Codev installation current with the latest improvements from the main repository while preserving your project work.

**When to use**:
- Periodic framework updates (monthly recommended)
- When new protocols are released (like TICK)
- When agents receive improvements or bug fixes
- When protocol templates are enhanced
- To check for available updates

**How to invoke**:
```bash
# Update to latest version
"Please update my codev framework to the latest version"

# Check for available updates
"Are there any updates available for codev?"
```

**What the agent does**:
1. Checks current installation and identifies installed components
2. Fetches latest version from the main codev repository
3. **Creates backups** of current installation
4. Updates protocols, agents, and templates
5. **Preserves all user work** (specs, plans, reviews)
6. Provides update report and rollback instructions

**Safety features**:
- Always creates timestamped backups before updating
- Never modifies user's specs, plans, or reviews
- Preserves CLAUDE.md customizations
- Provides clear rollback instructions if needed
- Verifies successful update before completing

**Agent location**: `.claude/agents/codev-updater.md`

## Architect-Builder Pattern

The Architect-Builder pattern enables parallel AI-assisted development by separating concerns:
- **Architect** (human + primary AI): Creates specs and plans, reviews work
- **Builders** (autonomous AI agents): Implement specs in isolated git worktrees

### Prerequisites

- **ttyd**: `brew install ttyd` (web-based terminal)
- **tmux**: `brew install tmux` (terminal multiplexer)
- **Node.js 18+**: For agent-farm runtime
- **git 2.5+**: With worktree support

### CLI Commands

```bash
# Start the architect dashboard
./codev/bin/agent-farm start

# Spawn a builder for a spec
./codev/bin/agent-farm spawn --project 0003

# Check status of all builders
./codev/bin/agent-farm status

# Open a utility shell
./codev/bin/agent-farm util

# Open files in annotation viewer
./codev/bin/agent-farm open src/auth/login.ts

# Clean up a builder (checks for uncommitted work first)
./codev/bin/agent-farm cleanup --project 0003

# Force cleanup (WARNING: may lose uncommitted work)
./codev/bin/agent-farm cleanup --project 0003 --force

# Stop all agent-farm processes
./codev/bin/agent-farm stop

# Manage port allocations (for multi-project support)
./codev/bin/agent-farm ports list
./codev/bin/agent-farm ports cleanup
```

### Configuration

Customize commands via `codev/config.json`:
```json
{
  "shell": {
    "architect": "claude --model opus",
    "builder": "claude --model sonnet",
    "shell": "bash"
  }
}
```

Override via CLI: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`

### Review Comments

Comments are stored directly in files using language-appropriate syntax:

```typescript
// REVIEW(@architect): Consider error handling here
// REVIEW(@builder): Fixed - added try/catch
```

```python
# REVIEW: This could be simplified
```

```markdown
<!-- REVIEW: Clarify this requirement -->
```

### Key Features

- **Multi-project support**: Each project gets its own port block (4200-4299, etc.)
- **Safe cleanup**: Refuses to delete worktrees with uncommitted changes
- **Orphan detection**: Cleans up stale tmux sessions on startup
- **Configurable commands**: Customize via `config.json` or CLI flags

### Key Files

- `.agent-farm/state.json` - Runtime state (builders, ports, processes)
- `~/.agent-farm/ports.json` - Global port registry
- `codev/config.json` - Project configuration
- `codev/templates/` - Dashboard and annotation templates
- `codev/roles/` - Architect and builder role prompts
- `codev/bin/agent-farm` - CLI wrapper script

See `codev/specs/0002-architect-builder.md` for full documentation.

## Git Workflow

### 🚨 ABSOLUTE PROHIBITION: NEVER USE `git add -A` or `git add .` 🚨

**THIS IS A CRITICAL SECURITY REQUIREMENT - NO EXCEPTIONS**

**BANNED COMMANDS (NEVER USE THESE)**:
```bash
git add -A        # ❌ ABSOLUTELY FORBIDDEN
git add .         # ❌ ABSOLUTELY FORBIDDEN
git add --all     # ❌ ABSOLUTELY FORBIDDEN
```

**WHY THIS IS CRITICAL**:
- Can expose API keys, secrets, and credentials
- May commit large data files or sensitive personal configs
- Could reveal private information in temporary files
- Has caused security incidents in the past

**MANDATORY APPROACH - ALWAYS ADD FILES EXPLICITLY**:
```bash
# ✅ CORRECT - Always specify exact files
git add codev/specs/0001-feature.md
git add src/components/TodoList.tsx
git add tests/helpers/common.bash

# ✅ CORRECT - Can use specific patterns if careful
git add codev/specs/*.md
git add tests/*.bats
```

**BEFORE EVERY COMMIT**:
1. Run `git status` to see what will be added
2. Add each file or directory EXPLICITLY by name
3. Never use shortcuts that could add unexpected files
4. If you catch yourself typing `git add -A` or `git add .`, STOP immediately

### Commit Messages
```
[Spec 0001] Initial specification draft
[Spec 0001] Specification with multi-agent review
[Spec 0001][Phase: user-auth] feat: Add password hashing
```

### Branch Naming
```
spider/0001-feature-name/phase-name
```

### Pull Request Merging

**DO NOT SQUASH MERGE** - Always use regular merge commits.

```bash
# ✅ CORRECT - Regular merge (preserves commit history)
gh pr merge <number> --merge

# ❌ FORBIDDEN - Squash merge (loses individual commits)
gh pr merge <number> --squash
```

**Why no squashing**: Individual commits document the development process (spec, plan, implementation, review, fixes). Squashing loses this valuable history.

## Consultation Guidelines

When the user requests "Consult" or "consultation" (including variations like "ultrathink and consult"), this specifically means:
- Use Gemini 3 Pro (gemini-3-pro-preview) for deep analysis
- Use GPT-5 Codex (gpt-5-codex) for coding and architecture perspective
- Both models should be consulted unless explicitly specified otherwise

## Consult Tool

The `consult` CLI provides a unified interface for single-agent consultation via external AI CLIs (gemini-cli, codex, and claude). Each invocation is stateless (fresh process).

**⚠️ ALWAYS RUN CONSULTATIONS IN PARALLEL**: When consulting multiple models (e.g., Gemini and Codex), use **separate Bash tool calls in the same message**. Claude Code executes them in parallel, and the user sees each stream as it completes.

```
# ✅ CORRECT - Two separate Bash tool calls in one message
[Bash tool call 1]: consult --model gemini spec 39
[Bash tool call 2]: consult --model codex spec 39

# ❌ WRONG - Sequential tool calls in separate messages
[Message 1, Bash]: consult --model gemini spec 39
[Message 2, Bash]: consult --model codex spec 39
```

### Prerequisites

- **@cluesmith/codev**: `npm install -g @cluesmith/codev` (provides `consult` binary)
- **gemini-cli**: For Gemini consultations (see https://github.com/google-gemini/gemini-cli)
- **codex**: For Codex consultations (`npm install -g @openai/codex`)
- **claude**: For Claude consultations (`npm install -g @anthropic-ai/claude-code`)

### Usage

```bash
# Subcommand-based interface
consult --model gemini pr 33        # Review a PR
consult --model codex spec 39       # Review a spec
consult --model claude plan 39      # Review a plan
consult --model gemini general "Review this design"  # General query

# Model aliases work too
consult --model pro spec 39    # alias for gemini
consult --model gpt pr 33      # alias for codex
consult --model opus plan 39   # alias for claude

# Dry run (print command without executing)
consult --model gemini spec 39 --dry-run

# Review type (use stage-specific review prompt)
consult --model gemini spec 39 --type spec-review
consult --model gemini pr 68 --type integration-review
```

### Review Types

Use the `--type` parameter to load stage-specific review prompts:

| Type | Stage | Use Case |
|------|-------|----------|
| `spec-review` | conceived | Review specification for completeness and clarity |
| `plan-review` | specified | Review implementation plan for coverage and feasibility |
| `impl-review` | implementing | Review implementation for spec adherence and quality |
| `pr-ready` | implemented | Final self-check before creating PR |
| `integration-review` | committed | Architect's review for architectural fit |

Review type prompts are in `codev/roles/review-types/`. The prompt is appended to the consultant role.

### Parallel Consultation (3-Way Reviews)

For 3-way reviews, run consultations in parallel using separate Bash tool calls:

```bash
# All three in parallel (separate Bash tool calls in same message)
consult --model gemini spec 39
consult --model codex spec 39
consult --model claude spec 39
```

Or use background processes in a single shell:
```bash
consult --model gemini spec 39 &
consult --model codex spec 39 &
consult --model claude spec 39 &
wait
```

### Model Aliases

| Alias | Resolves To | CLI Used |
|-------|-------------|----------|
| `gemini` | gemini-3-pro-preview | gemini-cli |
| `pro` | gemini-3-pro-preview | gemini-cli |
| `codex` | gpt-5-codex | codex |
| `gpt` | gpt-5-codex | codex |
| `claude` | (default model) | claude |
| `opus` | (default model) | claude |

### Performance Characteristics

| Model | Typical Time | Approach |
|-------|--------------|----------|
| Gemini | ~120-150s | Pure text analysis, no shell commands |
| Codex | ~200-250s | Sequential shell commands (`git show`, `rg`, etc.) |
| Claude | ~60-120s | Balanced analysis with targeted tool use |

**Why Codex is slower**: Codex CLI's `--full-auto` mode executes shell commands sequentially with reasoning between each step. For PR reviews, it typically runs 10-15 commands like `git show <branch>:<file>`, `rg -n "pattern"`, etc. This is more thorough but takes ~2x longer than Gemini's text-only analysis.

### Architect-Mediated PR Reviews

For faster and more consistent PR reviews, the Architect can prepare context upfront and pass it to consultants:

```bash
# Standard mode (consultant explores filesystem - slower)
consult --model gemini pr 68

# Mediated mode (architect provides context - faster)
consult --model gemini pr 68 --context overview.md

# Via stdin
cat overview.md | consult --model gemini pr 68 --context -

# 3-way parallel mediated reviews
consult --model gemini pr 68 --context overview.md &
consult --model codex pr 68 --context overview.md &
consult --model claude pr 68 --context overview.md &
wait
```

**When to use mediated mode**:
- 3-way reviews where consistent context is important
- Large PRs where exploration is slow
- When specific aspects need focused review

**Template**: Use `codev/templates/pr-overview.md` to prepare context.

**Performance**: Mediated reviews complete in ~30-60s vs 120-250s with exploration.

### How It Works

1. Reads the consultant role from `codev/roles/consultant.md`
2. For subcommands (pr, spec, plan), auto-locates the file (e.g., `codev/specs/0039-*.md`)
3. Invokes the appropriate CLI with autonomous mode enabled:
   - gemini: `GEMINI_SYSTEM_MD=<temp_file> gemini --yolo <query>`
   - codex: `codex exec -c experimental_instructions_file=<temp_file> -c model_reasoning_effort=low --full-auto <query>`
   - claude: `claude --print -p <role + query> --dangerously-skip-permissions`
4. Passes through stdout/stderr and exit codes
5. Logs queries with timing to `.consult/history.log`

### The Consultant Role

The consultant role (`codev/roles/consultant.md`) defines a collaborative partner that:
- Provides second perspectives on decisions
- Offers alternatives and considerations
- Works constructively alongside the primary agent
- Is NOT adversarial or a rubber stamp
- Uses `git show <branch>:<file>` for PR reviews (not working directory)

### Key Files

- `packages/codev/src/commands/consult/index.ts` - TypeScript implementation
- `codev/bin/consult` - Backwards-compatible shim (delegates to TypeScript)
- `codev/roles/consultant.md` - Role definition
- `.consult/history.log` - Query history with timing (gitignored)

## Important Notes

1. **ALWAYS check `codev/protocols/spider/protocol.md`** for detailed phase instructions
2. **Use provided templates** from `codev/protocols/spider/templates/`
3. **Document all deviations** from the plan with reasoning
4. **Create atomic commits** for each phase completion
5. **Maintain >90% test coverage** where possible

## Code Metrics

Use **tokei** for measuring codebase size: `brew install tokei`

```bash
# Standard usage (excludes vendored/generated code)
tokei -e "tests/lib" -e "node_modules" -e ".git" -e ".builders" -e "dist" .
```

**Why tokei**:
- Fastest option (Rust, parallelized) - 0.012s vs cloc's 0.18s
- Parses embedded code in markdown separately
- Correctly classifies prose vs actual code
- Active development

**Alternatives** (if tokei unavailable): `scc` (Go), `cloc` (Perl)

## 🚨 CRITICAL: Before Starting ANY Task

### ALWAYS Check for Existing Work First

**BEFORE writing ANY code, run these checks:**

```bash
# Check if there's already a PR for this
gh pr list --search "XXXX"

# Check projectlist for status
cat codev/projectlist.md | grep -A5 "XXXX"

# Check if implementation already exists
git log --oneline --all | grep -i "feature-name"
```

**If existing work exists:**
1. READ the PR/commits first
2. TEST if it actually works
3. IDENTIFY specific bugs - don't rewrite from scratch
4. FIX the bugs minimally

### When Stuck: STOP After 15 Minutes

**If you've been debugging the same issue for 15+ minutes:**
1. **STOP coding immediately**
2. **Consult external models** (GPT-5, Gemini) with specific questions
3. **Ask the user** if you're on the right path
4. **Consider simpler approaches** - you're probably overcomplicating it

**Warning signs you're in a rathole:**
- Making incremental fixes that don't work
- User telling you you're overcomplicating it (LISTEN TO THEM)
- Trying multiple CDNs/versions/approaches without understanding why
- Not understanding the underlying technology (protocol, module system, etc.)

### Understand Before Coding

**Before implementing, you MUST understand:**
1. **The protocol/API** - Read docs, don't guess
2. **The module system** - ESM vs CommonJS vs UMD vs globals
3. **What already exists** - Check the codebase and git history
4. **The spec's assumptions** - Verify they're actually true

**Example of what NOT to do (Spec 0009 disaster):**
- Started coding without checking PR 28 existed
- PR 28 was merged but never tested (xterm v5 doesn't export globals)
- Spent 90 minutes trying different CDNs instead of understanding the problem
- Ignored user's repeated feedback about overcomplication
- Consulted external models only after an hour of failure

**What SHOULD have happened:**
```
1. Check projectlist.md → "0009 is committed, needs integration"
2. Check PR 28 → See what was implemented
3. Test PR 28 → Find it doesn't work
4. Identify ROOT CAUSE → xterm v5 module system issue
5. Research → How does ttyd load xterm?
6. Minimal fix → Match ttyd's approach
7. Total time: 20 minutes
```

## Lessons Learned from Test Infrastructure (Spec 0001)

### Critical Requirements

1. **Multi-Agent Consultation is MANDATORY**:
   - MUST consult GPT-5 AND Gemini Pro after implementation
   - MUST get FINAL approval from ALL experts on FIXED versions
   - Consultation happens BEFORE presenting to user, not after
   - Skipping consultation leads to rework and missed issues

2. **Test Environment Isolation**:
   - **NEVER touch real $HOME directories** in tests
   - Always use XDG sandboxing: `export XDG_CONFIG_HOME="$TEST_PROJECT/.xdg"`
   - Tests must be hermetic - no side effects on user environment
   - Use failing shims instead of removing from PATH

3. **Strong Assertions**:
   - Never use `|| true` patterns that mask failures
   - Avoid `assert true` - be specific about expectations
   - Create control tests to verify default behavior
   - Prefer behavior testing over implementation testing

4. **Platform Compatibility**:
   - Test on both macOS and Linux
   - Handle stat command differences
   - Use portable shell constructs
   - Gracefully handle missing dependencies

5. **Review Phase Requirements**:
   - Update ALL documentation (README, AGENTS.md/CLAUDE.md, specs, plans)
   - Review for systematic issues across the project
   - Update protocol documents based on lessons learned
   - Create comprehensive lessons learned document

## For Detailed Instructions

**READ THE FULL PROTOCOL**: `codev/protocols/spider/protocol.md`

This contains:
- Detailed phase descriptions
- Required evidence for each phase
- Expert consultation requirements
- Templates and examples
- Best practices

---

*Remember: Context drives code. When in doubt, write more documentation rather than less.*