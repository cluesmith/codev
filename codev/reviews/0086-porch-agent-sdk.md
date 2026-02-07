# Review 0086: Porch Agent SDK Integration

## Metadata
- **ID**: 0086
- **Reviewed**: 2026-01-30
- **Protocol**: SPIR
- **Commits**: 82d8c7f, 3178b2a

---

## Summary

Replaced porch's `claude --print` subprocess with the Anthropic Agent SDK `query()` function. Established the Builder/Enforcer/Worker three-layer architecture where the Builder (interactive Claude) calls porch, porch (Enforcer) drives the protocol, and the Worker (Agent SDK Claude) does the actual coding with full tool access.

## What Changed

### New
- `buildWithSDK()` in `claude.ts` — Agent SDK adapter with streaming output, tool use logging, cost/duration tracking
- `--single-phase` flag — Builder stays in the loop between phases, receives structured `__PORCH_RESULT__` JSON
- `outputSinglePhaseResult()` — structured output with phase, status, gate, verdicts, artifact
- 5 unit tests for `buildWithSDK` (mocked SDK)
- E2E `single-phase.test.ts` and `runPorchSinglePhase()` runner helper

### Removed
- `repl.ts` — interactive REPL (Builder is now the interface)
- `signals.ts` — XML signal parsing (SDK provides structured completion)
- `signal-handling.test.ts` — E2E test for removed signal system
- Signal footer from `prompts.ts`

### Modified
- `run.ts` — uses `buildWithSDK()` instead of `spawnClaude()`, `--single-phase` exit points at gate-pending, gate-approved, build-verify-passes, request-changes, worker-failure
- `index.ts` — added `--single-phase` CLI option, removed orphaned `--answer`
- `package.json` — added `@anthropic-ai/claude-agent-sdk` dependency, fixed dashboard CI build

## 3-Way Review Results

### Round 1
| Reviewer | Verdict |
|----------|---------|
| Gemini   | APPROVE (1 issue: max iterations hangs in --single-phase) |
| Claude   | APPROVE with gaps (missing 'failed' status, no run.ts tests) |
| Codex    | REQUEST_CHANGES (4 issues) |

### Issues Raised and Resolution
1. **--single-phase loops on REQUEST_CHANGES** (Codex) — Fixed: exits with `iterating` status
2. **Max iterations hangs on rl.question** (Gemini) — Fixed: singlePhase check is before the prompt
3. **Tool output not streamed** (Codex) — Fixed: captures `tool_use` blocks and `tool_progress` events
4. **Missing 'failed' status** (Claude) — Fixed: added for non-build_verify Worker failures
5. **Dead startPhase variable** (Codex) — Fixed: removed
6. **Tower notifications lost** (Codex) — Acknowledged: intentional removal. Builder handles human communication now.
7. **No AWAITING_INPUT pathway** (Codex) — Acknowledged: Agent SDK handles this internally via its own tool loop. Worker doesn't need to pause for human input.

## Lessons Learned

1. **The drift problem is real.** The entire reason for Builder/Enforcer/Worker is that Claude skips reviews when given autonomy. Porch must wrap Claude, not the other way around. This was documented in `identity-and-porch-design.md` but still caused confusion during design.

2. **`--single-phase` is essential.** Without it, the Builder has no way to monitor or relay progress. The original design had porch running to completion, but the Builder needs to stay in the loop for human interaction.

3. **Agent SDK message types matter.** The SDK emits `assistant`, `result`, `tool_progress`, `tool_use_summary`, `stream_event` — not `tool_result`. Had to check the actual TypeScript types rather than guessing.

4. **E2E tests with real API calls are expensive and slow.** The happy-path test costs ~$4 and takes 10-40 minutes. Mock tests are essential for fast feedback. Real E2E should be reserved for integration validation.

5. **Pre-existing E2E infrastructure had ESM bugs.** `require('./setup.js')` in assertions.ts failed in vitest's ESM mode. Also `require('glob')` was unnecessary — `fs.readdirSync` with a filter works fine.
