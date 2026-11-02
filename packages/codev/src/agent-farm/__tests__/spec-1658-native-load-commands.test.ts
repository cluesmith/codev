/**
 * Spec 1658 Phase 10: a better-sqlite3 binding that cannot load (scripts disabled
 * at install, or Node switched after it) surfaces from a command on Windows with
 * the supported-versions message, not a raw loader error or a quiet fallback.
 * `afx whoami`'s architect path stands for every command that opens the global
 * database through openDatabase and degrades when the open fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOAD_ERROR = "Could not locate the bindings file. Tried:\n → C:\\npm\\node_modules\\better-sqlite3\\build\\better_sqlite3.node";

vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() {
      throw new Error(LOAD_ERROR);
    }
  },
}));

import { resolveIdentity } from '../commands/whoami.js';
import { openDatabase } from '../../lib/sqlite.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';

describe('a better-sqlite3 binding that cannot load', () => {
  let dir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-1658-native-load-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    resetHostPlatformForTests();
  });

  it('openDatabase explains it on Windows and keeps the loader error as the cause', () => {
    setHostPlatformForTests('win32');
    let caught: Error | null = null;
    try {
      openDatabase(join(dir, 'x.db'));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('native Windows needs Node.js 22 or 24');
    expect((caught?.cause as Error).message).toBe(LOAD_ERROR);
  });

  it('Windows: afx whoami fails with the supported-versions message instead of degrading', () => {
    setHostPlatformForTests('win32');
    expect(() => resolveIdentity({ CODEV_ARCHITECT_NAME: 'main' })).toThrow('native Windows needs Node.js 22 or 24');
  });

  it('POSIX: afx whoami keeps its degrade path (no database, identity from the env)', () => {
    setHostPlatformForTests('darwin');
    expect(resolveIdentity({ CODEV_ARCHITECT_NAME: 'main' })).toMatchObject({ type: 'architect', name: 'main' });
  });
});
