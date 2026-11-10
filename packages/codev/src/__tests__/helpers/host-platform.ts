/**
 * Scoped host-platform overrides for tests (Spec 1658, Amendment 2).
 *
 * `useHostPlatform('win32')` inside a `describe` forces the seam for every
 * test in it; `forceHostPlatform('win32')` inside a test (or a `beforeEach`)
 * forces it for that test only. Either restores the real platform when the
 * test finishes, so a test cannot forget the reset. The override itself stays
 * the test-guarded one in `lib/platform.ts`; product code never sets it.
 */

import { afterEach, beforeEach, onTestFinished } from 'vitest';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

export function useHostPlatform(platform: NodeJS.Platform): void {
  beforeEach(() => {
    setHostPlatformForTests(platform);
  });
  afterEach(() => {
    resetHostPlatformForTests();
  });
}

export function forceHostPlatform(platform: NodeJS.Platform): void {
  setHostPlatformForTests(platform);
  onTestFinished(() => {
    resetHostPlatformForTests();
  });
}
