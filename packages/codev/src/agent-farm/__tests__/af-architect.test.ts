/**
 * Tests for afx architect command
 *
 * Bugfix #393: afx architect starts an agent session with the architect role
 * in the current terminal. No Tower dependency.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CLAUDE_HARNESS } from '../utils/harness.js';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs — buildArchitectArgs (tower-utils) uses a default `import fs from 'node:fs'`,
// architect.ts historically used the named export, so provide both.
vi.mock('node:fs', () => {
  const fns = { writeFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn() };
  return { ...fns, default: fns };
});

// Mock config — include getArchitectHarness
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
  getArchitectHarness: () => CLAUDE_HARNESS,
}));

// architect() now delegates role injection to buildArchitectArgs (tower-utils),
// which resolves the harness via config.js directly (not the index.js barrel
// mocked above). Mock that seam too so the unit test stays filesystem-free.
vi.mock('../utils/config.js', () => ({
  getArchitectHarness: () => CLAUDE_HARNESS,
}));

// Mock role loading
vi.mock('../utils/roles.js', () => ({
  loadRolePrompt: vi.fn(() => ({
    content: '# Architect Role\n\nYou are an architect.',
    source: 'local',
  })),
}));

describe('afx architect command', () => {
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

    // shell: false — command is split, args passed as array
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--append-system-prompt', '# Architect Role\n\nYou are an architect.'],
      expect.objectContaining({
        stdio: 'inherit',
        cwd: '/test/workspace',
        env: expect.any(Object),
      })
    );
    // Verify shell: false (no shell key means Node default = false)
    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts.shell).toBeUndefined();
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
      expect.objectContaining({
        stdio: 'inherit',
        cwd: '/test/workspace',
      })
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
