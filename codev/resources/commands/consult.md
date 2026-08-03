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

## Model Selection Options

```
--model-id <id>        Override the provider model id for THIS invocation
```

`-m/--model` picks the **lane** (`claude`, `codex`, `gemini`, `hermes`); `--model-id` picks the
**model that lane runs**. The two are independent — see [Configuration](#configuration) for setting
an id persistently instead.

```bash
consult -m codex --model-id gpt-5.6-sol "Review this design"
```

- **Precedence**: `--model-id` > `consult.models.<lane>` > the lane's shipped default.
- **Supported lanes**: `claude`, `codex`, `gemini`. Using it with `hermes` is an **error**, not a
  silent no-op — `hermes chat -q` has no model selector, so accepting the flag there would mean
  ignoring it.
- **Validation is syntax-only.** Whether the id exists is the provider's call; a rejection fails
  loudly with no fallback to the default. See
  [the fail-fast contract](#the-fail-fast-contract-and-where-it-stops).

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

Supply rates for a model Codev doesn't know with [`consult.pricing.codex`](#consultpricingcodex).

## Configuration

Everything below lives in `.codev/config.json` and flows through the standard five-layer config
stack, lowest priority to highest:

1. built-in defaults
2. `<cache>/config.json` — remote framework base config
3. `~/.codev/config.json` — global, per-user, across all projects
4. `.codev/config.json` — project, checked in
5. `.codev/config.local.json` — project, per-engineer, gitignored

So any key can be set globally and narrowed per project, and an individual engineer can override
either without touching a checked-in file.

**Two independent axes**, easy to confuse:

| Axis | Key | Answers |
|------|-----|---------|
| *Which model* a lane runs | `consult.models` | "run `claude-opus-5` on the claude lane" |
| *Which lanes* run at all | `porch.consultation.*` | "review PIR with two lanes, not three" |

### `consult.models`

Per-lane model id. Absent → the shipped default in the [Models](#models) table. Outranked for a
single invocation by [`--model-id`](#model-selection-options).

```jsonc
{ "consult": { "models": { "claude": "claude-opus-5", "codex": "gpt-5.6-sol" } } }
```

Valid lanes: `claude`, `codex`, `gemini`. **`hermes` is rejected** — it is invoked as
`hermes chat -q` and exposes no model selector, so configuring one would silently do nothing.
(`hermes` remains valid in `porch.consultation` lane lists; the two key spaces differ on purpose.)

The `gemini` lane passes the id to `agy --model`, so the id space is agy's, not Google's API's.

### `consult.reasoningEffort`

```jsonc
{ "consult": { "reasoningEffort": { "codex": "high" } } }
```

Only `codex` exposes this. Values: `minimal`, `low`, `medium`, `high`, `xhigh` (default `medium`).
Unlike model ids, this **is** a closed set Codev validates locally — see the asymmetry below.

### `consult.pricing.codex`

Per-1M-token rates for the codex lane. Set this when Codev has no rates for the model you run
(otherwise `cost_usd` is `null`), or to correct rates that have gone stale.

**It outranks the shipped rate table for every model, not only unknown ones** — once set, it is
used for whatever the codex lane runs, so it is worth revisiting if you later change the model.

```jsonc
{ "consult": { "pricing": { "codex": { "inputPer1M": 1.25, "cachedInputPer1M": 0.125, "outputPer1M": 10.0 } } } }
```

- **`codex` is the only accepted lane.** Claude reports its own cost directly and the gemini/agy
  lane reports no usage data at all, so a pricing override for either would be inert. Any other
  lane key is an error.
- **All three rates are required together**, and each must be a finite, non-negative number. A
  partial object is an error, not a half-priced estimate: defaulting any one rate to a stale
  built-in would reintroduce exactly the wrong-cost problem this override exists to fix.

### `porch.consultation` — which lanes run

Lane lists accept a single name (`"codex"`), an array (`["codex", "claude"]`), or a whole-value
special mode: `"none"` (skip consultation) or `"parent"` (emit a gate for the architect instead).
An **empty array is rejected** — use `"none"`, so there is exactly one way to say it.

```jsonc
{
  "porch": {
    "consultation": {
      "models": ["gemini", "codex", "claude"],        // workspace-wide default
      "modelsByType": { "pr": ["codex", "claude"] },  // by review type
      "byProtocol": {
        "pir": {
          "models": ["gemini", "codex"],
          "modelsByType": { "impl": ["codex"] }
        }
      }
    }
  }
}
```

Review-type keys are the protocol's own `verify.type` values (`spec`, `plan`, `impl`, `pr`, …);
protocol keys are protocol names, and aliases are canonicalized so `byProtocol.spider` matches a
project running as `spir`. Unknown keys in either space are **errors, not warnings** — a typo that
merely warned would silently leave you on the defaults you were trying to override.

#### Precedence

Highest first. The first level that is present wins outright; levels do not merge.

1. `porch.consultation.byProtocol[<protocol>].modelsByType[<type>]`
2. `porch.consultation.byProtocol[<protocol>].models`
3. `porch.consultation.modelsByType[<type>]`
4. `porch.consultation.models`
5. the protocol's own `verify.models` (i.e. no config at all)

Both `porch next` and `porch done` resolve through this one ladder, so the lanes porch asks you to
run are exactly the lanes it will require review files for.

#### Worked example: keeping PIR cheap while widening the default

PIR is deliberately a 2-lane (CMAP-2) protocol. A workspace-wide 3-lane default silently inflates
it, because config outranks protocol. Scope PIR back down explicitly:

```jsonc
{
  "porch": {
    "consultation": {
      "models": ["gemini", "codex", "claude"],
      "byProtocol": { "pir": { "models": ["codex", "claude"] } }
    }
  }
}
```

SPIR and ASPIR reviews now run three lanes; PIR runs two. Without the `byProtocol` entry, PIR would
run three and cost 50% more per review with no change to the protocol file.

### The fail-fast contract, and where it stops

Config errors are raised when config is **loaded** — before any consultation starts — and name the
offending key and the valid alternatives. Nothing falls back to a default on error.

**The asymmetry worth knowing about:** these two are validated very differently.

| | Validated by | When you find out |
|---|---|---|
| `reasoningEffort` | **Codev**, against a closed enum | Config load, before anything runs |
| Model ids | **The provider** | When the lane runs |

Codev checks a model id's *syntax* only (ASCII alphanumerics plus `. _ : / @ + -`, 1–200 characters,
no leading punctuation) — never its existence. **There is no allowlist of model ids anywhere in
Codev, by design**: a new model must work the day the provider ships it, without a Codev release.

So a typo'd model id is not caught at config time. It reaches the backend, which rejects it; that
lane exits non-zero, the provider's error text is surfaced, the config key that supplied the id is
named, and **no review file is written** — so porch cannot advance on a lane that never ran. What
you do *not* get is a silent substitution of the default model.

One deliberate exception: a `gemini` lane **with no model id resolved** still skips non-blockingly
when `agy` is missing or unauthenticated (consultation is best-effort there). Once an id *is*
resolved — from either `consult.models.gemini` **or** `--model-id` — a rejected model becomes a hard
failure for that lane, because you asked for a specific model and did not get it. What still skips
rather than fails, even with an id, are environment causes that are not the model's fault: `agy`
absent, unauthenticated, timed out, or killed by a signal.

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

#### Test isolation

The cache above protects *production* runs. It did not protect test runs: the
cache disables itself under `VITEST` unless a cache directory is named, and any
test that reached the gemini lane without pinning `CODEV_AGY_BIN` resolved the
real binary — so a suite run could still open a login window per spawn (#1323).
Consult now treats a test runner as a hard boundary. Under `VITEST` (or
`CODEV_TEST_ISOLATION`) it refuses to resolve an unpinned `agy` and refuses to open the
user-global metrics database, failing loudly instead of reaching either. Codev's
own suites pin a fake `agy`, a sandbox auth cache, and a sandbox metrics DB for
every test; spawned `codev` / `consult` children inherit the pins through the
environment.

| Variable | Default | Purpose |
|---|---|---|
| `CODEV_AGY_BIN` | auto-resolved | Pin the agy binary. The harness sets this to a fake for every test. |
| `CODEV_ALLOW_REAL_AGY` | unset | `1` opts a test run into the REAL agy binary — the guarded integration smoke and real-AI e2e runs. Expect a browser window if agy's login has lapsed. |
| `CODEV_METRICS_DB` | `~/.codev/metrics.db` | Redirect the consult metrics database. Required under a test runner; the harness points it at a temp dir so suite runs stop skewing `consult stats`. |
| `CODEV_TEST_ISOLATION` | unset | `1` applies the same guards to a harness that is not vitest. |

**Adopters:** `VITEST` is exported by *any* vitest run, including yours. If your
project's own suite deliberately shells out to `consult -m gemini`, that call now
throws until you set `CODEV_ALLOW_REAL_AGY=1` (and `CODEV_METRICS_DB` if you want
the metrics recorded somewhere). This is intentional — a suite reaching the real
agy is what #1323 was about — but it is a behaviour change, not a silent one: the
error names the variable to set.

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
