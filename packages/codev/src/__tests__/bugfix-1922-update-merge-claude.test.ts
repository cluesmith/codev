/**
 * Issue #1922 — `codev update`'s conflict-merge launch ran a bare `spawn('claude')`,
 * unawaited: it bypassed the harness's `CODEV_CLAUDE_BIN` fake (#1912), so on a machine
 * with Claude Code installed the suites started the developer's REAL claude with
 * cwd = the temp project, which then failed every afterEach `rmSync` with EPERM.
 *
 * The launch now resolves through `resolveClaudeBin()` and is awaited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { update } from '../commands/update.js';
import { CLAUDE_BIN_ENV } from '../lib/claude-cli.js';

describe('issue #1922 — codev update merge session never reaches the real claude', () => {
  let originalCwd: string;
  let projectDir: string;
  let claudeLog: string;
  let savedPin: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    savedPin = process.env[CLAUDE_BIN_ENV];
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-1922-'));
    claudeLog = path.join(projectDir, '..', `${path.basename(projectDir)}.claude-log`);
    fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });
    // User content in both root files: update() reports them as root conflicts and
    // launches the merge session.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Codev\n\nKEEP_USER_CONTENT');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Codev\n\nKEEP_USER_CONTENT');
    process.env.CODEV_TEST_CLAUDE_LOG = claudeLog;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    delete process.env.CODEV_TEST_CLAUDE_LOG;
    if (savedPin === undefined) delete process.env[CLAUDE_BIN_ENV];
    else process.env[CLAUDE_BIN_ENV] = savedPin;
    // No retry: a merge session still running in projectDir is exactly the bug.
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(claudeLog, { force: true });
  });

  it('launches the CODEV_CLAUDE_BIN-pinned claude, and has finished by the time update() returns', async () => {
    expect(process.env[CLAUDE_BIN_ENV], 'the vitest harness pins a fake claude').toBeTruthy();

    const result = await update();

    expect(result.rootConflicts.map((c) => c.file).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    // Written by the harness's fake claude, synchronously before it exits.
    const log = fs.readFileSync(claudeLog, 'utf-8');
    expect(log).toContain('fake-claude-interactive Merge the following files from their .codev-new versions');
  });

  it('with no pin under the test runner, refuses rather than resolving claude from PATH', async () => {
    delete process.env[CLAUDE_BIN_ENV];

    await update();

    const errors = vi.mocked(console.error).mock.calls.map((args) => args.join(' '));
    expect(errors.some((e) => e.includes('Failed to launch Claude') && e.includes('Refusing to resolve the claude binary'))).toBe(true);
    expect(fs.existsSync(claudeLog)).toBe(false);
  });

  it('awaits an injected merge session in the project directory', async () => {
    const calls: Array<{ prompt: string; cwd: string }> = [];
    let finished = false;
    await update({}, {
      runMergeSession: async (prompt, cwd) => {
        calls.push({ prompt, cwd });
        await new Promise((r) => setTimeout(r, 50));
        finished = true;
        return { code: 0, signal: null };
      },
    });

    expect(calls).toHaveLength(1);
    expect(fs.realpathSync(calls[0].cwd)).toBe(fs.realpathSync(projectDir));
    expect(calls[0].prompt).toContain('CLAUDE.md');
    expect(finished).toBe(true);
    expect(fs.existsSync(claudeLog)).toBe(false);
  });
});
