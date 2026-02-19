/**
 * Tests for af bench command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, Readable, PassThrough } from 'node:stream';
import {
  computeStats,
  formatTime,
  detectCpu,
  detectRam,
  runEngine,
  runParallel,
  runSequential,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT,
} from '../commands/bench.js';
import type { EngineResult } from '../commands/bench.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Mock fs - createWriteStream must return a real writable stream for pipe() compatibility
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  createWriteStream: vi.fn(() => new PassThrough()),
}));

import { spawn as spawnMock, execSync as execSyncMock } from 'node:child_process';

/** Create a mock child process that emits events. */
function createMockProcess(exitCode: number, delay = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  proc.pid = 12345;

  // Schedule the close event
  if (delay > 0) {
    setTimeout(() => proc.emit('close', exitCode), delay);
  } else {
    // Use setImmediate for immediate resolution
    setImmediate(() => proc.emit('close', exitCode));
  }

  return proc;
}

/** Create a mock process that never closes (for timeout testing). */
function createHangingProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

/** Create a mock process that emits an error. */
function createErrorProcess(errorCode: string) {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  proc.pid = 12345;

  setImmediate(() => {
    const err = new Error('spawn error') as NodeJS.ErrnoException;
    err.code = errorCode;
    proc.emit('error', err);
  });

  return proc;
}

describe('af bench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  describe('computeStats', () => {
    it('should compute avg/min/max/stddev for multiple values', () => {
      const stats = computeStats([10, 20, 30]);
      expect(stats).not.toBeNull();
      expect(stats!.avg).toBe(20);
      expect(stats!.min).toBe(10);
      expect(stats!.max).toBe(30);
      expect(stats!.stddev).toBeCloseTo(10, 5);
    });

    it('should return null for empty array', () => {
      const stats = computeStats([]);
      expect(stats).toBeNull();
    });

    it('should handle single value (stddev = 0)', () => {
      const stats = computeStats([42]);
      expect(stats).not.toBeNull();
      expect(stats!.avg).toBe(42);
      expect(stats!.min).toBe(42);
      expect(stats!.max).toBe(42);
      expect(stats!.stddev).toBe(0);
    });

    it('should use sample stddev (N-1 denominator)', () => {
      // For [2, 4, 4, 4, 5, 5, 7, 9]:
      // mean = 5, sum of squared diffs = 32, sample variance = 32/7 ≈ 4.571, stddev ≈ 2.138
      const stats = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(stats).not.toBeNull();
      expect(stats!.avg).toBe(5);
      expect(stats!.stddev).toBeCloseTo(2.138, 2);
    });

    it('should handle two identical values (stddev = 0)', () => {
      const stats = computeStats([5, 5]);
      expect(stats).not.toBeNull();
      expect(stats!.avg).toBe(5);
      expect(stats!.stddev).toBe(0);
    });
  });

  describe('formatTime', () => {
    it('should format to 1 decimal place', () => {
      expect(formatTime(12.34)).toBe('12.3s');
    });

    it('should round up correctly', () => {
      expect(formatTime(12.36)).toBe('12.4s');
    });

    it('should handle zero', () => {
      expect(formatTime(0)).toBe('0.0s');
    });

    it('should handle large values', () => {
      expect(formatTime(300.123)).toBe('300.1s');
    });

    it('should handle small values', () => {
      expect(formatTime(0.05)).toBe('0.1s');
    });
  });

  describe('DEFAULT_PROMPT', () => {
    it('should match the bench.sh default', () => {
      expect(DEFAULT_PROMPT).toBe(
        'Please analyze the codev codebase and give me a list of potential impactful improvements.',
      );
    });
  });

  describe('DEFAULT_TIMEOUT', () => {
    it('should be 300 seconds', () => {
      expect(DEFAULT_TIMEOUT).toBe(300);
    });
  });

  describe('detectCpu', () => {
    it('should return CPU string on macOS', () => {
      vi.mocked(execSyncMock).mockReturnValueOnce('Apple M2 Max\n');
      expect(detectCpu()).toBe('Apple M2 Max');
    });

    it('should return "unknown" when both methods fail', () => {
      vi.mocked(execSyncMock).mockImplementation(() => {
        throw new Error('not found');
      });
      expect(detectCpu()).toBe('unknown');
    });
  });

  describe('detectRam', () => {
    it('should return RAM in GB on macOS', () => {
      vi.mocked(execSyncMock).mockReturnValueOnce('34359738368\n'); // 32 GB
      expect(detectRam()).toBe('32 GB');
    });

    it('should return "unknown" when both methods fail', () => {
      vi.mocked(execSyncMock).mockImplementation(() => {
        throw new Error('not found');
      });
      expect(detectRam()).toBe('unknown');
    });
  });

  describe('runEngine', () => {
    it('should return ok status on exit code 0', async () => {
      vi.useRealTimers();
      const proc = createMockProcess(0);
      vi.mocked(spawnMock).mockReturnValueOnce(proc as any);

      const result = await runEngine('gemini', 'test prompt', 300, '/tmp/out.txt');

      expect(result.engine).toBe('gemini');
      expect(result.status).toBe('ok');
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
      expect(spawnMock).toHaveBeenCalledWith(
        'consult',
        ['-m', 'gemini', '--prompt', 'test prompt'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    it('should return failed status on non-zero exit code', async () => {
      vi.useRealTimers();
      const proc = createMockProcess(1);
      vi.mocked(spawnMock).mockReturnValueOnce(proc as any);

      const result = await runEngine('codex', 'test prompt', 300, '/tmp/out.txt');

      expect(result.engine).toBe('codex');
      expect(result.status).toBe('failed');
      expect(result.elapsed).toBeNull();
    });

    it('should return failed status on spawn error', async () => {
      vi.useRealTimers();
      const proc = createErrorProcess('ENOENT');
      vi.mocked(spawnMock).mockReturnValueOnce(proc as any);

      const result = await runEngine('claude', 'test prompt', 300, '/tmp/out.txt');

      expect(result.engine).toBe('claude');
      expect(result.status).toBe('failed');
      expect(result.elapsed).toBeNull();
    });

    it('should return timeout status when engine exceeds timeout', async () => {
      vi.useRealTimers();
      const proc = createHangingProcess();
      vi.mocked(spawnMock).mockReturnValueOnce(proc as any);

      // Use a very short timeout
      const resultPromise = runEngine('gemini', 'test', 0.05, '/tmp/out.txt');
      const result = await resultPromise;

      expect(result.engine).toBe('gemini');
      expect(result.status).toBe('timeout');
      expect(result.elapsed).toBeNull();
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }, 10000);
  });

  describe('runParallel', () => {
    it('should spawn all 3 engines and return wall time', async () => {
      vi.useRealTimers();
      // Create 3 mock processes (one per engine)
      for (let i = 0; i < 3; i++) {
        const proc = createMockProcess(0);
        vi.mocked(spawnMock).mockReturnValueOnce(proc as any);
      }

      const result = await runParallel('test', 300, 1, '20260219-120000', '/tmp/results');

      expect(result.iteration).toBe(1);
      expect(result.engines).toHaveLength(3);
      expect(result.engines[0].engine).toBe('gemini');
      expect(result.engines[1].engine).toBe('codex');
      expect(result.engines[2].engine).toBe('claude');
      expect(result.wallTime).toBeGreaterThanOrEqual(0);
      expect(spawnMock).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed success and failure', async () => {
      vi.useRealTimers();
      // gemini succeeds, codex fails, claude succeeds
      vi.mocked(spawnMock).mockReturnValueOnce(createMockProcess(0) as any);
      vi.mocked(spawnMock).mockReturnValueOnce(createMockProcess(1) as any);
      vi.mocked(spawnMock).mockReturnValueOnce(createMockProcess(0) as any);

      const result = await runParallel('test', 300, 1, '20260219-120000', '/tmp/results');

      expect(result.engines[0].status).toBe('ok');
      expect(result.engines[1].status).toBe('failed');
      expect(result.engines[2].status).toBe('ok');
      // Wall time still computed
      expect(result.wallTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runSequential', () => {
    it('should spawn engines one at a time with null wall time', async () => {
      vi.useRealTimers();
      for (let i = 0; i < 3; i++) {
        vi.mocked(spawnMock).mockReturnValueOnce(createMockProcess(0) as any);
      }

      const result = await runSequential('test', 300, 1, '20260219-120000', '/tmp/results');

      expect(result.iteration).toBe(1);
      expect(result.engines).toHaveLength(3);
      expect(result.wallTime).toBeNull();
    });
  });

  describe('stats with failures excluded', () => {
    it('should compute stats only from successful engines', () => {
      const results: EngineResult[] = [
        { engine: 'gemini', elapsed: 10, status: 'ok' },
        { engine: 'codex', elapsed: null, status: 'failed' },
        { engine: 'claude', elapsed: 20, status: 'ok' },
      ];

      const successfulTimes = results
        .filter((e) => e.status === 'ok')
        .map((e) => e.elapsed!);

      const stats = computeStats(successfulTimes);
      expect(stats).not.toBeNull();
      expect(stats!.avg).toBe(15);
      expect(stats!.min).toBe(10);
      expect(stats!.max).toBe(20);
    });

    it('should return null when all engines fail', () => {
      const results: EngineResult[] = [
        { engine: 'gemini', elapsed: null, status: 'failed' },
        { engine: 'codex', elapsed: null, status: 'timeout' },
        { engine: 'claude', elapsed: null, status: 'failed' },
      ];

      const successfulTimes = results
        .filter((e) => e.status === 'ok')
        .map((e) => e.elapsed!);

      const stats = computeStats(successfulTimes);
      expect(stats).toBeNull();
    });
  });
});
