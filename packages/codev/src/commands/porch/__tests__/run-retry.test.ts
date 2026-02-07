/**
 * Tests for run() retry loop, circuit breaker, and AWAITING_INPUT detection.
 *
 * Strategy: Mock all run.ts dependencies. Use a shared state object that
 * writeState updates and readState returns, so mutations in run() are visible
 * across loop iterations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectState, Protocol } from '../types.js';

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('../state.js', () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
  findStatusPath: vi.fn(),
}));

vi.mock('../protocol.js', () => ({
  loadProtocol: vi.fn(),
  getPhaseConfig: vi.fn(),
  isPhased: vi.fn(() => false),
  getPhaseGate: vi.fn(() => null),
  isBuildVerify: vi.fn(() => true),
  getVerifyConfig: vi.fn(() => null),
  getMaxIterations: vi.fn(() => 7),
  getOnCompleteConfig: vi.fn(() => null),
  getBuildConfig: vi.fn(() => ({ prompt: 'test.md', artifact: 'test.md' })),
}));

vi.mock('../plan.js', () => ({ getCurrentPlanPhase: vi.fn(() => null) }));
vi.mock('../prompts.js', () => ({ buildPhasePrompt: vi.fn(() => 'test prompt') }));
vi.mock('../claude.js', () => ({ buildWithTimeout: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { run, EXIT_AWAITING_INPUT } from '../run.js';
import { readState, writeState, findStatusPath } from '../state.js';
import {
  loadProtocol, getPhaseConfig, isBuildVerify, isPhased,
  getPhaseGate, getMaxIterations, getVerifyConfig, getOnCompleteConfig, getBuildConfig,
} from '../protocol.js';
import { buildWithTimeout } from '../claude.js';

// ============================================================================
// Helpers
// ============================================================================

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0099', title: 'test-project', protocol: 'spir', phase: 'implement',
    plan_phases: [], current_plan_phase: null, gates: {},
    iteration: 1, build_complete: false, history: [],
    started_at: '2026-01-01', updated_at: '2026-01-01',
    ...overrides,
  };
}

const fakeProtocol: Protocol = {
  name: 'spir',
  phases: [{ id: 'implement', name: 'Implement', type: 'build_verify' }],
};
const implementPhase = { id: 'implement', name: 'Implement', type: 'build_verify' };

const realSetTimeout = globalThis.setTimeout;

/**
 * Set up shared state where writeState persists and readState returns latest.
 * This models the real behavior where run() mutates state, writes it, and
 * re-reads it on the next loop iteration.
 */
function setupStateMock(initial: ProjectState) {
  let currentState = { ...initial };
  (readState as ReturnType<typeof vi.fn>).mockImplementation(() => ({ ...currentState }));
  (writeState as ReturnType<typeof vi.fn>).mockImplementation((_p: string, s: ProjectState) => {
    currentState = { ...s };
  });
  return { getState: () => ({ ...currentState }) };
}

function resetAndSetup(testDir: string) {
  vi.resetAllMocks();

  (findStatusPath as ReturnType<typeof vi.fn>).mockReturnValue(path.join(testDir, 'status.yaml'));
  (loadProtocol as ReturnType<typeof vi.fn>).mockReturnValue(fakeProtocol);
  (getPhaseConfig as ReturnType<typeof vi.fn>).mockReturnValue(implementPhase);
  (isBuildVerify as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (isPhased as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (getPhaseGate as ReturnType<typeof vi.fn>).mockReturnValue(null);
  (getMaxIterations as ReturnType<typeof vi.fn>).mockReturnValue(7);
  (getVerifyConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);
  (getOnCompleteConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);
  (getBuildConfig as ReturnType<typeof vi.fn>).mockReturnValue({ prompt: 'test.md', artifact: 'test.md' });

  // Instant sleep
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
    return realSetTimeout(fn as (...args: unknown[]) => void, 0, ...args);
  });
}

// ============================================================================
// Retry logic
// ============================================================================

describe('run() - retry logic', () => {
  let testDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-retry-${Date.now()}`);
    fs.mkdirSync(path.join(testDir, 'codev', 'projects', '0099-test-project'), { recursive: true });
    resetAndSetup(testDir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should retry on failure and succeed on second attempt', async () => {
    setupStateMock(makeState());

    let buildCalls = 0;
    (buildWithTimeout as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      buildCalls++;
      if (buildCalls === 1) return { success: false, output: '[TIMEOUT]', duration: 100 };
      return { success: true, output: 'OK', cost: 0.01, duration: 5000 };
    });

    (getVerifyConfig as ReturnType<typeof vi.fn>).mockReturnValue({ type: 'impl-review', models: [] });

    await run(testDir, '0099', { singleIteration: true });

    expect(buildCalls).toBe(2); // 1 initial + 1 retry
  });

  it('should exhaust all retries (initial + 3) on persistent failure', async () => {
    setupStateMock(makeState());

    let buildCalls = 0;
    (buildWithTimeout as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      buildCalls++;
      return { success: false, output: 'fail', duration: 100 };
    });

    // End loop after first round of failures
    let phaseCount = 0;
    (getPhaseConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      phaseCount++;
      if (phaseCount > 1) return null;
      return implementPhase;
    });

    await run(testDir, '0099');

    expect(buildCalls).toBe(4); // 1 initial + 3 retries
  });

  it('should create distinct output files for each retry attempt', async () => {
    setupStateMock(makeState());
    const writtenPaths: string[] = [];

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockImplementation(
      async (_prompt: string, outputPath: string) => {
        writtenPaths.push(outputPath);
        return { success: false, output: 'fail', duration: 100 };
      }
    );

    let phaseCount = 0;
    (getPhaseConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      phaseCount++;
      if (phaseCount > 1) return null;
      return implementPhase;
    });

    await run(testDir, '0099');

    expect(writtenPaths.length).toBe(4);
    expect(writtenPaths[0]).not.toContain('-try-');
    expect(writtenPaths[1]).toContain('-try-2');
    expect(writtenPaths[2]).toContain('-try-3');
    expect(writtenPaths[3]).toContain('-try-4');
  });
});

// ============================================================================
// Circuit breaker
// ============================================================================

describe('run() - circuit breaker', () => {
  let testDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-cb-${Date.now()}`);
    fs.mkdirSync(path.join(testDir, 'codev', 'projects', '0099-test-project'), { recursive: true });
    resetAndSetup(testDir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should halt with exit code 2 after 5 consecutive failures', async () => {
    setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, output: 'fail', duration: 100,
    });

    await expect(run(testDir, '0099')).rejects.toThrow('process.exit(2)');

    expect(exitSpy).toHaveBeenCalledWith(2);
    // 5 rounds × 4 attempts each = 20
    expect(buildWithTimeout).toHaveBeenCalledTimes(20);
  });

  it('should reset counter after a successful build', async () => {
    setupStateMock(makeState());

    let buildCalls = 0;
    (buildWithTimeout as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      buildCalls++;
      if (buildCalls <= 3) return { success: false, output: 'fail', duration: 100 };
      return { success: true, output: 'OK', cost: 0.01, duration: 1000 };
    });

    (getVerifyConfig as ReturnType<typeof vi.fn>).mockReturnValue({ type: 'impl-review', models: [] });

    await run(testDir, '0099', { singleIteration: true });

    expect(exitSpy).not.toHaveBeenCalledWith(2);
    expect(buildCalls).toBe(4); // 3 failures + 1 success (within retry window)
  });
});

// ============================================================================
// AWAITING_INPUT
// ============================================================================

describe('run() - AWAITING_INPUT', () => {
  let testDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-await-${Date.now()}`);
    fs.mkdirSync(path.join(testDir, 'codev', 'projects', '0099-test-project'), { recursive: true });
    resetAndSetup(testDir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect AWAITING_INPUT signal and exit with code 3', async () => {
    const { getState } = setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: 'text\n<signal>AWAITING_INPUT</signal>\nmore',
      duration: 1000,
    });

    await expect(run(testDir, '0099')).rejects.toThrow('process.exit(3)');
    expect(exitSpy).toHaveBeenCalledWith(EXIT_AWAITING_INPUT);
    expect(getState().awaiting_input).toBe(true);
  });

  it('should detect BLOCKED signal and exit with code 3', async () => {
    setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: '<signal>BLOCKED:need info</signal>',
      duration: 1000,
    });

    await expect(run(testDir, '0099')).rejects.toThrow('process.exit(3)');
    expect(exitSpy).toHaveBeenCalledWith(EXIT_AWAITING_INPUT);
  });

  it('should resume from AWAITING_INPUT by clearing flag and continuing', async () => {
    const { getState } = setupStateMock(makeState({ awaiting_input: true }));

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, output: 'Resumed OK', duration: 1000,
    });

    (getVerifyConfig as ReturnType<typeof vi.fn>).mockReturnValue({ type: 'impl-review', models: [] });

    await run(testDir, '0099', { singleIteration: true });

    // Flag should have been cleared during resume
    expect(getState().awaiting_input).toBe(false);
    expect(exitSpy).not.toHaveBeenCalledWith(3);
  });

  it('should halt on resume if AWAITING_INPUT output file is unchanged', async () => {
    // Create the output file that was present when AWAITING_INPUT was set
    const outputFile = path.join(testDir, 'codev', 'projects', '0099-test-project', 'awaiting-output.txt');
    fs.writeFileSync(outputFile, 'Worker needs input\n<signal>AWAITING_INPUT</signal>');

    // Compute the hash the same way run.ts does
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(outputFile)).digest('hex');

    setupStateMock(makeState({
      awaiting_input: true,
      awaiting_input_output: outputFile,
      awaiting_input_hash: hash,
    }));

    // Should exit(3) because the output file hasn't changed
    await expect(run(testDir, '0099')).rejects.toThrow('process.exit(3)');
    expect(exitSpy).toHaveBeenCalledWith(EXIT_AWAITING_INPUT);
  });

  it('should resume normally if AWAITING_INPUT output file has changed', async () => {
    // Create the output file
    const outputFile = path.join(testDir, 'codev', 'projects', '0099-test-project', 'awaiting-output.txt');
    fs.writeFileSync(outputFile, 'Original content');

    // Hash of the ORIGINAL content
    const crypto = await import('node:crypto');
    const oldHash = crypto.createHash('sha256').update(Buffer.from('Original content')).digest('hex');

    // Now modify the file (human resolved the blocker)
    fs.writeFileSync(outputFile, 'Modified by human - blocker resolved');

    const { getState } = setupStateMock(makeState({
      awaiting_input: true,
      awaiting_input_output: outputFile,
      awaiting_input_hash: oldHash,
    }));

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, output: 'Resumed OK', duration: 1000,
    });

    (getVerifyConfig as ReturnType<typeof vi.fn>).mockReturnValue({ type: 'impl-review', models: [] });

    await run(testDir, '0099', { singleIteration: true });

    // Flag should have been cleared and build should proceed
    expect(getState().awaiting_input).toBe(false);
    expect(getState().awaiting_input_output).toBeUndefined();
    expect(getState().awaiting_input_hash).toBeUndefined();
  });

  it('should store output hash when AWAITING_INPUT is detected', async () => {
    const { getState } = setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockImplementation(async (_prompt: string, outputPath: string) => {
      // Simulate that the build created an output file
      fs.writeFileSync(outputPath, 'text\n<signal>AWAITING_INPUT</signal>\nmore');
      return {
        success: true,
        output: 'text\n<signal>AWAITING_INPUT</signal>\nmore',
        duration: 1000,
      };
    });

    await expect(run(testDir, '0099')).rejects.toThrow('process.exit(3)');
    expect(getState().awaiting_input).toBe(true);
    expect(getState().awaiting_input_output).toBeDefined();
    expect(getState().awaiting_input_hash).toBeDefined();
    expect(typeof getState().awaiting_input_hash).toBe('string');
    expect(getState().awaiting_input_hash!.length).toBe(64); // SHA-256 hex
  });
});

// ============================================================================
// build_complete invariant
// ============================================================================

describe('run() - build_complete invariant', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-inv-${Date.now()}`);
    fs.mkdirSync(path.join(testDir, 'codev', 'projects', '0099-test-project'), { recursive: true });
    resetAndSetup(testDir);
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return in singleIteration mode after retry exhaustion', async () => {
    setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, output: 'fail', duration: 100,
    });

    // Should return (not loop forever) with singleIteration
    await run(testDir, '0099', { singleIteration: true });

    // 1 initial + 3 retries = 4 calls, then exit
    expect(buildWithTimeout).toHaveBeenCalledTimes(4);
  });

  it('should return in singlePhase mode after retry exhaustion', async () => {
    setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, output: 'fail', duration: 100,
    });

    // Should return (not loop forever) with singlePhase
    await run(testDir, '0099', { singlePhase: true });

    // 1 initial + 3 retries = 4 calls, then exit
    expect(buildWithTimeout).toHaveBeenCalledTimes(4);
  });

  it('should NOT set build_complete=true when all retries fail', async () => {
    const { getState } = setupStateMock(makeState());

    (buildWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, output: 'fail', duration: 100,
    });

    let phaseCount = 0;
    (getPhaseConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      phaseCount++;
      if (phaseCount > 1) return null;
      return implementPhase;
    });

    await run(testDir, '0099');

    expect(getState().build_complete).toBe(false);
  });
});
