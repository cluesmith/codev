# Review 0078: Porch E2E Testing Infrastructure

## Summary

Implemented E2E testing infrastructure for porch that validates the full SPIR protocol lifecycle with real AI interactions.

## Implementation Status

### Files Created

| File | Purpose |
|------|---------|
| `packages/codev/src/commands/porch/__tests__/e2e/helpers/setup.ts` | Test project creation helper |
| `packages/codev/src/commands/porch/__tests__/e2e/helpers/teardown.ts` | Test cleanup helper |
| `packages/codev/src/commands/porch/__tests__/e2e/helpers/assertions.ts` | Custom test assertions |
| `packages/codev/src/commands/porch/__tests__/e2e/runner.ts` | Porch execution helpers |
| `packages/codev/src/commands/porch/__tests__/e2e/scenarios/happy-path.test.ts` | Full lifecycle test |
| `packages/codev/src/commands/porch/__tests__/e2e/scenarios/feedback-loop.test.ts` | Iteration/feedback tests |
| `packages/codev/src/commands/porch/__tests__/e2e/scenarios/signal-handling.test.ts` | AWAITING_INPUT/BLOCKED tests |
| `packages/codev/vitest.e2e.config.ts` | Vitest configuration for E2E |

### Files Modified

| File | Change |
|------|--------|
| `packages/codev/package.json` | Added `test:e2e` and `test:e2e:watch` scripts |
| `packages/codev/src/commands/porch/run.ts` | Added `PORCH_AUTO_APPROVE` env var support |

## 3-Way Consultation Results

### Gemini
- **VERDICT:** REQUEST_CHANGES
- **Issues:**
  1. Missing AWAITING_INPUT implementation - **FIXED**: Added signal-handling.test.ts
  2. Needs stdin handling for interactive tests - **FIXED**: Added `runPorchInteractive()` helper
  3. Mock strategy assumes child process invocation - **ACKNOWLEDGED**: This is correct, porch spawns consult as child process

### Codex
- **VERDICT:** REQUEST_CHANGES
- **Issues:**
  1. Spec lacks credential management details - **NOTED**: Uses existing environment credentials
  2. Plan uses `git add .` (policy violation) - **FIXED**: Changed to explicit file adds
  3. Auto-approve mechanism inconsistency (flag vs env var) - **NOTED**: Env var is more flexible for testing
  4. Missing AWAITING_INPUT implementation - **FIXED**: Added signal-handling.test.ts

### Claude
- **VERDICT:** COMMENT
- **Issues:**
  1. Missing AWAITING_INPUT scenario - **FIXED**: Added signal-handling.test.ts
  2. Missing BLOCKED signal testing - **FIXED**: Added to signal-handling.test.ts
  3. Spec/plan inconsistency on auto-approve - **NOTED**: Env var approach is valid

## Design Decisions

### 1. Environment Variable vs CLI Flag
Chose `PORCH_AUTO_APPROVE` environment variable over `--auto-approve-gates` flag because:
- More flexible for testing (can be set in test harness without modifying CLI calls)
- Follows convention of other test-mode environment variables
- Simpler implementation (checked at gate handling time)

### 2. Interactive Input Handling
Implemented `runPorchInteractive()` that:
- Takes pre-configured responses array
- Pipes stdin to the porch process
- Sends responses when AWAITING_INPUT is detected
- Records all signals for assertion

### 3. Mock Consult Strategy
Uses PATH manipulation to inject mock consult script for max-iterations testing. This works because:
- Porch spawns consult as a child process via `spawn('consult', ...)`
- PATH precedence allows mock to be found first
- Clean isolation (mock only affects the test's temp directory)

## Test Coverage

| Scenario | Status | Description |
|----------|--------|-------------|
| Happy Path | ✅ | Full SPIR lifecycle with real AI |
| Full Lifecycle | ✅ | End-to-end with auto-approve |
| Feedback Loop | ✅ | Build-verify iterations |
| Max Iterations | ✅ | Stops at iteration limit |
| AWAITING_INPUT | ✅ | Interactive question handling |
| BLOCKED | ✅ | Signal detection |

## Running the Tests

```bash
# Run all E2E tests
npm run test:e2e

# Run with watch mode (for development)
npm run test:e2e:watch

# Expected runtime: ~40 minutes
# Expected cost: ~$4 per full run
```

## Known Limitations

1. **AI Non-Determinism**: Tests focus on structure validation, not content. AI responses vary between runs.

2. **Long Timeouts**: Tests have 10-20 minute timeouts per scenario due to real AI interactions.

3. **Cost**: Full test run costs ~$4 in API usage. Should be run manually or in nightly builds, not on every commit.

4. **Credential Dependency**: Tests require valid API keys for Claude, Gemini, and Codex CLIs.

## Lessons Learned

1. **Policy Violations Matter**: Codex caught `git add .` in the plan pseudocode. Even example code should follow project policies.

2. **Test All Signal Types**: Easy to overlook edge cases like AWAITING_INPUT and BLOCKED. All three reviewers caught this.

3. **Env Vars vs Flags**: For test-mode switches, environment variables are often more flexible than CLI flags.

4. **Interactive Testing is Hard**: Testing interactive CLI flows requires careful stdin/stdout management. The `runPorchInteractive()` helper encapsulates this complexity.

## Conclusion

The E2E testing infrastructure is complete and ready for use. The 3-way consultation identified important gaps (AWAITING_INPUT handling, policy violations) that were addressed before finalization. The tests provide comprehensive coverage of the porch protocol lifecycle.
