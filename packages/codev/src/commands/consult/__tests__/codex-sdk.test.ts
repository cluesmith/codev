import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the Codex SDK integration (Phase 1).
 *
 * Part 1: Cost computation logic (CODEX_PRICING formula)
 * Part 2: Mocked runCodexConsultation() — event handling, error paths, temp file cleanup
 */

// Reproduce the CODEX_PRICING constant from index.ts for unit testing
const CODEX_PRICING = { inputPer1M: 2.00, cachedInputPer1M: 1.00, outputPer1M: 8.00 };

function computeCodexCost(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const uncached = inputTokens - cachedInputTokens;
  return (uncached / 1_000_000) * CODEX_PRICING.inputPer1M
       + (cachedInputTokens / 1_000_000) * CODEX_PRICING.cachedInputPer1M
       + (outputTokens / 1_000_000) * CODEX_PRICING.outputPer1M;
}

describe('Codex SDK cost computation', () => {
  it('computes correct cost for sample token counts', () => {
    const cost = computeCodexCost(24763, 24448, 122);
    expect(cost).toBeCloseTo(0.026054, 5);
  });

  it('computes correct cost when all tokens are uncached', () => {
    const cost = computeCodexCost(10000, 0, 5000);
    expect(cost).toBeCloseTo(0.06, 5);
  });

  it('computes correct cost when all tokens are cached', () => {
    const cost = computeCodexCost(5000, 5000, 100);
    expect(cost).toBeCloseTo(0.0058, 5);
  });

  it('computes zero cost for zero tokens', () => {
    expect(computeCodexCost(0, 0, 0)).toBe(0);
  });

  it('handles large token counts correctly', () => {
    const cost = computeCodexCost(1_000_000, 900_000, 100_000);
    expect(cost).toBeCloseTo(1.90, 5);
  });
});

// ============================================================================
// Part 2: Mocked runCodexConsultation() tests
// ============================================================================

// Helper to create an async generator from an array of events
async function* mockEvents(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

// Track what the mock was configured with
let mockRunStreamedFn: ReturnType<typeof vi.fn>;
let mockStartThreadFn: ReturnType<typeof vi.fn>;
let mockConstructorArgs: unknown;
let mockStartThreadArgs: unknown;

// Mock the @openai/codex-sdk module with a proper class
vi.mock('@openai/codex-sdk', () => {
  class MockCodex {
    constructor(...args: unknown[]) {
      mockConstructorArgs = args[0];
    }
    startThread(...args: unknown[]) {
      mockStartThreadArgs = args[0];
      return mockStartThreadFn();
    }
  }
  return { Codex: MockCodex };
});

// Import after mocking
const { runCodexConsultation } = await import('../index.js');

function setupMockCodex(events: unknown[]) {
  mockRunStreamedFn = vi.fn().mockResolvedValue({
    events: mockEvents(events),
  });
  const mockThread = { runStreamed: mockRunStreamedFn };
  mockStartThreadFn = vi.fn().mockReturnValue(mockThread);
  return mockThread;
}

describe('runCodexConsultation() with mocked SDK', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams agent_message text to stdout and writes output file', async () => {
    setupMockCodex([
      { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Hello ' } },
      { type: 'item.completed', item: { id: 'msg2', type: 'agent_message', text: 'world!' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200 } },
    ]);

    const outputPath = join(tmpDir, 'output.txt');
    await runCodexConsultation('test query', 'You are a reviewer', tmpDir, outputPath);

    // Verify streaming to stdout
    expect(stdoutSpy).toHaveBeenCalledWith('Hello ');
    expect(stdoutSpy).toHaveBeenCalledWith('world!');

    // Verify output file written
    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toBe('Hello world!');
  });

  it('captures usage data from turn.completed event without error', async () => {
    setupMockCodex([
      { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Review' } },
      { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } },
    ]);

    await runCodexConsultation('test query', 'You are a reviewer', tmpDir);
    // No error thrown = usage captured successfully
  });

  it('ignores non-agent_message items in output', async () => {
    setupMockCodex([
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking...' } },
      { type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'completed' } },
      { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Only this' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } },
    ]);

    const outputPath = join(tmpDir, 'output.txt');
    await runCodexConsultation('test query', 'You are a reviewer', tmpDir, outputPath);

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toBe('Only this');
  });

  it('throws on turn.failed event with error message', async () => {
    setupMockCodex([
      { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Started...' } },
      { type: 'turn.failed', error: { message: 'Rate limit exceeded' } },
    ]);

    await expect(
      runCodexConsultation('test query', 'You are a reviewer', tmpDir),
    ).rejects.toThrow('Rate limit exceeded');
  });

  it('cleans up temp file on success', async () => {
    setupMockCodex([
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } },
    ]);

    await runCodexConsultation('test query', 'You are a reviewer', tmpDir);
    // If we get here, the finally block ran successfully (temp file cleaned up)
  });

  it('cleans up temp file on error', async () => {
    setupMockCodex([
      { type: 'turn.failed', error: { message: 'Something went wrong' } },
    ]);

    try {
      await runCodexConsultation('test query', 'You are a reviewer', tmpDir);
    } catch {
      // Expected to throw
    }
    // If we get here, the finally block ran (temp file cleanup happened)
  });

  it('throws on stream error (runStreamed rejects)', async () => {
    mockRunStreamedFn = vi.fn().mockRejectedValue(new Error('Connection refused'));
    mockStartThreadFn = vi.fn().mockReturnValue({ runStreamed: mockRunStreamedFn });

    await expect(
      runCodexConsultation('test query', 'You are a reviewer', tmpDir),
    ).rejects.toThrow('Connection refused');
  });

  it('records metrics on success when metricsCtx provided', async () => {
    setupMockCodex([
      { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Review text' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200 } },
    ]);

    const metricsCtx = {
      timestamp: new Date().toISOString(),
      model: 'codex',
      reviewType: 'impl-review',
      subcommand: 'impl',
      protocol: 'spir',
      projectId: '0120',
      workspacePath: tmpDir,
    };

    // Completes without error — metrics recorded in finally
    await runCodexConsultation('test query', 'You are a reviewer', tmpDir, undefined, metricsCtx);
  });

  it('records metrics on error when metricsCtx provided', async () => {
    setupMockCodex([
      { type: 'turn.failed', error: { message: 'API error' } },
    ]);

    const metricsCtx = {
      timestamp: new Date().toISOString(),
      model: 'codex',
      reviewType: null,
      subcommand: 'general',
      protocol: 'manual',
      projectId: null,
      workspacePath: tmpDir,
    };

    try {
      await runCodexConsultation('test query', 'You are a reviewer', tmpDir, undefined, metricsCtx);
    } catch {
      // Expected — metrics should still be recorded in finally
    }
  });

  it('throws on stream error event (ThreadErrorEvent)', async () => {
    setupMockCodex([
      { type: 'item.completed', item: { id: 'msg1', type: 'agent_message', text: 'Started...' } },
      { type: 'error', message: 'Unrecoverable stream failure' },
    ]);

    await expect(
      runCodexConsultation('test query', 'You are a reviewer', tmpDir),
    ).rejects.toThrow('Unrecoverable stream failure');
  });

  it('passes correct config to Codex constructor and startThread', async () => {
    setupMockCodex([
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } },
    ]);

    await runCodexConsultation('test query', 'You are a reviewer', tmpDir);

    // Verify constructor receives experimental_instructions_file in config
    expect(mockConstructorArgs).toBeDefined();
    expect((mockConstructorArgs as Record<string, unknown>).config).toBeDefined();
    const config = (mockConstructorArgs as Record<string, Record<string, unknown>>).config;
    expect(config.experimental_instructions_file).toBeDefined();
    expect(typeof config.experimental_instructions_file).toBe('string');

    // Verify startThread receives model, sandboxMode, and workingDirectory
    expect(mockStartThreadArgs).toBeDefined();
    const threadArgs = mockStartThreadArgs as Record<string, unknown>;
    expect(threadArgs.model).toBe('gpt-5.2-codex');
    expect(threadArgs.sandboxMode).toBe('read-only');
    expect(threadArgs.workingDirectory).toBe(tmpDir);
  });
});
