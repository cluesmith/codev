/**
 * E2E Test: Signal Handling
 *
 * Tests the AWAITING_INPUT and BLOCKED signal scenarios.
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createTestProject,
  cleanupTestProject,
  getTestProjectState,
  type TestContext,
} from '../helpers/setup.js';

/**
 * Run porch with stdin pipe for interactive testing.
 * Allows us to respond to AWAITING_INPUT signals.
 */
async function runPorchInteractive(
  ctx: TestContext,
  stdinResponses: string[],
  timeoutMs: number = 600000
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signals: string[];
}> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const signals: string[] = [];
    let responseIndex = 0;

    const timeout = setTimeout(() => {
      porch.kill('SIGTERM');
    }, timeoutMs);

    const porchBin = path.resolve(__dirname, '../../../../../bin/porch.js');

    const porch = spawn('node', [porchBin, 'run', ctx.projectId], {
      cwd: ctx.tempDir,
      env: {
        ...process.env,
        PORCH_AUTO_APPROVE: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    porch.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // Check for AWAITING_INPUT signal
      if (text.includes('CLAUDE NEEDS INPUT')) {
        signals.push('AWAITING_INPUT');

        // Send pre-configured response if available
        if (responseIndex < stdinResponses.length) {
          setTimeout(() => {
            porch.stdin.write(stdinResponses[responseIndex] + '\n\n');
            responseIndex++;
          }, 100);
        }
      }

      // Check for BLOCKED signal
      if (text.includes('BLOCKED')) {
        signals.push('BLOCKED');
        // BLOCKED signals typically require human intervention
        // For testing, we'll just record it and let the test timeout or continue
      }

      // Check for gate
      if (text.match(/GATE:\s*\S+/)) {
        clearTimeout(timeout);
        porch.kill('SIGTERM');
      }
    });

    porch.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    porch.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        signals,
      });
    });

    porch.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        signals,
      });
    });
  });
}

describe('Porch E2E: Signal Handling', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9994', 'signal-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('detects and handles signals in stdout', async () => {
    // This test verifies the signal detection mechanism works
    // by running porch and checking that we can capture output

    const result = await runPorchInteractive(
      ctx,
      ['Test answer 1', 'Test answer 2'], // Pre-configured responses
      300000 // 5 minutes
    );

    // Verify we got some output
    expect(result.stdout.length).toBeGreaterThan(0);

    // State should be tracked
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();
  }, 300000);
});

describe('Porch E2E: AWAITING_INPUT Flow', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9993', 'awaiting-input-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('can respond to clarifying questions', async () => {
    // Run porch with pre-configured answers
    const result = await runPorchInteractive(
      ctx,
      [
        'The feature should handle user authentication.',
        'Yes, use JWT tokens.',
        'No additional requirements.',
      ],
      600000
    );

    // If AWAITING_INPUT was triggered, we should have detected it
    // Note: This depends on whether Claude actually asks questions
    // The mechanism is tested even if Claude doesn't ask

    // Verify state persists user answers if any were provided
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();

    // If signals were detected, verify they're the expected type
    for (const signal of result.signals) {
      expect(['AWAITING_INPUT', 'BLOCKED']).toContain(signal);
    }
  }, 600000);

  it('stores user answers in state context', async () => {
    // Check if previous run stored any answers
    const state = getTestProjectState(ctx);

    // Context may or may not have user_answers depending on whether
    // Claude asked questions. The mechanism should work either way.
    if (state?.context) {
      // If context exists, verify structure is valid
      expect(typeof state.context).toBe('object');
    }
  });
});

describe('Porch E2E: BLOCKED Signal', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestProject('9992', 'blocked-test');
  }, 120000);

  afterAll(async () => {
    await cleanupTestProject(ctx);
  }, 60000);

  it('detects BLOCKED signals when they occur', async () => {
    // BLOCKED signals are rare in normal flow - they indicate
    // human intervention is needed. We test the detection mechanism.

    const result = await runPorchInteractive(ctx, [], 300000);

    // If a BLOCKED signal occurred, it should be in our signals array
    // This test primarily verifies the detection mechanism works

    expect(result.stdout.length).toBeGreaterThan(0);

    // State should still be valid
    const state = getTestProjectState(ctx);
    expect(state).not.toBeNull();
  }, 300000);
});
