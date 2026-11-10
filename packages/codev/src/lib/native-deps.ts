/**
 * First-run native-dependency failure on native Windows (Spec 1658).
 *
 * The install guard (`scripts/preinstall.mjs`, `scripts/postinstall.mjs`)
 * stops an install that would need a source build. A binding can still fail
 * to load later: an install run with scripts disabled, or Node upgraded or
 * switched after the install. This module turns that load failure into the
 * same supported-versions message. The message text is the runtime twin of
 * `unsupportedWindowsNodeMessage` in `scripts/native-deps-guard.mjs`
 * (kept identical by a parity test; scripts cannot import from `dist`).
 */

import { isWindows } from './platform.js';

/** The Node versions Codev documents and tests on native Windows. */
export const SUPPORTED_WINDOWS_NODE = 'Node.js 22 or 24 (LTS), x64 or arm64';

/** The supported-versions message, as printed by the install guard. */
export function unsupportedWindowsNodeMessage(nodeVersion: string, arch: string): string {
  return [
    `@cluesmith/codev: native Windows needs ${SUPPORTED_WINDOWS_NODE}.`,
    `This is Node.js ${nodeVersion} (win32-${arch}), which has no prebuilt binary for Codev's native dependencies, and Codev does not compile them from source.`,
    'Install Node.js 22 or 24 (for example: winget install OpenJS.NodeJS.LTS), then run the install again. WSL 2 is the other supported way to run Codev on Windows.',
  ].join('\n');
}

/** Patterns of a native binding that could not be loaded (missing, wrong ABI, wrong arch). */
const BINDING_LOAD_FAILURE = [
  /Could not locate the bindings file/,
  /better_sqlite3\.node/,
  /NODE_MODULE_VERSION/,
  /Failed to load native module/,
  /is not a valid Win32 application/,
  /conpty\.node/,
  /[\\/]pty\.node/,
];

/** True when `err` is a native binding that failed to load. */
export function isNativeBindingLoadFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return BINDING_LOAD_FAILURE.some((pattern) => pattern.test(err.message));
}

/**
 * On Windows, a binding load failure becomes an Error carrying the
 * supported-versions message followed by the original error. Anything else,
 * and every error on other platforms, is returned unchanged.
 */
export function explainNativeLoadFailure(err: unknown): unknown {
  if (!isWindows() || !isNativeBindingLoadFailure(err)) {
    return err;
  }
  const original = (err as Error).message;
  return new Error(`${unsupportedWindowsNodeMessage(process.version, process.arch)}\nNative binding load failure: ${original}`, { cause: err });
}

/**
 * Run `load`, rethrowing a binding load failure through `explainNativeLoadFailure`.
 * For node-pty, whose ConPTY binding loads lazily inside `spawn`, so the import and
 * the first spawn are both load points.
 */
export function withNativeLoadExplanation<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    throw explainNativeLoadFailure(err);
  }
}

/**
 * For a caller that degrades on an open failure: on Windows a binding load failure
 * is not a missing database, so it is rethrown. POSIX callers keep their behaviour.
 */
export function rethrowIfNativeLoadFailure(err: unknown): void {
  if (isWindows() && isNativeBindingLoadFailure(err)) {
    throw err;
  }
}
