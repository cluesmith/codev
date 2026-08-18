/**
 * Regression tests for #1515 — a suite run must not be able to reach the
 * developer's real Codev Cloud state.
 *
 * Two independent holes let a test run deregister a live Tower and leave its
 * tunnel down for hours:
 *
 *   1. `AGENT_FARM_DIR` was `homedir()/.agent-farm` with no override, so a
 *      spawned test Tower read the real cloud credentials and real local key.
 *   2. Nothing stopped a test *client* from POSTing `/api/tunnel/disconnect` to
 *      the default Tower port — which is the developer's live Tower, and which
 *      `vitest-e2e-setup.ts` hands the real local key to.
 *
 * The Tower-spawning half of the fix is pinned end-to-end in
 * `bugfix-1515-test-tower-isolation.e2e.test.ts`; this file covers the units.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import {
  assertTunnelMutationAllowedUnderTest,
  cloudMutationBlocked,
  isUnderTest,
} from '../../lib/test-env.js';

/**
 * `AGENT_FARM_DIR` is a module-level constant in an externalised package, so it
 * cannot be re-evaluated under a different environment inside this process.
 * Resolve it in a child instead — which is also exactly how a spawned Tower
 * sees it.
 */
function resolveAgentFarmDirInChild(env: Record<string, string | undefined>): string {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e',
      "import { AGENT_FARM_DIR } from '@cluesmith/codev-core/constants';\nprocess.stdout.write(AGENT_FARM_DIR);"],
    { cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, ...env }, encoding: 'utf-8' },
  ).trim();
}

describe('#1515 agent-farm dir isolation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'af-1515-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AGENT_FARM_DIR honours CODEV_AGENT_FARM_DIR', () => {
    const resolved = resolveAgentFarmDirInChild({ CODEV_AGENT_FARM_DIR: tempDir });
    expect(resolved).toBe(tempDir);
    expect(resolved).not.toBe(resolve(homedir(), '.agent-farm'));
  });

  it('falls back to ~/.agent-farm when the override is unset', () => {
    const resolved = resolveAgentFarmDirInChild({ CODEV_AGENT_FARM_DIR: undefined });
    expect(resolved).toBe(resolve(homedir(), '.agent-farm'));
  });

  it('startTower points the spawned Tower at a throwaway agent-farm dir', async () => {
    const utils = await import('./helpers/tower-test-utils.js');
    const dir = utils.createIsolatedAgentFarmDir();
    try {
      expect(dir).not.toBe(resolve(homedir(), '.agent-farm'));
      // The shared local key is carried over so the test process and the child
      // agree on request auth; nothing else is.
      const { existsSync } = await import('node:fs');
      expect(existsSync(resolve(dir, 'local-key'))).toBe(true);
      expect(existsSync(resolve(dir, 'cloud-config.json'))).toBe(false);
      expect(existsSync(resolve(dir, 'global.db'))).toBe(false);
      expect(existsSync(resolve(dir, 'tower.log'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#1515 client guard on the default Tower port', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is active under the test runner', () => {
    expect(isUnderTest()).toBe(true);
    expect(cloudMutationBlocked()).toBe(true);
  });

  for (const path of ['/api/tunnel/disconnect', '/api/tunnel/connect']) {
    it(`refuses ${path} against the default port`, () => {
      expect(() => assertTunnelMutationAllowedUnderTest(path, true))
        .toThrow(/#1515/);
    });
  }

  it('allows the same paths against a test Tower port', () => {
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnel/disconnect', false))
      .not.toThrow();
  });

  it('allows reads of tunnel status on the default port', () => {
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnel/status', true))
      .not.toThrow();
  });

  it('leaves unrelated routes alone', () => {
    expect(() => assertTunnelMutationAllowedUnderTest('/api/state', true)).not.toThrow();
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnels', true)).not.toThrow();
  });

  it('also refuses the OAuth callback, which writes credentials', () => {
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnel/connect/callback?nonce=x', true))
      .toThrow(/#1515/);
  });

  it('is not fooled by a query string or trailing slash', () => {
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnel/disconnect?force=1', true))
      .toThrow(/#1515/);
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnel/disconnect/', true))
      .toThrow(/#1515/);
  });

  it('stands down for a test that explicitly opts in', () => {
    vi.stubEnv('CODEV_ALLOW_TEST_CLOUD_MUTATION', '1');
    expect(() => assertTunnelMutationAllowedUnderTest('/api/tunnel/disconnect', true))
      .not.toThrow();
  });
});

describe('#1515 the CLI TowerClient routes through the guard', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('refuses signalTunnel against the default port', async () => {
    const { TowerClient } = await import('../lib/tower-client.js');
    const client = new TowerClient();
    // signalTunnel swallows errors by design, so assert on request() directly —
    // the chokepoint the guard sits in.
    await expect(client.request('/api/tunnel/disconnect', { method: 'POST' }))
      .rejects.toThrow(/#1515/);
  });

  it('does not interfere with a client aimed at a test Tower', async () => {
    const { TowerClient } = await import('../lib/tower-client.js');
    const client = new TowerClient(14999);
    // Nothing is listening on 14999 — a connection error, not a guard throw.
    const result = await client.request('/api/tunnel/disconnect', { method: 'POST' });
    expect(result.ok).toBe(false);
  });
});
