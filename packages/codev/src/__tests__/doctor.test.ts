/**
 * Tests for codev doctor command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { forceHostPlatform } from './helpers/host-platform.js';

// These tests call vi.resetModules() and re-import doctor, which loads a fresh
// platform module with no override; pin every instance to POSIX so a win32 host
// does not take the Windows sections (covered by doctor-windows-*.test.ts).
vi.mock('../lib/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform.js')>();
  actual.setHostPlatformForTests('linux');
  return actual;
});
import { CLAUDE_INSTALL_HINT, CLAUDE_MIN_VERSION } from '../lib/claude-cli.js';
import {
  createStubClaude,
  STUB_LOGGED_OUT_STATUS,
  type StubClaude,
  type StubClaudeOptions,
} from './helpers/stub-claude.js';

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
  // All 20 concepts (KNOWN_CONCEPTS in lib/forge.ts) as default/gh-based, so the
  // doctor report's rendering is exercised for every row it actually prints.
  const concepts = [
    'issue-view', 'pr-list', 'issue-list', 'issue-search', 'issue-comment', 'pr-exists',
    'recently-closed', 'recently-merged', 'user-identity', 'team-activity',
    'on-it-timestamps', 'pr-create', 'pr-merge', 'pr-search', 'pr-view', 'pr-diff',
    'auth-status', 'repo-archive', 'commit-checks', 'workflow-runs',
  ];
  return concepts.map(c => ({ concept: c, command: `gh ${c}`, source: 'default', executable: 'gh' }));
}));
vi.mock('../lib/forge.js', () => ({
  executeForgeCommandSync: executeForgeCommandSyncMock,
  loadForgeConfig: loadForgeConfigMock,
  validateForgeConfig: validateForgeConfigMock,
  resolveAllConcepts: resolveAllConceptsMock,
  isHybridProvider: (provider?: string) => provider === 'linear' || provider === 'jira',
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

// Mock child_process. `execFileSync` stays real: it is the only call the claude
// checks make (`lib/claude-cli.ts`), and they run a stub `claude` executable —
// the harness's fake by default, or a `createStubClaude()` stub — never the real CLI.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    execSync: vi.fn(),
    spawnSync: vi.fn(),
    // Default for the async agy auth probe: reply "OK" → operational.
    spawn: vi.fn(() => makeFakeChild({ stdout: 'OK', code: 0 })),
    execFileSync: actual.execFileSync,
  };
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
      // #1338: the codex-architect "supported" branch calls chalk.gray (doctor.ts).
      // Without this, chalk.gray throws into the shell-section catch {}, aborting
      // before the builder branch runs — which made the supported-config test below
      // pass vacuously (it never reached the path it guards).
      gray: createChainableColor(),
    },
  };
});

/**
 * Restore an env var to its captured value, honouring "was unset" (#1323).
 *
 * A bare `delete process.env.CODEV_AGY_BIN` drops the vitest harness's fake-agy
 * pin for the rest of the file, leaving every later `doctor()` call to reach
 * `verifyAgy()` with nothing pinned. Nothing real spawned here — this file mocks
 * `node:child_process` wholesale — but that made the file safe *by accident*
 * rather than by construction: the module mock, not the pin, was doing the work.
 * Restoring keeps the pin intact so the lane guard stays satisfied on its own
 * terms.
 */
function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}

describe('doctor command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // These are the POSIX doctor's checks (which/--version probes through the mocked
    // child_process); force the seam so a win32 host does not take the Windows sections
    // (process census, job helper, Windows prerequisites), which have their own tests.
    forceHostPlatform('linux');
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

    it('prints no Windows prerequisites section on POSIX (Spec 1658: POSIX output unchanged)', async () => {
      vi.mocked(execSync).mockImplementation(() => Buffer.from('/usr/bin/command'));
      vi.mocked(spawnSync).mockImplementation(() => ({
        status: 0, stdout: 'git version 2.40.0', stderr: '', signal: null, output: [null, 'git version 2.40.0', ''], pid: 0,
      }));
      const { doctor } = await import('../commands/doctor.js');
      await doctor();
      const printed = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('Core Dependencies');
      expect(printed).not.toContain('Windows Prerequisites');
      expect(printed).not.toContain('Git Bash');
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
      vi.mock('node:child_process', async (importOriginal) => ({
        execFileSync: (await importOriginal<typeof import('node:child_process')>()).execFileSync,
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
      // Mock all core deps present but no AI CLIs (incl. agy and claude unavailable).
      const priorAgyBin = process.env.CODEV_AGY_BIN;
      const priorClaudeBin = process.env.CODEV_CLAUDE_BIN;
      process.env.CODEV_AGY_BIN = path.join(tmpdir(), `no-such-agy-${Date.now()}`);
      process.env.CODEV_CLAUDE_BIN = path.join(tmpdir(), `no-such-claude-${Date.now()}`);
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

      let result: number;
      try {
        result = await doctor();
      } finally {
        restoreEnv('CODEV_AGY_BIN', priorAgyBin);
        restoreEnv('CODEV_CLAUDE_BIN', priorClaudeBin);
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

  describe('hybrid provider auth (#1740)', () => {
    // A hybrid workspace: issue concepts on the tracker's CLI, PR concepts on gh.
    function hybridResolutions(trackerExec: string) {
      const issueConcepts = new Set(['issue-view', 'issue-list', 'issue-search', 'issue-comment', 'recently-closed', 'user-identity', 'auth-status']);
      return () => [
        'issue-view', 'pr-list', 'issue-list', 'issue-search', 'issue-comment', 'pr-exists',
        'recently-closed', 'recently-merged', 'user-identity', 'pr-create', 'pr-merge', 'pr-search',
        'pr-view', 'pr-diff', 'auth-status', 'repo-archive',
      ].map(c => issueConcepts.has(c)
        ? { concept: c, command: `/scripts/forge/tracker/${c}.sh`, source: 'preset', executable: trackerExec }
        : { concept: c, command: `/scripts/forge/github/${c}.sh`, source: 'default', executable: 'gh' });
    }

    type ForgeOpts = { forgeConfig?: { provider?: string } | null } | undefined;
    const isGhCall = (opts: ForgeOpts) => opts?.forgeConfig?.provider === 'github' || opts?.forgeConfig == null;

    async function runDoctor(missing: string[] = []): Promise<string[]> {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) {
          if (missing.some(m => cmd.includes(m))) throw new Error('not found');
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });
      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = { node: 'v20.0.0', git: 'git version 2.40.0' };
        return {
          status: 0, stdout: responses[cmd] || 'working', stderr: '', signal: null,
          output: [null, responses[cmd] || 'working', ''], pid: 0,
        };
      });
      vi.resetModules();
      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => { logOutput.push(args.join(' ')); });
      const { doctor } = await import('../commands/doctor.js');
      await doctor();
      return logOutput;
    }

    afterEach(() => {
      loadForgeConfigMock.mockImplementation(() => null);
      resolveAllConceptsMock.mockReset();
      executeForgeCommandSyncMock.mockImplementation((concept: string) => (concept === 'auth-status' ? 'Logged in' : null));
    });

    it('jira: reports the acli login and the gh login separately', async () => {
      loadForgeConfigMock.mockImplementation(() => ({ provider: 'jira' }) as never);
      resolveAllConceptsMock.mockImplementation(hybridResolutions('acli') as never);
      const seen: Array<string | undefined> = [];
      executeForgeCommandSyncMock.mockImplementation(((concept: string, _env: unknown, opts: ForgeOpts) => {
        if (concept !== 'auth-status') return null;
        seen.push(opts?.forgeConfig?.provider);
        return isGhCall(opts) ? 'Logged in to github.com account octo (keyring)' : 'Site: x\n  Email: dev@example.com';
      }) as never);

      const out = await runDoctor();
      expect(out.some(l => l.includes('jira auth') && l.includes('authenticated as dev@example.com'))).toBe(true);
      expect(out.some(l => l.includes('gh auth') && l.includes('authenticated as octo'))).toBe(true);
      // The tracker check runs against the workspace config; the gh check is forced onto the github default.
      expect(seen).toEqual(['jira', 'github']);
    });

    it('jira: an unauthenticated acli warns with the acli login hint', async () => {
      loadForgeConfigMock.mockImplementation(() => ({ provider: 'jira' }) as never);
      resolveAllConceptsMock.mockImplementation(hybridResolutions('acli') as never);
      executeForgeCommandSyncMock.mockImplementation(((concept: string, _env: unknown, opts: ForgeOpts) => {
        if (concept !== 'auth-status') return null;
        return isGhCall(opts) ? 'Logged in' : null;
      }) as never);

      const out = await runDoctor();
      expect(out.some(l => l.includes('jira auth') && l.includes('not authenticated'))).toBe(true);
      expect(out.some(l => l.includes('acli jira auth login'))).toBe(true);
    });

    it('jira: a missing acli gets the executable warning, not a misleading auth line', async () => {
      loadForgeConfigMock.mockImplementation(() => ({ provider: 'jira' }) as never);
      resolveAllConceptsMock.mockImplementation(hybridResolutions('acli') as never);
      const out = await runDoctor(['acli']);
      expect(out.some(l => l.includes('acli not found'))).toBe(true);
      expect(out.some(l => l.includes('jira auth'))).toBe(false);
    });

    it('linear: reports the linear login and the gh login', async () => {
      loadForgeConfigMock.mockImplementation(() => ({ provider: 'linear' }) as never);
      resolveAllConceptsMock.mockImplementation(hybridResolutions('curl') as never);
      executeForgeCommandSyncMock.mockImplementation(((concept: string, _env: unknown, opts: ForgeOpts) => {
        if (concept !== 'auth-status') return null;
        return isGhCall(opts) ? 'Logged in' : null;
      }) as never);

      const out = await runDoctor();
      expect(out.some(l => l.includes('linear auth') && l.includes('not authenticated'))).toBe(true);
      expect(out.some(l => l.includes('LINEAR_API_KEY'))).toBe(true);
      expect(out.some(l => l.includes('gh auth') && l.includes('authenticated'))).toBe(true);
    });

    it('gitlab and gitea: no auth lines at all, exactly as before', async () => {
      for (const provider of ['gitlab', 'gitea']) {
        loadForgeConfigMock.mockImplementation(() => ({ provider }) as never);
        resolveAllConceptsMock.mockImplementation(hybridResolutions(provider === 'gitlab' ? 'glab' : 'tea') as never);
        executeForgeCommandSyncMock.mockClear();
        const out = await runDoctor();
        expect(out.some(l => / auth\s/.test(l) && /authenticated/.test(l)), provider).toBe(false);
        expect(executeForgeCommandSyncMock.mock.calls.some(c => c[0] === 'auth-status'), provider).toBe(false);
      }
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

  // Issue #1338 — codev doctor flags a retired harness (gemini) on BOTH the
  // architect and builder shells, and no longer claims gemini is "supported for
  // builders". The structured issue/recommendation (rendered in the warning
  // summary) is the assertion target — stabler than the inline console text.
  describe('shell-harness retirement flagging (#1338)', () => {
    const testBaseDir = path.join(tmpdir(), `codev-doctor-1338-${Date.now()}`);
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      // `codev/` marks the workspace root for doctor's findWorkspaceRoot;
      // `.codev/config.json` is what loadConfig reads for the shell config.
      fs.mkdirSync(path.join(testBaseDir, 'codev'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, '.codev'), { recursive: true });
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (fs.existsSync(testBaseDir)) {
        fs.rmSync(testBaseDir, { recursive: true });
      }
    });

    // Every dependency present so doctor() runs through to the shell-config
    // section without bailing early on a missing tool.
    async function runDoctorWith(config: object): Promise<string[]> {
      fs.writeFileSync(path.join(testBaseDir, '.codev', 'config.json'), JSON.stringify(config));
      process.chdir(testBaseDir);
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('gh auth status')) return Buffer.from('Logged in');
        return Buffer.from('/usr/bin/command');
      });
      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          node: 'v20.0.0', tmux: 'tmux 3.4', git: 'git version 2.40.0',
          claude: '1.0.0', codex: '0.60.0',
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
      return logOutput;
    }

    it('flags a gemini BUILDER config as retired via the structured issue/recommendation', async () => {
      const out = await runDoctorWith({ shell: { builder: 'gemini --yolo' } });
      expect(out.some((l) => l.includes('gemini configured as builder shell (harness retired)'))).toBe(true);
      // Recommendation names BOTH selectors — an explicit shell.builderHarness beats
      // the shell.builder command, so switching only one wouldn't clear it (#1338).
      expect(out.some((l) => l.includes('Set shell.builder / shell.builderHarness to a supported harness'))).toBe(true);
      // The custom-harness escape hatch names the EXPLICIT selector (#1338): a bare
      // shell.builder "gemini" stays retired, so the rec points at shell.builderHarness.
      // ("via" is unique to the recommendation; the retirement message uses "with".)
      expect(out.some((l) => l.includes('select it explicitly via shell.builderHarness'))).toBe(true);
      // Locks the RENDERED custom-harness clause for the configured retired harness.
      // (This assertion can't by itself prove the `${role.name}` interpolation — with a
      // single RETIRED_HARNESSES entry it reads identically to a hard-coded literal; the
      // interpolation is verified by inspection and shares the pattern of the
      // already-asserted console/issue lines above. #1338.)
      expect(out.some((l) => l.includes('define a custom "gemini" harness'))).toBe(true);
      // The single-source-of-truth retirement explanation is surfaced (2026-06-18 cause).
      expect(out.some((l) => l.includes('2026-06-18'))).toBe(true);
    });

    it('flags a gemini ARCHITECT config as retired and never claims builder support', async () => {
      const out = await runDoctorWith({ shell: { architect: 'gemini --yolo' } });
      expect(out.some((l) => l.includes('gemini configured as architect shell (harness retired)'))).toBe(true);
      expect(out.some((l) => l.includes('Set shell.architect / shell.architectHarness to "codex"'))).toBe(true);
      // The custom-harness escape hatch names the EXPLICIT architect selector (#1338).
      expect(out.some((l) => l.includes('select it explicitly via shell.architectHarness'))).toBe(true);
      // Locks the RENDERED custom-harness clause for the configured retired harness
      // (not a proof of the `${role.name}` interpolation — see the builder test's note). #1338.
      expect(out.some((l) => l.includes('define a custom "gemini" harness'))).toBe(true);
      // The inverted pre-retirement message must be gone.
      expect(out.some((l) => l.includes('supported for builders'))).toBe(false);
      expect(out.some((l) => l.includes('builder-only'))).toBe(false);
    });

    it('detects gemini via explicit builderHarness, not only the command form', async () => {
      const out = await runDoctorWith({ shell: { builder: 'some-wrapper', builderHarness: 'gemini' } });
      expect(out.some((l) => l.includes('gemini configured as builder shell (harness retired)'))).toBe(true);
    });

    it('does NOT flag a supported-harness config (claude builder + codex architect)', async () => {
      const out = await runDoctorWith({ shell: { builder: 'claude', architect: 'codex' } });
      // Non-vacuity guard (#1338). The codex-architect branch prints the "supported"
      // line, THEN two chalk.gray lines, THEN control falls through to the builder
      // branch. Without the chalk.gray mock, gray throws into the section's catch {}
      // right after "supported" — skipping the builder branch entirely and making the
      // "not flagged" checks below vacuous. The "supported" line alone can't detect
      // that (it prints before the throw), so assert a line printed AFTER the gray
      // calls: its presence proves the section ran to completion and the builder
      // branch was actually reached.
      expect(out.some((l) => l.includes('codex is configured as architect shell') && l.includes('supported'))).toBe(true);
      expect(out.some((l) => l.includes('Select the architect harness via .codev/config.json'))).toBe(true);
      expect(out.some((l) => l.includes('harness retired'))).toBe(false);
      expect(out.some((l) => l.includes('supported for builders'))).toBe(false);
    });

    // The sanctioned escape hatch (#1338): an EXPLICIT shell.builderHarness "gemini"
    // backed by a matching custom `harness.gemini` definition resolves and spawns
    // fine (resolveHarness precedence: built-in → custom → retired), so doctor must
    // NOT flag it — otherwise following the retirement advice ("configure a custom
    // harness") would leave the warning stuck on. Mirrors the resolver's escape-hatch
    // case in harness.test.ts.
    it('does NOT flag an explicit custom gemini BUILDER harness (escape hatch)', async () => {
      const out = await runDoctorWith({
        shell: { builderHarness: 'gemini' },
        harness: { gemini: { roleArgs: [], roleScriptFragment: '' } },
      });
      expect(out.some((l) => l.includes('builder shell (harness retired)'))).toBe(false);
      expect(out.some((l) => l.includes('2026-06-18'))).toBe(false);
    });

    it('does NOT flag an explicit custom gemini ARCHITECT harness (escape hatch)', async () => {
      const out = await runDoctorWith({
        shell: { architectHarness: 'gemini' },
        harness: { gemini: { roleArgs: [], roleScriptFragment: '' } },
      });
      expect(out.some((l) => l.includes('architect shell (harness retired)'))).toBe(false);
      expect(out.some((l) => l.includes('2026-06-18'))).toBe(false);
    });

    // The distinction that keeps the escape hatch safe: auto-detection resolves the
    // BUILT-IN namespace only, so a bare `gemini …` command is retired even when a
    // same-named custom harness exists (matches resolveHarness in harness.ts). Doctor
    // must keep flagging it — otherwise it would green-light a config that fails
    // closed at spawn.
    it('STILL flags an auto-detected gemini command even when a custom gemini harness exists', async () => {
      const out = await runDoctorWith({
        shell: { builder: 'gemini --yolo' },
        harness: { gemini: { roleArgs: [], roleScriptFragment: '' } },
      });
      expect(out.some((l) => l.includes('gemini configured as builder shell (harness retired)'))).toBe(true);
    });

    it('flags an array-form gemini builder command (parity with the resolver)', async () => {
      const out = await runDoctorWith({ shell: { builder: ['gemini', '--yolo'] } });
      expect(out.some((l) => l.includes('gemini configured as builder shell (harness retired)'))).toBe(true);
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
    let savedAgyCacheDir: string | undefined;

    beforeEach(() => {
      originalCwd = process.cwd();
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      // verifyAgy shares the consult lane's auth cache (#1077): pin it to a
      // per-test directory so these cases neither read a verdict left by a
      // sibling case (which would suppress the probe they assert on) nor write
      // into the developer's real ~/.cache/codev.
      savedAgyCacheDir = process.env.CODEV_AGY_AUTH_CACHE_DIR;
      process.env.CODEV_AGY_AUTH_CACHE_DIR = path.join(testBaseDir, 'agy-auth-cache');
      process.chdir(testBaseDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (savedAgyCacheDir === undefined) delete process.env.CODEV_AGY_AUTH_CACHE_DIR;
      else process.env.CODEV_AGY_AUTH_CACHE_DIR = savedAgyCacheDir;
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

    it('reports "needs login" promptly when agy is unauthenticated (fast OAuth detection)', async () => {
      // The gemini lane verifies via agy. An unauthenticated agy prints an OAuth
      // URL and waits; verifyAgy streams the output and must detect it on the
      // early stream (not stall for the full timeout), reporting "needs login".
      const agyBin = path.join(testBaseDir, 'agy-fake');
      fs.writeFileSync(agyBin, '#!/bin/sh\n');
      const priorAgyBin = process.env.CODEV_AGY_BIN;
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
        restoreEnv('CODEV_AGY_BIN', priorAgyBin);
        vi.mocked(spawn).mockReset();
      }
    });

    it('passes the probe text immediately after --print and retains the print timeout', async () => {
      const agyBin = path.join(testBaseDir, 'agy-fake');
      fs.writeFileSync(agyBin, '#!/bin/sh\n');
      const priorAgyBin = process.env.CODEV_AGY_BIN;
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
        restoreEnv('CODEV_AGY_BIN', priorAgyBin);
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

  // Spec 1658 platform skip: this file pins the platform seam to linux (doctor's POSIX checks run
  // through mocked child_process), so on a Windows host these real-stub runs cannot take the
  // Windows launch path. Doctor's claude check composes resolveClaudeBin, readClaudeVersion and
  // readClaudeAuthStatus, which run unpinned on Windows in claude-cli.test.ts.
  describe.skipIf(process.platform === 'win32')('Claude checks on the installed CLI (#1912)', () => {
    // Doctor checks the claude lane's CLI the way the lane does: resolve the binary, check its
    // version against the floor, then run `claude auth status` with the child env the lane would
    // build. Every case runs a stub `claude`; none reaches a model.
    const SAVED_ENV = [
      'CODEV_CLAUDE_BIN', 'CODEV_ALLOW_REAL_CLAUDE', 'PATH', 'HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    ] as const;
    const CLAUDE = 'Claude'.padEnd(12);
    let savedEnv: Record<string, string | undefined>;
    let originalCwd: string;
    let tmpDir: string;
    let workspace: string;
    const stubs: StubClaude[] = [];

    function pinStub(options?: StubClaudeOptions): StubClaude {
      const stub = createStubClaude(options);
      stubs.push(stub);
      process.env.CODEV_CLAUDE_BIN = stub.bin;
      return stub;
    }

    async function runDoctor(): Promise<{ code: number; lines: string[]; claudeRows: string[] }> {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        lines.push(args.join(' '));
      });
      vi.resetModules();
      const { doctor } = await import('../commands/doctor.js');
      const code = await doctor();
      // The "AI CLI Dependencies" row, then the "AI Model Verification" row when the CLI is usable.
      const claudeRows = lines.filter((line) => line.startsWith('  ') && line.slice(4).startsWith(CLAUDE));
      return { code, lines, claudeRows: claudeRows.filter((line) => !line.includes('verifying...')) };
    }

    beforeEach(() => {
      savedEnv = Object.fromEntries(SAVED_ENV.map((key) => [key, process.env[key]]));
      originalCwd = process.cwd();
      tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'codev-doctor-claude-'));
      workspace = path.join(tmpDir, 'workspace');
      fs.mkdirSync(path.join(workspace, 'codev'), { recursive: true });
      // So no global ~/.codev/config.json can set consult.claudeAuth under the test.
      process.env.HOME = path.join(tmpDir, 'home');
      fs.mkdirSync(process.env.HOME);
      delete process.env.CODEV_ALLOW_REAL_CLAUDE;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      process.chdir(workspace);

      // Core deps, gh and codex present and working; claude is the variable.
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) return Buffer.from('/usr/bin/command');
        if (cmd.includes('gh auth status')) return Buffer.from('Logged in');
        return Buffer.from('');
      });
      vi.mocked(spawnSync).mockImplementation((cmd: string) => {
        const responses: Record<string, string> = {
          node: 'v20.0.0', tmux: 'tmux 3.4', git: 'git version 2.40.0', codex: '0.60.0',
        };
        const stdout = responses[cmd] || 'working';
        return { status: 0, stdout, stderr: '', signal: null, output: [null, stdout, ''], pid: 0 };
      });
    });

    afterEach(() => {
      process.chdir(originalCwd);
      for (const key of SAVED_ENV) restoreEnv(key, savedEnv[key]);
      for (const stub of stubs.splice(0)) stub.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('a logged-in claude at 2.1.326: ok rows with the version and the auth method (scenario 27)', async () => {
      pinStub();
      const { claudeRows } = await runDoctor();
      expect(claudeRows).toEqual([`  ✓ ${CLAUDE} 2.1.326`, `  ✓ ${CLAUDE} logged in (claude.ai)`]);
    });

    it('claude not on PATH: a warning with the install hint, and codex alone still satisfies doctor (scenario 28)', async () => {
      delete process.env.CODEV_CLAUDE_BIN;
      // Under a test runner the PATH walk needs the real-claude opt-in (#1323). PATH is an empty
      // dir, so there is no real claude to reach.
      process.env.CODEV_ALLOW_REAL_CLAUDE = '1';
      process.env.PATH = path.join(tmpDir, 'empty-path');
      fs.mkdirSync(process.env.PATH);

      const { lines, claudeRows } = await runDoctor();
      expect(claudeRows).toHaveLength(1);
      expect(claudeRows[0]).toContain(`⚠ ${CLAUDE} not found`);
      expect(claudeRows[0]).toContain(CLAUDE_INSTALL_HINT);
      expect(lines.some((line) => line.includes('⚠ Claude: not found'))).toBe(true);
      // Claude no longer counts as installed when it is absent; codex is the working model here.
      expect(lines.some((line) => line.includes('Codex') && line.includes('operational'))).toBe(true);
      expect(lines.some((line) => line.includes('No AI model operational'))).toBe(false);
    });

    it('claude below the floor: a warning naming the floor and `claude update`, and no login check (scenario 29)', async () => {
      const stub = pinStub({ version: { stdout: '2.1.100 (Claude Code)\n' } });
      const { claudeRows } = await runDoctor();
      expect(claudeRows).toHaveLength(1);
      expect(claudeRows[0]).toContain(`⚠ ${CLAUDE} 2.1.100`);
      expect(claudeRows[0]).toContain(CLAUDE_MIN_VERSION);
      expect(claudeRows[0]).toContain('claude update');
      expect(stub.invocations('authStatus')).toHaveLength(0);
    });

    it('claude logged out: a warning with `claude auth login` (scenario 30)', async () => {
      pinStub({ authStatus: { stdout: `${JSON.stringify(STUB_LOGGED_OUT_STATUS)}\n`, exitCode: 1 } });
      const { lines, claudeRows } = await runDoctor();
      expect(claudeRows[0]).toBe(`  ✓ ${CLAUDE} 2.1.326`);
      expect(claudeRows[1]).toContain(`⚠ ${CLAUDE} not logged in`);
      expect(claudeRows[1]).toContain('claude auth login');
      expect(lines.some((line) => line.includes('⚠ Claude: not logged in'))).toBe(true);
    });

    it('makes no model call: the stub sees only --version and auth status (scenario 31)', async () => {
      // This replaces the #1649 audit of the SDK probe, which opened a model session with
      // unrestricted tools in whatever directory doctor ran. Doctor no longer opens a session.
      const stub = pinStub();
      await runDoctor();
      expect(stub.invocations().map((inv) => inv.argv)).toEqual([['--version'], ['auth', 'status', '--json']]);
      expect(stub.invocations('print')).toHaveLength(0);
    });

    it('reports an ANTHROPIC_API_KEY from .env as withheld, without passing it on or touching process.env', async () => {
      fs.writeFileSync(path.join(workspace, '.env'), 'ANTHROPIC_API_KEY=sk-ant-doctor-dotenv-value\n');
      const stub = pinStub();
      const { lines, claudeRows } = await runDoctor();
      expect(claudeRows[1]).toBe(
        `  ✓ ${CLAUDE} logged in (claude.ai) (ignoring ANTHROPIC_API_KEY (from .env) — ` +
        'set consult.claudeAuth to "api-key" to bill the API instead)'
      );
      expect(stub.invocations('authStatus')[0].env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(lines.join('\n')).not.toContain('sk-ant-doctor-dotenv-value');
    });

    it('reports a shell ANTHROPIC_API_KEY as withheld from the shell, and leaves process.env alone', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-doctor-shell-value';
      const stub = pinStub();
      const { claudeRows } = await runDoctor();
      expect(claudeRows[1]).toContain('ignoring ANTHROPIC_API_KEY (from shell)');
      expect(stub.invocations('authStatus')[0].env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-doctor-shell-value');
    });

    it('in api-key mode, runs auth status with the key and reports the API login', async () => {
      fs.mkdirSync(path.join(workspace, '.codev'));
      fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify({ consult: { claudeAuth: 'api-key' } }));
      fs.writeFileSync(path.join(workspace, '.env'), 'ANTHROPIC_API_KEY=sk-ant-doctor-api-key-mode\n');
      const stub = pinStub({
        authStatus: {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }),
        },
      });
      const { claudeRows } = await runDoctor();
      expect(claudeRows[1]).toBe(`  ✓ ${CLAUDE} logged in (api_key)`);
      expect(stub.invocations('authStatus')[0].env.ANTHROPIC_API_KEY).toBe('sk-ant-doctor-api-key-mode');
    });

    it('in api-key mode, a logged-out status warns about the key, not `claude auth login` (#1941)', async () => {
      fs.mkdirSync(path.join(workspace, '.codev'));
      fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify({ consult: { claudeAuth: 'api-key' } }));
      fs.writeFileSync(path.join(workspace, '.env'), 'ANTHROPIC_API_KEY=sk-ant-doctor-api-key-mode\n');
      pinStub({ authStatus: { stdout: `${JSON.stringify(STUB_LOGGED_OUT_STATUS)}\n`, exitCode: 1 } });
      const { claudeRows } = await runDoctor();
      expect(claudeRows[1]).toContain(`⚠ ${CLAUDE} not logged in`);
      expect(claudeRows[1]).toContain('consult.claudeAuth is "api-key"');
      expect(claudeRows[1]).not.toContain('claude auth login');
    });

    it('honours a CODEV_CLAUDE_BIN set only in the workspace .env, as consult does, without touching process.env', async () => {
      const stub = createStubClaude();
      stubs.push(stub);
      delete process.env.CODEV_CLAUDE_BIN;
      fs.writeFileSync(path.join(workspace, '.env'), `CODEV_CLAUDE_BIN=${stub.bin}\n`);
      const { claudeRows } = await runDoctor();
      expect(claudeRows).toEqual([`  ✓ ${CLAUDE} 2.1.326`, `  ✓ ${CLAUDE} logged in (claude.ai)`]);
      expect(stub.invocations().map((inv) => inv.argv)).toEqual([['--version'], ['auth', 'status', '--json']]);
      expect(process.env.CODEV_CLAUDE_BIN).toBeUndefined();
    });

    it('a shell CODEV_CLAUDE_BIN outranks the one in .env', async () => {
      const inDotenv = createStubClaude();
      stubs.push(inDotenv);
      fs.writeFileSync(path.join(workspace, '.env'), `CODEV_CLAUDE_BIN=${inDotenv.bin}\n`);
      const inShell = pinStub();
      await runDoctor();
      expect(inShell.invocations()).toHaveLength(2);
      expect(inDotenv.invocations()).toHaveLength(0);
    });

    it('unparseable auth status: a warning quoting the output', async () => {
      pinStub({ authStatus: { stdout: 'definitely not json\n' } });
      const { claudeRows } = await runDoctor();
      expect(claudeRows[1]).toContain(`⚠ ${CLAUDE} auth unknown`);
      expect(claudeRows[1]).toContain('"definitely not json"');
    });
  });
});
