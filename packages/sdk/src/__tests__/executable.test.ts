import { describe, it, expect } from 'vitest';
import { findAllExecutables, findExecutable, isExecutableOnPath, resolveSpawnable } from '../node/executable.js';

/**
 * Spec 1658 Phase 5: the shared PATH/PATHEXT lookup and the shim resolver.
 * Platform, env and file probes are injected, so the Windows branches run on
 * any host. Real `CreateProcess` execution of the resolved form is covered by
 * `packages/codev/src/__tests__/executable.windows.test.ts`.
 */

/** A fake file system: a case-insensitive set of executable files plus shim texts. */
function fakeWindows(files: Record<string, string>, env: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([p, text]) => [p.toLowerCase(), text]));
  return {
    platform: 'win32' as const,
    env,
    isExecutableFile: (candidate: string) => lower.has(candidate.toLowerCase()),
    readText: (file: string) => lower.get(file.toLowerCase()) ?? null,
  };
}

const NPM_DIR = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
const AFX_ENTRY = `${NPM_DIR}\\node_modules\\@cluesmith\\codev\\bin\\afx.js`;
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@cluesmith\\codev\\bin\\afx.js" %*',
].join('\r\n');

const WIN_ENV = {
  PATH: `C:\\Windows\\System32;${NPM_DIR};C:\\Program Files\\nodejs`,
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
  COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
};

describe('findExecutable (POSIX)', () => {
  const posixHost = {
    platform: 'linux' as const,
    env: { PATH: '/usr/local/bin:/usr/bin' },
    isExecutableFile: (c: string) => c === '/usr/bin/jq' || c === '/usr/local/bin/jq',
  };

  it('returns the first PATH match, with no extension probing', () => {
    expect(findExecutable('jq', posixHost)).toBe('/usr/local/bin/jq');
    expect(findAllExecutables('jq', posixHost)).toEqual(['/usr/local/bin/jq', '/usr/bin/jq']);
  });

  it('checks a name with a separator directly', () => {
    expect(findExecutable('/usr/bin/jq', posixHost)).toBe('/usr/bin/jq');
    expect(findExecutable('./jq', posixHost)).toBeNull();
  });

  it('reports a missing command', () => {
    expect(isExecutableOnPath('gh', posixHost)).toBe(false);
  });
});

describe('findExecutable (seam win32)', () => {
  it('resolves claude to claude.cmd through PATHEXT', () => {
    const host = fakeWindows({ [`${NPM_DIR}\\claude.cmd`]: '' }, WIN_ENV);
    expect(findExecutable('claude', host)).toBe(`${NPM_DIR}\\claude.CMD`);
  });

  it('honors PATHEXT order within a directory (.exe before .cmd)', () => {
    const host = fakeWindows({ [`${NPM_DIR}\\claude.cmd`]: '', [`${NPM_DIR}\\claude.exe`]: '' }, WIN_ENV);
    expect(findExecutable('claude', host)).toBe(`${NPM_DIR}\\claude.EXE`);
  });

  it('honors PATH order across directories', () => {
    const host = fakeWindows({
      'C:\\Windows\\System32\\bash.exe': '',
      'C:\\Program Files\\Git\\bin\\bash.exe': '',
    }, { ...WIN_ENV, PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin' });
    expect(findAllExecutables('bash', host)).toEqual([
      'C:\\Windows\\System32\\bash.EXE',
      'C:\\Program Files\\Git\\bin\\bash.EXE',
    ]);
  });

  it('accepts a name that already carries a PATHEXT extension', () => {
    const host = fakeWindows({ [`${NPM_DIR}\\afx.cmd`]: '' }, WIN_ENV);
    expect(findExecutable('afx.cmd', host)).toBe(`${NPM_DIR}\\afx.cmd`);
  });

  it('reads Path and PathExt case-insensitively', () => {
    const host = fakeWindows({ [`${NPM_DIR}\\gh.exe`]: '' }, { Path: NPM_DIR, PathExt: '.EXE' });
    expect(findExecutable('gh', host)).toBe(`${NPM_DIR}\\gh.EXE`);
  });

  it('falls back to the default PATHEXT when unset', () => {
    const host = fakeWindows({ [`${NPM_DIR}\\npx.cmd`]: '' }, { PATH: NPM_DIR });
    expect(findExecutable('npx', host)).toBe(`${NPM_DIR}\\npx.CMD`);
  });
});

describe('resolveSpawnable', () => {
  it('returns the input unchanged on POSIX', () => {
    expect(resolveSpawnable('afx', ['status'], { platform: 'darwin', env: { PATH: '/usr/bin' } })).toEqual({
      command: 'afx',
      args: ['status'],
      windowsVerbatimArguments: false,
    });
  });

  it('returns a native .exe as its full path (CreateProcess runs it directly)', () => {
    const exe = 'C:\\Users\\dev\\.local\\bin\\claude.EXE';
    const host = fakeWindows({ [exe]: '' }, { ...WIN_ENV, PATH: 'C:\\Users\\dev\\.local\\bin' });
    expect(resolveSpawnable('claude', ['--version'], host)).toEqual({
      command: exe,
      args: ['--version'],
      windowsVerbatimArguments: false,
    });
  });

  it('turns an npm .cmd shim into node.exe <entry>', () => {
    const host = fakeWindows({
      [`${NPM_DIR}\\afx.cmd`]: NPM_SHIM,
      [AFX_ENTRY]: '',
      'C:\\Program Files\\nodejs\\node.exe': '',
    }, WIN_ENV);
    const spawnable = resolveSpawnable('afx', ['spawn', '42'], host);
    expect(spawnable).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.EXE',
      args: [AFX_ENTRY, 'spawn', '42'],
      windowsVerbatimArguments: false,
    });
    expect(spawnable.command.toLowerCase().endsWith('.exe')).toBe(true);
  });

  it('prefers a node.exe beside the shim, as the shim itself does', () => {
    const host = fakeWindows({
      [`${NPM_DIR}\\afx.cmd`]: NPM_SHIM,
      [`${NPM_DIR}\\node.exe`]: '',
      [AFX_ENTRY]: '',
      'C:\\Program Files\\nodejs\\node.exe': '',
    }, WIN_ENV);
    expect(resolveSpawnable('afx', [], host).command).toBe(`${NPM_DIR}\\node.exe`);
  });

  it('falls back to cmd.exe /d /s /c for a non-npm .cmd', () => {
    const host = fakeWindows({ 'C:\\tools\\build.cmd': '@echo %*' }, { ...WIN_ENV, PATH: 'C:\\tools' });
    const spawnable = resolveSpawnable('build', ['a b', 'x&y'], host);
    expect(spawnable.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spawnable.windowsVerbatimArguments).toBe(true);
    expect(spawnable.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spawnable.args[3]).toBe('"C:\\tools\\build.CMD ^"a^ b^" ^"x^&y^""');
  });

  it('uses the cmd.exe form when the npm entry is missing, with double escaping', () => {
    const host = fakeWindows({ [`${NPM_DIR}\\afx.cmd`]: NPM_SHIM }, WIN_ENV);
    const spawnable = resolveSpawnable('afx', ['a&b'], host);
    expect(spawnable.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spawnable.args[3]).toBe(`"${NPM_DIR}\\afx.CMD ^^^"a^^^&b^^^""`);
  });

  it('escapes embedded quotes and trailing backslashes MSVCRT-style', () => {
    const host = fakeWindows({ 'C:\\tools\\run.bat': '' }, { ...WIN_ENV, PATH: 'C:\\tools' });
    const spawnable = resolveSpawnable('run', ['say "hi"', 'C:\\dir\\'], host);
    expect(spawnable.args[3]).toBe('"C:\\tools\\run.BAT ^"say^ \\^"hi\\^"^" ^"C:\\dir\\\\^""');
  });

  it('leaves an unresolvable command unchanged so the spawn reports ENOENT', () => {
    const host = fakeWindows({}, WIN_ENV);
    expect(resolveSpawnable('nope', ['x'], host)).toEqual({ command: 'nope', args: ['x'], windowsVerbatimArguments: false });
  });
});
