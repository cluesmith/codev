/**
 * Tests for af architect command
 *
 * Bugfix #393: af architect starts a Claude session with the architect role
 * in the current terminal. No Tower dependency.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock config
vi.mock('../utils/index.js', () => ({
  getConfig: () => ({
    workspaceRoot: '/test/workspace',
    codevDir: '/test/workspace/codev',
    bundledRolesDir: '/test/workspace/codev/roles',
  }),
  getResolvedCommands: () => ({
    architect: 'claude',
    builder: 'claude',
    shell: 'bash',
  }),
}));

// Mock role loading
vi.mock('../utils/roles.js', () => ({
  loadRolePrompt: vi.fn(() => ({
    content: '# Architect Role\n\nYou are an architect.',
    source: 'local',
  })),
}));

describe('af architect command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should spawn claude with architect role in current terminal', async () => {
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { architect } = await import('../commands/architect.js');

    await architect();

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--append-system-prompt', '# Architect Role\n\nYou are an architect.'],
      { stdio: 'inherit', cwd: '/test/workspace', shell: true }
    );
  });

  it('should pass through additional args', async () => {
    const mockProcess = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 0);
        }
        return mockProcess;
      }),
    };
    mockSpawn.mockReturnValue(mockProcess);

    const { architect } = await import('../commands/architect.js');

    await architect({ args: ['--resume'] });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--resume', '--append-system-prompt', '# Architect Role\n\nYou are an architect.'],
      { stdio: 'inherit', cwd: '/test/workspace', shell: true }
    );
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

    const { architect } = await import('../commands/architect.js');

    // Should not throw - no Tower check
    await architect();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
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

    const { architect } = await import('../commands/architect.js');

    await expect(architect()).rejects.toThrow('claude exited with code 1');
  });
});
