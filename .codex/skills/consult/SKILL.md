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
| `gemini` | `pro` | Antigravity CLI (`agy`); agentic file access (`--sandbox`), OAuth login; skips non-blockingly if unavailable |
| `codex` | `gpt` | Thorough (~200-250s), shell exploration |
| `claude` | `opus` | Your installed `claude` CLI, read-only (Read/Glob/Grep) (~60-120s) |

## Credentials and `.env`

`consult` loads `<workspace>/.env` and sets every key the shell does not already define, **credentials included**. A key exported in the shell wins over `.env`.

- claude: the lane runs your installed `claude` on its own login, which for most people is the subscription. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are withheld from it, from the shell or `.env`, unless config sets `"consult": { "claudeAuth": "api-key" }` (CI and key-only machines). `CLAUDE_CODE_OAUTH_TOKEN` is a login, so it passes through and beats the keychain login. A missing `claude`, one older than 2.1.141, or a logged-out one fails the lane with the command to run.
- codex: `CODEX_API_KEY` beats the ChatGPT login. `OPENAI_API_KEY` is ignored.

The claude and codex lanes print what they authenticate with, e.g. `[CLAUDE] auth: claude.ai (max) — stored claude login; ignoring ANTHROPIC_API_KEY (from .env) — set consult.claudeAuth to "api-key" to bill the API instead`. If a review fails with a usage-limit or auth error while your own login works, check that line first.

## All flags

```
-m, --model <model>         Model to use (required except stats)
--prompt <text>              Inline prompt (general mode)
--prompt-file <path>         Prompt file path (general mode)
--protocol <name>            Protocol: spir, aspir, air, bugfix, pir, maintain
-t, --type <type>            Review type (see below)
--issue <number>             Issue or PR number (required in architect context)
--branch <ref>               Read spec/plan from this git ref instead of the workspace
--base <ref>                 --type integration only: diff against this base branch
--model-id <id>              Override the lane's provider model id for this call
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

`spec`, `plan`, `impl`, `pr` and `phase` need `--protocol` — their prompts live under
`protocols/<name>/consult-types/`. Only `integration` works without it.

## Usage patterns

**General query:**
```bash
consult -m gemini --prompt "What's the best way to structure auth?"
consult -m codex --prompt-file review-checklist.md
```

**Protocol review:**
```bash
consult -m gemini --protocol spir --type spec --issue 42
consult -m codex --protocol spir --type plan --issue 42
consult -m claude --type integration --issue 42
```

**3-way parallel review (cmap):**
Run each command as its own background task (in Claude Code, `run_in_background: true`, not a
trailing `&`), so the turn ends and you are notified as each finishes. Always use `--output` for
background runs — without it, results go to a temp file that may be garbage-collected.

```bash
consult -m gemini --type integration --issue 42 --output /tmp/cmap-gemini-42.md
consult -m codex --type integration --issue 42 --output /tmp/cmap-codex-42.md
consult -m claude --type integration --issue 42 --output /tmp/cmap-claude-42.md
```

In a strict-mode builder, porch emits the review commands itself — run those rather than
composing your own.

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
- `--protocol` requires `--type`; every type except `integration` requires `--protocol`
- From architect context (outside `.builders/`), `--issue` is required for protocol reviews
- From builder context (inside `.builders/`), project auto-detects from porch state
