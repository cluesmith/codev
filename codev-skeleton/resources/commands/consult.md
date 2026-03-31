# consult - AI Consultation CLI

The `consult` command provides a unified interface for AI consultation with external models (Gemini, Codex, Claude). It operates in three modes: general (ad-hoc prompts), protocol-based (structured reviews), and stats.

## Synopsis

```
consult -m <model> [options]
consult stats [options]
```

## Required Option

```
-m, --model <model>    Model to use (required for all modes except stats)
```

## Models

| Model | Alias | Backend | Notes |
|-------|-------|---------|-------|
| `gemini` | `pro` | gemini-cli | File access via --yolo, fast |
| `codex` | `gpt` | @openai/codex | Read-only sandbox, thorough |
| `claude` | `opus` | Claude Agent SDK | Balanced analysis with tool use |

## Modes

### General Mode

Send an ad-hoc prompt to a model.

```bash
# Inline prompt
consult -m gemini --prompt "What's the best way to structure auth middleware?"

# Prompt from file
consult -m codex --prompt-file review-checklist.md
```

**Options:**
- `--prompt <text>` — Inline prompt text
- `--prompt-file <path>` — Read prompt from a file

Cannot combine `--prompt` with `--prompt-file` or `--type`.

### Protocol Mode

Run structured reviews tied to a development protocol (SPIR, TICK, bugfix, maintain).

```bash
# Review a spec (auto-detects project context in builder worktrees)
consult -m gemini --protocol spir --type spec

# Review a plan
consult -m codex --protocol spir --type plan

# Review implementation
consult -m claude --protocol spir --type impl

# Review a PR
consult -m gemini --protocol spir --type pr

# Phase-scoped review (builder context only)
consult -m codex --protocol spir --type phase

# Integration review
consult -m gemini --type integration
```

**Options:**
- `--protocol <name>` — Protocol: spir, bugfix, tick, maintain
- `-t, --type <type>` — Review type: spec, plan, impl, pr, phase, integration
- `--issue <number>` — Issue number (required from architect context)

**Context resolution:**
- **Builder context** (cwd inside `.builders/`): auto-detects project ID, spec, plan, and PR from porch state
- **Architect context** (cwd outside `.builders/` or `--issue` provided): requires `--issue <N>` to identify the project

**Prompt templates:**
Protocol-specific prompts are loaded from `codev/protocols/<protocol>/consult-types/<type>-review.md`. The `integration` type uses the shared `codev/consult-types/integration-review.md`.

### Stats Mode

View consultation statistics and history.

```bash
consult stats
consult stats --days 7
consult stats --project 42
consult stats --last 10
consult stats --json
```

**Options:**
- `--days <n>` — Limit to last N days (default: 30)
- `--project <id>` — Filter by project ID
- `--last <n>` — Show last N individual invocations
- `--json` — Output as JSON

## Porch Integration Options

These flags are used by porch (the protocol orchestrator) when generating consult commands. They're not typically used directly.

```
--output <path>         Write output to file
--plan-phase <phase>    Scope review to a specific plan phase
--context <path>        Context file with previous iteration feedback
--project-id <id>       Project ID for metrics
```

## Parallel Consultation (3-Way Reviews)

For thorough reviews, run multiple models in parallel:

```bash
# 3-way spec review
consult -m gemini --protocol spir --type spec &
consult -m codex --protocol spir --type spec &
consult -m claude --protocol spir --type spec &
wait
```

## Performance

| Model | Typical Time | Approach |
|-------|--------------|----------|
| Gemini | ~120-150s | File access via --yolo, pure text output |
| Codex | ~200-250s | Shell command exploration, read-only sandbox |
| Claude | ~60-120s | Agent SDK with Read/Glob/Grep tools |

## Prerequisites

Install the model CLIs you plan to use:

```bash
# Claude Agent SDK
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

## The Consultant Role

The consultant role (`codev/roles/consultant.md`) defines behavior:
- Provides second perspectives on decisions
- Offers alternatives and considerations
- Works constructively (not adversarial, not a rubber stamp)

Customize by editing your local `codev/roles/consultant.md`.

## Query Logging

All consultations are logged to `.consult/history.log`:

```
2026-02-16T10:30:00.000Z model=gemini duration=142.3s query=Review spec...
```

## Examples

```bash
# General: ask a question
consult -m gemini --prompt "How should I structure the caching layer?"

# General: from file
consult -m codex --prompt-file design-question.md

# Protocol: spec review (builder context, auto-detected)
consult -m gemini --protocol spir --type spec

# Protocol: PR review (architect context)
consult -m codex --protocol spir --type pr --issue 42

# Protocol: implementation review with bugfix protocol
consult -m claude --protocol bugfix --type impl

# 3-way parallel review
consult -m gemini --protocol spir --type spec &
consult -m codex --protocol spir --type spec &
consult -m claude --protocol spir --type spec &
wait

# Stats
consult stats --days 7 --json
```

## See Also

- [codev](codev.md) - Project management commands
- [afx](agent-farm.md) - Agent Farm commands
- [overview](overview.md) - CLI overview
