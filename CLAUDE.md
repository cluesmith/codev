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
| 1.5.2 | Florence | Brunelleschi's dome atop the Florence Cathedral - engineering innovation enabling remote collaboration |

Future releases will continue this tradition, drawing from architectural wonders across cultures and eras.

### Release Process

To release a new version, simply tell the AI:
```
Let's release v1.6.0
```

The AI will guide you through the **RELEASE protocol** (`codev/protocols/release/protocol.md`):
1. Pre-flight checks (clean git, no running builders, no incomplete work)
2. MAINTAIN cycle (dead code removal, doc sync)
3. E2E tests
4. Version bump and git tag
5. Release notes
6. GitHub release
7. npm publish
8. Discussion forum announcement

The AI handles all the mechanical steps while you approve key decisions.

### Release Candidate Workflow (v1.7.0+)

Starting with v1.7.0, minor releases use release candidates for testing:

```
1.7.0-rc.1 → 1.7.0-rc.2 → 1.7.0 (stable)
```

| npm Tag | Purpose | Install Command |
|---------|---------|-----------------|
| `latest` | Stable releases | `npm install @cluesmith/codev` |
| `next` | Release candidates | `npm install @cluesmith/codev@next` |

- **Patch releases** (1.6.1, 1.6.2) go direct to stable for backported bug fixes
- **Minor releases** (1.7.0, 1.8.0) use RC workflow for testing first

See the full workflow in `codev/protocols/release/protocol.md`.

### Local Testing (Without Publishing)

To test changes locally before publishing to npm:

```bash
# From packages/codev directory:
cd packages/codev

# Build and create tarball
npm run build
npm pack

# Install globally from tarball
npm install -g ./cluesmith-codev-2.0.0-rc.10.tgz
```

This installs the exact package that would be published, without touching the npm registry. Better than `npm link` which has symlink issues.

**Do NOT use `npm link`** - it breaks global installs and has weird dependency resolution issues.

### UI Testing with Playwright

**IMPORTANT**: When making changes to UI code (tower, dashboard, terminal), you MUST test using Playwright before claiming the fix works. Do NOT rely solely on curl/API tests - they don't catch UI-level bugs.

**Default to headless mode** for automated testing:

```javascript
const browser = await chromium.launch({ headless: true });
```

**Test the actual user flow**, not just the API:

```bash
# From packages/codev directory
node test-launch-ui.cjs
```

Example test pattern:
```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('http://localhost:4100');
  await page.fill('#project-path', '/path/to/project');
  await page.click('button:has-text("Launch")');

  // Wait and check for errors
  const errorToast = await page.$('.toast.error');
  if (errorToast) {
    console.error('ERROR:', await errorToast.textContent());
    process.exit(1);
  }

  // Take screenshot for verification
  await page.screenshot({ path: '/tmp/test-result.png' });
  await browser.close();
})();
```

**When to use headed mode**: Only for debugging when you need to see what's happening visually. Add `{ headless: false }` temporarily.

## Quick Start

> **New to Codev?** See the [Cheatsheet](codev/resources/cheatsheet.md) for philosophies, concepts, and tool reference.

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

**Two complementary tracking systems:**

1. **`codev/projectlist.md`** - Master list of ALL projects (planning and history)
   - Contains status, priority, dependencies, and notes for every project
   - Reserve project numbers here BEFORE creating spec files
   - Update when project lifecycle changes (conceived → specified → committed → integrated)

2. **`codev/projects/<id>/status.yaml`** - Runtime state for ACTIVE porch projects
   - Detailed phase tracking (specify:draft, plan:consult, implement:phase_1, etc.)
   - Gate status (pending, passed, failed)
   - Managed automatically by porch

**When to use which:**
- **Starting work**: Check `codev/projectlist.md` for priorities and incomplete work
- **During implementation**: Use `porch status <id>` for detailed phase status
- **After completion**: Update `codev/projectlist.md` status field

**Note**: Porch state provides granular phase tracking during active development. Update projectlist.md when transitioning major lifecycle stages (conceived → specified → committed → integrated).

**🚨 CRITICAL: Two human approval gates exist:**
- **conceived → specified**: AI creates spec, but ONLY the human can approve it
- **committed → integrated**: AI can merge PRs, but ONLY the human can validate production

AI agents must stop at `conceived` after writing a spec, and stop at `committed` after merging.

**🚨 CRITICAL: Approved specs/plans need YAML frontmatter and must be committed to `main`.**
When the architect creates and approves a spec or plan before spawning a builder, it must have YAML frontmatter marking it as approved and validated, and be committed to `main`. Porch always runs the full protocol from `specify` — but when it finds an existing artifact with this metadata, it skips that phase as a no-op. If no spec/plan exists, porch drives the builder to create one.

Frontmatter format:
```yaml
---
approved: 2026-01-29
validated: [gemini, codex, claude]
---
```

## Agent Responsiveness

**Responsiveness is paramount.** The user should never wait for you. Use `run_in_background: true` for any operation that takes more than ~5 seconds.

### Default to Background Execution

| Task Type | Expected Duration | Action |
|-----------|------------------|--------|
| Running tests | 10-300s | `run_in_background: true` |
| Consultations (consult) | 60-250s | `run_in_background: true` |
| E2E test suites | 60-600s | `run_in_background: true` |
| npm install/build | 5-60s | `run_in_background: true` |
| Quick file reads/edits | <5s | Run normally |

### How to Use Background Tasks

```typescript
// In Bash tool call:
{
  "command": "npm test",
  "run_in_background": true  // REQUIRED for long tasks
}
```

**Critical**: Using `&` at the end of the command does NOT work - you MUST set the `run_in_background` parameter.

### Workflow

1. **Start long task in background** → Get task ID
2. **Continue interacting** with the user immediately
3. **Check results later** with `TaskOutput` when needed

### Never Block the User

❌ **Wrong**: Running 3-minute test suite while user waits
✅ **Right**: Starting test suite in background, continuing to answer questions

The user's time is valuable. Stay responsive.

## Protocol Selection Guide

### Use BUGFIX for (GitHub issue fixes):
- Bug reported as a **GitHub Issue**
- Fix is isolated (< 300 LOC net diff)
- No spec/plan artifacts needed
- Single builder can fix independently
- Examples:
  - "Login fails when username has spaces" (#42)
  - "consult-types/ not copied during adopt" (#127)
  - Crash on invalid input
  - Missing validation

**BUGFIX uses GitHub Issues as source of truth**, not projectlist.md. See `codev/protocols/bugfix/protocol.md`.

```bash
af spawn --issue 42      # Spawn builder for issue
af cleanup --issue 42    # Cleanup after merge
```

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
│   └── agents/             # AI agent definitions (custom project agents)
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

**CRITICAL: Keep Specs and Plans Separate**
- **DO NOT** put implementation plans in the spec file
- Specs define WHAT to build (requirements, acceptance criteria)
- Plans define HOW to build (phases, files to modify, implementation details)
- Each document serves a distinct purpose and must remain separate

## Multi-Agent Consultation

**DEFAULT BEHAVIOR**: Consultation is ENABLED by default with:
- **Gemini 3 Pro** (gemini-3-pro-preview) for deep analysis
- **GPT-5.2 Codex** (gpt-5.2-codex) for coding and architecture perspective

To disable: User must explicitly say "without multi-agent consultation"

**Consultation Checkpoints**:
1. **Specification Phase**: After draft and after human review
2. **Planning Phase**: After plan creation and after human review
3. **Implementation Phase**: After code implementation
4. **Defend Phase**: After test creation
5. **Evaluation Phase**: After evaluation completion
6. **Review Phase**: After review document

## Protocol Import Command

The `codev import` command provides AI-assisted import of protocol improvements from other codev projects.

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

**Example**:
```bash
# Import improvements from another project
codev import github:cluesmith/ansari-project

# Dry run to see what would be compared
codev import /path/to/project --dry-run
```

This replaces the older `codev-updater` and `spider-protocol-updater` agents with a more interactive, AI-assisted approach.

## CLI Command Reference

Codev provides three CLI tools designed for **both humans and AI agents**. The commands have simple, memorable names and consistent interfaces that work equally well whether typed by a human or called by an AI assistant.

For complete reference documentation, see:

- **[Overview](codev/resources/commands/overview.md)** - Quick start and summary of all tools
- **[codev](codev/resources/commands/codev.md)** - Project management (init, adopt, doctor, update, tower)
- **[af](codev/resources/commands/agent-farm.md)** - Agent Farm orchestration (start, spawn, status, cleanup, send, etc.)
- **[consult](codev/resources/commands/consult.md)** - AI consultation (pr, spec, plan, general)

## Architect-Builder Pattern

The Architect-Builder pattern enables parallel AI-assisted development by separating concerns:
- **Architect** (human + primary AI): Creates specs and plans, reviews work
- **Builders** (autonomous AI agents): Implement specs in isolated git worktrees

### Prerequisites

- **tmux**: `brew install tmux` (terminal multiplexer)
- **Node.js 18+**: For agent-farm runtime (includes node-pty for terminal sessions)
- **git 2.5+**: With worktree support

### CLI Commands

**Note:** `af`, `consult`, and `codev` are global commands installed via `npm install -g @cluesmith/codev`. They work from any directory.

```bash
# Start the architect dashboard
af dash start

# Spawn a builder for a spec (strict mode - porch orchestrates, default)
af spawn -p 0003

# Spawn in soft mode (AI follows protocol, you verify compliance)
af spawn --soft -p 0003

# Check status of all builders
af status

# Open a utility shell
af shell

# Open files in annotation viewer
af open src/auth/login.ts

# Clean up a builder (checks for uncommitted work first)
af cleanup --project 0003

# Force cleanup (WARNING: may lose uncommitted work)
af cleanup --project 0003 --force

# Stop all agent-farm processes
af dash stop

# Manage port allocations (for multi-project support)
af ports list
af ports cleanup
```

### Remote Access

Start Agent Farm on a remote machine and access it from your local workstation:

```bash
# On your local machine - one command does everything:
af dash start --remote user@remote-host

# Or with explicit project path:
af dash start --remote user@remote-host:/path/to/project

# With custom port:
af dash start --remote user@remote-host --port 4300
```

This single command:
1. SSHs into the remote machine
2. Starts Agent Farm there
3. Sets up SSH tunnel back to your local machine
4. Opens `http://localhost:4200` in your browser

The dashboard and all terminals work identically to local development. Press Ctrl+C to disconnect.

**Limitation**: File annotation tabs (`af open`) use separate ports and won't work through the tunnel. Use terminals for file viewing, or forward additional ports if needed.

**Note**: Requires SSH server on the remote machine. On Windows, enable OpenSSH Server or use WSL2.

### Configuration

Agent Farm is configured via `af-config.json` at the project root. Created during `codev init` or `codev adopt`. Override via CLI: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`.

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
- **Configurable commands**: Customize via `af-config.json` or CLI flags

### Key Files

- `.agent-farm/state.db` - Runtime state (SQLite: builders, ports, processes)
- `~/.agent-farm/global.db` - Global port registry (SQLite)
- `af-config.json` - Agent Farm configuration (project root)
- `codev/templates/` - Dashboard and annotation templates
- `codev/roles/` - Architect and builder role prompts

See `codev/specs/0002-architect-builder.md` for full documentation.

### Terminal Architecture (v2.0)

As of v2.0 (Spec 0085), Agent Farm uses **node-pty + WebSocket multiplexing** instead of ttyd:

- **One port per project**: The dashboard server (e.g., port 4200) serves both the React UI and all terminal WebSocket connections. There are no separate per-terminal ports.
- **tmux is still required**: tmux provides session persistence (survives disconnects). node-pty attaches to tmux sessions, not the other way around. Lifecycle: tmux session → node-pty PTY → `/ws/terminal/<uuid>` → React dashboard tab.
- **Terminal sessions**: `PtyManager` (`packages/codev/src/terminal/pty-manager.ts`) creates native PTY sessions via node-pty, each identified by a UUID. Sessions attach to tmux sessions (architect, builders, shells).
- **WebSocket path**: Clients connect to `/ws/terminal/<uuid>` on the dashboard port. The `TerminalManager` handles the upgrade and routes to the correct PTY session.
- **Tower proxy**: The tower (port 4100) is a multi-project reverse proxy. It routes `/project/<base64url-encoded-path>/*` to the project's dashboard port. All traffic (HTTP and WebSocket) goes to basePort — the tower does not need to know about terminal types.
- **React dashboard**: The frontend (`packages/codev/dashboard/`) manages tabs (Architect, Builder 0..N, Shell) and connects to the appropriate WebSocket endpoint for each terminal.

**Key distinction**: Tower (port 4100) ≠ Dashboard (port 4200+). `af tower` manages the tower. `af dash` manages dashboards. These are separate components.

See `codev/resources/arch.md` for detailed architecture diagrams.

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
- Use GPT-5.2 Codex (gpt-5.2-codex) for coding and architecture perspective
- Both models should be consulted unless explicitly specified otherwise

### cmap (Consult Multiple Agents in Parallel)

**cmap** is shorthand for "consult multiple agents in parallel in the background."

When the user says **"cmap the PR"** or **"cmap spec 42"**, this means:
1. Run a 3-way parallel review (Gemini, Codex, Claude)
2. Run all three in the **background** (`run_in_background: true`)
3. Return control to the user **immediately** so they can continue working
4. Retrieve results later with `TaskOutput` when needed

```bash
# "cmap PR 95" translates to:
consult --model gemini pr 95 &
consult --model codex pr 95 &
consult --model claude pr 95 &
# User continues working while reviews run
```

**Key principle**: cmap is non-blocking. The user should never wait for consultations to complete before they can continue interacting.

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

Review type prompts are in `codev/consult-types/`. The prompt is appended to the consultant role.

> **Migration Note (v1.4.0+)**: Review types moved from `codev/roles/review-types/` to `codev/consult-types/`. The old location still works with a deprecation warning. Run `codev doctor` to check your setup.

### Parallel Consultation (3-Way Reviews)

**IMPORTANT**: 3-way reviews should ALWAYS be run:
1. **In parallel** - All three models at once, not sequentially
2. **In background** - Use `run_in_background: true` so you can continue working

```bash
# CORRECT: Three separate Bash tool calls with run_in_background: true
# This lets you continue working while reviews run
consult --model gemini pr 95
consult --model codex pr 95
consult --model claude pr 95
```

**Important**: When using the Bash tool, you MUST set `run_in_background: true` in the tool parameters. Using `&` at the end of the command alone does NOT work - the tool will still block.

**Why background?** Each consultation takes 60-250 seconds. Running sequentially wastes time; running in foreground blocks other work.

### Model Aliases

| Alias | Resolves To | CLI Used |
|-------|-------------|----------|
| `gemini` | gemini-3-pro-preview | gemini-cli |
| `pro` | gemini-3-pro-preview | gemini-cli |
| `codex` | gpt-5.2-codex | codex |
| `gpt` | gpt-5.2-codex | codex |
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
- `codev/roles/consultant.md` - Role definition
- `.consult/history.log` - Query history with timing (gitignored)

## Porch - Protocol Orchestrator

Porch is the protocol orchestration system that drives SPIDER, TICK, and BUGFIX protocols. It uses a state machine to enforce phase transitions, manage gates, run defense checks, and coordinate multi-agent consultations.

### CLI Commands

```bash
# Initialize a new porch project
porch init spider 0073 "feature-name" --worktree .builders/0073

# Check current status
porch status 0073

# List pending gates
porch pending

# Approve a gate
porch approve 0073 spec-approval

# Run the protocol loop (single iteration)
porch run 0073

# Run with options
porch run 0073 --dry-run        # Show what would happen
porch run 0073 --no-claude      # Skip Claude invocations
```

### Spawning Builders

`af spawn -p` uses **strict mode by default** (porch orchestrates autonomously):

```bash
# Strict mode (default) - porch orchestrates, runs to completion
af spawn -p 0073

# With project title (if no spec exists yet)
af spawn -p 0073 -t "feature-name"

# With specific protocol
af spawn -p 0073 --use-protocol spider

# Resume existing porch state
af spawn -p 0073 --resume

# Without role prompt
af spawn -p 0073 --no-role
```

This combines:
1. Creating a git worktree
2. Initializing porch state
3. Starting the builder with porch context

For soft mode (AI follows protocol, you verify compliance), use `--soft`:
```bash
af spawn --soft -p 0073  # AI follows protocol, architect verifies
```

### Project State

Porch state is stored in `codev/projects/<id>-<name>/status.yaml`:

```yaml
id: "0073"
title: "feature-name"
protocol: "spider"
current_state: "implement:coding"
gates:
  spec-approval:
    status: passed
    approved_at: "2026-01-19T10:30:00Z"
phases:
  phase-1:
    status: complete
    title: "Core Implementation"
iteration: 3
```

### Protocol Definitions

Protocols are defined in `codev-skeleton/protocols/<name>/protocol.json`:

```json
{
  "name": "spider",
  "version": "1.0.0",
  "phases": [
    {
      "id": "specify",
      "type": "once",
      "consultation": { "models": ["gemini", "codex", "claude"] },
      "gate": { "name": "spec-approval", "next": "plan" }
    }
  ]
}
```

### Signal-Based Transitions

Porch uses signals embedded in Claude output to drive state transitions:

```
<signal>PHASE_COMPLETE</signal>     # Move to next phase
<signal>BLOCKED:reason</signal>     # Report blocker
<signal>REVISION_NEEDED</signal>    # Request changes
```

### Key Files

- `packages/codev/src/commands/porch/` - Porch implementation
- `packages/codev/bin/porch.js` - Standalone binary
- `codev-skeleton/protocols/` - Protocol JSON definitions
- `codev-skeleton/protocols/protocol-schema.json` - JSON Schema for protocol.json
- `codev/resources/protocol-format.md` - Protocol definition format reference
- `codev/projects/` - Project state files

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