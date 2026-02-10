# Codev Project Instructions for AI Agents

> **Note**: This file is specific to Claude Code. An identical [AGENTS.md](AGENTS.md) file is also maintained following the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility with Cursor, GitHub Copilot, and other AI coding assistants. Both files contain the same content and should be kept synchronized.

## Project Context

**THIS IS THE CODEV SOURCE REPOSITORY - WE ARE SELF-HOSTED**

This project IS Codev itself, and we use our own methodology for development. All new features and improvements to Codev should follow the SPIR protocol defined in `codev/protocols/spir/protocol.md`.

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

### Release Process

To release a new version, tell the AI: `Let's release v1.6.0`. The AI follows the **RELEASE protocol** (`codev/protocols/release/protocol.md`). Release candidate workflow and local testing procedures are documented there. For local testing shortcuts, see `codev/resources/testing-guide.md`.

### Testing

When making changes to UI code (tower, dashboard, terminal), you MUST test using Playwright before claiming the fix works. See `codev/resources/testing-guide.md` for procedures, including local build testing, Playwright patterns, and Tower regression prevention.

## Quick Start

> **New to Codev?** See the [Cheatsheet](codev/resources/cheatsheet.md) for philosophies, concepts, and tool reference.

You are working in the Codev project itself, with multiple development protocols available:

**Available Protocols**:
- **SPIR**: Multi-phase development with consultation - `codev/protocols/spir/protocol.md`
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

| Task Type | Expected Duration | Action |
|-----------|------------------|--------|
| Running tests | 10-300s | `run_in_background: true` |
| Consultations (consult) | 60-250s | `run_in_background: true` |
| E2E test suites | 60-600s | `run_in_background: true` |
| npm install/build | 5-60s | `run_in_background: true` |
| Quick file reads/edits | <5s | Run normally |

**Critical**: Using `&` at the end of the command does NOT work - you MUST set the `run_in_background` parameter.

## Protocol Selection Guide

### Use BUGFIX for (GitHub issue fixes):
- Bug reported as a **GitHub Issue**
- Fix is isolated (< 300 LOC net diff)
- No spec/plan artifacts needed
- Single builder can fix independently

**BUGFIX uses GitHub Issues as source of truth**, not projectlist.md. See `codev/protocols/bugfix/protocol.md`.

### Use TICK for (amendments to existing specs):
- **Amendments** to an existing SPIR spec that is already `integrated`
- Small scope (< 300 lines of new/changed code)
- Clear requirements that extend existing functionality

**TICK modifies spec/plan in-place** and creates a new review file. Cannot be used for greenfield work.

### Use SPIR for (new features):
- Creating a **new feature from scratch** (no existing spec to amend)
- New protocols or protocol variants
- Major changes to existing protocols
- Complex features requiring multiple phases
- Architecture changes

### Use EXPERIMENT for:
- Testing new approaches or techniques
- Evaluating models or libraries
- Proof-of-concept work
- Research spikes

### Use MAINTAIN for:
- Removing dead code and unused dependencies
- Quarterly codebase maintenance
- Before releases (clean slate for shipping)
- Syncing documentation (arch.md, lessons-learned.md, CLAUDE.md/AGENTS.md)

### Skip formal protocols for:
- README typos or minor documentation fixes
- Small bug fixes in templates
- Dependency updates

## Core Workflow

1. **When asked to build NEW FEATURES FOR CODEV**: Start with the Specification phase
2. **Create exactly THREE documents per feature**: spec, plan, and review (all with same filename)
3. **Follow the SPIR phases**: Specify → Plan → Implement → Review
4. **Use multi-agent consultation by default** unless user says "without consultation"

## Directory Structure
```
project-root/
├── codev/
│   ├── protocols/           # Development protocols
│   │   ├── spir/          # Multi-phase development with consultation
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
│       ├── testing-guide.md # Local testing, Playwright, regression prevention
│       └── lessons-learned.md  # Extracted wisdom from reviews (generated during MAINTAIN)
├── .claude/
│   └── agents/             # AI agent definitions (custom project agents)
├── AGENTS.md              # Universal AI agent instructions (AGENTS.md standard)
├── CLAUDE.md              # This file (Claude Code-specific, identical to AGENTS.md)
└── [project code]
```

## Directory Map
- npm install / npm run build / npm test → always run from `packages/codev/`
- E2E tests → `packages/codev/tests/e2e/`
- Unit tests → `packages/codev/tests/unit/`
- Never run npm commands from the repository root unless explicitly told to.

## File Naming Convention

Use sequential numbering with descriptive names:
- Specification: `codev/specs/0001-feature-name.md`
- Plan: `codev/plans/0001-feature-name.md`
- Review: `codev/reviews/0001-feature-name.md`

**CRITICAL: Keep Specs and Plans Separate**
- Specs define WHAT to build (requirements, acceptance criteria)
- Plans define HOW to build (phases, files to modify, implementation details)
- Each document serves a distinct purpose and must remain separate

## Multi-Agent Consultation

**DEFAULT BEHAVIOR**: Consultation is ENABLED by default with:
- **Gemini 3 Pro** (gemini-3-pro-preview) for deep analysis
- **GPT-5.2 Codex** (gpt-5.2-codex) for coding and architecture perspective

To disable: User must explicitly say "without multi-agent consultation"

**CRITICAL CONSULTATION CHECKPOINTS (DO NOT SKIP):**
- After writing implementation code → STOP → Consult GPT-5 and Gemini Pro
- After writing tests → STOP → Consult GPT-5 and Gemini Pro
- ONLY THEN present results to user for evaluation

### cmap (Consult Multiple Agents in Parallel)

**cmap** is shorthand for "consult multiple agents in parallel in the background."

When the user says **"cmap the PR"** or **"cmap spec 42"**, this means:
1. Run a 3-way parallel review (Gemini, Codex, Claude)
2. Run all three in the **background** (`run_in_background: true`)
3. Return control to the user **immediately**
4. Retrieve results later with `TaskOutput` when needed

**Always run consultations in parallel** using separate Bash tool calls in the same message, not sequentially.

## CLI Command Reference

**IMPORTANT: Never guess CLI commands.** Use the `/af` skill to check the quick reference before running agent farm commands. Common mistakes to avoid:
- There is NO `codev tower` command — use `af tower start` / `af tower stop`
- There is NO `restart` subcommand — stop then start
- When unsure about syntax, check the docs below first

Codev provides three CLI tools. For complete reference documentation, see:

- **[Overview](codev/resources/commands/overview.md)** - Quick start and summary of all tools
- **[codev](codev/resources/commands/codev.md)** - Project management (init, adopt, doctor, update, tower)
- **[af](codev/resources/commands/agent-farm.md)** - Agent Farm orchestration (start, spawn, status, cleanup, send, etc.)
- **[consult](codev/resources/commands/consult.md)** - AI consultation (pr, spec, plan, general)

## Architect-Builder Pattern

The Architect-Builder pattern enables parallel AI-assisted development:
- **Architect** (human + primary AI): Creates specs and plans, reviews work
- **Builders** (autonomous AI agents): Implement specs in isolated git worktrees

For detailed commands, configuration, and architecture, see:
- `codev/resources/commands/agent-farm.md` - Full CLI reference
- `codev/resources/arch.md` - Terminal architecture, state management
- `codev/resources/workflow-reference.md` - Stage-by-stage workflow

### Pre-Spawn Rule

**Commit all local changes before `af spawn`.** Builders work in git worktrees branched from HEAD — uncommitted specs, plans, and codev updates are invisible to the builder. The spawn command enforces this (override with `--force`).

### Key Commands

```bash
af dash start              # Start the architect dashboard
af spawn -p 0003           # Spawn builder (strict mode, default)
af spawn --soft -p 0003    # Spawn builder (soft mode)
af spawn --issue 42        # Spawn builder for a bugfix
af status                  # Check all builders
af cleanup --project 0003  # Clean up after merge
```

### Configuration

Agent Farm is configured via `af-config.json` at the project root. Created during `codev init` or `codev adopt`. Override via CLI: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`.

## Porch - Protocol Orchestrator

Porch drives SPIR, TICK, and BUGFIX protocols via a state machine with phase transitions, gates, and multi-agent consultations.

### Key Commands

```bash
porch init spir 0073 "feature-name" --worktree .builders/0073
porch status 0073
porch run 0073
porch approve 0073 spec-approval    # Human only
porch pending                        # List pending gates
```

### Project State

State is stored in `codev/projects/<id>-<name>/status.yaml`, managed automatically by porch. See `codev/resources/protocol-format.md` for protocol definition format.

## Git Workflow

### 🚨 ABSOLUTE PROHIBITION: NEVER USE `git add -A` or `git add .` 🚨

**THIS IS A CRITICAL SECURITY REQUIREMENT - NO EXCEPTIONS**

```bash
git add -A        # ABSOLUTELY FORBIDDEN
git add .         # ABSOLUTELY FORBIDDEN
git add --all     # ABSOLUTELY FORBIDDEN
```

**MANDATORY APPROACH - ALWAYS ADD FILES EXPLICITLY**:
```bash
git add codev/specs/0001-feature.md
git add src/components/TodoList.tsx
```

**BEFORE EVERY COMMIT**: Run `git status`, add each file explicitly by name.

### Commit Messages
```
[Spec 0001] Initial specification draft
[Spec 0001][Phase: user-auth] feat: Add password hashing
[Bugfix #42] Fix: URL-encode username before API call
```

### Branch Naming
```
spir/0001-feature-name/phase-name
builder/bugfix-42-description
```

### Pull Request Merging

**DO NOT SQUASH MERGE** - Always use regular merge commits:
```bash
gh pr merge <number> --merge    # CORRECT
```

Individual commits document the development process. Squashing loses this valuable history.

## Code Metrics

Use **tokei** for measuring codebase size: `tokei -e "tests/lib" -e "node_modules" -e ".git" -e ".builders" -e "dist" .`

## Before Starting ANY Task

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

**If existing work exists**: READ it first, TEST if it works, IDENTIFY specific bugs, FIX minimally.

### When Stuck: STOP After 15 Minutes

**If you've been debugging the same issue for 15+ minutes:**
1. **STOP coding immediately**
2. **Consult external models** (GPT-5, Gemini) with specific questions
3. **Ask the user** if you're on the right path
4. **Consider simpler approaches** - you're probably overcomplicating it

**Warning signs you're in a rathole:**
- Making incremental fixes that don't work
- User telling you you're overcomplicating it (LISTEN TO THEM)
- Trying multiple approaches without understanding why none work
- Not understanding the underlying technology

### Understand Before Coding

**Before implementing, you MUST understand:**
1. **The protocol/API** - Read docs, don't guess
2. **The module system** - ESM vs CommonJS vs UMD vs globals
3. **What already exists** - Check the codebase and git history
4. **The spec's assumptions** - Verify they're actually true

## Important Notes

1. **ALWAYS check `codev/protocols/spir/protocol.md`** for detailed phase instructions
2. **Use provided templates** from `codev/protocols/spir/templates/`
3. **Document all deviations** from the plan with reasoning
4. **Create atomic commits** for each phase completion
5. **Maintain >90% test coverage** where possible

---

*Remember: Context drives code. When in doubt, write more documentation rather than less.*
