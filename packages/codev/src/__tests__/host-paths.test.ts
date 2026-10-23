/**
 * Host-path helpers (Spec 1658, Phase 10): POSIX behavior is the call sites'
 * old behavior; the Windows branch is forced through the platform seam.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../lib/platform.js';
import {
  endsWithHostSeparator,
  expandHomePath,
  isHostPathAtOrUnder,
  isHostPathUnder,
  lastPathSegment,
} from '../lib/host-paths.js';

afterEach(() => {
  resetHostPlatformForTests();
});

describe('expandHomePath', () => {
  it('expands ~ and ~/ on POSIX and leaves other input alone', () => {
    setHostPlatformForTests('linux');
    expect(expandHomePath('~', '/home/a')).toBe('/home/a');
    expect(expandHomePath('~/src/repo', '/home/a')).toBe('/home/a/src/repo');
    expect(expandHomePath('~/', '/home/a')).toBe('/home/a/');
    expect(expandHomePath('~bob/x', '/home/a')).toBe('~bob/x');
    expect(expandHomePath('/abs/~/x', '/home/a')).toBe('/abs/~/x');
    expect(expandHomePath('~\\src', '/home/a')).toBe('~\\src');
  });

  it('also expands ~\\ on Windows', () => {
    setHostPlatformForTests('win32');
    expect(expandHomePath('~\\src\\repo', 'C:\\Users\\a')).toBe('C:\\Users\\a\\src\\repo');
    expect(expandHomePath('~/src', 'C:\\Users\\a')).toBe('C:\\Users\\a/src');
    expect(expandHomePath('~', 'C:\\Users\\a')).toBe('C:\\Users\\a');
  });
});

describe('endsWithHostSeparator', () => {
  it('accepts a backslash only on Windows', () => {
    setHostPlatformForTests('darwin');
    expect(endsWithHostSeparator('/a/')).toBe(true);
    expect(endsWithHostSeparator('a\\')).toBe(false);
    setHostPlatformForTests('win32');
    expect(endsWithHostSeparator('C:\\a\\')).toBe(true);
    expect(endsWithHostSeparator('C:/a/')).toBe(true);
    expect(endsWithHostSeparator('C:\\a')).toBe(false);
  });
});

describe('lastPathSegment', () => {
  it('splits on / only on POSIX', () => {
    setHostPlatformForTests('linux');
    expect(lastPathSegment('/home/a/repo')).toBe('repo');
    expect(lastPathSegment('/home/a/repo/')).toBe('');
    expect(lastPathSegment('dir\\name')).toBe('dir\\name');
  });

  it('splits on both separators on Windows', () => {
    setHostPlatformForTests('win32');
    expect(lastPathSegment('C:\\Users\\a\\repo')).toBe('repo');
    expect(lastPathSegment('C:/Users/a/repo')).toBe('repo');
    expect(lastPathSegment('C:\\Users\\a\\repo\\')).toBe('');
  });
});

describe('isHostPathUnder / isHostPathAtOrUnder', () => {
  it('compares bytes with a / boundary on POSIX', () => {
    setHostPlatformForTests('linux');
    expect(isHostPathUnder('/tmp/x', '/tmp')).toBe(true);
    expect(isHostPathUnder('/tmp', '/tmp')).toBe(false);
    expect(isHostPathUnder('/tmp2/x', '/tmp')).toBe(false);
    expect(isHostPathUnder('/TMP/x', '/tmp')).toBe(false);
    expect(isHostPathAtOrUnder('/tmp', '/tmp')).toBe(true);
    expect(isHostPathAtOrUnder('/tmp/x', '/tmp')).toBe(true);
    expect(isHostPathAtOrUnder('/tmpx', '/tmp')).toBe(false);
  });

  it('ignores case and separator style on Windows', () => {
    setHostPlatformForTests('win32');
    const temp = 'C:\\Users\\a\\AppData\\Local\\Temp';
    expect(isHostPathUnder('c:\\users\\A\\appdata\\local\\temp\\ws', temp)).toBe(true);
    expect(isHostPathUnder('C:/Users/a/AppData/Local/Temp/ws', temp)).toBe(true);
    expect(isHostPathUnder(temp, temp)).toBe(false);
    expect(isHostPathUnder('C:\\Users\\a\\AppData\\Local\\Temp2\\ws', temp)).toBe(false);
    expect(isHostPathUnder('C:\\Users\\a\\AppData\\Local\\Temp\\ws', temp + '\\')).toBe(true);
    expect(isHostPathAtOrUnder('c:\\users\\a\\appdata\\local\\temp', temp)).toBe(true);
    expect(isHostPathAtOrUnder('C:\\Users\\a\\src', temp)).toBe(false);
  });
});
