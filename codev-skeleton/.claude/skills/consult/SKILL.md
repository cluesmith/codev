---
name: consult
description: AI consultation CLI — query Gemini, Codex, or Claude for reviews and analysis. ALWAYS check this skill before running any `consult` command. Use when reviewing specs, plans, implementations, or PRs with external models, running parallel 3-way reviews (cmap), or checking consultation stats. The `-m` model flag is always required except for `consult stats`.
---

# consult - AI Consultation CLI

Query external AI models for reviews and analysis. Supports Gemini, Codex, and Claude.

## Synopsis

```
consult -m <model> [options]
consult stats [options]
```

The `-m` / `--model` flag is **always required** except for `consult stats`.

## Models

| Flag value | Alias | Notes |
|------------|-------|-------|
| `gemini` | `pro` | Fast (~120-150s), file access via --yolo |
| `codex` | `gpt` | Thorough (~200-250s), shell exploration |
| `claude` | `opus` | Agent SDK with tool use (~60-120s) |

## All flags

```
-m, --model <model>         Model to use (required except stats)
--prompt <text>              Inline prompt (general mode)
--prompt-file <path>         Prompt file path (general mode)
--protocol <name>            Protocol: spir, aspir, air, bugfix, maintain
-t, --type <type>            Review type (see below)
--issue <number>             Issue number (required in architect context)
--output <path>              Save result to file
--plan-phase <phase>         Scope review to a plan phase (porch use)
--context <path>             Context file with feedback (porch use)
--project-id <id>            Project ID for metrics (porch use)
--days <n>                   Stats: limit to last N days (default: 30)
--project <id>               Stats: filter by project ID
--last <n>                   Stats: show last N invocations
--json                       Stats: output as JSON
```

## Review types (`--type`)

| Type | When to use |
|------|-------------|
| `spec` | Review a specification for completeness |
| `plan` | Review an implementation plan |
| `impl` | Review code implementation |
| `pr` | Review a pull request before merge |
| `phase` | Phase-scoped review (builder context only) |
| `integration` | Architect's integration review of a PR |

## Usage patterns

**General query:**
```bash
consult -m gemini --prompt "What's the best way to structure auth?"
consult -m codex --prompt-file review-checklist.md
```

**Protocol review:**
```bash
consult -m gemini --type spec --issue 42
consult -m codex --type plan --issue 42
consult -m claude --type integration --issue 42
```

**3-way parallel review (cmap):**
Always use `--output` for background runs — without it, results go to a temp file that may be garbage-collected.

```bash
consult -m gemini --type integration --issue 42 --output /tmp/cmap-gemini-42.md &
consult -m codex --type integration --issue 42 --output /tmp/cmap-codex-42.md &
consult -m claude --type integration --issue 42 --output /tmp/cmap-claude-42.md &
wait
```

**Stats:**
```bash
consult stats                     # 30-day summary
consult stats --days 7 --json     # Last 7 days as JSON
consult stats --project 42        # Filter by project
```

## Rules

- `-m` is required for all non-stats commands
- `--prompt` and `--type` are mutually exclusive (different modes)
- `--prompt` and `--prompt-file` are mutually exclusive
- `--protocol` requires `--type`
- From architect context (outside `.builders/`), `--issue` is required for protocol reviews
- From builder context (inside `.builders/`), project auto-detects from porch state
