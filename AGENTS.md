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
   - Example: `codev/specs/1-test-infrastructure.md` is a feature spec for Codev itself

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

### Local Build Testing

To test changes locally before publishing to npm:

```bash
# From the repository root:

# 1. Build (Tower stays up during this)
pnpm build

# 2. Pack, install globally, and restart Tower (one command)
pnpm -w run local-install
```

- `pnpm build` builds core first, then codev (including dashboard)
- `pnpm -w run local-install` runs `scripts/local-install.sh`, which:
  - Packs both `@cluesmith/codev-core` and `@cluesmith/codev` tarballs into their package directories
  - Globally installs both in one `npm install -g` (separate installs fail because `@cluesmith/codev-core` isn't on the public npm registry)
  - Restores the executable bit on `scripts/forge/**/*.sh` (pnpm pack strips it, causing "GitHub CLI unavailable" errors otherwise)
  - Restarts Tower so it picks up the new code
- Install runs while Tower is up — only the final restart causes downtime
- Do NOT stop Tower yourself before running the script — the script handles restart at the end
- Do NOT use `npm link` or `pnpm link` — it breaks global installs

### Testing

When making changes to UI code (tower, dashboard, terminal), you MUST test using Playwright before claiming the fix works. See `codev/resources/testing-guide.md` for Playwright patterns and Tower regression prevention.

## Quick Start

> **New to Codev?** See the [Cheatsheet](codev/resources/cheatsheet.md) for philosophies, concepts, and tool reference.

You are working in the Codev project itself, with multiple development protocols available:

**Available Protocols**:
- **SPIR**: Multi-phase development with consultation - `codev/protocols/spir/protocol.md`
- **ASPIR**: Autonomous SPIR (no human gates on spec/plan) - `codev/protocols/aspir/protocol.md`
- **AIR**: Autonomous Implement & Review for small features - `codev/protocols/air/protocol.md`
- **BUGFIX**: Bug fixes from GitHub issues - `codev/protocols/bugfix/protocol.md`
- **PIR**: Plan / Implement / Review — issue-driven with two pre-PR human gates (plan-approval, dev-approval) plus a post-PR `pr` gate. Lighter than SPIR; stronger than BUGFIX/AIR. Useful when a change needs design review before coding OR pre-PR testing of running code (e.g., mobile / UI / cross-platform). See `codev/protocols/pir/protocol.md`.
- **EXPERIMENT**: Disciplined experimentation - `codev/protocols/experiment/protocol.md`
- **MAINTAIN**: Codebase maintenance (code hygiene + documentation sync) - `codev/protocols/maintain/protocol.md`
- **RESEARCH**: Multi-agent research with 3-way investigation, synthesis, and critique - `codev/protocols/research/protocol.md`

### File Resolution (How Codev Finds Protocols and Templates)

Codev resolves protocol files, prompts, agent definitions, and roles through a four-tier lookup (highest priority first):

1. `.codev/<path>` — user override (project-local customization)
2. `codev/<path>` — project-local copy (customized and checked in)
3. Runtime cache
4. **Installed package skeleton** — ships with `@cluesmith/codev` (the default for every standard protocol)

**The absence of `codev/protocols/<name>/` on disk is not a missing reference** — it's the normal case for any protocol you haven't customized. The protocol resolves from the installed package's skeleton at runtime. Only protocols you want to customize need to live in your repo's `codev/protocols/`.

**Implication for `codev update` and CLAUDE.md / AGENTS.md merges:** when an updated template references a protocol (e.g., PIR), do NOT drop the reference because `codev/protocols/<name>/` is absent locally. The protocol resolves via the package skeleton, and dropping the reference removes the protocol from the user's available-protocol list while it's still callable from the CLI.

### Protocol Verification (When You Don't Recognize a Protocol Name)

If the user mentions a protocol name you don't immediately recognize, verify against the CLI before responding:

```bash
afx spawn --protocol <name> --help
```

This succeeds if the protocol is registered (including via the skeleton fallback in tier 4 of the resolution chain) and errors helpfully otherwise. The CLI is the source of truth — defer to it when in doubt.

Key locations:
- Protocol details: `codev/protocols/` (Choose appropriate protocol)
- **Project tracking**: GitHub Issues (source of truth for all projects)
- Specifications go in: `codev/specs/`
- Plans go in: `codev/plans/`
- Reviews go in: `codev/reviews/`

### Project Tracking

**GitHub Issues are the source of truth for project tracking.**

- Issues with the `spec` label have approved specifications
- Issues with the `plan` label have approved plans
- Active builders are tracked via `codev/projects/<id>/status.yaml` (managed by porch)
- The workspace overview Work view shows builders, PRs, and backlog derived from GitHub + filesystem state

**When to use which:**
- **Starting work**: Check GitHub Issues for priorities and backlog
- **During implementation**: Use `porch status <id>` for detailed phase status
- **After completion**: Close the GitHub Issue when PR is merged

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
| pnpm install/build | 5-60s | `run_in_background: true` |
| Quick file reads/edits | <5s | Run normally |

**Critical**: Using `&` at the end of the command does NOT work - you MUST set the `run_in_background` parameter.

## Protocol Selection Guide

### Use BUGFIX for (GitHub issue fixes):
- Bug reported as a **GitHub Issue**
- Fix is isolated (< 300 LOC net diff)
- No spec/plan artifacts needed
- Single builder can fix independently

**BUGFIX uses GitHub Issues as source of truth.** See `codev/protocols/bugfix/protocol.md`.

### Use AIR for (small features from GitHub issues):
- Small features (< 300 LOC) fully described in a **GitHub Issue**
- No architectural decisions needed
- No spec/plan artifacts — review goes in the PR body
- Would be overkill for full SPIR/ASPIR ceremony

**AIR uses GitHub Issues as source of truth.** Two phases: Implement → Review. See `codev/protocols/air/protocol.md`.

### Use PIR for (engineer-judged — based on the nature of the work, not its size):

Pick PIR when ONE or BOTH of the following apply to a GitHub-issue-driven change:

**1. The approach needs review before coding starts**:
- Root cause is ambiguous; multiple valid fixes exist
- Area is unfamiliar or high-blast-radius (shared utilities, auth, migrations, public APIs)
- Design-sensitive (affects conventions, patterns, architecture)
- Cheaper to redirect at plan time than at PR time

**2. The implementation needs to be TESTED before a PR is created** (PR diff alone is insufficient):
- Mobile app changes (needs device testing on Android, iOS, possibly web)
- UI / UX changes (visual inspection, interaction flow, accessibility)
- Hardware-adjacent behavior (sensors, camera, permissions, notifications)
- Integration with external services that don't mock cleanly (OAuth, payments, analytics)
- User-journey changes that need a full-flow exercise
- Performance-sensitive changes that need profiling on the running app

**PIR uses GitHub Issues as source of truth.** Three phases: Plan (gated by `plan-approval`) → Implement (gated by `dev-approval`) → Review (PR + CMAP-2 at PR, then gated by `pr` for merge synchronization — matching SPIR's pr-gate pattern but with no post-merge verify phase). Plan and review artifacts live in `codev/plans/` and `codev/reviews/` on the builder branch, ship to main with the merge. Review file is shaped identically to SPIR's (Summary + Architecture Updates + Lessons Learned + supporting sections) so `codev/reviews/` stays semantically consistent across protocols. Lighter than SPIR (no spec phase — the issue body is the implicit spec; consult footprint matches BUGFIX/AIR's "one consult at PR" pattern). Stronger than BUGFIX/AIR (two human gates pre-PR — the human reviews the running worktree at the `dev-approval` gate, not the PR diff post-creation). CMAP at the PR is a **single advisory pass** (`max_iterations: 1`) — no iterate-until-APPROVE loop; a `REQUEST_CHANGES` is escalated to the human at the `pr` gate, not auto-re-reviewed. The CMAP-2 footprint is a design invariant: porch's model precedence is *config > protocol*, so a project-wide `porch.consultation.models` (e.g. a SPIR-tuned 3-model list) silently inflates PIR — leave it unset or scope it per-protocol to preserve the BUGFIX/AIR-parity cost. See `codev/protocols/pir/protocol.md`.

### Use SPIR for (new features):
- Creating a **new feature from scratch** (no existing spec to amend)
- New protocols or protocol variants
- Major changes to existing protocols
- Complex features requiring multiple phases
- Architecture changes

### Use ASPIR for (autonomous SPIR):
- Same as SPIR but **without human approval gates** on spec and plan
- Trusted, low-risk work where spec/plan review can be deferred to PR
- Builder runs autonomously through Specify → Plan → Implement → Review (→ Verify)
- Human approval still required at the PR gate before merge

**ASPIR is identical to SPIR** except `spec-approval` and `plan-approval` gates are removed. Both include an optional verify phase after review. See `codev/protocols/aspir/protocol.md`.

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

### Use RESEARCH for:
- Competitive analysis and technology evaluation
- Market research and "state of X" questions
- Architectural decision support when unfamiliar with the domain
- Triangulating across 3 AI models to get a high-confidence answer
- Output goes to `codev/research/<topic>.md`

### Skip formal protocols for:
- README typos or minor documentation fixes
- Small bug fixes in templates
- Dependency updates

## Core Workflow

1. **When asked to build NEW FEATURES FOR CODEV**: Start with the Specification phase
2. **Create exactly THREE documents per feature**: spec, plan, and review (all with same filename)
3. **Follow the SPIR phases**: Specify → Plan → Implement → Review (→ Verify)
4. **Use multi-agent consultation by default** unless user says "without consultation"

## Directory Structure
```
project-root/
├── codev/
│   ├── protocols/           # Development protocols
│   │   ├── spir/          # Multi-phase development with consultation
│   │   ├── experiment/     # Disciplined experimentation
│   │   └── maintain/       # Codebase maintenance (code + docs)
│   ├── maintain/            # MAINTAIN protocol runtime artifacts
│   │   └── .trash/         # Soft-deleted files (gitignored, 30-day retention)
│   ├── projects/           # Active project state (managed by porch)
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
- pnpm install → always run from the repository root (installs all workspace packages)
- pnpm build / pnpm test → run from `packages/codev/` or use `pnpm --filter @cluesmith/codev build`
- E2E tests → `packages/codev/tests/e2e/`
- Unit tests → `packages/codev/tests/unit/`
- Never run npm commands from the repository root unless explicitly told to.

## File Naming Convention

Use sequential numbering with descriptive names (no leading zeros):
- Specification: `codev/specs/42-feature-name.md`
- Plan: `codev/plans/42-feature-name.md`
- Review: `codev/reviews/42-feature-name.md`

**CRITICAL: Keep Specs and Plans Separate**
- Specs define WHAT to build (requirements, acceptance criteria)
- Plans define HOW to build (phases, files to modify, implementation details)
- Each document serves a distinct purpose and must remain separate

## Multi-Agent Consultation

**DEFAULT BEHAVIOR**: Consultation is ENABLED by default with:
- **Gemini 3 Pro** (gemini-3-pro-preview) for deep analysis
- **GPT-5.4 Codex** (gpt-5.4-codex) for coding and architecture perspective

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

**IMPORTANT: Never guess CLI commands.** Use the `/afx` skill to check the quick reference before running agent farm commands. Common mistakes to avoid:
- There is NO `codev tower` command — use `afx tower start` / `afx tower stop`
- There is NO `restart` subcommand — stop then start
- When unsure about syntax, check the docs below first

Codev provides five CLI tools. For complete reference documentation, see:

- **[Overview](codev/resources/commands/overview.md)** - Quick start and summary of all tools
- **[codev](codev/resources/commands/codev.md)** - Project management (init, adopt, doctor, update, tower)
- **[afx](codev/resources/commands/agent-farm.md)** - Agent Farm orchestration (start, spawn, status, cleanup, send, etc.)
- **[porch](codev/resources/commands/overview.md#porch---protocol-orchestrator)** - Protocol orchestrator (status, run, approve, pending)
- **[consult](codev/resources/commands/consult.md)** - AI consultation (general, protocol, stats)
- **[team](codev/resources/commands/team.md)** - Team coordination (list, message, update, add)

## Runnable Worktrees

When configured, each builder worktree (`.builders/<id>/`) becomes runnable — reviewers can spin up a dev server against the builder's branch without `cd`'ing, manually installing, or finding the right command. Opt-in via `.codev/config.json`; unconfigured repos see zero behavior change.

### Config: the `worktree` block

```jsonc
{
  "worktree": {
    "symlinks":   ["..."],        // glob patterns of files to symlink from root into each new worktree
    "postSpawn":  ["..."],        // shell commands run inside each new worktree after createWorktree
    "devCommand": "..."           // consumed by `afx dev <builder-id>`
  }
}
```

- `symlinks`: globs resolve from the workspace root; matches symlink into the worktree at the same relative path. Root `.env` and `.codev/config.json` are *always* symlinked regardless. **Symlinks, not copies** — edits to main's env files reflect instantly in any running dev session.
- `postSpawn`: each command runs sequentially with `cwd` = worktree path. Non-zero exit aborts the spawn loud (half-built worktree stays for inspection).
- `devCommand`: the foreground command that starts your dev server. Required for `afx dev` to work.

**Codev does not auto-detect your stack.** Pick the recipe below that matches your toolchain.

### CLI

```bash
afx dev <builder-id>     # start the dev server in <builder-id>'s worktree
afx dev --stop           # stop the currently running dev PTY
```

Only one dev PTY runs at a time (by design — see "URLs are load-bearing" below). Running `afx dev` while another builder's dev is up prompts for swap. Same-builder requests print the existing terminal URL and exit.

### VSCode

The same actions are available via right-click on any builder row in the Codev sidebar (Builders or Needs Attention view):

- **Codev: Open Builder Terminal** — opens that builder's AI terminal in a VSCode tab (same as left-clicking the row).
- **Codev: Open Worktree Folder** — opens `.builders/<id>/` in the OS file manager (Finder on macOS, Explorer on Windows, xdg-open on Linux).
- **Codev: Run Worktree Setup** — applies the configured `worktree.symlinks` and runs the `worktree.postSpawn` commands against the existing worktree (mirrors what spawn does, minus the git steps). Idempotent: existing symlinks are skipped, missing ones added. Useful when the lockfile changed (reinstall deps), `symlinks` or `postSpawn` was extended after the builder spawned, a symlink was accidentally deleted, or the original setup aborted mid-run. Opens a fresh VSCode terminal so install output streams live. Available via CLI too: `afx setup <builder-id>`.
- **Codev: View Diff** — opens a single unified diff editor for `main...HEAD` of that builder's worktree, with a file-list pane on the left (matches VSCode's built-in Source Control "Working Tree" view). Status icons indicate added / modified / deleted. Empty diff → friendly toast.
- **Codev: Run Dev Server** — reads `worktree.devCommand` from `.codev/config.json`, asks Tower to spawn a dev PTY in the builder's worktree, and opens it as a VSCode terminal tab named `Codev: <name> (dev)`. If another builder's dev is already running, you get a modal asking whether to swap.
- **Codev: Stop Dev Server** — kills the running dev PTY and closes its tab.

The three commands are also available from the command palette (Cmd+Shift+P). No default keybindings; bind via `keybindings.json` if you use them often.

### URLs are load-bearing

The dev PTY uses **the same ports and URLs as main** intentionally. OAuth callbacks, CORS allowlists, cookie scoping, CSP `connect-src`, webhook URLs are all keyed off origin — running the worktree on a different port would break them. Consequence: stop main's `pnpm dev` before `afx dev`. If you don't, the spawned dev fails at bind time with its own `EADDRINUSE`.

### Cleanup semantics

`afx dev --stop` and the swap path kill the entire PTY process group (SIGTERM, escalating to SIGKILL after 5s via `PtySession.kill`). That signals every grandchild of a monorepo dev orchestrator (`pnpm dev`, `turbo dev`, `pnpm -r --parallel run dev`, etc.) simultaneously. The OS reclaims ports as a consequence — Codev never touches ports directly.

**Orphan recovery** — if Tower itself hard-crashes mid-dev and a process is left holding a port outside Codev's records:

```bash
lsof -ti :<port> | xargs kill                       # one port
lsof -ti :3000,:3001,:4000 | xargs kill             # several at once
```

### Runnable Worktree Recipes

Ready-to-paste blocks per stack. Adjust ports / paths to your project.

**pnpm monorepo (Next.js + Turbo style):**
```json
{
  "worktree": {
    "symlinks": [".env.local", ".env.development.local", "packages/*/.env", "packages/*/.env.local", "turbo.json"],
    "postSpawn": ["pnpm install --frozen-lockfile"],
    "devCommand": "pnpm dev"
  }
}
```

**npm (single package):**
```json
{
  "worktree": {
    "symlinks": [".env.local", ".env.development"],
    "postSpawn": ["npm ci"],
    "devCommand": "npm run dev"
  }
}
```

**yarn:**
```json
{
  "worktree": {
    "symlinks": [".env.local"],
    "postSpawn": ["yarn install --frozen-lockfile"],
    "devCommand": "yarn dev"
  }
}
```

**bun:**
```json
{
  "worktree": {
    "symlinks": [".env.local"],
    "postSpawn": ["bun install --frozen-lockfile"],
    "devCommand": "bun dev"
  }
}
```

**cargo (Rust):**
```json
{
  "worktree": {
    "symlinks": [".env"],
    "postSpawn": [],
    "devCommand": "cargo run"
  }
}
```

**poetry / uv (Python):**
```json
{
  "worktree": {
    "symlinks": [".env", ".env.local"],
    "postSpawn": ["uv sync"],
    "devCommand": "uv run python -m myapp"
  }
}
```

**go mod:**
```json
{
  "worktree": {
    "symlinks": [".env"],
    "postSpawn": ["go mod download"],
    "devCommand": "go run ./cmd/server"
  }
}
```

## Architect-Builder Pattern

The Architect-Builder pattern enables parallel AI-assisted development:
- **Architect** (human + primary AI): Creates specs and plans, reviews work
- **Builders** (autonomous AI agents): Implement specs in isolated git worktrees

For detailed commands, configuration, and architecture, see:
- `codev/resources/commands/agent-farm.md` - Full CLI reference
- `codev/resources/arch.md` - Terminal architecture, state management
- `codev/resources/workflow-reference.md` - Stage-by-stage workflow

### 🚨 NEVER DESTROY BUILDER WORKTREES 🚨

**When a worktree already exists for a project:**
1. Use `afx spawn XXXX --resume`
2. If `--resume` fails → **ASK THE USER**
3. Only destroy if the user explicitly says to

**NEVER run without EXPLICIT user request:**
- `git worktree remove` (with or without --force)
- `git branch -D` on builder branches
- `afx cleanup` followed by fresh spawn

**You are NOT qualified to judge what's expendable.** It is NEVER your call to delete a worktree.

### 🚨 ALWAYS Operate From the Main Workspace Root 🚨

**ALL `afx` commands (`afx spawn`, `afx send`, `afx status`, `afx workspace`, `afx cleanup`) MUST be run from the repository root on the `main` branch.**

- **NEVER** run `afx spawn` from inside a builder worktree — builders will get nested inside that worktree, breaking everything
- **NEVER** run `afx workspace start` from a worktree — there is no separate workspace per worktree
- **NEVER** `cd` into a worktree to run afx commands
- The **only exception** is `porch` commands that need worktree context (e.g. `porch approve` from a builder's worktree)

**What happened**: On 2026-02-21, `afx spawn` was run from inside a builder's worktree. All new builders were nested inside that worktree, `afx send` couldn't find them, and `afx status` showed "not active in tower". Multiple builders had to be killed and respawned.

### Pre-Spawn Rule

**Commit all local changes before `afx spawn`.** Builders work in git worktrees branched from HEAD — uncommitted specs, plans, and codev updates are invisible to the builder. The spawn command enforces this (override with `--force`).

### Key Commands

```bash
afx workspace start                   # Start the workspace
afx spawn 42 --protocol spir          # Spawn builder for SPIR project
afx spawn 42 --protocol spir --soft   # Spawn builder (soft mode)
afx spawn 42 --protocol bugfix        # Spawn builder for a bugfix
afx status                            # Check all builders
afx cleanup --project 0042            # Clean up (architect-driven, not automatic)
afx open file.ts            # Open file in annotation viewer (NOT system open)
```

**IMPORTANT:** When the user says `afx open`, always run the `afx open` command — do NOT substitute the system `open` command.

### Configuration

Agent Farm is configured via `.codev/config.json` at the project root. Created during `codev init` or `codev adopt`. Override via CLI: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`.

## Porch - Protocol Orchestrator

Porch drives SPIR, ASPIR, AIR, and BUGFIX protocols via a state machine with phase transitions, gates, and multi-agent consultations.

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
git add codev/specs/42-feature.md
git add src/components/TodoList.tsx
```

**BEFORE EVERY COMMIT**: Run `git status`, add each file explicitly by name.

### Commit Messages
```
[Spec 42] Initial specification draft
[Spec 42][Phase: user-auth] feat: Add password hashing
[Bugfix #42] Fix: URL-encode username before API call
```

### Branch Naming
```
spir/42-feature-name/phase-name
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

# Check GitHub Issues for status
gh issue list --search "XXXX"

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
