/**
 * Bugfix #202: Tower shows E2E test temp directories as Recent Projects
 *
 * After running Playwright E2E tests, temp directories created by tests
 * appeared in the Tower UI under "Recent Projects". The root cause was that
 * test cleanup didn't reliably remove temp dirs from disk, and the original
 * existsSync check only filtered deleted directories.
 *
 * This test verifies that:
 * 1. GET /api/projects filters out projects whose directories no longer exist
 * 2. GET /api/status filters out projects in temp directories even if they still exist
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';

const TEST_TOWER_PORT = 14600;
const STARTUP_TIMEOUT = 15_000;

const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

let towerProcess: ChildProcess | null = null;

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

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

async function stopServer(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000);
  });
}

function toBase64URL(str: string): string {
  return Buffer.from(str).toString('base64url');
}

describe('Bugfix #202: Stale temp project directories filtered from project list', () => {
  beforeAll(async () => {
    towerProcess = await startTower(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    await stopServer(towerProcess);
    towerProcess = null;
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-wal`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-shm`), { force: true }); } catch { /* ignore */ }
  });

  it('does not list projects whose directories have been deleted', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;

    // Step 1: Create a temp project directory (simulating what E2E tests do)
    // Use realpathSync to resolve macOS symlinks (/var → /private/var) to match
    // the tower's normalizeProjectPath behavior
    const tempProjectDir = realpathSync(mkdtempSync(resolve(tmpdir(), 'bugfix-202-')));
    mkdirSync(resolve(tempProjectDir, 'codev'), { recursive: true });
    writeFileSync(
      resolve(tempProjectDir, 'af-config.json'),
      JSON.stringify({ shell: { architect: 'bash', builder: 'bash', shell: 'bash' } })
    );

    const encodedPath = toBase64URL(tempProjectDir);

    // Step 2: Activate the project (registers in tower's terminal_sessions)
    const activateRes = await fetch(`${base}/api/projects/${encodedPath}/activate`, {
      method: 'POST',
    });
    expect(activateRes.ok).toBe(true);

    // Step 3: Verify it appears in the project list while the directory exists
    const listRes1 = await fetch(`${base}/api/projects`);
    expect(listRes1.ok).toBe(true);
    const data1 = await listRes1.json();
    const found1 = data1.projects.find((p: { path: string }) => p.path === tempProjectDir);
    expect(found1).toBeDefined();

    // Step 4: Deactivate the project (stops terminals)
    await fetch(`${base}/api/projects/${encodedPath}/deactivate`, { method: 'POST' });

    // Step 5: Kill tmux session and delete the temp directory from disk (simulating E2E test teardown)
    try { execSync(`tmux kill-session -t "architect-${basename(tempProjectDir)}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ignore */ }
    rmSync(tempProjectDir, { recursive: true, force: true });

    // Step 6: Verify it NO LONGER appears in the project list
    const listRes2 = await fetch(`${base}/api/projects`);
    expect(listRes2.ok).toBe(true);
    const data2 = await listRes2.json();
    const found2 = data2.projects.find((p: { path: string }) => p.path === tempProjectDir);
    expect(found2).toBeUndefined();

  });

  it('filters temp directory projects from /api/status even when directory still exists', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;

    // Create a temp project that will NOT be deleted (the actual bug scenario)
    const tempProjectDir = realpathSync(mkdtempSync(resolve(tmpdir(), 'bugfix-202-exists-')));
    mkdirSync(resolve(tempProjectDir, 'codev'), { recursive: true });
    writeFileSync(
      resolve(tempProjectDir, 'af-config.json'),
      JSON.stringify({ shell: { architect: 'bash', builder: 'bash', shell: 'bash' } })
    );

    const encodedPath = toBase64URL(tempProjectDir);

    try {
      // Activate the project
      const activateRes = await fetch(`${base}/api/projects/${encodedPath}/activate`, {
        method: 'POST',
      });
      expect(activateRes.ok).toBe(true);

      // Deactivate so it becomes a "recent" project
      await fetch(`${base}/api/projects/${encodedPath}/deactivate`, { method: 'POST' });

      // The directory still exists, but /api/status should filter it out
      const statusRes = await fetch(`${base}/api/status`);
      expect(statusRes.ok).toBe(true);
      const statusData = await statusRes.json();
      const found = statusData.instances.find(
        (i: { projectPath: string }) => i.projectPath === tempProjectDir
      );
      expect(found).toBeUndefined();
    } finally {
      try { execSync(`tmux kill-session -t "architect-${basename(tempProjectDir)}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ignore */ }
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });
});
