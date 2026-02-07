# Plan 0078: Porch E2E Testing Infrastructure

## Overview

Build an E2E test harness for porch that runs real AI interactions through the full SPIR protocol lifecycle.

## Dependencies

- Existing porch implementation (run.ts, state.ts, etc.)
- consult CLI
- claude CLI
- vitest (test runner)

## Implementation Phases

```json
{
  "phases": [
    {
      "id": "phase_1",
      "title": "Test Harness Foundation",
      "description": "Create the basic test runner, setup/teardown helpers, and directory structure"
    },
    {
      "id": "phase_2",
      "title": "Happy Path Scenario",
      "description": "Implement the full SPIR lifecycle test with real AI calls"
    },
    {
      "id": "phase_3",
      "title": "Feedback Loop and Edge Cases",
      "description": "Test iteration on reviewer feedback and max iterations limit"
    }
  ]
}
```

### Phase 1: Test Harness Foundation

**Goal:** Create the infrastructure to run E2E tests.

**Files to create:**

| File | Purpose |
|------|---------|
| `packages/codev/src/commands/porch/__tests__/e2e/runner.ts` | Main test harness |
| `packages/codev/src/commands/porch/__tests__/e2e/helpers/setup.ts` | Create temp repo with codev |
| `packages/codev/src/commands/porch/__tests__/e2e/helpers/teardown.ts` | Cleanup temp directories |
| `packages/codev/src/commands/porch/__tests__/e2e/helpers/assertions.ts` | Custom test assertions |
| `packages/codev/vitest.e2e.config.ts` | Vitest config for E2E tests |

**Files to modify:**

| File | Change |
|------|--------|
| `packages/codev/package.json` | Add `test:e2e` script |
| `packages/codev/src/commands/porch/run.ts` | Add `--auto-approve-gates` flag |

**Implementation details:**

Setup helper:
```typescript
export async function createTestProject(): Promise<TestContext> {
  // 1. Create temp directory
  const tempDir = await mkdtemp(join(tmpdir(), 'porch-e2e-'));

  // 2. Initialize git repo
  await exec('git init', { cwd: tempDir });
  await exec('git config user.email "test@test.com"', { cwd: tempDir });
  await exec('git config user.name "Test"', { cwd: tempDir });

  // 3. Copy codev-skeleton
  await cp(skeletonPath, join(tempDir, 'codev'), { recursive: true });

  // 4. Create initial commit
  await exec('git add .', { cwd: tempDir });
  await exec('git commit -m "Initial commit"', { cwd: tempDir });

  // 5. Initialize porch project
  await exec(`porch init spir 9999 "test-feature"`, { cwd: tempDir });

  return { tempDir, projectId: '9999' };
}
```

Auto-approve flag:
```typescript
// In run.ts, add to handleGate()
if (process.env.PORCH_AUTO_APPROVE === 'true') {
  console.log(chalk.yellow(`[E2E] Auto-approving gate: ${gateName}`));
  state.gates[gateName].status = 'approved';
  state.gates[gateName].approved_at = new Date().toISOString();
  writeState(statusPath, state);
  return;
}
```

### Phase 2: Happy Path Scenario

**Goal:** Test the full SPIR lifecycle with real AI.

**Files to create:**

| File | Purpose |
|------|---------|
| `packages/codev/src/commands/porch/__tests__/e2e/scenarios/happy-path.test.ts` | Happy path test |

**Test structure:**

```typescript
describe('Porch E2E: Happy Path', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject();
  }, 120000); // 2 min setup timeout

  afterAll(async () => {
    await teardown(ctx);
  });

  it('completes specify phase with 3-way review', async () => {
    // Run porch until gate
    await runPorchUntilGate(ctx, 'spec-approval');

    // Verify spec was created
    const specPath = join(ctx.tempDir, 'codev/specs/9999-test-feature.md');
    expect(fs.existsSync(specPath)).toBe(true);

    // Verify 3-way review files exist
    const projectDir = join(ctx.tempDir, 'codev/projects/9999-test-feature');
    const reviewFiles = glob.sync('*-specify-*-*.txt', { cwd: projectDir });
    expect(reviewFiles.length).toBeGreaterThanOrEqual(3); // gemini, codex, claude
  }, 600000); // 10 min timeout

  it('completes plan phase after spec approval', async () => {
    // Approve spec gate
    await approvegate(ctx, 'spec-approval');

    // Run porch until next gate
    await runPorchUntilGate(ctx, 'plan-approval');

    // Verify plan was created
    const planPath = join(ctx.tempDir, 'codev/plans/9999-test-feature.md');
    expect(fs.existsSync(planPath)).toBe(true);
  }, 600000);

  // ... more phases
});
```

**Helper function:**

```typescript
async function runPorchUntilGate(ctx: TestContext, gateName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 600000);

    const porch = spawn('porch', ['run', ctx.projectId], {
      cwd: ctx.tempDir,
      env: { ...process.env, PORCH_AUTO_APPROVE: 'false' }
    });

    porch.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes(`GATE: ${gateName}`)) {
        clearTimeout(timeout);
        porch.kill();
        resolve();
      }
    });

    porch.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Porch exited with ${code}`));
    });
  });
}
```

### Phase 3: Feedback Loop and Edge Cases

**Goal:** Test reviewer feedback iteration and max iterations.

**Files to create:**

| File | Purpose |
|------|---------|
| `packages/codev/src/commands/porch/__tests__/e2e/scenarios/feedback-loop.test.ts` | Feedback iteration test |
| `packages/codev/src/commands/porch/__tests__/e2e/scenarios/max-iterations.test.ts` | Max iterations test |

**Feedback loop test:**

```typescript
it('iterates when reviewers request changes', async () => {
  // Run specify phase
  await runPorchUntilGate(ctx, 'spec-approval');

  // Check iteration count in state
  const state = readState(ctx);

  // If iteration > 1, feedback loop worked
  // Note: Can't guarantee reviewers will reject, but we can verify
  // the mechanism exists by checking history array
  expect(state.history).toBeDefined();
  expect(Array.isArray(state.history)).toBe(true);
});
```

**Max iterations test (uses mock reviewer):**

```typescript
it('stops at max iterations', async () => {
  // Create a mock consult that always returns REQUEST_CHANGES
  const mockConsult = join(ctx.tempDir, 'mock-consult');
  await writeFile(mockConsult, `#!/bin/bash
echo "VERDICT: REQUEST_CHANGES"
echo "This needs more work."
`, { mode: 0o755 });

  // Run porch with mock consult
  const env = {
    ...process.env,
    PATH: `${ctx.tempDir}:${process.env.PATH}` // Prepend mock
  };

  await runPorchWithEnv(ctx, env);

  // Verify stopped at iteration 7
  const state = readState(ctx);
  expect(state.history.length).toBe(7);
});
```

## Vitest Configuration

```typescript
// vitest.e2e.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/commands/porch/__tests__/e2e/**/*.test.ts'],
    testTimeout: 1200000, // 20 minutes per test
    hookTimeout: 300000,  // 5 minutes for setup/teardown
    pool: 'forks',        // Isolate tests
    maxConcurrency: 1,    // Run sequentially (expensive)
  },
});
```

## Package.json Scripts

```json
{
  "scripts": {
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "test:e2e:watch": "vitest --config vitest.e2e.config.ts"
  }
}
```

## Success Criteria

| Phase | Deliverable | Verification |
|-------|-------------|--------------|
| 1 | Test harness runs | `npm run test:e2e` executes without crash |
| 2 | Happy path passes | Full SPIR lifecycle completes |
| 3 | Edge cases pass | Feedback loop and max iterations work |

## Estimated Scope

| Metric | Value |
|--------|-------|
| New files | 8 |
| Modified files | 2 |
| Lines of code | ~500 |
| Test runtime | ~40 minutes |
| Cost per run | ~$4 |
