/**
 * Spec 1658 Phase 5: Git Bash resolution precedence (ruling 5 as amended
 * 2026-10-21T06:15:45Z), against a fake host. Real resolution on a Windows
 * runner is in `git-bash.windows.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { resolveGitBash, isWslLauncher, GitBashError, type GitBashHost } from '../lib/git-bash.js';

const PROGRAM_FILES_GIT = 'C:\\Program Files\\Git';
const LOCAL_GIT = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git';
const CUSTOM_GIT = 'D:\\tools\\Git';
const SYSTEM32_BASH = 'C:\\Windows\\System32\\bash.exe';
const MSYS2_BASH = 'C:\\msys64\\usr\\bin\\bash.exe';
const GIT_VERSION = 'git version 2.47.1.windows.1';

const BASE_ENV = {
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
};

/** A Git for Windows install at `root`: bash in bin and usr\bin, git in cmd. */
function gitInstall(root: string): string[] {
  return [`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`, `${root}\\cmd\\git.exe`];
}

function fakeHost(opts: {
  files: string[];
  env?: Record<string, string>;
  onPath?: string[];
  versions?: Record<string, string>;
}): GitBashHost {
  const files = new Set(opts.files.map((f) => f.toLowerCase()));
  return {
    env: { ...BASE_ENV, ...(opts.env ?? {}) },
    isFile: (file) => files.has(file.toLowerCase()),
    gitVersion: (gitExe) => opts.versions?.[gitExe] ?? GIT_VERSION,
    findBashOnPath: () => opts.onPath ?? [],
  };
}

function failureOf(fn: () => unknown): GitBashError {
  try {
    fn();
  } catch (err) {
    if (err instanceof GitBashError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected a GitBashError');
}

describe('resolveGitBash precedence', () => {
  it('a valid config override wins over an installed Git', () => {
    const host = fakeHost({ files: [...gitInstall(PROGRAM_FILES_GIT), ...gitInstall(CUSTOM_GIT)] });
    const resolved = resolveGitBash({ configPath: `${CUSTOM_GIT}\\bin\\bash.exe` }, host);
    expect(resolved).toEqual({ path: `${CUSTOM_GIT}\\bin\\bash.exe`, root: CUSTOM_GIT, gitVersion: GIT_VERSION, source: 'config' });
  });

  it('a valid CLAUDE_CODE_GIT_BASH_PATH wins over an installed Git', () => {
    const host = fakeHost({
      files: [...gitInstall(PROGRAM_FILES_GIT), ...gitInstall(CUSTOM_GIT)],
      env: { CLAUDE_CODE_GIT_BASH_PATH: `${CUSTOM_GIT}\\usr\\bin\\bash.exe` },
    });
    const resolved = resolveGitBash({}, host);
    expect(resolved.path).toBe(`${CUSTOM_GIT}\\usr\\bin\\bash.exe`);
    expect(resolved.root).toBe(CUSTOM_GIT);
    expect(resolved.source).toBe('env');
  });

  it('the config setting wins over the environment variable', () => {
    const host = fakeHost({
      files: [...gitInstall(PROGRAM_FILES_GIT), ...gitInstall(CUSTOM_GIT)],
      env: { CLAUDE_CODE_GIT_BASH_PATH: `${PROGRAM_FILES_GIT}\\bin\\bash.exe` },
    });
    expect(resolveGitBash({ configPath: `${CUSTOM_GIT}\\bin\\bash.exe` }, host).source).toBe('config');
  });

  it('an empty override is ignored', () => {
    const host = fakeHost({ files: gitInstall(PROGRAM_FILES_GIT), env: { CLAUDE_CODE_GIT_BASH_PATH: '  ' } });
    expect(resolveGitBash({ configPath: '' }, host).source).toBe('install');
  });

  it('Program Files before LocalAppData', () => {
    const host = fakeHost({ files: [...gitInstall(PROGRAM_FILES_GIT), ...gitInstall(LOCAL_GIT)] });
    expect(resolveGitBash({}, host).path).toBe(`${PROGRAM_FILES_GIT}\\bin\\bash.exe`);
  });

  it('a per-user install under LocalAppData', () => {
    const host = fakeHost({ files: gitInstall(LOCAL_GIT) });
    expect(resolveGitBash({}, host)).toMatchObject({ path: `${LOCAL_GIT}\\bin\\bash.exe`, source: 'install' });
  });

  it('install path before PATH', () => {
    const host = fakeHost({
      files: [...gitInstall(PROGRAM_FILES_GIT), ...gitInstall(CUSTOM_GIT)],
      onPath: [`${CUSTOM_GIT}\\usr\\bin\\bash.exe`],
    });
    expect(resolveGitBash({}, host).source).toBe('install');
  });

  it('System32 is never returned, even when first on PATH (the owner-machine layout)', () => {
    const host = fakeHost({
      files: [SYSTEM32_BASH, ...gitInstall(CUSTOM_GIT)],
      onPath: [SYSTEM32_BASH, SYSTEM32_BASH, `${CUSTOM_GIT}\\usr\\bin\\bash.exe`],
    });
    const resolved = resolveGitBash({}, host);
    expect(resolved.path).toBe(`${CUSTOM_GIT}\\usr\\bin\\bash.exe`);
    expect(resolved.source).toBe('path');
  });

  it('PATH skips a bash that is not Git for Windows (MSYS2, Cygwin)', () => {
    const host = fakeHost({
      files: [MSYS2_BASH, 'C:\\msys64\\usr\\bin\\git.exe', ...gitInstall(CUSTOM_GIT)],
      onPath: [MSYS2_BASH, `${CUSTOM_GIT}\\bin\\bash.exe`],
      versions: { 'C:\\msys64\\usr\\bin\\git.exe': 'git version 2.45.2' },
    });
    expect(resolveGitBash({}, host).path).toBe(`${CUSTOM_GIT}\\bin\\bash.exe`);
  });

  it('an install whose git.exe does not run is skipped', () => {
    const host = fakeHost({
      files: [...gitInstall(PROGRAM_FILES_GIT), ...gitInstall(CUSTOM_GIT)],
      onPath: [`${CUSTOM_GIT}\\bin\\bash.exe`],
      versions: { [`${PROGRAM_FILES_GIT}\\cmd\\git.exe`]: 'broken' },
    });
    expect(resolveGitBash({}, host).root).toBe(CUSTOM_GIT);
  });
});

describe('resolveGitBash failures are loud', () => {
  it('an override at System32 fails, even with Git installed', () => {
    const host = fakeHost({ files: [SYSTEM32_BASH, ...gitInstall(PROGRAM_FILES_GIT)] });
    const err = failureOf(() => resolveGitBash({ configPath: SYSTEM32_BASH }, host));
    expect(err.failure).toBe('override-wsl');
    expect(err.message).toContain('windows.gitBashPath');
    expect(err.message).toContain('WSL launcher');
  });

  it('an env override at the WindowsApps alias fails', () => {
    const alias = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const host = fakeHost({ files: [alias, ...gitInstall(PROGRAM_FILES_GIT)], env: { CLAUDE_CODE_GIT_BASH_PATH: alias } });
    const err = failureOf(() => resolveGitBash({}, host));
    expect(err.failure).toBe('override-wsl');
    expect(err.message).toContain('CLAUDE_CODE_GIT_BASH_PATH');
  });

  it('an override at a non-Git bash fails', () => {
    const host = fakeHost({
      files: [MSYS2_BASH, 'C:\\msys64\\usr\\bin\\git.exe', ...gitInstall(PROGRAM_FILES_GIT)],
      versions: { 'C:\\msys64\\usr\\bin\\git.exe': 'git version 2.45.2' },
    });
    const err = failureOf(() => resolveGitBash({ configPath: MSYS2_BASH }, host));
    expect(err.failure).toBe('override-not-git');
    expect(err.message).toContain('not a Git for Windows bash');
  });

  it('an override at a missing file fails', () => {
    const host = fakeHost({ files: gitInstall(PROGRAM_FILES_GIT) });
    const err = failureOf(() => resolveGitBash({ configPath: `${CUSTOM_GIT}\\bin\\bash.exe` }, host));
    expect(err.failure).toBe('override-missing');
  });

  it('nothing found: only System32 bash present → error naming Git for Windows', () => {
    const host = fakeHost({ files: [SYSTEM32_BASH], onPath: [SYSTEM32_BASH] });
    const err = failureOf(() => resolveGitBash({}, host));
    expect(err.failure).toBe('not-found');
    expect(err.message).toContain('Git for Windows');
    expect(err.message).toContain('winget install --id Git.Git');
  });
});

describe('isWslLauncher', () => {
  it.each([
    ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows', true],
    ['c:\\windows\\system32\\BASH.EXE', 'C:\\Windows', true],
    ['C:\\Windows\\Sysnative\\bash.exe', 'C:\\Windows', true],
    ['C:/Windows/System32/bash.exe', 'C:\\Windows', true],
    ['E:\\Win\\System32\\bash.exe', 'E:\\Win', true],
    ['C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe', 'C:\\Windows', true],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows', false],
    ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows', false],
  ])('%s (SystemRoot %s) → %s', (bashPath, systemRoot, expected) => {
    expect(isWslLauncher(bashPath, { SystemRoot: systemRoot })).toBe(expected);
  });
});
