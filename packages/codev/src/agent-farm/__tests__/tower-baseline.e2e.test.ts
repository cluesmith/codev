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
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';

// Test configuration - use high ports to avoid conflicts
const TEST_TOWER_PORT = 14100;
const STARTUP_TIMEOUT = 15_000;

// Paths to server scripts
const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

// Test project directory
let testProjectPath: string;

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
 * Create a test project directory with minimal codev structure
 */
function createTestProject(): string {
  const projectPath = mkdtempSync(resolve(tmpdir(), 'codev-baseline-test-'));

  mkdirSync(resolve(projectPath, 'codev'), { recursive: true });
  mkdirSync(resolve(projectPath, '.agent-farm'), { recursive: true });

  writeFileSync(
    resolve(projectPath, 'af-config.json'),
    JSON.stringify({
      shell: { architect: 'bash', builder: 'bash', shell: 'bash' },
    })
  );

  return projectPath;
}

/**
 * Clean up test project directory
 */
function cleanupTestProject(projectPath: string): void {
  try {
    rmSync(projectPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Encode project path for tower proxy URL (base64url)
 */
function encodeProjectPath(path: string): string {
  return Buffer.from(path).toString('base64url');
}

/**
 * Activate a project via tower API
 */
async function activateProject(towerPort: number, projectPath: string): Promise<boolean> {
  const encodedPath = encodeProjectPath(projectPath);
  const response = await fetch(
    `http://localhost:${towerPort}/api/projects/${encodedPath}/activate`,
    { method: 'POST' }
  );
  return response.ok;
}

/**
 * Deactivate a project via tower API
 */
async function deactivateProject(towerPort: number, projectPath: string): Promise<boolean> {
  const encodedPath = encodeProjectPath(projectPath);
  const response = await fetch(
    `http://localhost:${towerPort}/api/projects/${encodedPath}/deactivate`,
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
      testProjectPath = createTestProject();
    });

    afterEach(async () => {
      // Deactivate project to clean up terminals
      await deactivateProject(towerPort, testProjectPath);
      cleanupTestProject(testProjectPath);
    });

    it('starts dashboard on specified port', async () => {
      // Phase 4: Project activation happens through tower
      // Activation may fail to create architect terminal (e.g., bash not available as expected)
      // but the project should still be accessible via state API
      await activateProject(towerPort, testProjectPath);

      // Verify project state is accessible (this is the real indicator of success)
      const encodedPath = encodeProjectPath(testProjectPath);
      const response = await fetch(`http://localhost:${towerPort}/project/${encodedPath}/api/state`);
      expect(response.ok).toBe(true);
    });

    it('dashboard serves state API', async () => {
      // Activate project first
      await activateProject(towerPort, testProjectPath);

      // Access state via tower's project API
      const encodedPath = encodeProjectPath(testProjectPath);
      const response = await fetch(`http://localhost:${towerPort}/project/${encodedPath}/api/state`);
      expect(response.ok).toBe(true);
      const state = await response.json();
      expect(state).toBeDefined();
      expect(state).toHaveProperty('architect');
    });

    it('dashboard serves React or legacy UI', async () => {
      // Activate project first
      await activateProject(towerPort, testProjectPath);

      // Access dashboard via tower
      const encodedPath = encodeProjectPath(testProjectPath);
      const response = await fetch(`http://localhost:${towerPort}/project/${encodedPath}/`);
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
      testProjectPath = createTestProject();
    });

    afterEach(async () => {
      await deactivateProject(towerPort, testProjectPath);
      cleanupTestProject(testProjectPath);
    });

    it('dashboard state API returns consistent results', async () => {
      // Activate project
      await activateProject(towerPort, testProjectPath);

      const encodedPath = encodeProjectPath(testProjectPath);

      // Get state multiple times - should be consistent
      const [res1, res2] = await Promise.all([
        fetch(`http://localhost:${towerPort}/project/${encodedPath}/api/state`),
        fetch(`http://localhost:${towerPort}/project/${encodedPath}/api/state`),
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
      testProjectPath = createTestProject();
    });

    afterEach(async () => {
      await deactivateProject(towerPort, testProjectPath);
      cleanupTestProject(testProjectPath);
    });

    it('tower proxies requests to dashboard', async () => {
      // Phase 4: Tower handles everything directly, no proxying
      // This test verifies project appears in tower status after activation

      // Activate project
      await activateProject(towerPort, testProjectPath);

      // Poll for project to appear in tower status
      let status: any;
      for (let i = 0; i < 20; i++) {
        const statusRes = await fetch(`http://localhost:${towerPort}/api/status`);
        status = await statusRes.json();
        if (status.instances?.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      // Project should appear in instances
      expect(status.instances).toBeDefined();
      expect(status.instances.length).toBeGreaterThan(0);
    });

    it('encodes project paths correctly for proxy URLs', () => {
      const testPath = '/Users/test/my-project';
      const encoded = encodeProjectPath(testPath);

      // Should not contain URL-unsafe characters
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('+');

      // Should decode back correctly
      const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
      expect(decoded).toBe(testPath);
    });
  });

  describe('multi-project support', () => {
    let towerProc: ChildProcess | null = null;
    let project1: string;
    let project2: string;
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
      project1 = createTestProject();
      project2 = createTestProject();
    });

    afterEach(async () => {
      await Promise.all([
        deactivateProject(towerPort, project1),
        deactivateProject(towerPort, project2),
      ]);
      cleanupTestProject(project1);
      cleanupTestProject(project2);
    });

    it('multiple dashboards can run on different ports', async () => {
      // Phase 4: Tower manages all projects, no separate ports needed
      // This test verifies multiple projects can be activated

      await activateProject(towerPort, project1);
      await activateProject(towerPort, project2);

      // Both should respond to state API
      const [res1, res2] = await Promise.all([
        fetch(`http://localhost:${towerPort}/project/${encodeProjectPath(project1)}/api/state`),
        fetch(`http://localhost:${towerPort}/project/${encodeProjectPath(project2)}/api/state`),
      ]);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
    });

    it('stopping one dashboard does not affect others', async () => {
      // Activate both projects
      await activateProject(towerPort, project1);
      await activateProject(towerPort, project2);

      // Deactivate first project
      await deactivateProject(towerPort, project1);

      // Second should still be accessible
      const res1 = await fetch(`http://localhost:${towerPort}/project/${encodeProjectPath(project1)}/api/state`);
      const res2 = await fetch(`http://localhost:${towerPort}/project/${encodeProjectPath(project2)}/api/state`);

      // First project's state should still return (structure exists, but no architect)
      expect(res1.ok).toBe(true);
      const state1 = await res1.json();
      expect(state1.architect).toBeNull();

      // Second project should still have its state
      expect(res2.ok).toBe(true);
    });
  });
});
