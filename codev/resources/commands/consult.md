# consult - AI Consultation CLI

The `consult` command provides a unified interface for AI consultation with external models (Gemini, Codex, Claude, Hermes). It operates in three modes: general (ad-hoc prompts), protocol-based (structured reviews), and stats.

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

| Model | Alias | Backend | Shipped default model id | Notes |
|-------|-------|---------|--------------------------|-------|
| `gemini` | `pro` | Antigravity CLI (`agy`) | *(agy's own default — no pinned id)* | Agentic file access (`--sandbox --add-dir`), OAuth/subscription login. Skips non-blockingly if `agy` is missing/unauthed. |
| `codex` | `gpt` | @openai/codex | `gpt-5.6-sol` (medium reasoning effort) | Read-only sandbox, thorough |
| `claude` | `opus` | Claude Agent SDK | `claude-opus-5` | Balanced analysis with tool use |
| `hermes` | - | hermes CLI (`hermes chat -q`) | *(hermes' own default)* | Uses Hermes agent as consult backend |

> **The codex lane's `-sol` suffix is load-bearing.** Plain `gpt-5.6` and `gpt-5.6-codex` are both
> rejected by Codex when running on a ChatGPT account (`The '<id>' model is not supported when
> using Codex with a ChatGPT account.`). Don't "simplify" the id — a unit test pins it.

### Cost reporting

Codex consultation cost is computed from OpenAI's published per-1M-token rates for the lane's
model. If a model has no rates recorded in Codev, the consultation still runs and its token counts
are still recorded, but `cost_usd` is stored as `null` rather than billed at some other model's
rates. Only OpenAI's standard pricing tier is modelled — costs for consultations large enough to
enter the long-context tier are under-reported.

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

Run structured reviews tied to a development protocol (SPIR, ASPIR, AIR, bugfix, maintain).

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

# Integration review anchored on a long-lived integration branch (#1113)
consult -m codex --type integration --issue 42 --base ci
```

**Options:**
- `--protocol <name>` — Protocol: spir, aspir, air, bugfix, maintain
- `-t, --type <type>` — Review type: spec, plan, impl, pr, phase, integration
- `--issue <number>` — Issue number (required from architect context)
- `--base <ref>` — **`--type integration` only.** Anchor the diff on this base branch (e.g. `ci`), computed locally as `git diff origin/<base>...origin/<head>` (three-dot, merge-base anchored). Use in repos with a long-lived integration branch ahead of the default branch so the review sees only the PR's actual change, not the whole integration-over-trunk delta. Unresolvable refs fail loudly with a `git fetch` hint (no silent fallback to the local checkout). Defaults to config `consult.integrationBranch`; with neither set, the integration review uses the PR's host-recorded base (`gh pr diff`), unchanged.

**Config (`.codev/config.json`):**
```jsonc
{
  "consult": {
    // Repo-wide default base for `--type integration` (overridden by --base).
    "integrationBranch": "ci"
  }
}
```

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

## Parallel Consultation (Multi-Model Reviews)

Default project configuration uses a 3-model set (`gemini`, `codex`, `claude`).

For thorough reviews, run multiple models in parallel:

```bash
# Default 3-way spec review
consult -m gemini --protocol spir --type spec &
consult -m codex --protocol spir --type spec &
consult -m claude --protocol spir --type spec &
wait

# Optional: include Hermes as a 4th reviewer
consult -m hermes --protocol spir --type spec
```

## Performance

| Model | Typical Time | Approach |
|-------|--------------|----------|
| Gemini | ~120-180s | Antigravity CLI (`agy`); agentic file access via `--sandbox`, plain text output |
| Codex | ~200-250s | Shell command exploration, read-only sandbox |
| Claude | ~60-120s | Agent SDK with Read/Glob/Grep tools |

## Prerequisites

Install the model CLIs you plan to use:

```bash
# Claude Agent SDK
npm install -g @anthropic-ai/claude-code

# Codex
npm install -g @openai/codex

# Gemini lane → Antigravity CLI (`agy`), replacing the retired Gemini CLI
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy   # run once and sign in (OAuth / Google subscription)
```

Configure auth:
- Claude: `ANTHROPIC_API_KEY`
- Codex: `OPENAI_API_KEY`
- Gemini (`agy`): **OAuth / subscription** — run `agy` once and sign in (no API key). If `agy`
  is missing or unauthenticated, the gemini lane skips non-blockingly (the run proceeds without it).

#### agy auth-state cache (unauthenticated tab burst)

An unauthenticated `agy` opens an OAuth browser tab *before* it prints the URL
Codev detects, so the lane cannot suppress the tab after spawning — only by not
spawning. Since a CMAP round is several independent `consult` processes, this used
to strand one tab per consult (#1077).

Codev keeps a shared auth verdict in `~/.cache/codev/agy-auth.json` (0600,
honours `XDG_CACHE_HOME`). The first call probes; the rest read the verdict and
short-circuit, so **an unauthenticated agy is spawned at most once per TTL
window** instead of once per consult. A file lock keeps parallel consults from
probing simultaneously. `codev doctor`'s agy check shares the same cache.

Verdicts expire on their own — sign in with `agy` in another terminal and the lane
recovers within the unauth TTL, no cache clearing required. The cache only ever
suppresses a lane on positive "signed out" evidence; anything ambiguous falls
through to a normal spawn.

| Variable | Default | Purpose |
|---|---|---|
| `CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS` | `300000` (5 min) | How long a "signed out" verdict is trusted — the sign-in recovery window. |
| `CODEV_AGY_AUTH_CACHE_TTL_AUTH_MS` | `1800000` (30 min) | How long a "signed in" verdict is trusted. |
| `CODEV_AGY_AUTH_CACHE_WAIT_MS` | `6000` | How long a consult waits for another process's in-flight probe before proceeding anyway. |
| `CODEV_AGY_AUTH_CACHE_DIR` | `~/.cache/codev` | Cache location (mainly for tests). |
| `CODEV_AGY_AUTH_CACHE_DISABLE` | unset | `1` restores the always-spawn behaviour. |

### Claude auth: subscription vs. metered API

`consult -m claude` runs on the Claude Agent SDK. When `CLAUDE_CODE_OAUTH_TOKEN`
(a Claude subscription/OAuth token) is present, consult strips `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` from the SDK subprocess env so the consultation
authenticates against the **subscription** rather than the **metered Opus API**.
The Agent SDK otherwise prioritizes `ANTHROPIC_API_KEY`, which silently routes
CMAP/review traffic to the metered API (issue #985). When no OAuth token is set,
the API key is used as before so CI / key-only environments keep working.

> **Caveat:** dedicated Agent-SDK subscription credit starts **2026-06-15**.
> Before that date, subscription auth draws from the interactive Max quota.

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

# Default 3-way parallel review
consult -m gemini --protocol spir --type spec &
consult -m codex --protocol spir --type spec &
consult -m claude --protocol spir --type spec &
wait

# Optional: include Hermes as an additional reviewer
consult -m hermes --protocol spir --type spec

# Stats
consult stats --days 7 --json
```

## See Also

- [codev](codev.md) - Project management commands
- [afx](agent-farm.md) - Agent Farm commands
- [overview](overview.md) - CLI overview
