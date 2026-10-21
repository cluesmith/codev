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
    setHostPlatformForTests(process.platform === 'win32' ? 'darwin' : 'win32');
    resetHostPlatformForTests();
    expect(hostPlatform()).toBe(process.platform);
  });
});
