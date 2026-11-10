/**
 * Host-path helpers (Spec 1658, Phase 10): POSIX behavior is the call sites'
 * old behavior; the Windows branch is forced through the platform seam.
 */

// spec-1658-tmp: opaque (every /tmp is an input to pure string path comparisons under a forced platform; nothing touches the disk)

import { describe, expect, it } from 'vitest';
import {
  endsWithHostSeparator,
  expandHomePath,
  isHostPathAtOrUnder,
  isHostPathUnder,
  lastPathSegment,
} from '../lib/host-paths.js';
import { forceHostPlatform } from './helpers/host-platform.js';

describe('expandHomePath', () => {
  it('expands ~ and ~/ on POSIX and leaves other input alone', () => {
    forceHostPlatform('linux');
    expect(expandHomePath('~', '/home/a')).toBe('/home/a');
    expect(expandHomePath('~/src/repo', '/home/a')).toBe('/home/a/src/repo');
    expect(expandHomePath('~/', '/home/a')).toBe('/home/a/');
    expect(expandHomePath('~bob/x', '/home/a')).toBe('~bob/x');
    expect(expandHomePath('/abs/~/x', '/home/a')).toBe('/abs/~/x');
    expect(expandHomePath('~\\src', '/home/a')).toBe('~\\src');
  });

  it('also expands ~\\ on Windows', () => {
    forceHostPlatform('win32');
    expect(expandHomePath('~\\src\\repo', 'C:\\Users\\a')).toBe('C:\\Users\\a\\src\\repo');
    expect(expandHomePath('~/src', 'C:\\Users\\a')).toBe('C:\\Users\\a/src');
    expect(expandHomePath('~', 'C:\\Users\\a')).toBe('C:\\Users\\a');
  });
});

describe('endsWithHostSeparator', () => {
  it('accepts a backslash only on Windows', () => {
    forceHostPlatform('darwin');
    expect(endsWithHostSeparator('/a/')).toBe(true);
    expect(endsWithHostSeparator('a\\')).toBe(false);
    forceHostPlatform('win32');
    expect(endsWithHostSeparator('C:\\a\\')).toBe(true);
    expect(endsWithHostSeparator('C:/a/')).toBe(true);
    expect(endsWithHostSeparator('C:\\a')).toBe(false);
  });
});

describe('lastPathSegment', () => {
  it('splits on / only on POSIX', () => {
    forceHostPlatform('linux');
    expect(lastPathSegment('/home/a/repo')).toBe('repo');
    expect(lastPathSegment('/home/a/repo/')).toBe('');
    expect(lastPathSegment('dir\\name')).toBe('dir\\name');
  });

  it('splits on both separators on Windows', () => {
    forceHostPlatform('win32');
    expect(lastPathSegment('C:\\Users\\a\\repo')).toBe('repo');
    expect(lastPathSegment('C:/Users/a/repo')).toBe('repo');
    expect(lastPathSegment('C:\\Users\\a\\repo\\')).toBe('');
  });
});

describe('isHostPathUnder / isHostPathAtOrUnder', () => {
  it('compares bytes with a / boundary on POSIX', () => {
    forceHostPlatform('linux');
    expect(isHostPathUnder('/tmp/x', '/tmp')).toBe(true);
    expect(isHostPathUnder('/tmp', '/tmp')).toBe(false);
    expect(isHostPathUnder('/tmp2/x', '/tmp')).toBe(false);
    expect(isHostPathUnder('/TMP/x', '/tmp')).toBe(false);
    expect(isHostPathAtOrUnder('/tmp', '/tmp')).toBe(true);
    expect(isHostPathAtOrUnder('/tmp/x', '/tmp')).toBe(true);
    expect(isHostPathAtOrUnder('/tmpx', '/tmp')).toBe(false);
  });

  it('ignores case and separator style on Windows', () => {
    forceHostPlatform('win32');
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
