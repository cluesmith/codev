/**
 * Scoped host-platform override for tests (Spec 1658, Amendment 2).
 *
 * `useHostPlatform('win32')` inside a `describe` forces the seam for every
 * test in it and restores the real platform after each one, so a test cannot
 * forget the reset. The override itself stays the test-guarded one in
 * `lib/platform.ts`; product code never sets it.
 */

import { afterEach, beforeEach } from 'vitest';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

export function useHostPlatform(platform: NodeJS.Platform): void {
  beforeEach(() => {
    setHostPlatformForTests(platform);
  });
  afterEach(() => {
    resetHostPlatformForTests();
  });
}
