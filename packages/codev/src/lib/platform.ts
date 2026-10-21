/**
 * Host-platform seam for native Windows support (Spec 1658).
 *
 * Every Windows branch in the runtime asks this module, not `process.platform`
 * directly. That is what makes the Windows branches testable on the macOS and
 * Linux hosts the suites run on: a test forces the seam to `win32` and
 * exercises the branch with injected exec/fs, while real-Windows behavior is
 * covered separately by the on-demand Windows workflow.
 *
 * The override is test-only. Production code never sets it, so on a real host
 * the seam is exactly `process.platform`.
 */

let override: NodeJS.Platform | null = null;

/** The platform the runtime should behave as: `process.platform` unless a test forced it. */
export function hostPlatform(): NodeJS.Platform {
  if (override !== null) {
    return override;
  }
  return process.platform;
}

/** True when the runtime should take its native-Windows branches. */
export function isWindows(): boolean {
  return hostPlatform() === 'win32';
}

/**
 * Force the seam to a platform for the duration of a test. Pair every call
 * with `resetHostPlatformForTests()` (typically in `afterEach`).
 */
export function setHostPlatformForTests(platform: NodeJS.Platform): void {
  override = platform;
}

/** Restore the seam to the real `process.platform`. */
export function resetHostPlatformForTests(): void {
  override = null;
}
