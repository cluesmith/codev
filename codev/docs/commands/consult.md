# consult - AI Consultation CLI

The `consult` command provides a unified interface for AI consultation with external models (Gemini, Codex, Claude). Use it for code reviews, spec reviews, and general questions.

## Synopsis

```
consult -m <model> <subcommand> [args] [options]
```

## Required Option

```
-m, --model <model>    Model to use (required)
```

## Models

| Model | Alias | CLI Used | Notes |
|-------|-------|----------|-------|
| `gemini` | `pro` | gemini-cli | Pure text analysis, fast |
| `codex` | `gpt` | @openai/codex | Shell command exploration, thorough |
| `claude` | `opus` | @anthropic-ai/claude-code | Balanced analysis |

## Options

```
-n, --dry-run           Show what would execute without running
-t, --type <type>       Review type (see Review Types below)
```

## Subcommands

### consult pr

Review a pull request.

```bash
consult -m <model> pr <number>
```

**Arguments:**
- `number` - PR number to review

**Description:**

Reviews a GitHub pull request. The consultant reads:
- PR info and description
- Comments and discussions
- Diff of all changes
- File metadata

Outputs a structured review with verdict: APPROVE, REQUEST_CHANGES, or COMMENT.

**Examples:**

```bash
# Review PR #42 with Gemini
consult -m gemini pr 42

# Review with Codex (more thorough, slower)
consult -m codex pr 42

# Dry run to see command
consult -m gemini pr 42 --dry-run
```

---

### consult spec

Review a specification.

```bash
consult -m <model> spec <number>
```

**Arguments:**
- `number` - Spec number to review (e.g., `42` for `codev/specs/0042-*.md`)

**Description:**

Reviews a specification file for:
- Clarity and completeness
- Technical feasibility
- Edge cases and error scenarios
- Security considerations
- Testing strategy

If a matching plan exists, it's included for context.

**Examples:**

```bash
# Review spec 42
consult -m gemini spec 42

# With specific review type
consult -m gemini spec 42 --type spec-review
```

---

### consult plan

Review an implementation plan.

```bash
consult -m <model> plan <number>
```

**Arguments:**
- `number` - Plan number to review (e.g., `42` for `codev/plans/0042-*.md`)

**Description:**

Reviews an implementation plan for:
- Alignment with specification
- Implementation approach
- Task breakdown and ordering
- Risk identification
- Testing strategy

If a matching spec exists, it's included for context.

**Example:**

```bash
consult -m gemini plan 42
```

---

### consult general

General AI consultation.

```bash
consult -m <model> general "<query>"
```

**Arguments:**
- `query` - Question or request (quoted string)

**Description:**

Sends a free-form query to the consultant. The consultant role is still loaded, so responses follow the consultant guidelines.

**Examples:**

```bash
# Ask about code design
consult -m gemini general "What's the best way to structure auth middleware?"

# Get architecture advice
consult -m codex general "Review src/lib/database.ts for potential issues"
```

---

## Review Types

Use `--type` to load stage-specific review prompts:

| Type | Stage | Use Case |
|------|-------|----------|
| `spec-review` | conceived | Review specification completeness |
| `plan-review` | specified | Review implementation plan |
| `impl-review` | implementing | Review code implementation |
| `pr-ready` | implemented | Final check before PR |
| `integration-review` | committed | Architect's integration review |

**Example:**

```bash
consult -m gemini spec 42 --type spec-review
consult -m codex pr 68 --type integration-review
```

---

## Parallel Consultation (3-Way Reviews)

For thorough reviews, run multiple models in parallel:

```bash
# Using background processes
consult -m gemini spec 42 &
consult -m codex spec 42 &
consult -m claude spec 42 &
wait
```

Or with separate terminal sessions for better output separation.

---

## Performance

| Model | Typical Time | Approach |
|-------|--------------|----------|
| Gemini | ~120-150s | Pure text analysis |
| Codex | ~200-250s | Shell command exploration |
| Claude | ~60-120s | Balanced tool use |

Codex is slower because it executes shell commands (git show, rg, etc.) sequentially. It's more thorough but takes ~2x longer than Gemini.

---

## Prerequisites

Install the model CLIs you plan to use:

```bash
# Claude
npm install -g @anthropic-ai/claude-code

# Codex
npm install -g @openai/codex

# Gemini
# See: https://github.com/google-gemini/gemini-cli
```

Configure API keys:
- Claude: `ANTHROPIC_API_KEY`
- Codex: `OPENAI_API_KEY`
- Gemini: `GOOGLE_API_KEY` or `GEMINI_API_KEY`

---

## The Consultant Role

The consultant role (`codev/roles/consultant.md`) defines behavior:
- Provides second perspectives on decisions
- Offers alternatives and considerations
- Works constructively (not adversarial, not a rubber stamp)
- Uses `git show <branch>:<file>` for PR reviews

Customize by ejecting and modifying:

```bash
codev eject roles/consultant.md
```

---

## Query Logging

All consultations are logged to `.consult/history.log`:

```
2024-01-15T10:30:00.000Z model=gemini duration=142.3s query=Review spec 0042...
```

---

## Examples

```bash
# Quick spec review
consult -m gemini spec 42

# Thorough PR review
consult -m codex pr 68

# Architecture question
consult -m claude general "How should I structure the caching layer?"

# Dry run to see command
consult -m gemini pr 42 --dry-run

# 3-way parallel review
consult -m gemini spec 42 &
consult -m codex spec 42 &
consult -m claude spec 42 &
wait
```

---

## See Also

- [codev](codev.md) - Project management commands
- [af](agent-farm.md) - Agent Farm commands
- [overview](overview.md) - CLI overview
