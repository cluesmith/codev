# Spec 0115: Consultation Metrics & Cost Tracking

## Problem

The `consult` CLI runs 3-way parallel reviews (Gemini, Codex, Claude) which are expensive and time-consuming. A single consultation round spawns three model invocations, each taking 60-250 seconds, with no measurement of cost or duration beyond a per-project text log (`$PROJECT/.consult/history.log`) that records model name, duration, and a 100-character query preview. There is no aggregation, no cost tracking, no way to answer questions like:

- How much are we spending on consultations per week?
- Which model is slowest? Which fails most often?
- How much time does the spec-review phase add to SPIR?
- Are porch-automated consultations more expensive than manual ones?

The existing `logQuery()` function (consult/index.ts line 237) writes a flat text file per project. This is not queryable, not centralized, and does not capture token usage, cost, exit codes, or protocol context.

## Motivation

- **Cost visibility**: Each consult round costs $5-25+ depending on models and codebase size. Without measurement, there is no feedback loop on spending.
- **Performance insight**: Duration varies wildly (Codex is often 60s, Claude SDK can be 200s+). Tracking this enables informed decisions about model selection and timeout tuning.
- **Protocol analytics**: Knowing how many consultations each protocol triggers (SPIR averages 3 rounds, TICK 1, BUGFIX 1) helps quantify the overhead of multi-agent review.
- **Failure detection**: Consultations silently fail (exit code non-zero) and the builder retries. Without metrics, repeated failures are invisible.

## Requirements

### R1: SQLite metrics database

Store all consultation metrics in a global SQLite database at `~/.codev/metrics.db` (not per-project — consultations span multiple repos).

**Schema** (`consultation_metrics` table):

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Row ID |
| `timestamp` | TEXT NOT NULL | ISO 8601 UTC timestamp of invocation start |
| `model` | TEXT NOT NULL | Model identifier: `gemini`, `codex`, `claude` |
| `review_type` | TEXT | Review type flag: `spec-review`, `plan-review`, `impl-review`, `pr-ready`, `integration-review`, or null for general |
| `subcommand` | TEXT NOT NULL | Consult subcommand: `pr`, `spec`, `plan`, `impl`, `general` |
| `protocol` | TEXT | Protocol context: `spir`, `tick`, `bugfix`, `manual` |
| `project_id` | TEXT | Porch project ID if applicable (e.g., `0108`, `bugfix-269`), null for manual invocations |
| `duration_seconds` | REAL NOT NULL | Wall-clock duration from subprocess start to exit |
| `input_tokens` | INTEGER | Exact input/prompt tokens from structured model output, null if unavailable |
| `cached_input_tokens` | INTEGER | Cached input tokens with discounted pricing, null if unavailable. For Claude SDK: stores `cache_read_input_tokens` (not `cache_creation_input_tokens`, which has different pricing but is irrelevant since Claude cost comes from SDK). For Codex: `cached_input_tokens`. For Gemini: `cached`. |
| `output_tokens` | INTEGER | Exact output/completion tokens from structured model output, null if unavailable |
| `cost_usd` | REAL | Cost in USD: exact from SDK when available, computed from exact tokens × static rates otherwise, null if neither possible |
| `exit_code` | INTEGER NOT NULL | Subprocess exit code (0 = success) |
| `workspace_path` | TEXT NOT NULL | Absolute path to the git repository root |
| `error_message` | TEXT | Error details (first 500 chars) if exit_code != 0, null on success. For Claude SDK: exception message. For subprocess models: generic "Process exited with code N" (stderr is not captured — it streams to terminal for real-time visibility) |

**Why three seemingly-overlapping columns (review_type, subcommand, protocol)?** These are orthogonal dimensions:
- **subcommand** = the user action (`pr`, `spec`, `plan`, `impl`, `general`) — determines what query is built
- **review_type** = the consultation style/prompt (`spec-review`, `impl-review`, etc.) — determines how the model reviews. A `spec` subcommand can use different review types; `general` has no review type at all
- **protocol** = orchestration context (`spir`, `tick`, `bugfix`, `manual`) — distinguishes automated from manual invocations and enables per-protocol cost analysis. Not derivable from review_type: a `spec-review` can be triggered by SPIR, TICK, or manually

All three are needed for meaningful analytics (e.g., "how much does SPIR spec-review cost via the `spec` subcommand vs the `general` subcommand?").

Create `~/.codev/` directory if it does not exist (with `0700` permissions, matching the existing `~/.codev/run/` convention). Use `better-sqlite3` (already a project dependency) for synchronous writes.

**Database initialization**: On first access:
1. Create directory with `fs.mkdirSync(~/.codev, { recursive: true, mode: 0o700 })`
2. Open database with `new Database(dbPath)`
3. Set pragmas for concurrent access: `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`
4. Create table with `CREATE TABLE IF NOT EXISTS`

**Concurrency**: 3-way parallel consultations mean three separate processes write to the same database simultaneously. WAL mode enables concurrent reads and serialized writes. The 5-second busy timeout ensures a process retries instead of immediately failing with `SQLITE_BUSY`. Combined with R6's error handling (warn-and-continue on failure), this makes concurrent access robust.

No migration framework needed for v1 — this is a new database.

### R2: Time measurement

Wrap every consult invocation to measure wall-clock duration:

1. Record `startTime = Date.now()` immediately before spawning the subprocess (or starting the Claude SDK session).
2. Record `endTime = Date.now()` when the subprocess exits (or SDK session completes).
3. Compute `duration_seconds = (endTime - startTime) / 1000`.

This is partially done already — `runConsultation()` captures `startTime` and computes duration for the `logQuery()` call. Extend this to also write to SQLite.

### R3: Token and cost capture

Each model provides structured mechanisms for reporting exact token counts. **Data integrity is paramount**: only store values that come directly from the model or are computed from exact token counts. Never estimate, approximate, or guess. If exact data is unavailable, store null.

#### Claude (Agent SDK) — Exact tokens AND exact cost

The Claude Agent SDK's `query()` async generator yields `SDKResultMessage` when `type === "result"`. This message provides:

```typescript
// Fields available on SDKResultMessage (subtype === "success"):
{
  total_cost_usd: number;          // Exact cost computed by Anthropic
  duration_ms: number;             // SDK-measured duration
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}
```

**Implementation**: Capture the `result` message in `runClaudeConsultation()` (currently the result message is only checked for errors at line 318-322 of index.ts). Store `total_cost_usd` directly — no static pricing needed for Claude.

#### Gemini CLI — Exact tokens, NO cost

Gemini CLI supports `--output-format json` which returns structured JSON with a `stats` block:

```json
{
  "response": "The review text appears here...",
  "stats": {
    "models": {
      "[model-name]": {
        "tokens": {
          "prompt": 1200,
          "candidates": 450,
          "total": 1650,
          "cached": 800
        }
      }
    }
  }
}
```

**Implementation**: Add `--output-format json` to the Gemini command args. Parse the JSON output to extract `stats.models.*.tokens.prompt` (input_tokens), `stats.models.*.tokens.candidates` (output_tokens), and `stats.models.*.tokens.cached` (cached_input_tokens). All three are required for cost computation. Gemini CLI does **not** report cost — compute it from exact tokens using the static pricing table.

**Output unwrapping**: The `response` field contains the actual review text. Extract this and write it to stdout/outputPath. Do NOT write raw JSON to review files — porch expects plain-text reviews.

**Streaming trade-off**: `--output-format json` buffers the entire response before returning (no streaming). This means users see no output until Gemini completes (60-120s). This is an acceptable trade-off: porch invocations (the primary use case) already capture to file, and manual invocations are less common. If the UX impact proves problematic, a future enhancement could use Gemini's `--session-summary <path>` flag (which writes stats to a separate file while streaming text to stdout), but that requires additional verification.

#### Codex CLI — Exact tokens, NO cost

Codex CLI supports `--json` which produces a JSONL (newline-delimited JSON) stream. The `turn.completed` event includes usage:

```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 24763,
    "cached_input_tokens": 24448,
    "output_tokens": 122
  }
}
```

Response text appears in `message` events with `role: "assistant"`.

**Implementation**: Add `--json` to the Codex command args. Parse the JSONL output to find `turn.completed` events and sum `usage.input_tokens`, `usage.cached_input_tokens`, and `usage.output_tokens` across all turns. All three are required for cost computation. Codex CLI does **not** report cost — compute it from exact tokens using the static pricing table.

**Output unwrapping**: Extract assistant message text from `message` events in the JSONL stream. Write only the extracted review text to stdout/outputPath — not raw JSONL. This requires always piping stdout (not inheriting) and streaming the extracted text to the terminal in real-time as JSONL events arrive.

#### Stdout handling change for subprocess models

Adding JSON output modes (`--output-format json`, `--json`) changes the subprocess stdout from plain text to structured data. To preserve the existing user experience:

1. **Always pipe stdout** for subprocess models (change `stdoutMode` to `'pipe'` unconditionally — currently it's `'pipe'` only when `outputPath` is set)
2. **Buffer the raw output** for JSON/JSONL parsing after completion
3. **Extract the review text** from the structured output (Gemini: `response` field; Codex: assistant `message` events)
4. **Stream extracted text to terminal** in real-time where possible (Codex JSONL streams; Gemini JSON buffers entirely)
5. **Write extracted text** (not raw JSON) to `outputPath` when specified

This ensures porch review files remain plain text, users see human-readable output, and metrics capture gets structured token data.

#### Error handling

**Token/cost extraction**: Must never cause a consultation to fail. Wrap all structured output parsing in try/catch. If parsing fails:
1. Store null for `input_tokens`, `cached_input_tokens`, `output_tokens`, and `cost_usd`
2. Log a warning to stderr with the parse error details
3. Continue normally — the consultation result is still valid

**Response text extraction failure (critical fallback)**: If JSON/JSONL parsing fails when extracting the review text (e.g., malformed output, unexpected format), the raw subprocess output MUST be written to stdout/outputPath as-is. This ensures porch review files are never empty — even if they contain raw JSON, downstream verdict parsing can still attempt to find the VERDICT block in the text. Metrics should record the consultation with null token/cost data. This is the "degrade gracefully" principle: a metrics parsing failure must never break the consultation pipeline.

### R4: Protocol and project context

When porch invokes `consult`, it must pass protocol and project context so the metrics record knows what triggered it.

**Why protocol is not implicit from review type**: Review types like `spec-review` and `impl-review` are used by multiple protocols (SPIR, TICK, BUGFIX all run `impl-review`). The protocol field answers "which workflow triggered this?" which cannot be derived from the review type alone. Manual invocations (e.g., `consult -m claude spec 42`) have a review type but no protocol — storing `manual` as the protocol distinguishes ad-hoc usage from automated porch-driven usage.

**Mechanism**: Add two new CLI flags to the `consult` command:

```
--protocol <spir|tick|bugfix>
--project-id <id>
```

These are optional. When omitted (manual invocations), `protocol` defaults to `manual` and `project_id` defaults to null.

**Porch integration**: In `next.ts`, the consultation command strings already include model, type, output path, etc. Add `--protocol ${state.protocol} --project-id ${state.id}` to the command template.

### R5: `consult stats` subcommand

Add a new subcommand `consult stats` that queries `~/.codev/metrics.db` and displays summary statistics.

**CLI routing**: The current `consult` command requires `-m, --model` (it's a `requiredOption` in Commander). The `stats` subcommand does NOT need a model. Handle this by intercepting `stats` before Commander's option validation — either by making `-m` optional and checking it's present for non-stats subcommands, or by registering `stats` as a separate Commander subcommand (e.g., `codev consult-stats`). The recommended approach is making `-m` optional in Commander and validating it in the handler code, since `consult stats` is semantically part of the `consult` command family.

**Cold start**: If `metrics.db` does not exist, print "No metrics data found. Run a consultation first." and exit 0.

**Default output** (no flags):

```
Consultation Metrics (last 30 days)
====================================

Total invocations: 47
Total duration:    4.2 hours
Total cost:        $182.50 (31 of 47 with cost data)
Success rate:      93.6% (44/47)

By Model:
  gemini   16 calls   avg 72s    $38.20   94% success
  codex    16 calls   avg 95s    $44.30   88% success
  claude   15 calls   avg 185s   $100.00  100% success

By Review Type:
  impl-review        24 calls   avg 132s   $98.00
  spec-review         9 calls   avg  85s   $34.50
  plan-review         8 calls   avg  78s   $30.00
  integration-review  6 calls   avg 110s   $20.00

By Protocol:
  spir     30 calls   $142.00
  bugfix   12 calls   $28.50
  manual    5 calls   $12.00
```

**Flags**:

| Flag | Description |
|------|-------------|
| `--days <N>` | Limit to last N days (default: 30) |
| `--model <name>` | Filter by model |
| `--type <name>` | Filter by review type |
| `--protocol <name>` | Filter by protocol |
| `--project <id>` | Filter by project ID |
| `--last <N>` | Show last N individual invocations (table format) |
| `--json` | Output as JSON instead of table |

**Individual invocations** (`--last N`):

```
Last 5 consultations:
TIMESTAMP            MODEL   TYPE         DURATION  COST     EXIT  PROJECT
2026-02-15 14:32:01  claude  impl-review  185.2s    $6.50    0     0108
2026-02-15 14:32:01  codex   impl-review   92.1s    $2.80    0     0108
2026-02-15 14:32:01  gemini  impl-review   68.4s    $2.40    0     0108
2026-02-15 12:10:45  claude  spec-review  142.0s    $4.20    0     0113
2026-02-15 12:10:44  codex   spec-review   78.3s    $2.10    1     0113
```

### R6: Async metrics recording

Metrics recording must NOT slow down the consult flow. After the subprocess exits and the duration is computed:

1. Write the metrics row to SQLite synchronously (better-sqlite3 is sync and fast — a single INSERT takes <1ms).
2. This happens **after** the subprocess has completed and output has been written, so it does not add latency to the consultation itself.
3. If the SQLite write fails (e.g., disk full, permissions), log a warning to stderr and continue. Never throw.

The <100ms overhead requirement is easily met since better-sqlite3 INSERTs are sub-millisecond.

### R7: Retain existing log

Keep the existing `logQuery()` text log as-is. It serves a different purpose (per-project quick history). The SQLite database is the new structured store. Do not remove or modify `logQuery()`.

## Design Details

### New files

| File | Purpose |
|------|---------|
| `packages/codev/src/commands/consult/metrics.ts` | MetricsDB class: open/create database, insert row, query for stats |
| `packages/codev/src/commands/consult/stats.ts` | `consult stats` subcommand implementation |
| `packages/codev/src/commands/consult/usage-extractor.ts` | Extract token counts and cost from structured model output (JSON, JSONL, SDK result) |

### Modified files

| File | Change |
|------|--------|
| `packages/codev/src/commands/consult/index.ts` | Add `--protocol` and `--project-id` flags to `ConsultOptions`. Capture Claude SDK `result` message for usage data. Add `--output-format json` to Gemini args; add `--json` to Codex args. After each consultation completes, call `MetricsDB.record()`. |
| `packages/codev/src/commands/porch/next.ts` | Add `--protocol` and `--project-id` flags to consultation command templates |
| `packages/codev/src/cli.ts` | Add `--protocol` and `--project-id` option definitions; make `-m` optional (required for all subcommands except `stats`); add `stats` subcommand routing |

### MetricsDB API

```typescript
interface MetricsRecord {
  timestamp: string;        // ISO 8601
  model: string;
  reviewType: string | null;
  subcommand: string;
  protocol: string;         // defaults to 'manual'
  projectId: string | null;
  durationSeconds: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  exitCode: number;
  workspacePath: string;
  errorMessage: string | null;
}

class MetricsDB {
  constructor();                              // Opens/creates ~/.codev/metrics.db
  record(entry: MetricsRecord): void;         // INSERT row
  query(filters: StatsFilters): MetricsRow[]; // SELECT with filters
  summary(filters: StatsFilters): StatsSummary; // Aggregated summary
  close(): void;
}
```

### Token/cost extraction strategy

Create a `extractUsage(model: string, output: string, sdkResult?: SDKResultMessage): UsageData | null` function that extracts token counts and cost from structured model output. Unlike regex-based parsing, this uses the structured JSON output modes documented in R3.

The function should:

1. For Claude: read `total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens` directly from the `SDKResultMessage` — no parsing needed
2. For Gemini: parse the JSON output (`--output-format json`) and extract `stats.models.*.tokens.prompt`, `stats.models.*.tokens.candidates`, and `stats.models.*.tokens.cached`
3. For Codex: parse the JSONL output (`--json`) and extract `turn.completed` events with `usage.input_tokens`, `usage.cached_input_tokens`, and `usage.output_tokens`
4. Return null (not throw) if extraction fails
5. Log a warning to stderr on extraction failure

#### Cost computation

- **Claude**: Use `total_cost_usd` from `SDKResultMessage` — this is exact cost computed by Anthropic. No static pricing table needed.
- **Gemini and Codex**: Compute cost from exact token counts using a static pricing table. This is labeled as "computed" (not "estimated") because the token counts are exact — only the per-token rates are static snapshots.

```typescript
// Static pricing — only used for Gemini and Codex (Claude provides exact cost via SDK)
// Includes cached input rates to avoid overcharging on cache-heavy runs
const SUBPROCESS_MODEL_PRICING: Record<string, {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}> = {
  codex:  { inputPer1M: 2.00, cachedInputPer1M: 1.00, outputPer1M: 8.00 },   // gpt-5.2-codex
  gemini: { inputPer1M: 1.25, cachedInputPer1M: 0.315, outputPer1M: 10.00 },  // gemini-3-pro-preview
};
```

**Cost formula**: `cost = (input - cached) × inputRate + cached × cachedRate + output × outputRate`. All three values (input, cached, output) must be available to compute cost. If any token count is null, store `cost_usd = null` — consistent with R3's data integrity rule ("if exact data is unavailable, store null"). Since all three models provide cached token counts in their structured output, this should not reduce coverage in practice.

Update these constants manually when pricing changes. A future enhancement could fetch pricing from the LiteLLM community-maintained JSON file (`github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json`), but no official provider API exists for programmatic pricing data.

## Non-Requirements

- No real-time dashboard or web UI for metrics
- No alerting on cost thresholds (can be added later as a separate spec)
- No modification to the consultation subprocesses themselves (Gemini CLI, Codex CLI, Claude SDK internals)
- No automatic pricing updates — Gemini/Codex pricing constants are updated manually. No official provider API exists for programmatic pricing. Third-party sources (LiteLLM JSON, PricePerToken.com) exist but are out of scope for v1. Claude cost is exact from the SDK and needs no pricing table at all.
- No metrics export (CSV, etc.) beyond the `--json` flag
- No data retention/pruning — SQLite handles thousands of rows trivially; revisit if metrics.db exceeds 10MB

## Acceptance Criteria

1. Every `consult` invocation (manual or porch-automated) creates a row in `~/.codev/metrics.db` with at minimum: timestamp, model, subcommand, duration, exit code, and workspace path.
2. `consult stats` displays a summary table with total invocations, duration, cost, and success rate broken down by model, review type, and protocol.
3. `consult stats --last 10` displays the 10 most recent invocations in tabular format.
4. `consult stats --json` outputs the same data as JSON.
5. Metrics recording adds <100ms overhead to consult invocations (measured by comparing before/after wall-clock times).
6. When porch invokes consult, the resulting metrics row includes the correct `protocol` and `project_id` values.
7. Token/cost fields are populated when the model CLI provides parseable usage data; null otherwise.
8. SQLite write failures do not cause `consult` to fail — warning logged to stderr, consultation result preserved.
9. Works for all three models (gemini, codex, claude) and all subcommands (pr, spec, plan, impl, general).

## Testing

1. **Unit test**: `MetricsDB.record()` inserts a row; `MetricsDB.query()` retrieves it with correct values. Use a temp file for the test database.
2. **Unit test**: `MetricsDB.summary()` correctly aggregates duration, cost, and success rate across multiple rows.
3. **Unit test**: `extractUsage()` correctly parses sample Gemini JSON output (`stats.models.*.tokens`); returns null for malformed JSON.
4. **Unit test**: `extractUsage()` correctly parses sample Codex JSONL output (`turn.completed` events with `usage`); handles multiple turns.
5. **Unit test**: `extractUsage()` correctly reads Claude SDK result message fields (`total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`).
6. **Unit test**: `consult stats` formatting — verify table output matches expected format for known data.
7. **Unit test**: Filter flags (`--days`, `--model`, `--type`, `--protocol`, `--project`) correctly narrow query results.
8. **Integration test**: Run `consult --dry-run` with `--protocol` and `--project-id` flags, verify flags are accepted without error.
9. **Unit test**: SQLite write failure (e.g., read-only path) logs warning but does not throw.
10. **Unit test**: Gemini JSON output unwrapping — verify `response` field is extracted as plain text, not raw JSON.
11. **Unit test**: Codex JSONL output unwrapping — verify assistant message text is extracted from `message` events.
12. **Unit test**: Concurrent MetricsDB writes — verify three rapid inserts from different connections succeed with WAL+busy_timeout.
13. **Unit test**: `consult stats` with no database file prints "No metrics data found" and exits 0.
14. **Unit test**: JSON parsing failure fallback — when Gemini output is not valid JSON, raw output is written to outputPath and metrics record has null token/cost data.
