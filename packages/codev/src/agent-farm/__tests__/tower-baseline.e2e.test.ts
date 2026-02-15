/**
 * Phase 0 Baseline Tests for Tower Single Daemon Architecture (Spec 0090)
 *
 * These tests capture expected tower behavior.
 * Phase 4: Updated to test tower-only architecture (no dashboard-server).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';

// Test configuration - use high ports to avoid conflicts
const TEST_TOWER_PORT = 14100;
const STARTUP_TIMEOUT = 15_000;

// Paths to server scripts
const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

// Test workspace directory
let testWorkspacePath: string;

// Server processes
let towerProcess: ChildProcess | null = null;

/**
 * Check if a port is listening
 */
async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Wait for a port to start listening
 */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Start tower server
 */
async function startTower(port: number): Promise<ChildProcess> {
  const proc = spawn('node', [TOWER_SERVER_PATH, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, NODE_ENV: 'test', AF_TEST_DB: `test-${port}.db` },
  });

  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));

  const started = await waitForPort(port, STARTUP_TIMEOUT);
  if (!started) {
    proc.kill();
    throw new Error(`Tower failed to start on port ${port}. stderr: ${stderr}`);
  }

  return proc;
}

/**
 * Stop a server process
 */
async function stopServer(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

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
 * Encode workspace path for tower proxy URL (base64url)
 */
function encodeWorkspacePath(path: string): string {
  return Buffer.from(path).toString('base64url');
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
      const proc = await startTower(port);

      try {
        const listening = await isPortListening(port);
        expect(listening).toBe(true);
      } finally {
        await stopServer(proc);
      }
    });

    it('stops tower cleanly on SIGTERM', async () => {
      const port = 14151;
      const proc = await startTower(port);

      // Verify it's running
      expect(await isPortListening(port)).toBe(true);

      // Stop it
      await stopServer(proc);

      // Verify it stopped
      await new Promise((r) => setTimeout(r, 500));
      expect(await isPortListening(port)).toBe(false);
    });

    it('tower serves dashboard UI at root', async () => {
      const port = 14152;
      const proc = await startTower(port);

      try {
        const response = await fetch(`http://localhost:${port}/`);
        expect(response.ok).toBe(true);
        const html = await response.text();
        expect(html).toContain('Control Tower');
      } finally {
        await stopServer(proc);
      }
    });

    it('tower returns status API response', async () => {
      const port = 14153;
      const proc = await startTower(port);

      try {
        const response = await fetch(`http://localhost:${port}/api/status`);
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data).toHaveProperty('instances');
        expect(Array.isArray(data.instances)).toBe(true);
      } finally {
        await stopServer(proc);
      }
    });
  });

  describe('dashboard lifecycle', () => {
    let towerProc: ChildProcess | null = null;
    const towerPort = 14160;

    beforeAll(async () => {
      towerProc = await startTower(towerPort);
    });

    afterAll(async () => {
      await stopServer(towerProc);
      towerProc = null;
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-wal`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-shm`), { force: true }); } catch { /* ignore */ }
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
    let towerProc: ChildProcess | null = null;
    const towerPort = 14170;

    beforeAll(async () => {
      towerProc = await startTower(towerPort);
    });

    afterAll(async () => {
      await stopServer(towerProc);
      towerProc = null;
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-wal`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-shm`), { force: true }); } catch { /* ignore */ }
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
    let towerProc: ChildProcess | null = null;
    const towerPort = 14180;

    beforeAll(async () => {
      towerProc = await startTower(towerPort);
    });

    afterAll(async () => {
      await stopServer(towerProc);
      towerProc = null;
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-wal`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-shm`), { force: true }); } catch { /* ignore */ }
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
    let towerProc: ChildProcess | null = null;
    let workspace1: string;
    let workspace2: string;
    const towerPort = 14190;

    beforeAll(async () => {
      towerProc = await startTower(towerPort);
    });

    afterAll(async () => {
      await stopServer(towerProc);
      towerProc = null;
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-wal`), { force: true }); } catch { /* ignore */ }
      try { rmSync(resolve(homedir(), '.agent-farm', `test-${towerPort}.db-shm`), { force: true }); } catch { /* ignore */ }
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
