# Spec 0078: Porch E2E Testing Infrastructure

## Problem Statement

Porch orchestrates a triple-nested AI system (Architect → Builder → Porch → Inner Claude) with 3-way verification loops. Currently there's no way to test this system end-to-end without manual testing. We need automated E2E tests that validate the full workflow.

## Goals

1. **Test the full porch lifecycle** - from `porch init` through all phases to completion
2. **Test the build-verify loop** - inner Claude creates artifact, 3-way review, iterate on feedback
3. **Test signal handling** - PHASE_COMPLETE, AWAITING_INPUT, BLOCKED
4. **Test gate enforcement** - spec-approval, plan-approval gates work correctly
5. **Validate real AI interactions** - use actual Claude/Gemini/Codex (not mocks)

## Non-Goals

- Unit test coverage (already exists)
- Mocked/stubbed tests (that's a separate concern)
- Performance benchmarking
- Cost optimization (this is explicitly allowed to be expensive)

## Proposed Solution

### Test Harness

Create a test harness that:
1. Creates a temporary git repository with codev initialized
2. Runs `porch init` with a test project
3. Executes `porch run` through the full SPIR protocol
4. Validates state transitions and artifacts at each phase
5. Cleans up after completion

### Test Scenarios

#### Scenario 1: Happy Path (Full SPIR)
- Initialize project 9999 "test-feature"
- Run through specify → plan → implement → review
- Verify all artifacts created (spec, plan, review files)
- Verify all gates hit and can be approved
- Verify 3-way reviews run at each phase

#### Scenario 2: Feedback Loop
- Start specify phase
- If reviewers request changes, verify porch iterates
- Verify feedback is included in respawn prompt
- Verify iteration count increments

#### Scenario 3: AWAITING_INPUT Signal
- Trigger inner Claude to ask clarifying questions
- Verify porch prompts for answers
- Verify answers are stored in context.user_answers
- Verify Claude is respawned with answers

#### Scenario 4: Max Iterations
- Force reviewers to always reject (mock this one scenario)
- Verify porch stops at max_iterations (7)
- Verify gate is still requested after max iterations

### Test Runner

```bash
# Run all E2E tests
npm run test:e2e

# Run specific scenario
npm run test:e2e -- --scenario happy-path

# Run with verbose output
npm run test:e2e -- --verbose
```

### Directory Structure

```
packages/codev/
├── src/
│   └── commands/porch/
│       └── __tests__/
│           └── e2e/
│               ├── runner.ts        # Test harness
│               ├── scenarios/
│               │   ├── happy-path.ts
│               │   ├── feedback-loop.ts
│               │   ├── awaiting-input.ts
│               │   └── max-iterations.ts
│               ├── fixtures/
│               │   └── test-project/  # Template project
│               └── helpers/
│                   ├── setup.ts      # Create temp repo
│                   ├── teardown.ts   # Cleanup
│                   └── assertions.ts # Custom assertions
```

## Technical Implementation

### Test Harness (runner.ts)

```typescript
interface E2ETestContext {
  tempDir: string;           // Temporary git repo
  projectId: string;         // Test project ID
  porchProcess: ChildProcess; // Running porch
  state: ProjectState;       // Current porch state
}

async function runScenario(scenario: Scenario): Promise<TestResult> {
  const ctx = await setup();
  try {
    await scenario.run(ctx);
    return { passed: true };
  } catch (err) {
    return { passed: false, error: err };
  } finally {
    await teardown(ctx);
  }
}
```

### Gate Approval Automation

For E2E tests, gates need to be auto-approved. Options:
1. Run `porch approve` in a separate process when gate is hit
2. Add `--auto-approve-gates` flag to porch for testing
3. Use expect/pty to interact with porch REPL

Recommendation: Option 2 (`--auto-approve-gates`) is cleanest for testing.

### Reviewer Interaction

Real 3-way reviews will run. This means:
- Tests take 2-5 minutes per phase (3 consultations × ~60s each)
- Full happy path test: ~15-20 minutes
- Cost per run: ~$1-2 (estimate)

This is acceptable per user requirement ("I don't care if it's expensive").

## Success Criteria

1. `npm run test:e2e` runs all scenarios
2. Happy path completes with all artifacts created
3. Feedback loop demonstrates iteration works
4. AWAITING_INPUT flow works (may need manual input for first run)
5. Max iterations stops at 7
6. Tests are reproducible (same inputs → same structure of outputs)

## Testing Strategy

| Test | Real AI | Duration | Cost |
|------|---------|----------|------|
| Happy path | Yes | ~20 min | ~$2 |
| Feedback loop | Yes | ~10 min | ~$1 |
| AWAITING_INPUT | Yes | ~5 min | ~$0.50 |
| Max iterations | Partial mock | ~5 min | ~$0.50 |

Total per full run: ~40 minutes, ~$4

## Out of Scope

- CI integration (run manually for now)
- Parallel test execution
- Test result dashboard
- Cost tracking per test

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Tests are flaky due to AI non-determinism | High | Medium | Focus on structure, not content |
| Tests take too long | Medium | Low | Accept it; run nightly |
| Costs spiral | Low | Medium | Budget cap per month |
| Porch bugs cause test hangs | Medium | High | Timeouts on all operations |

## Consultation

(To be filled after 3-way review)
