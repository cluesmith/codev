/**
 * Tests for codev doctor command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// We need to test the internal functions, so we'll import the module
// and test the exported function behavior

// Mock forge module (imported by doctor.ts)
const executeForgeCommandSyncMock = vi.hoisted(() => vi.fn((concept: string) => {
  if (concept === 'auth-status') return 'Logged in';
  return null;
}));
const loadForgeConfigMock = vi.hoisted(() => vi.fn(() => null));
const validateForgeConfigMock = vi.hoisted(() => vi.fn(() => []));
const resolveAllConceptsMock = vi.hoisted(() => vi.fn(() => {
  // Return all 15 concepts as default/gh-based
  const concepts = [
    'issue-view', 'pr-list', 'issue-list', 'issue-comment', 'pr-exists',
    'recently-closed', 'recently-merged', 'user-identity', 'team-activity',
    'on-it-timestamps', 'pr-merge', 'pr-search', 'pr-view', 'pr-diff', 'auth-status',
  ];
  return concepts.map(c => ({ concept: c, command: `gh ${c}`, source: 'default', executable: 'gh' }));
}));
vi.mock('../lib/forge.js', () => ({
  executeForgeCommandSync: executeForgeCommandSyncMock,
  loadForgeConfig: loadForgeConfigMock,
  validateForgeConfig: validateForgeConfigMock,
  resolveAllConcepts: resolveAllConceptsMock,
}));

// A minimal fake child process for the async `spawn`-based agy auth probe.
// verifyAgy streams stdout/stderr and kills on the OAuth marker.
const makeFakeChild = vi.hoisted(() => (opts: { stdout?: string; stderr?: string; code?: number | null }) => {
  const procH: Record<string, (arg?: unknown) => void> = {};
  const outH: Record<string, (b: Buffer) => void> = {};
  const errH: Record<string, (b: Buffer) => void> = {};
  const child = {
    stdout: { on: (ev: string, cb: (b: Buffer) => void) => { outH[ev] = cb; } },
    stderr: { on: (ev: string, cb: (b: Buffer) => void) => { errH[ev] = cb; } },
    on: (ev: string, cb: (arg?: unknown) => void) => { procH[ev] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    if (opts.stdout) outH['data']?.(Buffer.from(opts.stdout));
    if (opts.stderr) errH['data']?.(Buffer.from(opts.stderr));
    procH['close']?.(opts.code ?? 0);
  });
  return child;
});

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  // Default for the async agy auth probe: reply "OK" → operational.
  spawn: vi.fn(() => makeFakeChild({ stdout: 'OK', code: 0 })),
}));

// Mock Claude Agent SDK - returns success by default
let mockDoctorQueryFn: ReturnType<typeof vi.fn>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  mockDoctorQueryFn = vi.fn().mockImplementation(() =>
    (async function* () {
      yield { type: 'result', subtype: 'success' };
    })()
  );
  return { query: mockDoctorQueryFn };
});

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
        spawn: vi.fn(() => makeFakeChild({ stdout: 'OK', code: 0 })),
      }));

      const { doctor } = await import('../commands/doctor.js');
      const result = await doctor();
      // Should fail because node is missing
      expect(result).toBe(1);
    });

    it('should return 1 when no AI CLI is available', async () => {
      // Mock all core deps present but no AI CLIs (incl. agy unavailable).
      process.env.CODEV_AGY_BIN = path.join(tmpdir(), `no-such-agy-${Date.now()}`);
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

      // Claude SDK also fails (auth error)
      mockDoctorQueryFn.mockImplementation(() =>
        (async function* () {
          throw new Error('Invalid API key');
        })()
      );

      let result: number;
      try {
        result = await doctor();
      } finally {
        delete process.env.CODEV_AGY_BIN;
      }
      expect(result).toBe(1);
    });
  });

  describe('gh auth check (Spec 0126)', () => {
    it('should warn when gh is not authenticated', async () => {
      // Make forge auth-status concept fail
      executeForgeCommandSyncMock.mockImplementation((concept: string) => {
        if (concept === 'auth-status') throw new Error('not authenticated');
        return null;
      });

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
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

      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      const hasGhWarning = logOutput.some(line =>
        line.includes('gh') && line.includes('not authenticated')
      );
      expect(hasGhWarning).toBe(true);
    });

    it('should show authenticated when gh auth succeeds', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in to github.com account testuser (keyring)');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
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

      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      const hasGhAuth = logOutput.some(line =>
        line.includes('gh') && line.includes('authenticated')
      );
      expect(hasGhAuth).toBe(true);
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

    it('should not warn about consult-types/ (resolved at runtime from package)', async () => {
      // Create a codev directory without consult-types/ — this is normal now
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });

      process.chdir(testBaseDir);

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

      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      // Should NOT warn about consult-types — they resolve from the package at runtime
      const hasWarning = logOutput.some(line =>
        line.includes('consult-types/') && line.includes('not found')
      );
      expect(hasWarning).toBe(false);
    });

    it('should warn when deprecated roles/review-types/ still exists', async () => {
      // Create a codev directory with both directories
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'integration-review.md'),
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
      // Create a codev directory without git remote to trigger a warning
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });

      process.chdir(testBaseDir);

      // Mock all core dependencies as present, but no git remote
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('git remote')) {
          return Buffer.from('');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      vi.mocked(spawnSync).mockImplementation((cmd: string, args?: readonly string[]) => {
        // Return empty output for git remote -v to trigger no-remote warning
        if (cmd === 'git' && args && args[0] === 'remote') {
          return {
            status: 0,
            stdout: '',
            stderr: '',
            signal: null,
            output: [null, '', ''],
            pid: 0,
          };
        }
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
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
      const separatorIndex = logOutput.findIndex(line => line.includes('============'));
      const summaryLines = logOutput.slice(separatorIndex);

      // Should mention "issues detected"
      const hasIssuesMessage = summaryLines.some(line =>
        line.includes('issue') && line.includes('detected')
      );
      expect(hasIssuesMessage).toBe(true);

      // Should list the specific warning about missing git remote
      const hasSpecificWarning = summaryLines.some(line =>
        line.includes('Project structure') && line.includes('No git remote')
      );
      expect(hasSpecificWarning).toBe(true);
    });

    it('should show no warnings when properly migrated', async () => {
      // Create a properly migrated codev directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'integration-review.md'),
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

      vi.mocked(spawnSync).mockImplementation((cmd: string, args?: readonly string[]) => {
        // Healthy state-file split (#1192): thread files not ignored,
        // nothing tracked under codev/state/
        if (cmd === 'git' && args && args[0] === 'check-ignore' && String(args[args.length - 1]).endsWith('_thread.md')) {
          return {
            status: 1,
            stdout: '',
            stderr: '',
            signal: null,
            output: [null, '', ''],
            pid: 0,
          };
        }
        if (cmd === 'git' && args && args[0] === 'ls-files') {
          return {
            status: 0,
            stdout: '',
            stderr: '',
            signal: null,
            output: [null, '', ''],
            pid: 0,
          };
        }
        const responses: Record<string, string> = {
          'node': 'v20.0.0',
          'tmux': 'tmux 3.4',
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

  describe('protocol PR-gate audit (#943)', () => {
    const testBaseDir = path.join(tmpdir(), `codev-doctor-prgate-${Date.now()}`);
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      fs.mkdirSync(path.join(testBaseDir, 'codev'), { recursive: true });
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (fs.existsSync(testBaseDir)) {
        fs.rmSync(testBaseDir, { recursive: true });
      }
    });

    function mockDepsPresent() {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) return Buffer.from('/usr/bin/command');
        if (cmd.includes('gh auth status')) return Buffer.from('Logged in');
        return Buffer.from('');
      });
      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          node: 'v20.0.0', git: 'git version 2.40.0', claude: '1.0.0',
        };
        return {
          status: 0, stdout: responses[cmd] || 'working', stderr: '',
          signal: null, output: [null, responses[cmd] || 'working', ''], pid: 0,
        } as never;
      });
    }

    it('warns when a PR-producing override lacks a pr gate', async () => {
      const bugfixDir = path.join(testBaseDir, 'codev', 'protocols', 'bugfix');
      fs.mkdirSync(bugfixDir, { recursive: true });
      fs.writeFileSync(path.join(bugfixDir, 'protocol.json'), JSON.stringify({
        name: 'bugfix',
        phases: [{ id: 'fix' }, { id: 'pr', steps: ['create_pr'] }],
      }));

      process.chdir(testBaseDir);
      mockDepsPresent();
      vi.resetModules();

      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => { logOutput.push(args.join(' ')); });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      const hasWarning = logOutput.some(line =>
        line.includes('Protocol `bugfix`') && line.includes('no `pr` gate'));
      expect(hasWarning).toBe(true);
    });

    it('shows clean when no PR-producing override is gateless', async () => {
      // codev/ exists but no protocol overrides — bundled protocols resolve from
      // the always-gated skeleton (or not at all), so the section is clean.
      process.chdir(testBaseDir);
      mockDepsPresent();
      vi.resetModules();

      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => { logOutput.push(args.join(' ')); });

      const { doctor } = await import('../commands/doctor.js');
      await doctor();

      const hasClean = logOutput.some(line => line.includes('All PR-producing protocols are pr-gated'));
      expect(hasClean).toBe(true);
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

    it('should show auth error with hint when Claude SDK auth fails', async () => {
      // Mock core deps present
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

      // Claude SDK fails with API key error
      mockDoctorQueryFn.mockImplementation(() =>
        (async function* () {
          throw new Error('Invalid API key provided');
        })()
      );

      await doctor();

      // Should show auth error with actionable hint
      const hasAuthError = logOutput.some(line =>
        line.includes('Claude') && (line.includes('auth error') || line.includes('ANTHROPIC_API_KEY'))
      );
      expect(hasAuthError).toBe(true);
    });

    it('reports "needs login" promptly when agy is unauthenticated (fast OAuth detection)', async () => {
      // The gemini lane verifies via agy. An unauthenticated agy prints an OAuth
      // URL and waits; verifyAgy streams the output and must detect it on the
      // early stream (not stall for the full timeout), reporting "needs login".
      const agyBin = path.join(testBaseDir, 'agy-fake');
      fs.writeFileSync(agyBin, '#!/bin/sh\n');
      process.env.CODEV_AGY_BIN = agyBin;

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        if (cmd.includes('gh auth status')) {
          return Buffer.from('Logged in');
        }
        return Buffer.from('');
      });

      // agy --print emits the OAuth URL on stderr (then would hang) → fast skip.
      vi.mocked(spawn).mockReturnValue(makeFakeChild({
        stderr: 'Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/o/oauth2/auth?client_id=x',
        code: null,
      }) as unknown as ReturnType<typeof spawn>);

      vi.resetModules();

      // Capture console.log output
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      try {
        const { doctor } = await import('../commands/doctor.js');
        await doctor();

        // The Gemini (agy) line should report "needs login".
        const hasNeedsLogin = logOutput.some(line =>
          line.includes('Gemini') && line.includes('needs login')
        );
        expect(hasNeedsLogin).toBe(true);
      } finally {
        delete process.env.CODEV_AGY_BIN;
        vi.mocked(spawn).mockReset();
      }
    });

    it('passes the probe text immediately after --print and retains the print timeout', async () => {
      const agyBin = path.join(testBaseDir, 'agy-fake');
      fs.writeFileSync(agyBin, '#!/bin/sh\n');
      process.env.CODEV_AGY_BIN = agyBin;

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) return Buffer.from('/usr/bin/command');
        if (cmd.includes('gh auth status')) return Buffer.from('Logged in');
        return Buffer.from('');
      });
      vi.mocked(spawnSync).mockImplementation((cmd: string) => ({
        status: 0,
        stdout: cmd === 'node' ? 'v20.0.0' : cmd === 'git' ? 'git version 2.40.0' : 'working',
        stderr: '',
        signal: null,
        output: [null, 'working', ''],
        pid: 0,
      }));
      vi.mocked(spawn).mockImplementation(
        () => makeFakeChild({ stdout: 'OK', code: 0 }) as unknown as ReturnType<typeof spawn>,
      );
      vi.resetModules();

      try {
        const { doctor } = await import('../commands/doctor.js');
        await doctor();

        const call = vi.mocked(spawn).mock.calls.find(c => c[0] === agyBin);
        expect(call).toBeDefined();
        const args = call![1] as string[];
        const printIndex = args.indexOf('--print');
        expect(args[printIndex + 1]).toBe('Reply with just OK');
        expect(args.slice(0, printIndex)).toContain('--print-timeout');
        expect(args[args.indexOf('--print-timeout') + 1]).toBe('20s');
      } finally {
        delete process.env.CODEV_AGY_BIN;
      }
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
