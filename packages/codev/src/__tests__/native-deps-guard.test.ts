/**
 * Spec 1658 Phase 10: the native-dependency install guard. The guard logic
 * (scripts/native-deps-guard.mjs) is pure and tested here on any host; the
 * real install on Windows (Node 20 refused before node-gyp, Node 22 installs)
 * is the `install-guard` job of windows.yml.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  SUPPORTED_WINDOWS_NODE as SCRIPT_SUPPORTED,
  WINDOWS_PREBUILD_NODE_ABIS,
  checkWindowsNodeForPrebuilds,
  unsupportedWindowsNodeMessage as scriptMessage,
  verifyNativeBindings,
} from '../../scripts/native-deps-guard.mjs';
import {
  SUPPORTED_WINDOWS_NODE,
  explainNativeLoadFailure,
  isNativeBindingLoadFailure,
  withNativeLoadExplanation,
  unsupportedWindowsNodeMessage,
} from '../lib/native-deps.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../lib/platform.js';

const codevPkgRoot = resolve(__dirname, '..', '..');

afterEach(() => {
  resetHostPlatformForTests();
});

describe('checkWindowsNodeForPrebuilds', () => {
  it('passes every non-Windows platform, whatever the Node', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(checkWindowsNodeForPrebuilds({ platform, arch: 'x64', abi: '115', nodeVersion: 'v20.18.0' })).toBeNull();
    }
  });

  it('passes Node 22 and 24 on x64 and arm64 (the audited prebuild set)', () => {
    for (const arch of ['x64', 'arm64']) {
      expect(checkWindowsNodeForPrebuilds({ platform: 'win32', arch, abi: '127', nodeVersion: 'v22.11.0' })).toBeNull();
      expect(checkWindowsNodeForPrebuilds({ platform: 'win32', arch, abi: '137', nodeVersion: 'v24.13.0' })).toBeNull();
    }
    expect(WINDOWS_PREBUILD_NODE_ABIS).toEqual(expect.arrayContaining(['127', '137']));
  });

  it('refuses Node 20 (no better-sqlite3 prebuild: the source-build fallback) with the supported versions', () => {
    const message = checkWindowsNodeForPrebuilds({ platform: 'win32', arch: 'x64', abi: '115', nodeVersion: 'v20.18.0' });
    expect(message).toContain('native Windows needs Node.js 22 or 24');
    expect(message).toContain('v20.18.0 (win32-x64)');
    expect(message).toContain('does not compile them from source');
  });

  it('refuses an unknown ABI and an architecture without prebuilds', () => {
    expect(checkWindowsNodeForPrebuilds({ platform: 'win32', arch: 'x64', abi: '999', nodeVersion: 'v99.0.0' })).not.toBeNull();
    expect(checkWindowsNodeForPrebuilds({ platform: 'win32', arch: 'ia32', abi: '127', nodeVersion: 'v22.11.0' })).toContain('win32-ia32');
  });
});

describe('runtime twin of the message', () => {
  it('is identical to the install-time message', () => {
    expect(SUPPORTED_WINDOWS_NODE).toBe(SCRIPT_SUPPORTED);
    expect(unsupportedWindowsNodeMessage('v20.18.0', 'arm64')).toBe(scriptMessage('v20.18.0', 'arm64'));
  });

  it('explains a binding load failure on Windows and leaves everything else alone', () => {
    const loadFailure = new Error('The module \'C:\\x\\better_sqlite3.node\' was compiled against a different Node.js version using NODE_MODULE_VERSION 115.');
    expect(isNativeBindingLoadFailure(loadFailure)).toBe(true);
    expect(isNativeBindingLoadFailure(new Error('SQLITE_BUSY: database is locked'))).toBe(false);

    setHostPlatformForTests('darwin');
    expect(explainNativeLoadFailure(loadFailure)).toBe(loadFailure);

    setHostPlatformForTests('win32');
    const explained = explainNativeLoadFailure(loadFailure) as Error;
    expect(explained.message).toContain('native Windows needs Node.js 22 or 24');
    expect(explained.message).toContain('NODE_MODULE_VERSION 115');
    expect(explained.cause).toBe(loadFailure);
    const other = new Error('SQLITE_BUSY: database is locked');
    expect(explainNativeLoadFailure(other)).toBe(other);
  });
});

describe('node-pty binding load failures', () => {
  it('recognises the ConPTY loader error shapes', () => {
    expect(isNativeBindingLoadFailure(new Error('Failed to load native module: conpty.node, checked: build/Release'))).toBe(true);
    expect(isNativeBindingLoadFailure(new Error("Cannot find module 'C:\\x\\node-pty\\build\\Release\\conpty.node'"))).toBe(true);
    expect(isNativeBindingLoadFailure(new Error("Cannot find module '/x/node-pty/build/Release/pty.node'"))).toBe(true);
  });

  it('withNativeLoadExplanation rethrows a load failure explained on Windows, anything else as is', () => {
    setHostPlatformForTests('win32');
    expect(() => withNativeLoadExplanation(() => { throw new Error('Failed to load native module: conpty.node'); }))
      .toThrow('native Windows needs Node.js 22 or 24');
    expect(() => withNativeLoadExplanation(() => { throw new Error('boom'); })).toThrow(/^boom$/);
    expect(withNativeLoadExplanation(() => 42)).toBe(42);
  });
});

describe('verifyNativeBindings', () => {
  // node-pty's conpty binding exists only on Windows.
  it.runIf(process.platform === 'win32')('loads the installed bindings on Windows', () => {
    expect(verifyNativeBindings(createRequire(join(codevPkgRoot, 'package.json')))).toBeNull();
  });

  it('reports each binding that fails to load', () => {
    const requireFn = (id: string) => {
      throw new Error(`Cannot find module '${id}'`);
    };
    const failure = verifyNativeBindings(requireFn);
    expect(failure).toContain('better-sqlite3: Cannot find module');
    expect(failure).toContain('node-pty: Cannot find module');
  });
});

describe('package wiring', () => {
  const pkg = JSON.parse(readFileSync(join(codevPkgRoot, 'package.json'), 'utf8'));

  it('runs the guard as preinstall and ships both guard files', () => {
    expect(pkg.scripts.preinstall).toBe('node ./scripts/preinstall.mjs');
    expect(pkg.files).toEqual(expect.arrayContaining(['scripts/preinstall.mjs', 'scripts/native-deps-guard.mjs', 'scripts/postinstall.mjs']));
  });

  it('keeps engines.node at >=20 so POSIX installs are unaffected', () => {
    expect(pkg.engines.node).toBe('>=20.0.0');
  });

  it('preinstall is a no-op off Windows and on a supported Windows Node', () => {
    const result = spawnSync(process.execPath, [join(codevPkgRoot, 'scripts', 'preinstall.mjs')], { encoding: 'utf8' });
    if (process.platform !== 'win32' || WINDOWS_PREBUILD_NODE_ABIS.includes(process.versions.modules)) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
  });

  it('postinstall passes on this host', () => {
    expect(() => execFileSync(process.execPath, [join(codevPkgRoot, 'scripts', 'postinstall.mjs')], { encoding: 'utf8' })).not.toThrow();
  });
});
