import { afterEach, describe, expect, it } from 'vitest';
import {
  hostPlatform,
  isWindows,
  resetHostPlatformForTests,
  setHostPlatformForTests,
} from '../lib/platform.js';

describe('platform seam (Spec 1658)', () => {
  afterEach(() => {
    resetHostPlatformForTests();
  });

  it('defaults to process.platform', () => {
    expect(hostPlatform()).toBe(process.platform);
    expect(isWindows()).toBe(process.platform === 'win32');
  });

  it('can be forced to win32 for a test', () => {
    setHostPlatformForTests('win32');
    expect(hostPlatform()).toBe('win32');
    expect(isWindows()).toBe(true);
  });

  it('can be forced to a POSIX platform for a test', () => {
    setHostPlatformForTests('linux');
    expect(hostPlatform()).toBe('linux');
    expect(isWindows()).toBe(false);
  });

  it('reset restores process.platform', () => {
    let other: NodeJS.Platform = 'win32';
    if (process.platform === 'win32') other = 'darwin';
    setHostPlatformForTests(other);
    resetHostPlatformForTests();
    expect(hostPlatform()).toBe(process.platform);
  });

  it('refuses to override outside a test runner', () => {
    const saved = { vitest: process.env.VITEST, isolation: process.env.CODEV_TEST_ISOLATION };
    delete process.env.VITEST;
    delete process.env.CODEV_TEST_ISOLATION;
    try {
      expect(() => setHostPlatformForTests('win32')).toThrow(/test-only/);
      expect(hostPlatform()).toBe(process.platform);
    } finally {
      if (saved.vitest !== undefined) process.env.VITEST = saved.vitest;
      if (saved.isolation !== undefined) process.env.CODEV_TEST_ISOLATION = saved.isolation;
    }
  });
});
