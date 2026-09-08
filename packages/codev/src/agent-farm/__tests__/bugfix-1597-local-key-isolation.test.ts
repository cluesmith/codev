/**
 * Isolation canary for the user-global Agent Farm directory (#1597).
 *
 * The vitest harness (vitest-setup.ts) pins `CODEV_AGENT_FARM_DIR` into the
 * per-run sandbox so that `ensureLocalKey()` — reached by the e2e fetch patch,
 * `towerWsProtocols()`, and any suite touching core auth — never reads or
 * creates the developer's real `~/.agent-farm/local-key`. These tests prove the
 * pin is present and actually governs the key path, in the same spirit as the
 * fake-agy canary (#1323) and the isolated-Tower checks (#1515).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { AGENT_FARM_DIR } from '@cluesmith/codev-core/constants';

const REAL_AGENT_FARM_DIR = resolve(homedir(), '.agent-farm');

describe('agent-farm dir isolation (#1597)', () => {
  it('the harness pins CODEV_AGENT_FARM_DIR away from the real ~/.agent-farm', () => {
    const pinned = process.env.CODEV_AGENT_FARM_DIR;
    expect(pinned, 'vitest-setup.ts must pin CODEV_AGENT_FARM_DIR').toBeTruthy();
    expect(resolve(pinned!)).not.toBe(REAL_AGENT_FARM_DIR);
  });

  it('core resolved AGENT_FARM_DIR from the pin (module-load ordering held)', () => {
    // AGENT_FARM_DIR is a module-load const; if core was imported before the
    // harness set the env var, it silently froze on the real home path and
    // every downstream key read/write escapes the sandbox.
    expect(AGENT_FARM_DIR).toBe(resolve(process.env.CODEV_AGENT_FARM_DIR!));
    expect(AGENT_FARM_DIR).not.toBe(REAL_AGENT_FARM_DIR);
  });

  it('ensureLocalKey() creates and reads the key inside the sandbox', () => {
    const key = ensureLocalKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const sandboxKeyPath = join(AGENT_FARM_DIR, 'local-key');
    expect(existsSync(sandboxKeyPath)).toBe(true);
    expect(readFileSync(sandboxKeyPath, 'utf-8').trim()).toBe(key);

    // The real key file must not have been created by this run. If the
    // developer already has one, it must not be what the suites are using —
    // both keys are 32 random bytes, so equality means the sandbox read it.
    const realKeyPath = join(REAL_AGENT_FARM_DIR, 'local-key');
    if (existsSync(realKeyPath)) {
      expect(readFileSync(realKeyPath, 'utf-8').trim()).not.toBe(key);
    }
  });
});
