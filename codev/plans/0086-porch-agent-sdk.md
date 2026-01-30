# Plan 0086: Porch Agent SDK Integration

## Architecture Recap

```
BUILDER → porch run --single-phase → ENFORCER → WORKER (Agent SDK) + consult (Reviewer)
```

The Enforcer (porch) replaces `claude --print` subprocess with Agent SDK `query()` to invoke the Worker. The REPL and signal system are removed — the Builder is the human interface. Consultation is unchanged.

## Phases

```json
{
  "phases": [
    {
      "id": "phase_1",
      "title": "Agent SDK integration in claude.ts",
      "files": [
        "packages/codev/src/commands/porch/claude.ts",
        "packages/codev/package.json"
      ]
    },
    {
      "id": "phase_2",
      "title": "Update run.ts to use SDK and add --single-phase",
      "files": [
        "packages/codev/src/commands/porch/run.ts",
        "packages/codev/src/commands/porch/index.ts"
      ]
    },
    {
      "id": "phase_3",
      "title": "Remove repl.ts and signals.ts",
      "files": [
        "packages/codev/src/commands/porch/repl.ts",
        "packages/codev/src/commands/porch/signals.ts",
        "packages/codev/src/commands/porch/run.ts"
      ]
    },
    {
      "id": "phase_4",
      "title": "Tests and validation",
      "files": [
        "packages/codev/src/commands/porch/__tests__/claude.test.ts",
        "packages/codev/src/commands/porch/__tests__/run.test.ts"
      ]
    }
  ]
}
```

---

## Phase 1: Agent SDK integration in claude.ts

**Goal**: Replace `spawnClaude()` with an Agent SDK wrapper that provides the same interface to `run.ts` but uses `query()` internally.

### Steps

1. Add `@anthropic-ai/claude-agent-sdk` to `packages/codev/package.json` dependencies
2. Rewrite `claude.ts`:
   - Remove the `spawn('claude', ['--print', ...])` subprocess approach
   - Export a new `buildWithSDK(prompt, cwd, outputPath)` async function
   - Uses `query()` from the Agent SDK with:
     - `allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"]`
     - `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`
     - `cwd` set to the worktree path
     - `maxTurns: 200` (generous limit for implementation phases)
   - Streams assistant messages to `outputPath` (so `tail -f` still works from dashboard)
   - Returns a structured result: `{ success, output, cost, duration }`
3. Remove the `ClaudeProcess` interface (no longer a subprocess to manage)
4. Run `npm install` to pull the SDK dependency

### Key Decision: Streaming to Output File

Even though we remove the REPL, we still write output to a file. This allows:
- Dashboard to show live output via `af open`
- Debugging via `tail -f` from any terminal
- Post-mortem analysis of what Claude did

---

## Phase 2: Update run.ts to use SDK and add --single-phase

**Goal**: Replace the subprocess-based build loop with SDK calls and add `--single-phase` support.

### Steps

1. In `run.ts`:
   - Replace `spawnClaude()` + `runRepl()` + signal watching with a single `await buildWithSDK()` call
   - Remove the REPL-based event loop (`runRepl` returns actions; now we just await the SDK)
   - After `buildWithSDK()` returns, check if artifact exists, then proceed to VERIFY (unchanged)
   - Remove signal handling (`handleSignal`, `watchForSignal` imports)
   - The `build_complete` flag is set based on SDK result, not signal detection
2. Add `--single-phase` flag:
   - In `index.ts` (CLI entry), add `--single-phase` option
   - In `run()`, after completing one build-verify cycle (or hitting a gate), return instead of continuing the loop
   - Exit code 0 = phase completed successfully
   - Exit code 10 = gate needed (existing `EXIT_AWAITING_INPUT` pattern)
   - stdout: JSON summary of what happened (phase, iteration, verdict, gate status)
3. Remove the `claude_exit`, `signal`, `manual_claude` action handling from the main loop — these were REPL actions

### --single-phase Output Format

```json
{
  "phase": "implement",
  "plan_phase": "phase_1",
  "iteration": 2,
  "status": "verified",
  "verdicts": { "gemini": "APPROVE", "codex": "APPROVE", "claude": "APPROVE" },
  "next": "implement:phase_2"
}
```

Or for a gate:
```json
{
  "phase": "specify",
  "status": "gate_needed",
  "gate": "spec-approval",
  "artifact": "codev/specs/0086-porch-agent-sdk.md"
}
```

This structured output lets the outer Claude parse what happened and communicate it to the human.

---

## Phase 3: Remove repl.ts and signals.ts

**Goal**: Clean up code that's no longer needed.

### Steps

1. Delete `packages/codev/src/commands/porch/repl.ts`
2. Delete `packages/codev/src/commands/porch/signals.ts`
3. Remove imports of `repl.ts` and `signals.ts` from `run.ts`
4. Remove any tests for `signals.ts` (signal parsing tests)
5. Update any imports in `index.ts` if needed
6. Verify TypeScript compiles clean

---

## Phase 4: Tests and validation

**Goal**: Ensure the new SDK integration works and existing tests pass.

### Steps

1. Update `claude.test.ts` — test the new `buildWithSDK()` function with a mocked Agent SDK
2. Update `run.test.ts` — test `--single-phase` returns after one cycle
3. Verify existing tests pass:
   - `state.test.ts` — state management (unchanged)
   - `protocol.test.ts` — protocol loading (unchanged)
   - `plan.test.ts` — plan phase management (unchanged)
4. Manual validation:
   - `porch run <id> --single-phase` executes one build-verify cycle
   - Agent SDK Claude can edit files, run bash, search code
   - 3-way consultation runs after BUILD
   - Gate status returned properly
   - Output file populated for debugging
5. Build and `npm pack` for testing

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Agent SDK API instability (`unstable_v2_*`) | Use stable `query()` API (v1), not v2 sessions |
| SDK requires `claude` binary | Already required for builders — no new dependency |
| Agent SDK Claude cost per phase | Set `maxTurns` and monitor `total_cost_usd` in results |
| Output file format changes | Still write to file for backward compat with dashboard |
| Existing tests break | Only claude.ts and run.ts change; state/protocol/plan unchanged |
