/**
 * E2E Test: Single Phase (Builder/Enforcer/Worker pattern)
 *
 * Tests that --single-phase mode correctly:
 * 1. Runs one phase via Agent SDK (Worker)
 * 2. Outputs structured __PORCH_RESULT__ JSON
 * 3. Exits after the phase completes (or hits a gate)
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestProject,
  cleanupTestProject,
  getTestProjectState,
  type TestContext,
} from '../helpers/setup.js';
import {
  runPorchSinglePhase,
  approveGate,
} from '../runner.js';
import {
  assertSpecExists,
  assertPhase,
  assertGatePending,
  assertGateApproved,
} from '../helpers/assertions.js';

describe('Porch E2E: Single Phase Mode', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9990', 'single-phase-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('starts in specify phase', () => {
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();
    expect(state?.phase).toBe('specify');
  });

  it('runs specify phase and returns structured result', async () => {
    const result = await runPorchSinglePhase(ctx, 600000);

    expect(result.timedOut).toBe(false);

    // Should have output __PORCH_RESULT__ JSON
    expect(result.singlePhaseResult).not.toBeNull();

    const pr = result.singlePhaseResult!;
    expect(pr.phase).toBe('specify');
    expect(pr.iteration).toBeGreaterThanOrEqual(1);

    // Specify phase has a gate, so we expect gate_needed or verified
    // (depending on whether verification passes on first try)
    expect(['gate_needed', 'verified']).toContain(pr.status);

    // If gate_needed, the gate name should be present
    if (pr.status === 'gate_needed') {
      expect(pr.gate).toBe('spec-approval');
    }

    // Process should have exited (--single-phase)
    expect(result.exitCode).toBe(0);

    // Spec file should have been created by the Worker
    assertSpecExists(ctx);
  }, 600000);

  it('exits cleanly without hanging after single phase', async () => {
    // Verify the state is consistent after --single-phase exit
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();
    expect(state?.phase).toBe('specify');

    // Gate should be pending (waiting for human approval)
    if (state?.gates?.['spec-approval']) {
      expect(state.gates['spec-approval'].status).toBe('pending');
    }
  });

  it('can resume with another --single-phase after gate approval', async () => {
    // Approve the gate
    await approveGate(ctx, 'spec-approval');
    assertGateApproved(ctx, 'spec-approval');

    // Run another single phase - should advance past specify
    const result = await runPorchSinglePhase(ctx, 600000);

    expect(result.timedOut).toBe(false);
    expect(result.singlePhaseResult).not.toBeNull();

    const pr = result.singlePhaseResult!;
    // Should have advanced past specify to plan
    // The result might show 'advanced' (gate was already approved, moved to plan)
    // or 'gate_needed' (now in plan phase, hit plan-approval gate)
    expect(['advanced', 'gate_needed', 'verified']).toContain(pr.status);
  }, 600000);
});

describe('Porch E2E: Single Phase Result Format', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9989', 'result-format-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('includes artifact path in result for specify phase', async () => {
    const result = await runPorchSinglePhase(ctx, 600000);

    expect(result.singlePhaseResult).not.toBeNull();
    const pr = result.singlePhaseResult!;

    // Specify phase should include artifact path
    if (pr.artifact) {
      expect(pr.artifact).toContain('codev/specs/');
      expect(pr.artifact).toContain('9989');
    }
  }, 600000);

  it('includes verdicts when verification ran', async () => {
    const result = await runPorchSinglePhase(ctx, 600000);

    // If the phase got to verification, verdicts should be present
    const pr = result.singlePhaseResult;
    if (pr && pr.verdicts) {
      // Verdicts should be model -> verdict mapping
      const models = Object.keys(pr.verdicts);
      expect(models.length).toBeGreaterThan(0);

      for (const verdict of Object.values(pr.verdicts)) {
        expect(['APPROVE', 'REQUEST_CHANGES']).toContain(verdict);
      }
    }
  }, 600000);
});
