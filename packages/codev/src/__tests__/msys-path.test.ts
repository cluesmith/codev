/**
 * Spec 1658 Phase 5: path translation across the Git Bash boundary.
 */

// spec-1658-tmp: opaque (/tmp/x is a string fed to a pure MSYS path translator to assert it throws; nothing touches the disk)

import { describe, it, expect } from 'vitest';
import { toMsysPath, fromMsysPath, MSYS_PATHCONV_OPT_OUT, withoutMsysPathConversion } from '../lib/msys-path.js';

describe('MSYS path round trip', () => {
  it.each([
    ['C:\\Users\\dev\\repo', '/c/Users/dev/repo'],
    ['C:\\Users\\Dev Name\\my repo\\file.sh', '/c/Users/Dev Name/my repo/file.sh'],
    ['D:\\', '/d/'],
    ['E:\\a\\b c\\d', '/e/a/b c/d'],
    ['\\\\server\\share\\dir', '//server/share/dir'],
    ['\\\\file server\\team share\\a b\\c.txt', '//file server/team share/a b/c.txt'],
    ['codev\\specs\\1-x.md', 'codev/specs/1-x.md'],
  ])('%s ⇄ %s', (native, msys) => {
    expect(toMsysPath(native)).toBe(msys);
    expect(fromMsysPath(msys)).toBe(native);
  });
});

describe('toMsysPath', () => {
  it('lowercases the drive letter and accepts forward slashes', () => {
    expect(toMsysPath('c:/Users/dev')).toBe('/c/Users/dev');
  });

  it('leaves a POSIX path unchanged', () => {
    expect(toMsysPath('/c/already/posix')).toBe('/c/already/posix');
  });
});

describe('fromMsysPath', () => {
  it('maps a bare drive to its root', () => {
    expect(fromMsysPath('/c')).toBe('C:\\');
  });

  it('normalizes the native form git.exe prints', () => {
    expect(fromMsysPath('C:/Users/dev/repo')).toBe('C:\\Users\\dev\\repo');
  });

  it('throws for a mount-table path rather than guessing', () => {
    expect(() => fromMsysPath('/usr/bin/bash')).toThrow(/Cannot map MSYS path \/usr\/bin\/bash/);
    expect(() => fromMsysPath('/tmp/x')).toThrow(/only drive/);
  });
});

describe('MSYS conversion opt-out', () => {
  it('sets both the Git for Windows and MSYS2 variables', () => {
    expect(MSYS_PATHCONV_OPT_OUT).toEqual({ MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });
  });

  it('adds the opt-out without dropping the caller environment', () => {
    const env = withoutMsysPathConversion({ PATH: 'C:\\bin', GH_TOKEN: 't' });
    expect(env).toEqual({ PATH: 'C:\\bin', GH_TOKEN: 't', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });
  });
});
