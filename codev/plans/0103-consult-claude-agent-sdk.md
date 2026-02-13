# Plan: Consult Claude via Agent SDK

## Metadata
- **ID**: plan-2026-02-13-consult-claude-agent-sdk
- **Status**: draft
- **Specification**: codev/specs/0103-consult-claude-agent-sdk.md
- **Created**: 2026-02-13

## Executive Summary

Replace the Claude CLI subprocess delegation in `consult` with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The implementation adds the SDK as a hard dependency, creates a new `runClaudeConsultation()` function using `query()`, updates doctor to verify Claude auth via SDK instead of CLI, and updates tests.

**Key API corrections from spec** (discovered during research):
- Use `allowedTools` (not `tools`) for restricting to `['Read', 'Glob', 'Grep']`
- No `persistSession` option — sessions are ephemeral by default
- No `effort` option in SDK — omit or use `extraArgs` if needed
- No `tool_use_summary` message type — tool use appears in assistant message content blocks
- Use `delete env.CLAUDECODE` pattern instead of spreading with `undefined`

## Success Metrics
- [ ] `consult -m claude` works from inside builder worktrees (no CLAUDECODE nesting error)
- [ ] Claude can read files during reviews (uses Read, Glob, Grep tools)
- [ ] `--output` flag writes review text to file
- [ ] `--dry-run` shows SDK parameters
- [ ] `codev doctor` verifies Claude auth via SDK
- [ ] Gemini and Codex invocations unchanged
- [ ] All existing tests pass
- [ ] New unit tests for SDK path

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Add SDK dependency and runClaudeConsultation"},
    {"id": "phase_2", "title": "Update doctor and tests"},
    {"id": "phase_3", "title": "Cleanup and verify"}
  ]
}
```

## Phase Breakdown

### Phase 1: Add SDK dependency and runClaudeConsultation
**Dependencies**: None

#### Objectives
- Add `@anthropic-ai/claude-agent-sdk` as a hard dependency
- Create `runClaudeConsultation()` function in consult/index.ts
- Wire it into `runConsultation()` for the claude model branch
- Handle dry-run output for SDK path
- Keep `claude` in `MODEL_CONFIGS` for now (removed in Phase 3 after validation updates)

#### Deliverables
- [ ] `@anthropic-ai/claude-agent-sdk` added to `packages/codev/package.json` dependencies
- [ ] `runClaudeConsultation()` function implemented
- [ ] Claude model branch in `runConsultation()` calls SDK instead of CLI
- [ ] Dry-run shows SDK parameters for claude model
- [ ] `npm install` and `npm run build` succeed

#### Implementation Details

**package.json** (`packages/codev/package.json`):
```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "^0.2.41",
  // ... existing
}
```

**consult/index.ts** (`packages/codev/src/commands/consult/index.ts`):

1. Add import at top:
```typescript
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
```

2. Add new `runClaudeConsultation()` function:
```typescript
async function runClaudeConsultation(
  queryText: string,
  role: string,
  projectRoot: string,
  outputPath?: string,
): Promise<void> {
  const chunks: string[] = [];
  const env = { ...process.env };
  delete env.CLAUDECODE;  // Remove nesting guard

  const session = claudeQuery({
    prompt: queryText,
    options: {
      systemPrompt: role,
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'claude-opus-4-6',
      maxTurns: 10,
      maxBudgetUsd: 1.00,
      cwd: projectRoot,
      env,
    },
  });

  for await (const message of session) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          process.stdout.write(block.text);
          chunks.push(block.text);
        } else if ('name' in block) {
          // Tool use block — show tool name + input summary on stderr
          // This surfaces file paths and search patterns for visibility
          const input = 'input' in block ? block.input : {};
          const detail = typeof input === 'object' && input !== null
            ? (input as any).file_path || (input as any).pattern || (input as any).path || ''
            : '';
          const summary = detail ? `: ${detail}` : '';
          process.stderr.write(chalk.dim(`[Tool: ${block.name}${summary}]\n`));
        }
      }
    }
    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        const errors = 'errors' in message ? (message as any).errors : [];
        throw new Error(`Claude SDK error (${message.subtype}): ${errors.join(', ')}`);
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

3. Modify `runConsultation()`:
- Add claude SDK branch before existing CLI delegation
- For dry-run, print SDK parameters
- Skip `commandExists` check for claude (SDK handles this internally)
- Keep logging duration and calling `logQuery()`

**Note on stderr vs output file**: Tool use logs go to stderr only. The `chunks[]` array (written to `--output` file) contains only assistant text blocks. This matches existing Gemini/Codex behavior where tool exploration is visible on stderr but captured output is review text only.

#### Acceptance Criteria
- [ ] `npm run build` succeeds with new dependency
- [ ] `consult -m claude --dry-run general "test"` shows SDK parameters
- [ ] Claude consultation uses SDK (no subprocess spawn for claude)

#### Test Plan
- **Unit Tests**: Mock `@anthropic-ai/claude-agent-sdk` `query()` function; verify `runClaudeConsultation()` extracts text, writes output file, removes CLAUDECODE from env
- **Manual Testing**: Run `consult -m claude general "Reply OK"` and verify it works

#### Risks
- **Risk**: SDK API may differ from documented behavior
  - **Mitigation**: Verify with `npm run build` and manual test early

---

### Phase 2: Update doctor and tests
**Dependencies**: Phase 1

#### Objectives
- Update `codev doctor` to verify Claude auth via SDK instead of CLI
- Remove Claude CLI dependency from `AI_DEPENDENCIES`
- Add unit tests for the new SDK-based consultation
- Update existing tests to reflect claude model changes

#### Deliverables
- [ ] Doctor uses SDK `query()` for Claude auth verification
- [ ] Claude CLI removed from `AI_DEPENDENCIES`
- [ ] Unit tests for `runClaudeConsultation()` (mocked SDK)
- [ ] Unit test for dry-run with claude model
- [ ] Unit test for doctor Claude SDK auth check
- [ ] All existing tests still pass

#### Implementation Details

**doctor.ts** (`packages/codev/src/commands/doctor.ts`):

1. Remove Claude from `AI_DEPENDENCIES` array (the CLI is no longer required)
2. Update `VERIFY_CONFIGS['Claude']` to use SDK:
```typescript
'Claude': {
  // Use Agent SDK for verification instead of CLI
  command: '__sdk__',  // sentinel value
  args: [],
  timeout: 30000,
  successCheck: () => true,  // handled by custom verification
  authHint: 'Set ANTHROPIC_API_KEY or run: claude /login',
},
```
3. Add a new `verifyClaudeViaSDK()` function that uses `query()` with minimal options (`prompt: 'Reply OK'`, `allowedTools: []`, `maxTurns: 1`)
4. Update `verifyAiModel()` to call `verifyClaudeViaSDK()` when model is Claude

**consult.test.ts** (`packages/codev/src/__tests__/consult.test.ts`):

1. Add mock for `@anthropic-ai/claude-agent-sdk`
2. Add tests:
   - `runClaudeConsultation` extracts text from assistant messages
   - `runClaudeConsultation` writes output to file
   - `runClaudeConsultation` removes CLAUDECODE from env
   - `runClaudeConsultation` throws on SDK error results
   - Dry-run for claude shows SDK parameters (not CLI command)

**doctor.test.ts** (`packages/codev/src/__tests__/doctor.test.ts`):

1. Add mock for `@anthropic-ai/claude-agent-sdk`
2. Add tests:
   - Doctor verifies Claude auth via SDK (success case)
   - Doctor reports auth failure via SDK (failure case)
   - Claude CLI no longer in AI_DEPENDENCIES

**Integration test** (`packages/codev/src/__tests__/consult.test.ts` or separate file):

Add an automated test that verifies CLAUDECODE nesting is handled:
```typescript
it('should succeed with CLAUDECODE env var set (nesting workaround)', async () => {
  // Set CLAUDECODE to simulate builder context
  process.env.CLAUDECODE = '1';
  // Mock the SDK query to verify env passed does NOT contain CLAUDECODE
  const mockQuery = vi.fn().mockReturnValue(mockAsyncGenerator([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
    { type: 'result', subtype: 'success', result: 'OK', /* ... */ },
  ]));
  // Verify mockQuery was called with env that lacks CLAUDECODE
  // ...
  delete process.env.CLAUDECODE;
});
```

This test ensures the primary regression (CLAUDECODE nesting) cannot silently return.

#### Acceptance Criteria
- [ ] `npm test` passes all existing and new tests
- [ ] `codev doctor` no longer checks for `claude` CLI binary
- [ ] `codev doctor` verifies Claude auth via SDK
- [ ] CLAUDECODE nesting integration test passes

#### Test Plan
- **Unit Tests**: All tests listed above with mocked SDK
- **Integration Test**: Automated CLAUDECODE nesting test (verifies env cleanup)
- **Manual Testing**: Run `codev doctor` and verify Claude verification section

#### Risks
- **Risk**: Mocking the SDK async generator may be complex
  - **Mitigation**: Create a helper function that yields canned SDKMessage objects

---

### Phase 3: Cleanup and verify
**Dependencies**: Phase 2

#### Objectives
- Clean up MODEL_CONFIGS for claude entry
- Ensure build is clean and all tests pass
- Verify end-to-end behavior

#### Deliverables
- [ ] `MODEL_CONFIGS` cleaned up (remove `claude` entry, update `commandExists` logic)
- [ ] `MODEL_ALIASES` still work (opus → claude)
- [ ] Build succeeds cleanly
- [ ] All unit tests pass
- [ ] Manual verification from builder context

#### Implementation Details

1. Remove `claude` entry from `MODEL_CONFIGS` entirely
2. Update model validation in `consult()` to recognize `claude` even without a `MODEL_CONFIGS` entry (since it uses SDK, not CLI)
3. Update `commandExists` check to skip for claude model
4. Run full build and test suite

#### Acceptance Criteria
- [ ] `npm run build` clean (no warnings)
- [ ] `npm test` all pass
- [ ] `consult -m claude general "Reply OK"` works
- [ ] `consult -m opus general "Reply OK"` works (alias)
- [ ] `consult -m gemini general "Reply OK"` works (unchanged)
- [ ] `consult -m codex general "Reply OK"` works (unchanged)

#### Test Plan
- **Unit Tests**: Verify model alias resolution still works for claude/opus
- **Manual Testing**: Run all four model variants

#### Risks
- **Risk**: Removing MODEL_CONFIGS entry may break other code paths
  - **Mitigation**: Search for all references to MODEL_CONFIGS before removal

---

## Dependency Map
```
Phase 1 (SDK + runClaudeConsultation) ──→ Phase 2 (Doctor + Tests) ──→ Phase 3 (Cleanup)
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| SDK API mismatch with spec | M | H | Research done; corrected options identified |
| CLAUDECODE nesting still triggers in SDK subprocess | L | H | Explicitly delete from env before passing to SDK |
| SDK version churn (pre-1.0) | L | M | Pin to ^0.2.41, use only stable `query()` API |
| Cost increase from agent mode | L | M | `maxBudgetUsd: 1.00` and `maxTurns: 10` cap worst case |
| CLAUDECODE regression without automated test | M | H | Integration test added to Phase 2 verifying env cleanup |

## Validation Checkpoints
1. **After Phase 1**: `npm run build` succeeds, `consult -m claude --dry-run general "test"` works
2. **After Phase 2**: `npm test` all pass, `codev doctor` verifies Claude via SDK
3. **Before PR**: Full build, all tests pass, manual end-to-end verification

## Notes

- The spec mentions `persistSession: false` and `effort: 'high'` but these are not valid SDK options. Sessions are ephemeral by default and effort is an API-level parameter, not SDK-level.
- The spec mentions `tool_use_summary` message type but this doesn't exist in the SDK. Tool use appears as content blocks within assistant messages.
- The `tools` option in the SDK is for presets; use `allowedTools` to restrict available tools.
