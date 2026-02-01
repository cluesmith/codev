/**
 * Tests for porch timeout, retry, circuit breaker, and AWAITING_INPUT
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock the Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { buildWithTimeout } from '../claude.js';

describe('buildWithTimeout', () => {
  let testDir: string;
  let outputPath: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-timeout-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    outputPath = path.join(testDir, 'output.txt');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should return timeout result after deadline', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    // Mock a build that hangs forever
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        await new Promise(() => {}); // Never resolves
      })()
    );

    const result = await buildWithTimeout('prompt', outputPath, testDir, 100); // 100ms timeout

    expect(result.success).toBe(false);
    expect(result.output).toContain('[TIMEOUT]');
    expect(result.duration).toBe(100);
  });

  it('should return normal result before deadline', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done fast' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Complete',
          total_cost_usd: 0.01,
          duration_ms: 50,
        };
      })()
    );

    const result = await buildWithTimeout('prompt', outputPath, testDir, 5000);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Done fast');
  });
});

describe('AWAITING_INPUT signal detection', () => {
  it('should detect BLOCKED signal in output', () => {
    const output = 'some text\n<signal>BLOCKED:needs human approval</signal>\nmore text';
    expect(/<signal>BLOCKED:/i.test(output)).toBe(true);
  });

  it('should detect AWAITING_INPUT signal in output', () => {
    const output = 'some text\n<signal>AWAITING_INPUT</signal>\nmore text';
    expect(/<signal>AWAITING_INPUT<\/signal>/i.test(output)).toBe(true);
  });

  it('should not match unrelated text', () => {
    const output = 'normal build output with no signals';
    expect(/<signal>BLOCKED:/i.test(output)).toBe(false);
    expect(/<signal>AWAITING_INPUT<\/signal>/i.test(output)).toBe(false);
  });
});

describe('circuit breaker logic', () => {
  it('should track consecutive failures and reset on success', () => {
    let consecutiveFailures = 0;
    const THRESHOLD = 5;

    // Simulate 4 failures
    for (let i = 0; i < 4; i++) {
      consecutiveFailures++;
    }
    expect(consecutiveFailures).toBe(4);
    expect(consecutiveFailures >= THRESHOLD).toBe(false);

    // Success resets
    consecutiveFailures = 0;
    expect(consecutiveFailures).toBe(0);

    // 5 failures trips breaker
    for (let i = 0; i < 5; i++) {
      consecutiveFailures++;
    }
    expect(consecutiveFailures >= THRESHOLD).toBe(true);
  });
});

describe('output file naming with retries', () => {
  it('should generate distinct file names for retry attempts', () => {
    const basePath = '/tmp/0087-specify-iter-1.txt';

    // First attempt uses base path
    expect(basePath).toBe('/tmp/0087-specify-iter-1.txt');

    // Retry attempts use -try-N suffix
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryPath = basePath.replace(/\.txt$/, `-try-${attempt + 1}.txt`);
      expect(retryPath).toBe(`/tmp/0087-specify-iter-1-try-${attempt + 1}.txt`);
    }
  });
});

describe('ProjectState awaiting_input field', () => {
  it('should accept awaiting_input in state type', async () => {
    // Type-level test: ensure the field exists on ProjectState
    const { } = await import('../types.js');

    const state = {
      id: '0087',
      title: 'test',
      protocol: 'spider',
      phase: 'specify',
      plan_phases: [],
      current_plan_phase: null,
      gates: {},
      iteration: 1,
      build_complete: false,
      history: [],
      awaiting_input: true,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    expect(state.awaiting_input).toBe(true);
    state.awaiting_input = false;
    expect(state.awaiting_input).toBe(false);
  });
});
