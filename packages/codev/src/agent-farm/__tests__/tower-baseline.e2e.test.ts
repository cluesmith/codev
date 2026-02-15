/**
 * Phase 0 Baseline Tests for Tower Single Daemon Architecture (Spec 0090)
 *
 * These tests capture expected tower behavior.
 * Phase 4: Updated to test tower-only architecture (no dashboard-server).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { TowerHandle } from './helpers/tower-test-utils.js';
import {
  startTower,
  isPortListening,
  cleanupTestDb,
  encodeWorkspacePath,
} from './helpers/tower-test-utils.js';

// Test configuration - use high ports to avoid conflicts
const TEST_TOWER_PORT = 14100;

// Test workspace directory
let testWorkspacePath: string;

/**
 * Create a test workspace directory with minimal codev structure
 */
function createTestWorkspace(): string {
  // Create inside a dedicated test directory under homedir (not OS temp)
  // to avoid isTempDirectory filtering AND to avoid .builders filtering
  const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');
  mkdirSync(testBase, { recursive: true });
  const workspacePath = mkdtempSync(resolve(testBase, 'codev-baseline-test-'));

  mkdirSync(resolve(workspacePath, 'codev'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.agent-farm'), { recursive: true });

  writeFileSync(
    resolve(workspacePath, 'af-config.json'),
    JSON.stringify({
      shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' },
    })
  );

  return workspacePath;
}

/**
 * Clean up test workspace directory
 */
function cleanupTestWorkspace(workspacePath: string): void {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Activate a workspace via tower API
 */
async function activateWorkspace(towerPort: number, workspacePath: string): Promise<boolean> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/api/workspaces/${encodedPath}/activate`,
    { method: 'POST' }
  );
  return response.ok;
}

/**
 * Deactivate a workspace via tower API
 */
async function deactivateWorkspace(towerPort: number, workspacePath: string): Promise<boolean> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/api/workspaces/${encodedPath}/deactivate`,
    { method: 'POST' }
  );
  return response.ok;
}

// ============================================================================
// BASELINE TESTS - Tower-Only Architecture (Phase 4)
// ============================================================================

describe('Tower Baseline - Current Behavior (Phase 0)', () => {
  describe('tower lifecycle', () => {
    it('starts tower on specified port', async () => {
      const port = 14150;
      const handle = await startTower(port);

      try {
        const listening = await isPortListening(port);
        expect(listening).toBe(true);
      } finally {
        await handle.stop();
      }
    });

    it('stops tower cleanly on SIGTERM', async () => {
      const port = 14151;
      const handle = await startTower(port);

      // Verify it's running
      expect(await isPortListening(port)).toBe(true);

      // Stop it
      await handle.stop();

      // Verify it stopped
      await new Promise((r) => setTimeout(r, 500));
      expect(await isPortListening(port)).toBe(false);
    });

    it('tower serves dashboard UI at root', async () => {
      const port = 14152;
      const handle = await startTower(port);

      try {
        const response = await fetch(`http://localhost:${port}/`);
        expect(response.ok).toBe(true);
        const html = await response.text();
        expect(html).toContain('Control Tower');
      } finally {
        await handle.stop();
      }
    });

    it('tower returns status API response', async () => {
      const port = 14153;
      const handle = await startTower(port);

      try {
        const response = await fetch(`http://localhost:${port}/api/status`);
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data).toHaveProperty('instances');
        expect(Array.isArray(data.instances)).toBe(true);
      } finally {
        await handle.stop();
      }
    });
  });

  describe('dashboard lifecycle', () => {
    let tower: TowerHandle;
    const towerPort = 14160;

    beforeAll(async () => {
      tower = await startTower(towerPort);
    });

    afterAll(async () => {
      await tower.stop();
      cleanupTestDb(towerPort);
    });

    beforeEach(() => {
      testWorkspacePath = createTestWorkspace();
    });

    afterEach(async () => {
      // Deactivate workspace to clean up terminals
      await deactivateWorkspace(towerPort, testWorkspacePath);
      cleanupTestWorkspace(testWorkspacePath);
    });

    it('starts dashboard on specified port', async () => {
      // Phase 4: Workspace activation happens through tower
      // Activation may fail to create architect terminal (e.g., bash not available as expected)
      // but the workspace should still be accessible via state API
      await activateWorkspace(towerPort, testWorkspacePath);

      // Verify workspace state is accessible (this is the real indicator of success)
      const encodedPath = encodeWorkspacePath(testWorkspacePath);
      const response = await fetch(`http://localhost:${towerPort}/workspace/${encodedPath}/api/state`);
      expect(response.ok).toBe(true);
    });

    it('dashboard serves state API', async () => {
      // Activate workspace first
      await activateWorkspace(towerPort, testWorkspacePath);

      // Access state via tower's workspace API
      const encodedPath = encodeWorkspacePath(testWorkspacePath);
      const response = await fetch(`http://localhost:${towerPort}/workspace/${encodedPath}/api/state`);
      expect(response.ok).toBe(true);
      const state = await response.json();
      expect(state).toBeDefined();
      expect(state).toHaveProperty('architect');
    });

    // Spec 0100: /api/state includes gateStatus field
    it('/api/state includes gateStatus field', async () => {
      await activateWorkspace(towerPort, testWorkspacePath);
      const encodedPath = encodeWorkspacePath(testWorkspacePath);
      const response = await fetch(`http://localhost:${towerPort}/workspace/${encodedPath}/api/state`);
      expect(response.ok).toBe(true);
      const state = await response.json();
      expect(state).toHaveProperty('gateStatus');
      expect(state.gateStatus).toHaveProperty('hasGate');
      // No pending gates in test workspace, so hasGate should be false
      expect(state.gateStatus.hasGate).toBe(false);
    });

    it('dashboard serves React or legacy UI', async () => {
      // Activate workspace first
      await activateWorkspace(towerPort, testWorkspacePath);

      // Access dashboard via tower
      const encodedPath = encodeWorkspacePath(testWorkspacePath);
      const response = await fetch(`http://localhost:${towerPort}/workspace/${encodedPath}/`);
      expect(response.ok).toBe(true);

      const html = await response.text();
      // Should serve React dashboard
      expect(html.length).toBeGreaterThan(100);
    });
  });

  describe('state consistency', () => {
    let tower: TowerHandle;
    const towerPort = 14170;

    beforeAll(async () => {
      tower = await startTower(towerPort);
    });

    afterAll(async () => {
      await tower.stop();
      cleanupTestDb(towerPort);
    });

    beforeEach(() => {
      testWorkspacePath = createTestWorkspace();
    });

    afterEach(async () => {
      await deactivateWorkspace(towerPort, testWorkspacePath);
      cleanupTestWorkspace(testWorkspacePath);
    });

    it('dashboard state API returns consistent results', async () => {
      // Activate workspace
      await activateWorkspace(towerPort, testWorkspacePath);

      const encodedPath = encodeWorkspacePath(testWorkspacePath);

      // Get state multiple times - should be consistent
      const [res1, res2] = await Promise.all([
        fetch(`http://localhost:${towerPort}/workspace/${encodedPath}/api/state`),
        fetch(`http://localhost:${towerPort}/workspace/${encodedPath}/api/state`),
      ]);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);

      const state1 = await res1.json();
      const state2 = await res2.json();

      // States should be structurally equal
      expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
    });
  });

  describe('tower proxy', () => {
    let tower: TowerHandle;
    const towerPort = 14180;

    beforeAll(async () => {
      tower = await startTower(towerPort);
    });

    afterAll(async () => {
      await tower.stop();
      cleanupTestDb(towerPort);
    });

    beforeEach(() => {
      testWorkspacePath = createTestWorkspace();
    });

    afterEach(async () => {
      await deactivateWorkspace(towerPort, testWorkspacePath);
      cleanupTestWorkspace(testWorkspacePath);
    });

    it('tower proxies requests to dashboard', async () => {
      // Phase 4: Tower handles everything directly, no proxying
      // This test verifies workspace appears in tower status after activation

      // Activate workspace
      await activateWorkspace(towerPort, testWorkspacePath);

      // Poll for workspace to appear in tower status
      // CI runners can be slow — allow up to 60s (120 × 500ms)
      let status: any;
      for (let i = 0; i < 120; i++) {
        const statusRes = await fetch(`http://localhost:${towerPort}/api/status`);
        status = await statusRes.json();
        if (status.instances?.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // Workspace should appear in instances
      expect(status.instances).toBeDefined();
      expect(status.instances.length).toBeGreaterThan(0);
    });

    it('encodes workspace paths correctly for proxy URLs', () => {
      const testPath = '/Users/test/my-workspace';
      const encoded = encodeWorkspacePath(testPath);

      // Should not contain URL-unsafe characters
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('+');

      // Should decode back correctly
      const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
      expect(decoded).toBe(testPath);
    });
  });

  describe('multi-workspace support', () => {
    let tower: TowerHandle;
    let workspace1: string;
    let workspace2: string;
    const towerPort = 14190;

    beforeAll(async () => {
      tower = await startTower(towerPort);
    });

    afterAll(async () => {
      await tower.stop();
      cleanupTestDb(towerPort);
    });

    beforeEach(() => {
      workspace1 = createTestWorkspace();
      workspace2 = createTestWorkspace();
    });

    afterEach(async () => {
      await Promise.all([
        deactivateWorkspace(towerPort, workspace1),
        deactivateWorkspace(towerPort, workspace2),
      ]);
      cleanupTestWorkspace(workspace1);
      cleanupTestWorkspace(workspace2);
    });

    it('multiple dashboards can run on different ports', async () => {
      // Phase 4: Tower manages all workspaces, no separate ports needed
      // This test verifies multiple workspaces can be activated

      await activateWorkspace(towerPort, workspace1);
      await activateWorkspace(towerPort, workspace2);

      // Both should respond to state API
      const [res1, res2] = await Promise.all([
        fetch(`http://localhost:${towerPort}/workspace/${encodeWorkspacePath(workspace1)}/api/state`),
        fetch(`http://localhost:${towerPort}/workspace/${encodeWorkspacePath(workspace2)}/api/state`),
      ]);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
    });

    it('stopping one dashboard does not affect others', async () => {
      // Activate both workspaces
      await activateWorkspace(towerPort, workspace1);
      await activateWorkspace(towerPort, workspace2);

      // Deactivate first workspace
      await deactivateWorkspace(towerPort, workspace1);

      // Second should still be accessible
      const res1 = await fetch(`http://localhost:${towerPort}/workspace/${encodeWorkspacePath(workspace1)}/api/state`);
      const res2 = await fetch(`http://localhost:${towerPort}/workspace/${encodeWorkspacePath(workspace2)}/api/state`);

      // First workspace's state should still return (structure exists, but no architect)
      expect(res1.ok).toBe(true);
      const state1 = await res1.json();
      expect(state1.architect).toBeNull();

      // Second workspace should still have its state
      expect(res2.ok).toBe(true);
    });
  });
});
