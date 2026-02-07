/**
 * E2E Test: Happy Path
 *
 * Tests the full SPIR protocol lifecycle with real AI calls.
 * This is an expensive test (~$4, ~40 minutes).
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createTestProject,
  cleanupTestProject,
  getTestProjectState,
  type TestContext,
} from '../helpers/setup.js';
import {
  runPorchUntilGate,
  runPorchWithAutoApprove,
  approveGate,
} from '../runner.js';
import {
  assertSpecExists,
  assertPlanExists,
  assertPhase,
  assertGatePending,
  assertGateApproved,
} from '../helpers/assertions.js';

describe('Porch E2E: Happy Path', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9999', 'test-feature');
  }, 120000); // 2 minute setup timeout

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('initializes project with correct state', () => {
    const state = getTestProjectState(ctx);

    expect(state).not.toBeNull();
    expect(state?.id).toBe('9999');
    expect(state?.title).toBe('test-feature');
    expect(state?.protocol).toBe('spir');
    expect(state?.phase).toBe('specify');
    expect(state?.iteration).toBe(1);
  });

  it('completes specify phase and hits spec-approval gate', async () => {
    const result = await runPorchUntilGate(ctx, 600000);

    // Should have hit the gate
    expect(result.hitGate).toBe('spec-approval');
    expect(result.timedOut).toBe(false);

    // Verify spec file was created
    assertSpecExists(ctx);

    // Verify state shows pending gate
    assertGatePending(ctx, 'spec-approval');
  }, 600000); // 10 minute timeout

  it('continues to plan phase after spec approval', async () => {
    // Approve the spec gate programmatically
    await approveGate(ctx, 'spec-approval');
    assertGateApproved(ctx, 'spec-approval');

    // Run until next gate
    const result = await runPorchUntilGate(ctx, 600000);

    // Should hit plan-approval gate
    expect(result.hitGate).toBe('plan-approval');
    expect(result.timedOut).toBe(false);

    // Verify plan file was created
    assertPlanExists(ctx);

    // Verify current phase
    assertPhase(ctx, 'plan');
    assertGatePending(ctx, 'plan-approval');
  }, 600000);

  it('continues to implement phase after plan approval', async () => {
    // Approve the plan gate
    await approveGate(ctx, 'plan-approval');
    assertGateApproved(ctx, 'plan-approval');

    // Run until next gate (implement phase has no gate, will continue to review)
    const result = await runPorchUntilGate(ctx, 900000); // 15 min for implement

    // Implement phase should complete and move to review gate
    // Or it might hit integration-approval gate
    expect(result.timedOut).toBe(false);
  }, 900000);
});

/**
 * Full lifecycle test with auto-approve.
 * This runs the entire SPIR protocol from start to finish.
 */
describe('Porch E2E: Full Lifecycle', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9998', 'full-lifecycle');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('completes full SPIR protocol with auto-approve', async () => {
    const result = await runPorchWithAutoApprove(ctx, 2400000); // 40 minutes

    // Should complete successfully
    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);

    // Verify all artifacts exist
    assertSpecExists(ctx);
    assertPlanExists(ctx);

    // Verify final state
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();

    // All gates should be approved
    assertGateApproved(ctx, 'spec-approval');
    assertGateApproved(ctx, 'plan-approval');
  }, 2400000); // 40 minute timeout
});
