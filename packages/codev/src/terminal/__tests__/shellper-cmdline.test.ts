/**
 * Spec 1658 Phase 3: reading a shellper's JSON config out of a process-table
 * command line. On Windows the census reports the raw command line, so the
 * JSON argument carries argv quoting and its paths carry JSON-escaped
 * backslashes (`C:\\Users\\...`); matchers must still find `C:\Users\...`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  shellperTeardownIdentities,
  isShellperInScope,
  readJsonStringField,
  sameWindowsPath,
  shellperArgvText,
  unquoteWindowsCommandLine,
} from '../shellper-cmdline.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';
import { windowsShellperCmdline } from './windows-cmdline-fixtures.js';

afterEach(() => {
  resetHostPlatformForTests();
});

const WIN_SOCKET_DIR = 'C:\\Users\\me\\.agent-farm\\run';

describe('unquoteWindowsCommandLine', () => {
  it('recovers the raw JSON argument, escapes intact', () => {
    const config = { socketPath: '\\\\.\\pipe\\codev-shellper-me-1', socketDir: WIN_SOCKET_DIR, cwd: 'C:\\ws' };
    const text = unquoteWindowsCommandLine(windowsShellperCmdline(config));
    expect(text).toContain(JSON.stringify(config));
  });

  it('handles a value ending in a backslash (doubled before the closing quote)', () => {
    const config = { cwd: 'C:\\', note: 'say "hi"' };
    expect(unquoteWindowsCommandLine(windowsShellperCmdline(config))).toContain(JSON.stringify(config));
  });

  it('leaves backslashes not followed by a quote alone', () => {
    expect(unquoteWindowsCommandLine('C:\\a\\b.exe x')).toBe('C:\\a\\b.exe x');
  });
});

describe('readJsonStringField', () => {
  it('JSON-decodes the value, so escaped backslashes match the real path', () => {
    const text = JSON.stringify({ socketDir: WIN_SOCKET_DIR });
    expect(text).toContain('C:\\\\Users');
    expect(readJsonStringField(text, 'socketDir')).toBe(WIN_SOCKET_DIR);
  });

  it('decodes an escaped quote inside a value', () => {
    expect(readJsonStringField('{"cwd":"a\\"b"}', 'cwd')).toBe('a"b');
  });

  it('reads POSIX values unchanged', () => {
    expect(readJsonStringField('{"cwd":"/Users/x/ws","socketPath":"/tmp/s.sock"}', 'cwd')).toBe('/Users/x/ws');
  });

  it('reads an absent, empty or truncated field as null', () => {
    expect(readJsonStringField('{"cwd":"/x"}', 'socketDir')).toBeNull();
    expect(readJsonStringField('{"cwd":""}', 'cwd')).toBeNull();
    expect(readJsonStringField('{"cwd":"/x', 'cwd')).toBeNull();
  });
});

describe('shellperArgvText', () => {
  it('is the identity on POSIX', () => {
    const line = 'node shellper-main.js {"cwd":"a\\"b"}';
    expect(shellperArgvText(line)).toBe(line);
  });

  it('unquotes on Windows', () => {
    setHostPlatformForTests('win32');
    expect(shellperArgvText(windowsShellperCmdline({ cwd: 'C:\\ws' }))).toContain('{"cwd":"C:\\\\ws"}');
  });
});

describe('isShellperInScope', () => {
  it('POSIX: matches the socketDir marker with a trailing separator only', () => {
    const line = 'node shellper-main.js {"socketPath":"/run/s.sock"}';
    expect(isShellperInScope(line, '/run')).toBe(true);
    expect(isShellperInScope(line, '/run/')).toBe(true);
    expect(isShellperInScope('node shellper-main.js {"socketPath":"/run2/s.sock"}', '/run')).toBe(false);
  });

  it('Windows: matches the decoded socketDir field, case-insensitively', () => {
    setHostPlatformForTests('win32');
    const line = windowsShellperCmdline({ socketPath: '\\\\.\\pipe\\codev-shellper-me-1', socketDir: WIN_SOCKET_DIR });
    expect(isShellperInScope(line, WIN_SOCKET_DIR)).toBe(true);
    expect(isShellperInScope(line, 'c:\\users\\ME\\.agent-farm\\run\\')).toBe(true);
  });

  it('Windows: rejects another instance\'s directory, including a prefix', () => {
    setHostPlatformForTests('win32');
    const line = windowsShellperCmdline({ socketDir: `${WIN_SOCKET_DIR}2` });
    expect(isShellperInScope(line, WIN_SOCKET_DIR)).toBe(false);
    expect(isShellperInScope(windowsShellperCmdline({ cwd: 'C:\\ws' }), WIN_SOCKET_DIR)).toBe(false);
  });
});

describe('sameWindowsPath', () => {
  it('ignores case, separator style and a trailing separator', () => {
    expect(sameWindowsPath('C:\\Users\\Me\\ws', 'c:/users/me/ws/')).toBe(true);
    expect(sameWindowsPath('C:\\Users\\Me\\ws', 'C:\\Users\\Me\\ws2')).toBe(false);
  });
});

describe('shellperTeardownIdentities', () => {
  const entries = [
    { pid: 1, cmdline: windowsShellperCmdline({ sessionId: 'abc' }), creationTime: 10 },
    { pid: 2, cmdline: windowsShellperCmdline({ cwd: 'C:\\ws' }), creationTime: 20 },
    { pid: 3, cmdline: windowsShellperCmdline({ sessionId: 'not-reaped' }), creationTime: 30 },
  ];

  it('Windows: creation times and session job names for the reaped pids only', () => {
    setHostPlatformForTests('win32');
    const { startTimes, jobNames } = shellperTeardownIdentities(entries, [1, 2]);
    expect(startTimes).toEqual(new Map([[1, 10], [2, 20]]));
    expect(jobNames).toEqual(new Map([[1, 'Local\\codev-session-abc']]));
  });

  it('POSIX: no job names', () => {
    const { jobNames } = shellperTeardownIdentities([{ pid: 1, cmdline: 'node shellper-main.js {"sessionId":"abc"}' }], [1]);
    expect(jobNames.size).toBe(0);
  });
});
