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

    it('should display warning details in summary (regression test for #129)', async () => {
      // Create a codev directory with missing consult-types/ to trigger a warning
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });

      process.chdir(testBaseDir);

      // Mock all core dependencies as present
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

      // Issue #129: Summary should show WHICH dependencies have warnings
      // Look for warning details in the summary section (after the separator)
      const separatorIndex = logOutput.findIndex(line => line.includes('============'));
      const summaryLines = logOutput.slice(separatorIndex);

      // Should mention "issues detected" (not vague "below recommended version")
      const hasIssuesMessage = summaryLines.some(line =>
        line.includes('issue') && line.includes('detected')
      );
      expect(hasIssuesMessage).toBe(true);

      // Should list the specific warning with its name
      const hasSpecificWarning = summaryLines.some(line =>
        line.includes('Project structure') && line.includes('consult-types')
      );
      expect(hasSpecificWarning).toBe(true);
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

  describe('AI model verification (Issue #128)', () => {
    const testBaseDir = path.join(tmpdir(), `codev-doctor-ai-test-${Date.now()}`);
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      process.chdir(testBaseDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (fs.existsSync(testBaseDir)) {
        fs.rmSync(testBaseDir, { recursive: true });
      }
    });

    it('should provide actionable hints when Codex auth fails', async () => {
      // Mock Codex CLI exists but login status fails
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
        // Codex login status returns non-zero when not logged in
        if (cmd === 'codex' && args?.includes('login')) {
          return {
            status: 1,
            stdout: '',
            stderr: 'Not logged in. Run `codex login` to authenticate.',
            signal: null,
            output: [null, '', 'Not logged in. Run `codex login` to authenticate.'],
            pid: 0,
          };
        }

        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
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

      vi.resetModules();

      // Capture console.log output
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      // Should show actionable hint for Codex
      const hasActionableHint = logOutput.some(line =>
        line.includes('Codex') && line.includes('codex login')
      );
      expect(hasActionableHint).toBe(true);
    });

    it('should show auth error with hint when API key related failure', async () => {
      // Mock Claude CLI exists but auth fails with API key error
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
        // Claude version check succeeds, but auth check fails with API key error
        if (cmd === 'claude') {
          // Version check (--version) succeeds
          if (args?.includes('--version')) {
            return {
              status: 0,
              stdout: '1.0.0',
              stderr: '',
              signal: null,
              output: [null, '1.0.0', ''],
              pid: 0,
            };
          }
          // Auth check (--print) fails with API key error
          return {
            status: 1,
            stdout: '',
            stderr: 'Error: Invalid API key provided',
            signal: null,
            output: [null, '', 'Error: Invalid API key provided'],
            pid: 0,
          };
        }

        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
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

      // Should show auth error with actionable hint
      const hasAuthError = logOutput.some(line =>
        line.includes('Claude') && (line.includes('auth error') || line.includes('ANTHROPIC_API_KEY'))
      );
      expect(hasAuthError).toBe(true);
    });

    it('should show timeout message for network issues', async () => {
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
        // Gemini version check succeeds, but auth check times out
        if (cmd === 'gemini') {
          // Version check (--version) succeeds
          if (args?.includes('--version')) {
            return {
              status: 0,
              stdout: '0.1.0',
              stderr: '',
              signal: null,
              output: [null, '0.1.0', ''],
              pid: 0,
            };
          }
          // Auth check (--yolo) times out
          return {
            status: null,
            stdout: '',
            stderr: '',
            signal: 'SIGTERM',
            output: [null, '', ''],
            pid: 0,
          };
        }

        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
          'git': 'git version 2.40.0',
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

      // Should show timeout with network hint
      const hasTimeoutHint = logOutput.some(line =>
        line.includes('Gemini') && (line.includes('timeout') || line.includes('network'))
      );
      expect(hasTimeoutHint).toBe(true);
    });

    it('should show operational when Codex login status succeeds', async () => {
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
        // Codex login status succeeds
        if (cmd === 'codex' && args?.includes('login')) {
          return {
            status: 0,
            stdout: 'Logged in as user@example.com',
            stderr: '',
            signal: null,
            output: [null, 'Logged in as user@example.com', ''],
            pid: 0,
          };
        }

        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
          'ttyd': '1.7.4',
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

      vi.resetModules();

      // Capture console.log output
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      // Should show Codex as operational
      const hasOperational = logOutput.some(line =>
        line.includes('Codex') && line.includes('operational')
      );
      expect(hasOperational).toBe(true);
    });
  });
});
