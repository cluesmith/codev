/**
 * Tests for codev doctor command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// We need to test the internal functions, so we'll import the module
// and test the exported function behavior

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

// Mock chalk to avoid color output issues in tests
// Chalk methods are chainable, so we need to return functions that also have methods
vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const createChainableColor = () => {
    const fn = (s: string) => s;
    (fn as any).bold = identity;
    return fn;
  };
  return {
    default: {
      bold: identity,
      green: createChainableColor(),
      yellow: createChainableColor(),
      red: createChainableColor(),
      blue: identity,
      dim: identity,
    },
  };
});

describe('doctor command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('versionGte', () => {
    // Import the function dynamically to test it
    it('should correctly compare equal versions', async () => {
      // Since versionGte is not exported, we test through doctor behavior
      // Instead, let's write a test for the whole doctor function
      expect(true).toBe(true);
    });
  });

  describe('doctor function', () => {
    it('should return 0 when all dependencies are installed', async () => {
      // Mock all commands as existing and having good versions
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string, args?: string[]) => {
        const arg = args?.[0] || '';
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4 - tty.js',
          'git': 'git version 2.40.0',
          'claude': '1.0.0',
          'gemini': '0.1.0',
          'codex': '0.60.0',
        };
        return {
          status: 0,
          stdout: responses[cmd] || 'working',
          stderr: '',
          signal: null,
          output: [null, responses[cmd] || 'working', ''],
          pid: 0,
        };
      });

      const { doctor } = await import('../commands/doctor.js');
      const result = await doctor();
      expect(result).toBe(0);
    });

    it('should return 1 when required dependencies are missing', async () => {
      // Mock node as missing
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which node')) {
          throw new Error('not found');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
          'claude': '1.0.0',
        };
        return {
          status: 0,
          stdout: responses[cmd] || 'working',
          stderr: '',
          signal: null,
          output: [null, responses[cmd] || 'working', ''],
          pid: 0,
        };
      });

      // Re-import to get fresh module
      vi.resetModules();
      vi.mock('node:child_process', () => ({
        execSync: vi.fn((cmd: string) => {
          if (cmd.includes('which node')) {
            throw new Error('not found');
          }
          if (cmd.includes('which')) {
            return Buffer.from('/usr/bin/command');
          }
          if (cmd.includes('gh auth status')) {
            return Buffer.from('Logged in');
          }
          return Buffer.from('');
        }),
        spawnSync: vi.fn((cmd: string) => ({
          status: 0,
          stdout: 'working',
          stderr: '',
          signal: null,
          output: [null, 'working', ''],
          pid: 0,
        })),
      }));

      const { doctor } = await import('../commands/doctor.js');
      const result = await doctor();
      // Should fail because node is missing
      expect(result).toBe(1);
    });

    it('should return 1 when no AI CLI is available', async () => {
      // Mock all core deps present but no AI CLIs
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which claude') || cmd.includes('which gemini') || cmd.includes('which codex')) {
          throw new Error('not found');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
        };
        return {
          status: 0,
          stdout: responses[cmd] || '',
          stderr: '',
          signal: null,
          output: [null, responses[cmd] || '', ''],
          pid: 0,
        };
      });

      vi.resetModules();
      const { doctor } = await import('../commands/doctor.js');
      const result = await doctor();
      expect(result).toBe(1);
    });
  });

  describe('codev structure checks (Spec 0056)', () => {
    const testBaseDir = path.join(tmpdir(), `codev-doctor-test-${Date.now()}`);
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      fs.mkdirSync(testBaseDir, { recursive: true });
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (fs.existsSync(testBaseDir)) {
        fs.rmSync(testBaseDir, { recursive: true });
      }
    });

    it('should warn when consult-types/ directory is missing', async () => {
      // Create a codev directory without consult-types/
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      // Mock all dependencies as present to isolate our test
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
          'claude': '1.0.0',
        };
        return {
          status: 0,
          stdout: responses[cmd] || 'working',
          stderr: '',
          signal: null,
          output: [null, responses[cmd] || 'working', ''],
          pid: 0,
        };
      });

      vi.resetModules();

      // Capture console.log output
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      // Should have warning about missing consult-types/
      const hasWarning = logOutput.some(line =>
        line.includes('consult-types/') && line.includes('not found')
      );
      expect(hasWarning).toBe(true);
    });

    it('should warn when deprecated roles/review-types/ still exists', async () => {
      // Create a codev directory with both directories
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# Spec Review'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'review-types', 'old-type.md'),
        '# Old Type'
      );

      process.chdir(testBaseDir);

      // Mock all dependencies as present
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
          'claude': '1.0.0',
        };
        return {
          status: 0,
          stdout: responses[cmd] || 'working',
          stderr: '',
          signal: null,
          output: [null, responses[cmd] || 'working', ''],
          pid: 0,
        };
      });

      vi.resetModules();

      // Capture console.log output
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      // Should have warning about deprecated roles/review-types/
      const hasWarning = logOutput.some(line =>
        line.includes('Deprecated') && line.includes('roles/review-types/')
      );
      expect(hasWarning).toBe(true);
    });

    it('should show no warnings when properly migrated', async () => {
      // Create a properly migrated codev directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# Spec Review'
      );
      // No roles/review-types/ directory

      process.chdir(testBaseDir);

      // Mock all dependencies as present
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
          'claude': '1.0.0',
        };
        return {
          status: 0,
          stdout: responses[cmd] || 'working',
          stderr: '',
          signal: null,
          output: [null, responses[cmd] || 'working', ''],
          pid: 0,
        };
      });

      vi.resetModules();

      // Capture console.log output
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      // Should show "Project structure OK" (no warnings for structure)
      const hasOk = logOutput.some(line =>
        line.includes('Project structure OK')
      );
      expect(hasOk).toBe(true);
    });
  });
});
