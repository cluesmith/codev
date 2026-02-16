# Specification: Consult CLI Rework

## Metadata
- **ID**: 0125
- **Status**: draft
- **Created**: 2026-02-16

## Problem Statement

The `consult` CLI has accumulated complexity that makes it confusing to use and fragile in practice:

1. **Too many parameters**: `--model`, `--type`, `--role`, `--context`, `--output`, `--plan-phase`, `--protocol`, `--project-id` — users can't tell which flags matter
2. **Context is wrong**: PR reviews run from main, so models read stale files instead of the PR branch code
3. **Prompt sourcing is opaque**: Review type prompts come from `codev/consult-types/` with skeleton fallbacks. Users can't tell what the model sees
4. **Inconsistent file access**: All three models should have file access in whatever worktree they're running in

## Design

Two modes: **general** and **protocol-based**.

### Mode 1: General (default)

Simple question-and-answer. No protocol context needed.

```bash
consult -m gemini --prompt "What is the best approach for caching?"
consult -m codex --prompt-file questions.md
```

Flags:
- `-m, --model` — which model (gemini, codex, claude). Required.
- `--prompt` — inline prompt string
- `--prompt-file` — path to a prompt file

One of `--prompt` or `--prompt-file` is required in general mode.

### Mode 2: Protocol-based

For structured reviews that follow a protocol. The `--protocol` and `--type` together form the path to the prompt template.

```bash
consult -m gemini --protocol spir --type spec
consult -m codex --protocol spir --type plan
consult -m claude --protocol bugfix --type pr
consult -m gemini --protocol spir --type integration
consult -m codex --protocol spir --type phase
```

Flags:
- `-m, --model` — which model. Required.
- `--protocol` — protocol name (spir, bugfix, tick). Required for protocol mode.
- `--type` — review type (spec, plan, pr, integration, phase). Required for protocol mode.
- `--issue` — issue number. Required when running from the architect (not in a builder worktree).

#### Prompt resolution

`--protocol` + `--type` map to a prompt template path:
```
codev/consult-types/<type>-review.md
```
(Or protocol-specific overrides at `codev/protocols/<protocol>/consult-types/<type>-review.md` if they exist.)

#### Context resolution

The consult command must figure out what artifact to review. The rules depend on where it's running:

**In a builder worktree** (auto-detected via `.builders/` in cwd):
- `--type spec` → finds the spec file automatically from porch state or the `codev/specs/` directory in the worktree
- `--type plan` → finds the plan file automatically
- `--type pr` → finds the PR associated with the current branch
- `--type phase` → detects the current phase from porch state
- `--type integration` → same as pr but uses the integration-review prompt

**From the architect** (main worktree):
- `--issue <N>` is required — consult uses it to locate the artifact:
  - `--type spec` → looks up `codev/specs/<N>-*.md`
  - `--type plan` → looks up `codev/plans/<N>-*.md`
  - `--type pr` → looks up the PR linked to issue N (via `gh pr list --search`)
  - `--type integration` → same as pr with integration-review prompt
  - `--type phase` → error (phases only exist in builders)

For PR reviews (`--type pr` and `--type integration`), the model should run with cwd set to a temporary worktree of the PR branch so file reads reflect the actual PR code.

### All models get file access

All three models (Claude, Codex, Gemini) must be able to read files in the worktree they're running in. The prompt contract is: "You are in a directory with the full codebase. Read any file you need."

## Flags Summary

| Flag | Required | Description |
|------|----------|-------------|
| `-m, --model` | Always | Model to use (gemini, codex, claude) |
| `--prompt` | General mode | Inline prompt |
| `--prompt-file` | General mode | Path to prompt file |
| `--protocol` | Protocol mode | Protocol name |
| `--type` | Protocol mode | Review type (spec, plan, pr, integration, phase) |
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

## Success Criteria

- [ ] `consult -m X --prompt "question"` works for general queries
- [ ] `consult -m X --protocol spir --type spec` auto-detects spec in builder worktrees
- [ ] `consult -m X --protocol spir --type spec --issue 42` finds spec from architect
- [ ] `consult -m X --protocol spir --type pr` runs model against PR branch code, not main
- [ ] `consult -m X --protocol spir --type phase` detects current phase in builder
- [ ] All three models have file access in the correct worktree
- [ ] Porch integration works without env vars — all context via explicit flags
- [ ] Errors clearly when required context is missing (e.g., `--type spec` from architect without `--issue`)

## Constraints

- Must not break porch integration — porch calls consult programmatically
- Must not require additional API keys or new model installations
- Temporary worktrees for PR reviews must be cleaned up reliably
- All flags visible in logs (no hidden env var state)

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
- `--issue` only needed from architect context (builders auto-detect)

### What changes for users

Old: `consult -m gemini spec 42` / `consult -m codex pr 87`
New: `consult -m gemini --protocol spir --type spec --issue 42` (from architect)

For general queries:
Old: `consult -m gemini general "question"`
New: `consult -m gemini --prompt "question"`

### What changes for protocols and prompts

- Existing `codev/consult-types/*.md` templates remain unchanged
- Protocol definitions (`protocol.json`) may need verify section updates if they reference old consult subcommands
- `codev/resources/commands/consult.md` must be rewritten
- CLAUDE.md/AGENTS.md consultation examples must be updated

## Out of Scope

- Changing the prompt template content (just the CLI and context resolution)
- Adding new review types
- Multi-model parallel execution (user handles that with `&` or scripting)
