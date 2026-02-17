/**
 * Tests for af consult command (direct process spawning)
 *
 * Phase 3 (Spec 0099): consult command now spawns the consult CLI
 * directly as a subprocess instead of creating a Tower dashboard tab.
 *
 * Updated for Spec 325: flag-based mode routing (no positional args).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

describe('af consult command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should spawn consult process with protocol and type flags', async () => {
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { consult } = await import('../commands/consult.js');

    await consult({ model: 'gemini', protocol: 'spir', type: 'spec' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'consult',
      ['-m', 'gemini', '--protocol', 'spir', '--type', 'spec'],
      { stdio: 'inherit' }
    );
  });

  it('should include --prompt for general mode', async () => {
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { consult } = await import('../commands/consult.js');

    await consult({ model: 'claude', prompt: 'test query' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'consult',
      ['-m', 'claude', '--prompt', 'test query'],
      { stdio: 'inherit' }
    );
  });

  it('should reject on non-zero exit code', async () => {
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(1), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { consult } = await import('../commands/consult.js');

    await expect(consult({ model: 'gemini', type: 'spec' }))
      .rejects.toThrow('consult exited with code 1');
  });

  it('should not require Tower to be running', async () => {
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { consult } = await import('../commands/consult.js');

    await consult({ model: 'claude', prompt: 'test' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'consult',
      ['-m', 'claude', '--prompt', 'test'],
      { stdio: 'inherit' }
    );
  });
});
