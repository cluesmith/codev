// Native-dependency install guard for native Windows (Spec 1658).
//
// better-sqlite3's install script is `prebuild-install || node-gyp rebuild`:
// when no prebuilt binary matches the running Node, it silently falls back to
// compiling from source, which needs a C++ toolchain most Windows machines do
// not have. npm runs every package's `preinstall` before any package's
// `install`, so `preinstall.mjs` checks the running Node against the prebuild
// set below and stops the install before that fallback can start.
// `postinstall.mjs` then verifies that both native bindings actually load.
//
// Node core only: `preinstall` runs before any dependency is installed.
// The runtime twin of the message is src/lib/native-deps.ts (parity-tested).

/**
 * Node ABIs (`process.versions.modules`) for which better-sqlite3 ships a
 * win32 prebuilt binary: Node 22 (127), 24 (137), 25 (141) and 26 (147), as
 * measured for better-sqlite3 12.10 (Spec 1658 audit, fact 1.1). Update this
 * list when the dependency adds prebuilds.
 */
export const WINDOWS_PREBUILD_NODE_ABIS = ['127', '137', '141', '147'];

/** Architectures both native dependencies ship win32 prebuilds for. */
export const WINDOWS_PREBUILD_ARCHES = ['x64', 'arm64'];

/** The Node versions Codev documents and tests on native Windows. */
export const SUPPORTED_WINDOWS_NODE = 'Node.js 22 or 24 (LTS), x64 or arm64';

/** The message printed whenever native Windows cannot use the prebuilt binaries. */
export function unsupportedWindowsNodeMessage(nodeVersion, arch) {
  return [
    `@cluesmith/codev: native Windows needs ${SUPPORTED_WINDOWS_NODE}.`,
    `This is Node.js ${nodeVersion} (win32-${arch}), which has no prebuilt binary for Codev's native dependencies, and Codev does not compile them from source.`,
    'Install Node.js 22 or 24 (for example: winget install OpenJS.NodeJS.LTS), then run the install again. WSL 2 is the other supported way to run Codev on Windows.',
  ].join('\n');
}

/**
 * Null when the running Node can install from prebuilt binaries on Windows,
 * else the message to print. Non-Windows platforms always pass.
 */
export function checkWindowsNodeForPrebuilds({ platform, arch, abi, nodeVersion }) {
  if (platform !== 'win32') {
    return null;
  }
  if (WINDOWS_PREBUILD_ARCHES.includes(arch) && WINDOWS_PREBUILD_NODE_ABIS.includes(abi)) {
    return null;
  }
  return unsupportedWindowsNodeMessage(nodeVersion, arch);
}

function errorText(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Load both native bindings the way Codev does at runtime. Returns null when
 * both load, else the failure description. `requireFn` resolves from the
 * installed package (createRequire), so the check sees the installed tree.
 */
export function verifyNativeBindings(requireFn) {
  const failures = [];
  try {
    const Database = requireFn('better-sqlite3');
    new Database(':memory:').close();
  } catch (err) {
    failures.push(`better-sqlite3: ${errorText(err)}`);
  }
  try {
    const utils = requireFn('node-pty/lib/utils.js');
    utils.loadNativeModule('conpty');
  } catch (err) {
    failures.push(`node-pty: ${errorText(err)}`);
  }
  if (failures.length === 0) {
    return null;
  }
  return failures.join('\n');
}
