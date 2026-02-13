# Spec 0103: Consult Claude via Agent SDK

## Summary

Replace the `claude` CLI subprocess delegation in `consult` with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), giving Claude the same tool-using agent capabilities as Gemini and Codex while eliminating the CLAUDECODE nesting problem that causes timeouts in builder contexts.

## Problem

The `consult` command delegates to three external CLIs: `gemini`, `codex`, and `claude`. The Claude backend (`consult -m claude`) fails when invoked from inside a builder because:

1. **Nesting guard**: The Claude CLI detects the `CLAUDECODE` environment variable (set by the parent Claude session) and refuses to start. This causes timeouts or errors in builder-driven 3-way reviews.
2. **No tool access in `--print` mode**: The current invocation uses `claude --print -p "<query>" --dangerously-skip-permissions`, which runs Claude in a text-in/text-out mode without tool use. Gemini and Codex CLIs both explore the codebase (grep, git show, file reading), giving them an advantage.
3. **Fragile flags**: `--dangerously-skip-permissions` and `--print` are CLI convenience flags, not a stable programmatic API.

### Impact

- Claude reviews timeout in ~8% of builder invocations (spec/plan and implementation phases)
- Claude cannot explore the codebase during reviews, unlike Gemini/Codex
- The `cmap` workflow (3-way parallel review) is incomplete when Claude fails

## Current State

### consult architecture (`packages/codev/src/commands/consult/index.ts`)

The `runConsultation()` function (line 262) delegates to model CLIs:

```typescript
// Current claude invocation (lines 322-325):
const fullQuery = `${role}\n\n---\n\nConsultation Request:\n${query}`;
cmd = [config.cli, ...config.args, fullQuery, '--dangerously-skip-permissions'];
// Spawns: claude --print -p "<role+query>" --dangerously-skip-permissions
```

All three models follow the same pattern:
1. Build a query string (PR diff, spec content, etc.)
2. Inject the consultant role (temp file or query prepend)
3. Spawn the CLI as a subprocess with `stdio: ['ignore', stdout, 'inherit']`
4. Capture stdout to `--output` file (used by porch for verdict parsing)

### Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.41)

The SDK exports a `query()` function that returns an `AsyncGenerator<SDKMessage>`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt: "Review this code...",
  options: {
    systemPrompt: consultantRole,
    tools: ['Read', 'Glob', 'Grep'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    model: 'claude-opus-4-6',
    maxTurns: 10,
    persistSession: false,
    cwd: projectRoot,
  }
});

for await (const message of session) {
  // message.type: 'assistant' | 'result' | 'system' | ...
}
```

Key SDK capabilities relevant to consult:
- **`systemPrompt`**: First-class option — no temp files, no query prepending
- **`tools`**: Restrict to read-only tools (`['Read', 'Glob', 'Grep']`) for reviews
- **`permissionMode: 'bypassPermissions'`**: No interactive prompts (equivalent to `--dangerously-skip-permissions`)
- **`outputFormat`**: Can enforce JSON schema on responses (structured verdict output)
- **`maxTurns`**: Cap agent turns to control cost/latency
- **`maxBudgetUsd`**: Hard cost limit per review
- **`persistSession: false`**: Ephemeral — no session files littering `~/.claude/projects/`
- **`effort`**: `'low'` / `'medium'` / `'high'` — can trade speed for thoroughness
- **`env`**: Pass custom environment (can omit `CLAUDECODE` explicitly)

The SDK spawns a bundled Claude Code process via IPC/stdio — it does NOT shell out to the system `claude` CLI. This means:
- No dependency on globally-installed `claude` CLI version
- The `CLAUDECODE` nesting check may behave differently (needs verification)
- Tool execution happens in the SDK's subprocess, not the parent shell

## Desired State

### Replace CLI delegation with SDK invocation for Claude model only

When `model === 'claude'`, instead of spawning `claude --print`, use the Agent SDK's `query()` function directly. Gemini and Codex continue using CLI delegation (no change).

### New `runClaudeConsultation()` function

```typescript
async function runClaudeConsultation(
  queryText: string,
  role: string,
  projectRoot: string,
  outputPath?: string,
): Promise<void> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const chunks: string[] = [];
  const session = query({
    prompt: queryText,
    options: {
      systemPrompt: role,
      tools: ['Read', 'Glob', 'Grep'],      // Read-only for reviews
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'claude-opus-4-6',
      maxTurns: 10,
      maxBudgetUsd: 1.00,
      persistSession: false,
      effort: 'high',
      cwd: projectRoot,
      env: {
        ...process.env,
        CLAUDECODE: undefined,               // Remove nesting guard
      },
    },
  });

  for await (const message of session) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          process.stdout.write(block.text);
          chunks.push(block.text);
        }
      }
    }
  }

  if (outputPath) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, chunks.join(''));
  }
}
```

### Structured verdict output (optional enhancement)

The SDK's `outputFormat` option can enforce JSON schema on responses:

```typescript
outputFormat: {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
      summary: { type: 'string' },
      confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
      key_issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'summary', 'confidence', 'key_issues'],
  }
}
```

This eliminates the fragile backward text-scanning in `verdict.ts`. However, this changes the output format from free-text to JSON, which would require updating `verdict.ts` parsing and changing how review files look. **Defer this to a follow-up TICK** — for now, keep free-text output and existing verdict parsing.

### Changes to `runConsultation()`

The existing function stays for gemini and codex. Add a branch for claude:

```typescript
if (model === 'claude') {
  await runClaudeConsultation(query, role, projectRoot, outputPath);
  return;
}
// ... existing CLI delegation for gemini/codex
```

### Dependency management

Add `@anthropic-ai/claude-agent-sdk` as an **optional peer dependency** (not a hard dependency). The SDK is only needed when `consult -m claude` is used. If not installed, fail fast with a clear error message.

```json
// package.json
"peerDependencies": {
  "@anthropic-ai/claude-agent-sdk": ">=0.2.0"
},
"peerDependenciesMeta": {
  "@anthropic-ai/claude-agent-sdk": { "optional": true }
}
```

At runtime, use dynamic `import()` and catch the error:

```typescript
let sdkModule: typeof import('@anthropic-ai/claude-agent-sdk');
try {
  sdkModule = await import('@anthropic-ai/claude-agent-sdk');
} catch {
  throw new Error(
    'Claude Agent SDK not installed.\n' +
    'Install with: npm install -g @anthropic-ai/claude-agent-sdk\n' +
    'Or use a different model: consult -m gemini ...'
  );
}
```

### CLI fallback removed

Once the SDK path is implemented, remove the `claude` entry from `MODEL_CONFIGS` entirely. The `commandExists('claude')` check is no longer needed for this model.

### Dry-run behavior

For `--dry-run` with claude model, print the SDK invocation parameters instead of the CLI command:

```
[claude] Would invoke Agent SDK:
  Model: claude-opus-4-6
  Tools: Read, Glob, Grep
  Max turns: 10
  Max budget: $1.00
  Effort: high
  Prompt: <first 200 chars>...
```

## Acceptance Criteria

1. `consult -m claude pr 42` works from inside a builder worktree (no CLAUDECODE nesting error)
2. `consult -m claude spec 42` produces a review with VERDICT line parseable by existing `verdict.ts`
3. Claude can read files during review (uses Read, Glob, Grep tools) — visible in output
4. `--output` flag writes review text to file (porch integration works)
5. `--dry-run` shows SDK parameters instead of CLI command
6. Missing SDK produces a clear error message with install instructions
7. Gemini and Codex invocations are unchanged
8. Cost per review stays under $1.00 (enforced by `maxBudgetUsd`)
9. Review completes within 120 seconds for typical PR reviews

## Out of Scope

- Structured JSON output via `outputFormat` (follow-up TICK)
- Changing Gemini or Codex backends to SDKs
- Session persistence or multi-turn consultation
- Custom MCP tools for review-specific functionality

## Risks

1. **SDK IPC conflicts**: The SDK spawns a bundled Claude Code subprocess. If the parent Claude session's environment leaks into the SDK subprocess, the nesting guard may still trigger. Mitigation: explicitly set `env` with `CLAUDECODE: undefined` and verify during implementation.

2. **SDK version churn**: The SDK is at v0.2.41 — still pre-1.0. API changes are possible. Mitigation: pin to `>=0.2.0` peer dependency, use only stable `query()` entrypoint.

3. **Output format differences**: The SDK returns structured `SDKMessage` objects, not raw text. The text extraction logic must match what the CLI's `--print` mode produced. Mitigation: extract text blocks from `AssistantMessage` content, concatenate in order.

4. **Cost**: Agent mode with tool use costs more tokens than `--print` mode (tool calls, results). Mitigation: `maxBudgetUsd: 1.00` and `maxTurns: 10` cap worst case. Monitor during testing.
