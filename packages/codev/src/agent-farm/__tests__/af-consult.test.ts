/**
 * Tests for af consult command (direct process spawning)
 *
 * Phase 3 (Spec 0099): consult command now spawns the consult CLI
 * directly as a subprocess instead of creating a Tower dashboard tab.
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

  it('should spawn consult process with correct arguments', async () => {
    // Mock a successful spawn
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          // Simulate successful exit
          setTimeout(() => callback(0), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { consult } = await import('../commands/consult.js');

    await consult('spec', '42', { model: 'gemini' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'consult',
      ['--model', 'gemini', 'spec', '42'],
      { stdio: 'inherit' }
    );
  });

  it('should include --type when provided', async () => {
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

    await consult('pr', '87', { model: 'codex', type: 'impl-review' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'consult',
      ['--model', 'codex', '--type', 'impl-review', 'pr', '87'],
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

    await expect(consult('spec', '42', { model: 'gemini' }))
      .rejects.toThrow('consult exited with code 1');
  });

  it('should not require Tower to be running', async () => {
    // The key assertion: no TowerClient import, no Tower check
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

    // Should succeed without any Tower mocking
    await consult('general', 'test', { model: 'claude' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'consult',
      ['--model', 'claude', 'general', 'test'],
      { stdio: 'inherit' }
    );
  });
});
