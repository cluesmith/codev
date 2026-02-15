/**
 * Phase 1 API Tests for Tower Single Daemon Architecture (Spec 0090)
 *
 * Tests for the new tower APIs:
 * - GET /health
 * - GET /api/workspaces
 * - POST /api/workspaces/:encodedPath/activate
 * - POST /api/workspaces/:encodedPath/deactivate
 * - GET /api/workspaces/:encodedPath/status
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';

// Test configuration
const TEST_TOWER_PORT = 14300;
const STARTUP_TIMEOUT = 15_000;

// Paths to server scripts
const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

// Server process
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
 * Encode workspace path to base64url
 */
function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64url');
}

/**
 * Create a test workspace directory
 */
function createTestWorkspace(): string {
  // Create inside a dedicated test directory under homedir (not OS temp)
  // to avoid isTempDirectory filtering AND to avoid .builders filtering
  // when running tests inside a builder workspace.
  const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');
  mkdirSync(testBase, { recursive: true });
  const workspacePath = mkdtempSync(resolve(testBase, 'codev-api-test-'));
  mkdirSync(resolve(workspacePath, 'codev'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.agent-farm'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, 'af-config.json'),
    JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } })
  );
  return workspacePath;
}

/**
 * Clean up test workspace
 */
function cleanupTestWorkspace(workspacePath: string): void {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// PHASE 1 API TESTS
// ============================================================================

describe('Tower API (Phase 1)', () => {
  beforeAll(async () => {
    towerProcess = await startTower(TEST_TOWER_PORT);
  });

  afterAll(async () => {
    await stopServer(towerProcess);
    towerProcess = null;
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-wal`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-shm`), { force: true }); } catch { /* ignore */ }
  });

  describe('GET /health', () => {
    it('returns 200 with health metrics', async () => {
      const response = await fetch(`http://localhost:${TEST_TOWER_PORT}/health`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(typeof data.uptime).toBe('number');
      expect(typeof data.activeWorkspaces).toBe('number');
      expect(typeof data.totalWorkspaces).toBe('number');
      expect(typeof data.memoryUsage).toBe('number');
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('GET /api/workspaces', () => {
    it('returns list of workspaces', async () => {
      const response = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/workspaces`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.workspaces).toBeDefined();
      expect(Array.isArray(data.workspaces)).toBe(true);
    });
  });

  describe('GET /api/workspaces/:encodedPath/status', () => {
    it('returns 404 for non-existent workspace', async () => {
      const fakePath = '/nonexistent/workspace/path';
      const encoded = encodeWorkspacePath(fakePath);

      const response = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/status`
      );
      expect(response.status).toBe(404);
    });

    it('returns 400 for invalid encoding', async () => {
      const response = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/invalid!!!encoding/status`
      );
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/workspaces/:encodedPath/activate', () => {
    let testWorkspace: string;

    beforeEach(() => {
      testWorkspace = createTestWorkspace();
    });

    afterEach(() => {
      cleanupTestWorkspace(testWorkspace);
    });

    it('returns 400 for non-existent path', async () => {
      const fakePath = '/nonexistent/path/to/workspace';
      const encoded = encodeWorkspacePath(fakePath);

      const response = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/activate`,
        { method: 'POST' }
      );
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });

  describe('POST /api/workspaces/:encodedPath/deactivate', () => {
    it('returns 404 for non-existent workspace', async () => {
      const fakePath = '/nonexistent/workspace/path';
      const encoded = encodeWorkspacePath(fakePath);

      const response = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/deactivate`,
        { method: 'POST' }
      );
      expect(response.status).toBe(404);
    });
  });

  describe('Static file serving', () => {
    it('serves content at /workspace/:encodedPath/', async () => {
      const workspacePath = resolve(import.meta.dirname, '../../../../../');
      const encoded = encodeWorkspacePath(workspacePath);

      const response = await fetch(`http://localhost:${TEST_TOWER_PORT}/workspace/${encoded}/`);
      expect(response.ok).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('handles rapid requests gracefully', async () => {
      const requests = Array.from({ length: 10 }, () =>
        fetch(`http://localhost:${TEST_TOWER_PORT}/health`)
      );

      const responses = await Promise.all(requests);
      for (const response of responses) {
        expect(response.ok).toBe(true);
      }
    });
  });

  // SQLite tests MUST run before rate limiting tests (which exhaust the rate limit)
  describe('SQLite authoritative terminal storage', () => {
    let testWorkspaceDir: string;
    let encodedPath: string;

    beforeEach(() => {
      // Create test workspace inside a dedicated test directory under homedir
      const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');
      mkdirSync(testBase, { recursive: true });
      testWorkspaceDir = mkdtempSync(resolve(testBase, 'tower-sqlite-test-'));
      mkdirSync(resolve(testWorkspaceDir, 'codev'), { recursive: true });
      writeFileSync(resolve(testWorkspaceDir, 'af-config.json'), JSON.stringify({
        shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' }
      }));
      encodedPath = encodeWorkspacePath(testWorkspaceDir);
    });

    afterEach(() => {
      // Cleanup
      rmSync(testWorkspaceDir, { recursive: true, force: true });
    });

    it('saves terminal session to SQLite on activate', async () => {
      // Activate workspace - this allocates a port and creates terminals
      const activateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encodedPath}/activate`,
        { method: 'POST' }
      );
      expect(activateRes.ok).toBe(true);
      const activateData = await activateRes.json();
      expect(activateData.success).toBe(true);

      // Poll for workspace to appear in the workspaces list with terminals
      // CI runners can be slow — allow up to 60s (120 × 500ms)
      let workspace: any;
      for (let i = 0; i < 120; i++) {
        const listRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/workspaces`);
        expect(listRes.ok).toBe(true);
        const listData = await listRes.json();
        workspace = listData.workspaces.find((p: { path: string }) =>
          p.path === testWorkspaceDir || p.path.includes('tower-sqlite-test')
        );
        if (workspace?.terminals > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(workspace).toBeDefined();
      expect(workspace.terminals).toBeGreaterThan(0);

      // Cleanup: deactivate
      await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encodedPath}/deactivate`,
        { method: 'POST' }
      );
    });

    it('clears terminal sessions from SQLite on deactivate', async () => {
      // Activate workspace first
      const activateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encodedPath}/activate`,
        { method: 'POST' }
      );
      expect(activateRes.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 1000));

      // Deactivate workspace
      const deactivateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encodedPath}/deactivate`,
        { method: 'POST' }
      );
      expect(deactivateRes.ok).toBe(true);

      // Verify workspace now shows 0 terminals in the workspaces list
      const listRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/workspaces`);
      expect(listRes.ok).toBe(true);
      const listData = await listRes.json();
      const workspace = listData.workspaces.find((p: { path: string }) =>
        p.path === testWorkspaceDir || p.path.includes('tower-sqlite-test')
      );
      // Workspace may still be listed (port allocated) but with 0 terminals
      if (workspace) {
        expect(workspace.terminals).toBe(0);
      }
    });
  });

  // Issue #187: POST /api/terminals with workspace association registers terminal in workspace state
  describe('POST /api/terminals with workspace registration', () => {
    let testWorkspaceDir: string;
    let encodedPath: string;

    beforeEach(async () => {
      testWorkspaceDir = createTestWorkspace();
      encodedPath = encodeWorkspacePath(testWorkspaceDir);

      // Activate the workspace so it has an entry in workspaceTerminals
      const activateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encodedPath}/activate`,
        { method: 'POST' }
      );
      expect(activateRes.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 1000));
    });

    afterEach(async () => {
      // Deactivate and clean up
      await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encodedPath}/deactivate`,
        { method: 'POST' }
      );
      cleanupTestWorkspace(testWorkspaceDir);
    });

    it('registers builder terminal in workspace state when workspacePath/type/roleId provided', async () => {
      // Create a terminal with workspace association fields
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/echo',
          args: ['hello'],
          cwd: testWorkspaceDir,
          cols: 80,
          rows: 24,
          workspacePath: testWorkspaceDir,
          type: 'builder',
          roleId: 'builder-test-1',
        }),
      });
      expect(createRes.status).toBe(201);
      const createData = await createRes.json();
      expect(createData.id).toBeDefined();

      // Query workspace state and verify the builder appears
      const stateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/workspace/${encodedPath}/api/state`
      );
      expect(stateRes.ok).toBe(true);
      const state = await stateRes.json();

      const builder = state.builders.find((b: { id: string }) => b.id === 'builder-test-1');
      expect(builder).toBeDefined();
      expect(builder.terminalId).toBe(createData.id);
    });

    it('registers shell terminal in workspace state when type is shell', async () => {
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/echo',
          args: ['hello'],
          cwd: testWorkspaceDir,
          cols: 80,
          rows: 24,
          workspacePath: testWorkspaceDir,
          type: 'shell',
          roleId: 'shell-test-1',
        }),
      });
      expect(createRes.status).toBe(201);
      const createData = await createRes.json();

      const stateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/workspace/${encodedPath}/api/state`
      );
      expect(stateRes.ok).toBe(true);
      const state = await stateRes.json();

      const shell = state.utils.find((u: { id: string }) => u.id === 'shell-test-1');
      expect(shell).toBeDefined();
      expect(shell.terminalId).toBe(createData.id);
    });

    it('does not register terminal when workspace fields are missing', async () => {
      // Create terminal WITHOUT workspace association fields
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/echo',
          args: ['hello'],
          cwd: testWorkspaceDir,
          cols: 80,
          rows: 24,
        }),
      });
      expect(createRes.status).toBe(201);
      const createData = await createRes.json();

      // Query workspace state - the terminal should NOT appear as a builder or shell
      const stateRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/workspace/${encodedPath}/api/state`
      );
      expect(stateRes.ok).toBe(true);
      const state = await stateRes.json();

      const hasTerminal = [
        ...state.builders.map((b: { terminalId: string }) => b.terminalId),
        ...state.utils.map((u: { terminalId: string }) => u.terminalId),
      ].includes(createData.id);
      expect(hasTerminal).toBe(false);
    });
  });

  describe('Rate limiting', () => {
    // Note: Rate limiting is per-client IP. In tests, all requests come from 127.0.0.1
    // so they share a rate limit bucket. Previous tests may have consumed some activations.

    it('returns 429 after exceeding 10 activations per minute', async () => {
      // Make 15 activation requests in quick succession
      // Some may already be consumed by previous tests, so we check:
      // 1. At least some requests return 400 (not 429) - the rate limit is working
      // 2. Eventually we get 429 responses - the limit kicks in
      // 3. We get at least 3 rate-limited (429) responses

      const fakePaths = Array.from({ length: 15 }, (_, i) => `/nonexistent/rate-limit-test-${i}`);
      const responses: number[] = [];

      for (const fakePath of fakePaths) {
        const encoded = encodeWorkspacePath(fakePath);
        const response = await fetch(
          `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/activate`,
          { method: 'POST' }
        );
        responses.push(response.status);
      }

      // Count how many were allowed (400 = path doesn't exist but request allowed)
      const allowedCount = responses.filter((s) => s === 400).length;
      // Count how many were rate limited (429)
      const rateLimitedCount = responses.filter((s) => s === 429).length;

      // We should have some allowed requests (at least a few of the 10 allowed per minute)
      expect(allowedCount).toBeGreaterThan(0);
      // We should hit the rate limit eventually
      expect(rateLimitedCount).toBeGreaterThanOrEqual(3);
      // Total should add up
      expect(allowedCount + rateLimitedCount).toBe(15);
    });

    it('does not rate-limit deactivation', async () => {
      // Make 15 deactivation requests - none should return 429
      const fakePaths = Array.from({ length: 15 }, (_, i) => `/nonexistent/deactivate-test-${i}`);

      for (const fakePath of fakePaths) {
        const encoded = encodeWorkspacePath(fakePath);
        const response = await fetch(
          `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/deactivate`,
          { method: 'POST' }
        );
        // Should be 404 (workspace not found), not 429
        expect(response.status).toBe(404);
      }
    });

    it('does not rate-limit status queries', async () => {
      // Make 15 status requests - none should return 429
      const fakePaths = Array.from({ length: 15 }, (_, i) => `/nonexistent/status-test-${i}`);

      for (const fakePath of fakePaths) {
        const encoded = encodeWorkspacePath(fakePath);
        const response = await fetch(
          `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/status`
        );
        // Should be 404 (workspace not found), not 429
        expect(response.status).toBe(404);
      }
    });
  });
});
