---
approved: 2026-02-16
validated: [claude]
---

# Specification: Consult CLI Rework

## Metadata
- **ID**: 325
- **Status**: approved
- **Created**: 2026-02-16

## Problem Statement

The `consult` CLI has accumulated complexity that makes it confusing to use and fragile in practice:

1. **Too many parameters**: `--model`, `--type`, `--role`, `--context`, `--output`, `--plan-phase`, `--protocol`, `--project-id` — users can't tell which flags matter
2. **Context is wrong**: PR reviews run from main, so models read stale files instead of the PR branch code
3. **Prompt sourcing is opaque**: Review type prompts come from `codev/consult-types/` with skeleton fallbacks. Users can't tell what the model sees
4. **Inconsistent file access**: All three models should have file access in whatever worktree they're running in

### Current Architecture (for context)

The consult CLI lives at `packages/codev/src/commands/consult/index.ts` (~1,130 lines). It currently uses positional subcommands (`spec`, `plan`, `pr`, `impl`, `general`, `stats`) with model-specific invocation:

- **Claude**: Uses `@anthropic-ai/claude-agent-sdk` `query()` with Read/Glob/Grep tools
- **Codex**: Uses `@openai/codex-sdk` `Codex` class with read-only sandbox
- **Gemini**: Spawned as subprocess via `gemini --yolo`, role via `GEMINI_SYSTEM_MD` env var

Porch calls consult from `packages/codev/src/commands/porch/next.ts` (lines 445-447), generating commands like:
```bash
consult --model gemini --type spec-review --protocol spir --project-id 42 --output "..." spec 42
```

## Design

Three modes: **general**, **protocol-based**, and **stats**.

### Mode 1: General (default)

Simple question-and-answer. No protocol context needed.

```bash
consult -m gemini --prompt "What is the best approach for caching?"
consult -m codex --prompt-file questions.md
```

Flags:
- `-m, --model` — which model (gemini, codex, claude). Required. Aliases preserved: `pro` (gemini), `gpt` (codex), `opus` (claude).
- `--prompt` — inline prompt string
- `--prompt-file` — path to a prompt file (must exist and be readable, error otherwise)

Exactly one of `--prompt` or `--prompt-file` is required in general mode. Providing both is an error.

### Mode 2: Protocol-based

For structured reviews that follow a protocol.

```bash
consult -m gemini --protocol spir --type spec
consult -m codex --protocol spir --type plan
consult -m claude --protocol spir --type impl
consult -m claude --protocol bugfix --type pr
consult -m gemini --type integration
consult -m codex --protocol spir --type phase
```

Flags:
- `-m, --model` — which model. Required. Aliases: `pro`, `gpt`, `opus`.
- `--protocol` — protocol name (spir, bugfix, tick). Optional — narrows prompt lookup to a protocol directory.
- `--type` — review type (spec, plan, impl, pr, integration, phase). Required for protocol mode.
- `--issue` — issue number. Required when running from the architect (not in a builder worktree).

**Mode conflict**: If both general flags (`--prompt`/`--prompt-file`) and protocol flags (`--type`) are provided, the command errors with a clear message. The two modes are mutually exclusive.

**Additional validation**:
- `--protocol` without `--type` is an error (protocol narrows prompt lookup but needs a type to resolve)
- `--issue` in general mode is silently ignored (no harm, no effect)
- `consult stats -m <model>` ignores `-m` (stats mode doesn't invoke a model)
- Porch-only flags (`--context`, `--plan-phase`, `--output`, `--project-id`) in general mode are silently ignored

#### Prompt resolution

Prompt lookup depends on whether `--protocol` is provided:

1. If `--protocol` is given → `codev/protocols/<protocol>/consult-types/<type>-review.md`
2. If `--type` alone (no `--protocol`) → `codev/consult-types/<type>-review.md`
3. Error if the file doesn't exist in the resolved location

#### Prompt template layout

Each protocol owns its prompts in a `consult-types/` subdirectory:

| Protocol | Prompts |
|----------|---------|
| `spir` | spec-review, plan-review, impl-review, phase-review, pr-review |
| `bugfix` | impl-review, pr-review |
| `tick` | spec-review, plan-review, impl-review, pr-review |
| `maintain` | impl-review, pr-review |
| shared (`codev/consult-types/`) | integration-review |

Notes:
- `phase-review.md` is a copy of `impl-review.md` (same prompt, may diverge later)
- `pr-review.md` replaces the old `pr-ready.md` for naming consistency
- The old top-level `codev/consult-types/` retains only `integration-review.md`
- The old files (`spec-review.md`, `plan-review.md`, `impl-review.md`, `pr-ready.md`) in the top-level directory are removed
- `tick` currently has no `protocol.json` or `consult-types/` directory — this work creates `codev/protocols/tick/consult-types/` with the listed prompt files
- `maintain` currently reads from the shared `codev/consult-types/` — this work creates `codev/protocols/maintain/consult-types/` with its own prompt files

#### Context resolution

The consult command must figure out what artifact to review. The rules depend on where it's running:

**In a builder worktree** (auto-detected via `.builders/` in cwd):
- `--type spec` — finds the spec file from porch state (`codev/projects/<id>-<name>/status.yaml` → title → `codev/specs/<title>.md`) or glob `codev/specs/<id>-*.md`
- `--type plan` — finds the plan file using same resolution as spec
- `--type impl` — reviews implementation code; uses git diff from merge-base to HEAD. Supports `--plan-phase` to scope to a specific phase.
- `--type pr` — finds the PR associated with the current branch via `gh pr list --head <branch-name> --json number,url --jq '.[0]'`. Errors if no PR found.
- `--type phase` — detects the current phase automatically from porch state (`status.yaml` → `current_plan_phase`). Scopes the diff to the phase's atomic commit (`git show HEAD`) rather than the full branch diff. The SPIR protocol requires one atomic commit per phase, so this gives the model exactly the code that changed in that phase.
- `--type integration` — same as pr but uses the `integration-review.md` template

**From the architect** (main worktree):
- `--issue <N>` is required — consult uses it to locate the artifact:
  - `--type spec` — globs `codev/specs/<N>-*.md`. Errors if zero or multiple matches.
  - `--type plan` — globs `codev/plans/<N>-*.md`. Same error handling.
  - `--type impl` — uses `--issue` to find the builder branch via `gh pr list --search "<N>" --json headRefName --jq '.[0].headRefName'`, gets diff from merge-base. Errors if no PR found for the issue.
  - `--type pr` — looks up the PR via `gh pr list --search "<N>" --json number,headRefName --jq '.[0]'`. Errors if not found.
  - `--type integration` — same as pr with integration-review template
  - `--type phase` — error ("phases only exist in builders, and require the phase commit to exist")

**Builder detection**: A worktree is identified as a builder context if `cwd` contains `/.builders/` in the path. If `--issue` is explicitly provided in a builder worktree, it overrides the auto-detected context and the command behaves as if running from the architect. This means `--type phase` with `--issue` always errors, even inside a builder worktree, since the override puts consult in architect mode.

**Multiple matches**: If a glob like `codev/specs/<N>-*.md` returns multiple files, the command errors with a list of matches and asks the user to resolve.

For PR reviews (`--type pr` and `--type integration`), the model receives the PR diff as context and reads other files from the local filesystem. See "PR review context" below.

### PR review context

PR reviews (`--type pr` and `--type integration`) give the model two things:

1. **The PR diff**: Fetched via `gh pr diff <number>` and included in the prompt as context. This shows exactly what changed.
2. **Local filesystem access**: The model runs with `cwd` set to the current worktree (wherever consult was invoked). It can read any file from disk to understand surrounding code.

No temporary worktrees are created. The model reviews the PR as a PR (diff-based) and uses file access for additional context about the codebase.

### All models get file access

All three models (Claude, Codex, Gemini) must be able to read files in the worktree they're running in. The prompt contract is: "You are in a directory with the full codebase. Read any file you need."

Currently:
- Claude gets Read/Glob/Grep tools via the Agent SDK — **no change needed**
- Codex gets read-only sandbox access — **no change needed**
- Gemini has NO file access (subprocess only) — **NEW WORK required**

**Gemini file access (new capability)**: The `gemini` CLI supports `--yolo` mode which auto-approves tool calls. When running in a worktree with file access tools available, Gemini can read files via its built-in tools. The implementation must:
1. Set `cwd` to the correct worktree before spawning the `gemini` subprocess
2. Verify Gemini's built-in tools include file reading (the `--yolo` flag enables this)
3. Include an instruction in the prompt: "You have file access. Read files directly from disk to review code."

This is a meaningful change because today's Gemini invocation passes the entire query as text with no expectation of file reading. The new approach relies on Gemini's tool-use capability.

### Mode 3: Stats (unchanged)

The `stats` subcommand (`consult stats`) is independent of review modes and preserved as-is:

```bash
consult stats                           # All-time stats
consult stats --days 30                 # Last 30 days
consult stats --project 42              # Filter by project
consult stats --last 10                 # Last 10 invocations
consult stats --json                    # JSON output
```

No `-m` flag needed. Reads from `~/.codev/metrics.db`. No model invocation.

### Input validation

The `--protocol` and `--type` values are used to construct file paths (e.g., `codev/protocols/<protocol>/consult-types/<type>-review.md`). These values must be validated to prevent path traversal — same pattern as the existing `isValidRoleName()` function. Only alphanumeric characters and hyphens are allowed.

## Flags Summary

| Flag | Required | Description |
|------|----------|-------------|
| `-m, --model` | Always (except stats) | Model to use (gemini/pro, codex/gpt, claude/opus) |
| `--prompt` | General mode (one of) | Inline prompt |
| `--prompt-file` | General mode (one of) | Path to prompt file |
| `--protocol` | Optional | Protocol name (narrows prompt lookup to protocol directory) |
| `--type` | Protocol mode | Review type (spec, plan, impl, pr, integration, phase) |
| `--issue` | Architect + protocol | Issue number for artifact lookup |
| `--output` | Porch only | Write output to file |
| `--context` | Porch only | Previous iteration context file |
| `--plan-phase` | Porch only | Scope impl review to plan phase |
| `--project-id` | Porch only | Project ID for metrics |

No env vars — all flags are explicit and visible in logs.

## Porch Integration

Porch calls consult programmatically with additional flags for automation:

```bash
consult -m gemini --protocol spir --type spec \
  --project-id 42 \
  --output "codev/projects/42-feature/42-specify-iter1-gemini.txt"

consult -m codex --protocol spir --type phase \
  --plan-phase phase1 \
  --context "codev/projects/42-feature/42-implement-iter1-context.md" \
  --project-id 42 \
  --output "codev/projects/42-feature/42-phase1-iter2-codex.txt"
```

### Porch-only flags (not needed by users)

| Flag | Purpose |
|------|---------|
| `--output <path>` | Write review output to file (porch collects results) |
| `--context <path>` | Previous iteration context for multi-round reviews |
| `--plan-phase <phase>` | Scope impl review to a specific plan phase |
| `--project-id <id>` | Project ID for metrics tracking |

These flags remain as explicit CLI flags (not env vars) so they're visible in logs. They're only used by porch — users don't need them.

When porch runs consult inside a builder worktree, `--issue` is not needed (context is auto-detected). When porch runs consult from the architect context, it passes `--issue`.

### Porch command generation changes

Porch generates consult commands in `packages/codev/src/commands/porch/next.ts` (around line 445). The current format:
```bash
consult --model gemini --type spec-review --protocol spir --project-id 42 --output "..." spec 42
```

Must change to:
```bash
consult -m gemini --protocol spir --type spec --project-id 42 --output "..."
```

Key differences:
- No positional subcommand (`spec 42`) — replaced by `--protocol spir --type spec`
- `--type` value changes from `spec-review` to `spec` (the `-review` suffix is implicit)
- `--issue` only needed from architect context (builders auto-detect)

## Success Criteria

### Functional
- [ ] `consult -m X --prompt "question"` works for general queries
- [ ] `consult -m X --prompt-file path.md` works, errors if file missing
- [ ] `consult -m X --protocol spir --type spec` auto-detects spec in builder worktrees
- [ ] `consult -m X --protocol spir --type spec --issue 42` finds spec from architect
- [ ] `consult -m X --protocol spir --type impl` reviews implementation via git diff
- [ ] `consult -m X --protocol spir --type pr` passes PR diff to model with local file access
- [ ] `consult -m X --protocol spir --type phase` detects current phase and scopes diff to phase commit
- [ ] `consult -m X --type integration` works without `--protocol` (shared prompt)
- [ ] All three models (including Gemini) have file access in the correct worktree
- [ ] Porch integration works — all context via explicit flags
- [ ] `consult stats` continues to work unchanged
- [ ] Metrics recording continues to work with new command structure
- [ ] Model aliases (`pro`, `gpt`, `opus`) continue to work
- [ ] Protocol-specific prompt templates are loaded from `codev/protocols/<protocol>/consult-types/`

### Error handling
- [ ] Errors clearly when required context is missing (e.g., `--type spec` from architect without `--issue`)
- [ ] Errors when both `--prompt` and `--type` are provided (mode conflict)
- [ ] Errors when both `--prompt` and `--prompt-file` are provided
- [ ] Errors when `--type phase` used from architect context
- [ ] Errors when spec/plan glob matches zero or multiple files
- [ ] Errors when PR not found for current branch or issue
- [ ] Errors when `--protocol`/`--type` contain invalid characters (path traversal prevention)
- [ ] Errors when prompt template file not found in resolved location
- [ ] Errors when `--protocol` is provided without `--type`
- [ ] PR diff is correctly fetched and included in model prompt

## Constraints

- Must not break porch integration — porch calls consult programmatically
- Must not require additional API keys or new model installations
- PR reviews must include the actual PR diff (via `gh pr diff`), not stale code
- All flags visible in logs (no hidden env var state)
- Claude SDK nesting guard bypass (`CLAUDECODE` env var removal) must be preserved
- If SDK dangling handles prevent clean process exit, add `process.exit(0)` after completion as a workaround

## Migration

### What changes for porch

Porch currently generates commands like:
```bash
consult --model gemini --type spec-review --protocol spir --project-id 42 --output "..." spec 42
```

New form:
```bash
consult -m gemini --protocol spir --type spec --project-id 42 --output "..."
```

Key differences:
- No positional subcommand (`spec 42`) — replaced by `--protocol spir --type spec`
- `--type` value changes from `spec-review` to `spec` (the `-review` suffix is implicit)
- `--type impl-review` becomes `--type impl`
- `--issue` only needed from architect context (builders auto-detect)

### What changes for users

Old: `consult -m gemini spec 42` / `consult -m codex pr 87`
New: `consult -m gemini --protocol spir --type spec --issue 42` (from architect)

For general queries:
Old: `consult -m gemini general "question"`
New: `consult -m gemini --prompt "question"`

### Features removed

- **`--role` / `-r`**: Removed. Custom roles added unnecessary complexity.
- **`--dry-run` / `-n`**: Removed. Not useful enough to justify the code.

### Features preserved

- **Model aliases**: `pro` (gemini), `gpt` (codex), `opus` (claude)
- **`stats` subcommand**: All stats flags (`--days`, `--project`, `--last`, `--json`)
- **Metrics recording**: Same SQLite database, same schema

### Review type mapping (old → new)

| Old `--type` value | New `--type` value | Template file |
|---------------------|---------------------|---------------|
| `spec-review` | `spec` | `spec-review.md` |
| `plan-review` | `plan` | `plan-review.md` |
| `impl-review` | `impl` | `impl-review.md` |
| `pr-ready` | `pr` | `pr-review.md` |
| `integration-review` | `integration` | `integration-review.md` |
| *(new)* | `phase` | `phase-review.md` |

The `-review` suffix is always appended when resolving the template file.

### What changes for protocols and prompts

- Prompt templates move from `codev/consult-types/` into `codev/protocols/<protocol>/consult-types/`
- `pr-ready.md` renamed to `pr-review.md` everywhere
- New `phase-review.md` added to SPIR (copy of `impl-review.md`)
- Only `integration-review.md` stays in shared `codev/consult-types/`
- Old top-level files (`spec-review.md`, `plan-review.md`, `impl-review.md`, `pr-ready.md`) are removed
- Protocol definitions (`protocol.json`) verify sections need updates for new consult command format
- `codev/resources/commands/consult.md` must be rewritten
- CLAUDE.md/AGENTS.md consultation examples must be updated

### What changes in the codebase

Files that need modification:
- `packages/codev/src/commands/consult/index.ts` — Main CLI rewrite (command parsing, mode routing, context resolution)
- `packages/codev/src/commands/porch/next.ts` — Porch command generation (line ~445), `getConsultArtifactType()` removal/repurposing
- `packages/codev/src/cli.ts` — Commander.js command registration
- `codev/protocols/spir/protocol.json` — Update `verify.type` values (`spec-review` → `spec`, `plan-review` → `plan`, `impl-review` → `impl`, `pr-ready` → `pr`)
- `codev/protocols/bugfix/protocol.json` — Update `verify.type` values (`impl-review` → `impl`)
- `codev/protocols/maintain/protocol.json` — Update `verify.type` values (`impl-review` → `impl`)
- `codev/resources/commands/consult.md` — CLI documentation
- `codev-skeleton/resources/commands/consult.md` — Skeleton CLI documentation

New files to create:
- `codev/protocols/tick/consult-types/` — New directory with spec-review, plan-review, impl-review, pr-review prompt files
- `codev/protocols/maintain/consult-types/` — New directory with impl-review, pr-review prompt files
- `codev/protocols/spir/consult-types/phase-review.md` — New phase review prompt (copy of impl-review.md)
- `codev/protocols/spir/consult-types/pr-review.md` — Renamed from pr-ready.md

## Out of Scope

- Changing the prompt template content (just the CLI and context resolution)
- Adding new review types beyond phase
- Multi-model parallel execution (user handles that with `&` or scripting)
- Changing the metrics database schema
- Changing model pricing or token tracking
