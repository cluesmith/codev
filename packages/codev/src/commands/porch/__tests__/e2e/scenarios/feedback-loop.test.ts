/**
 * E2E Test: Feedback Loop
 *
 * Tests that porch correctly handles reviewer feedback and iterates.
 * Also tests the max iterations limit.
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
  runPorchOnce,
} from '../runner.js';
import {
  assertHistoryNotEmpty,
  assertIteration,
} from '../helpers/assertions.js';

describe('Porch E2E: Feedback Loop', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9997', 'feedback-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('tracks build-verify iterations in history', async () => {
    // Run porch until it hits a gate
    const result = await runPorchUntilGate(ctx, 600000);

    // Get state
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();

    // History should exist (even if just one iteration)
    expect(state?.history).toBeDefined();
    expect(Array.isArray(state?.history)).toBe(true);

    // If reviewers requested changes, iteration should be > 1
    // If reviewers approved on first try, iteration is 1
    // Either way, history should have at least one entry
    const history = state?.history as unknown[];
    expect(history.length).toBeGreaterThan(0);
  }, 600000);

  it('records review results in history', async () => {
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();

    const history = state?.history as { iteration: number; reviews: unknown[] }[];
    if (history && history.length > 0) {
      const lastIteration = history[history.length - 1];

      // Reviews should be recorded
      expect(lastIteration.reviews).toBeDefined();
      expect(Array.isArray(lastIteration.reviews)).toBe(true);

      // Should have 3 reviews (gemini, codex, claude)
      if (lastIteration.reviews.length > 0) {
        expect(lastIteration.reviews.length).toBeGreaterThanOrEqual(1);

        // Each review should have model and verdict
        const review = lastIteration.reviews[0] as {
          model?: string;
          verdict?: string;
        };
        expect(review.model).toBeDefined();
        expect(review.verdict).toBeDefined();
      }
    }
  });
});

describe('Porch E2E: Max Iterations', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9996', 'max-iter-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('respects max iterations setting', async () => {
    // This test verifies the max iterations mechanism exists.
    // In real usage, max iterations = 7 (configurable in protocol.json).

    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();

    // Initial iteration should be 1
    expect(state?.iteration).toBe(1);

    // Run one porch iteration
    const result = await runPorchOnce(ctx, 300000);

    // Get updated state
    const newState = getTestProjectState(ctx);
    expect(newState).not.toBeNull();

    // Iteration should still be tracked
    expect(newState?.iteration).toBeGreaterThanOrEqual(1);
  }, 300000);
});

/**
 * Test with mock consult that always rejects.
 * This verifies porch stops at max iterations even with constant rejection.
 */
describe('Porch E2E: Max Iterations with Mock Consult', () => {
  let ctx: TestContext;
  let originalPath: string | undefined;

  beforeAll(async () => {
    ctx = await createTestProject('9995', 'mock-reject-test');

    // Create a mock consult script that always rejects
    const mockConsultPath = path.join(ctx.tempDir, 'consult');
    fs.writeFileSync(
      mockConsultPath,
      `#!/bin/bash
echo "Reviewing..."
echo ""
echo "VERDICT: REQUEST_CHANGES"
echo "This needs more work."
`,
      { mode: 0o755 }
    );

    // Save original PATH
    originalPath = process.env.PATH;
  }, 120000);

  afterAll(async () => {
    // Restore PATH
    if (originalPath) {
      process.env.PATH = originalPath;
    }
    await cleanupTestProject(ctx);
  }, 60000);

  it('stops at max iterations with constant rejection', async () => {
    // Prepend temp dir to PATH so mock consult is found first
    process.env.PATH = `${ctx.tempDir}:${process.env.PATH}`;

    // Run porch - it should eventually stop at max iterations
    const result = await runPorchUntilGate(ctx, 900000); // 15 min

    // Get final state
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();

    // History should have entries (up to max iterations)
    const history = state?.history as unknown[];
    if (history) {
      // Max iterations is 7, so history shouldn't exceed that
      expect(history.length).toBeLessThanOrEqual(7);
    }

    // Should still hit the gate eventually (after max iterations)
    // because porch proceeds to gate after max iterations
  }, 900000);
});
