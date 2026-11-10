/**
 * Spec 1658, Amendment 2: the scoped test overrides restore the real platform
 * when a test finishes, so forcing `win32` in one test cannot leak into the
 * next (the migration of 41 suites onto them relies on this).
 */

import { describe, it, expect } from 'vitest';
import { hostPlatform, isWindows } from '../lib/platform.js';
import { forceHostPlatform, useHostPlatform } from './helpers/host-platform.js';

const realPlatform = process.platform;
let forced: NodeJS.Platform = 'win32';
if (realPlatform === 'win32') {
  forced = 'linux';
}

describe('forceHostPlatform', () => {
  it('forces the seam for the running test', () => {
    forceHostPlatform(forced);
    expect(hostPlatform()).toBe(forced);
  });

  it('is gone in the next test', () => {
    expect(hostPlatform()).toBe(realPlatform);
  });
});

describe('useHostPlatform', () => {
  describe('inside the describe', () => {
    useHostPlatform('win32');
    it('every test sees the forced platform', () => {
      expect(isWindows()).toBe(true);
    });
  });

  it('outside it, the real platform is back', () => {
    expect(hostPlatform()).toBe(realPlatform);
  });
});
