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

/**
 * Force the seam for the running test (call it in the test or a `beforeEach`).
 * The reset is registered first, so a misuse outside a test fails before the
 * seam is forced. It runs after the `afterEach` hooks, so their cleanup still
 * sees the forced platform. A test that cancels itself with a dynamic
 * `ctx.skip()` gets no `onTestFinished`; such a suite should use
 * `useHostPlatform` instead.
 */
export function forceHostPlatform(platform: NodeJS.Platform): void {
  onTestFinished(() => {
    resetHostPlatformForTests();
  });
  setHostPlatformForTests(platform);
}
