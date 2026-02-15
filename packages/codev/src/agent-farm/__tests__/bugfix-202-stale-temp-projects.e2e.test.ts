/**
 * Bugfix #202: Tower shows E2E test temp directories as Recent Workspaces
 *
 * After running Playwright E2E tests, temp directories created by tests
 * appeared in the Tower UI under "Recent Workspaces". The root cause was that
 * test cleanup didn't reliably remove temp dirs from disk, and the original
 * existsSync check only filtered deleted directories.
 *
 * This test verifies that:
 * 1. GET /api/workspaces filters out workspaces whose directories no longer exist
 * 2. GET /api/status filters out workspaces in temp directories even if they still exist
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import type { TowerHandle } from './helpers/tower-test-utils.js';
import {
  startTower,
  cleanupAllTerminals,
  cleanupTestDb,
  encodeWorkspacePath,
} from './helpers/tower-test-utils.js';

const TEST_TOWER_PORT = 14600;

let tower: TowerHandle;

describe('Bugfix #202: Stale temp workspace directories filtered from workspace list', () => {
  beforeAll(async () => {
    tower = await startTower(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    // Defensive workspace deactivation + terminal cleanup (failure-safe)
    await cleanupAllTerminals(TEST_TOWER_PORT);
    await tower.stop();
    cleanupTestDb(TEST_TOWER_PORT);
  });

  it('does not list workspaces whose directories have been deleted', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;

    // Step 1: Create a workspace directory OUTSIDE OS temp (to avoid isTempDirectory filtering)
    // This test verifies the "deleted directory" filter, not the temp directory filter.
    const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');
    mkdirSync(testBase, { recursive: true });
    const tempProjectDir = realpathSync(mkdtempSync(resolve(testBase, 'bugfix-202-')));
    mkdirSync(resolve(tempProjectDir, 'codev'), { recursive: true });
    writeFileSync(
      resolve(tempProjectDir, 'af-config.json'),
      JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } })
    );

    const encodedPath = encodeWorkspacePath(tempProjectDir);

    // Step 2: Activate the workspace (registers in tower's terminal_sessions)
    const activateRes = await fetch(`${base}/api/workspaces/${encodedPath}/activate`, {
      method: 'POST',
    });
    expect(activateRes.ok).toBe(true);

    // Step 3: Poll for workspace to appear in the workspace list
    // CI runners can be slow — allow up to 60s (120 × 500ms)
    let found1: any;
    for (let i = 0; i < 120; i++) {
      const listRes1 = await fetch(`${base}/api/workspaces`);
      expect(listRes1.ok).toBe(true);
      const data1 = await listRes1.json();
      found1 = data1.workspaces.find((p: { path: string }) => p.path === tempProjectDir);
      if (found1) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(found1).toBeDefined();

    // Step 4: Deactivate the workspace (stops terminals)
    await fetch(`${base}/api/workspaces/${encodedPath}/deactivate`, { method: 'POST' });

    // Step 5: Delete the temp directory from disk (simulating E2E test teardown)
    rmSync(tempProjectDir, { recursive: true, force: true });

    // Step 6: Verify it NO LONGER appears in the workspace list
    const listRes2 = await fetch(`${base}/api/workspaces`);
    expect(listRes2.ok).toBe(true);
    const data2 = await listRes2.json();
    const found2 = data2.workspaces.find((p: { path: string }) => p.path === tempProjectDir);
    expect(found2).toBeUndefined();

  });

  it('filters temp directory workspaces from /api/status even when directory still exists', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;

    // Create a temp workspace that will NOT be deleted (the actual bug scenario)
    const tempProjectDir = realpathSync(mkdtempSync(resolve(tmpdir(), 'bugfix-202-exists-')));
    mkdirSync(resolve(tempProjectDir, 'codev'), { recursive: true });
    writeFileSync(
      resolve(tempProjectDir, 'af-config.json'),
      JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } })
    );

    const encodedPath = encodeWorkspacePath(tempProjectDir);

    try {
      // Activate the workspace
      const activateRes = await fetch(`${base}/api/workspaces/${encodedPath}/activate`, {
        method: 'POST',
      });
      expect(activateRes.ok).toBe(true);

      // Deactivate so it becomes a "recent" workspace
      await fetch(`${base}/api/workspaces/${encodedPath}/deactivate`, { method: 'POST' });

      // The directory still exists, but /api/status should filter it out
      const statusRes = await fetch(`${base}/api/status`);
      expect(statusRes.ok).toBe(true);
      const statusData = await statusRes.json();
      const found = statusData.instances.find(
        (i: { workspacePath: string }) => i.workspacePath === tempProjectDir
      );
      expect(found).toBeUndefined();
    } finally {
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });
});
