/**
 * Issue #1911, on Windows: a `git.exe` planted in the folder Codev runs `git`
 * from must never run.
 *
 * Plants a copy of `hostname.exe` named `git.exe` in a worktree-shaped temp
 * folder and runs `git` there the three ways Codev does (`execFileSync`,
 * `spawnSync`, an `execSync` string through `cmd.exe`). The control case runs
 * with the protection off and must hit the planted file, so the test proves the
 * hazard is real on the runner before proving the fix. (Some shells, Claude
 * Code's among them, already export the variable; the control removes it.)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardenExeSearch, NO_CWD_EXE_SEARCH_ENV } from '../lib/exe-search-hardening.js';

const isWindows = process.platform === 'win32';

describe.skipIf(!isWindows)('a planted git.exe in the cwd never runs (Windows)', () => {
  let worktree: string;
  let saved: string | undefined;
  const hostname = os.hostname().toLowerCase();

  /** What `git` printed when run with no arguments in the planted folder. */
  function bareGitOutput(env: NodeJS.ProcessEnv = process.env): string {
    const result = spawnSync('git', [], { cwd: worktree, env, encoding: 'utf8', windowsHide: true });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().toLowerCase();
  }

  beforeAll(() => {
    saved = process.env[NO_CWD_EXE_SEARCH_ENV];
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1911-'));
    fs.mkdirSync(path.join(worktree, '.git'));
    const hostnameExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe');
    fs.copyFileSync(hostnameExe, path.join(worktree, 'git.exe'));
  });

  afterEach(() => {
    delete process.env[NO_CWD_EXE_SEARCH_ENV];
    if (saved !== undefined) {
      process.env[NO_CWD_EXE_SEARCH_ENV] = saved;
    }
  });

  afterAll(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('control: with the protection off, Windows runs the planted file', () => {
    delete process.env[NO_CWD_EXE_SEARCH_ENV];
    expect(bareGitOutput()).toBe(hostname);
  });

  it('hardened: execFileSync, spawnSync and an execSync string all run the PATH git', () => {
    delete process.env[NO_CWD_EXE_SEARCH_ENV];
    hardenExeSearch(process.platform, process.env);
    const options = { cwd: worktree, encoding: 'utf8' as const, windowsHide: true };
    expect(execFileSync('git', ['--version'], options)).toMatch(/^git version /);
    expect(spawnSync('git', ['--version'], options).stdout).toMatch(/^git version /);
    expect(execSync('git --version', options)).toMatch(/^git version /);
    expect(bareGitOutput()).not.toBe(hostname);
  });

  it('hardened, Git missing from PATH: the spawn fails and the planted file still never runs', () => {
    delete process.env[NO_CWD_EXE_SEARCH_ENV];
    hardenExeSearch(process.platform, process.env);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const withoutGit = (process.env[pathKey] ?? '')
      .split(path.delimiter)
      .filter((dir) => !fs.existsSync(path.join(dir, 'git.exe')))
      .join(path.delimiter);
    const env = { ...process.env, [pathKey]: withoutGit };

    const result = spawnSync('git', ['--version'], { cwd: worktree, env, encoding: 'utf8', windowsHide: true });
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
    expect(() => execFileSync('git', ['--version'], { cwd: worktree, env, windowsHide: true, stdio: 'pipe' }))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(bareGitOutput(env)).not.toBe(hostname);
  });
});
