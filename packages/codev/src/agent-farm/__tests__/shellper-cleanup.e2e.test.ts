/**
 * Spec 0116: Shellper Resource Leakage - E2E Tests
 *
 * Phase 3 deliverables:
 * - Tower periodic cleanup timer fires and removes stale sockets during runtime
 * - Tower graceful shutdown completes without hanging (validates clearInterval)
 * - Full lifecycle creates no orphans
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import type { TowerHandle } from './helpers/tower-test-utils.js';
import {
  startTower,
  cleanupAllTerminals,
  cleanupTestDb,
} from './helpers/tower-test-utils.js';

// Use a short cleanup interval for testing (2 seconds)
const CLEANUP_INTERVAL_MS = '2000';
const TEST_TOWER_PORT = 14700;

let tower: TowerHandle;

/**
 * Wait for Tower's shellper manager to be fully initialized.
 * The listen callback runs async after the port opens, so we need
 * to poll until persistent terminals can be created.
 */
async function waitForShellperReady(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/echo', args: ['ready-probe'], cwd: '/tmp',
          label: 'readiness-probe', persistent: true,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.persistent) {
          // Clean up the probe terminal
          await fetch(`http://localhost:${port}/api/terminals/${data.id}`, { method: 'DELETE' });
          return;
        }
      }
    } catch { /* server not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Shellper manager not ready within ${timeoutMs}ms`);
}

/**
 * Helper: create a persistent (shellper-backed) terminal via Tower API.
 * Must pass persistent:true and cwd for shellper to be used.
 */
async function createPersistentTerminal(port: number, label: string): Promise<{ id: string; pid: number; persistent: boolean }> {
  const res = await fetch(`http://localhost:${port}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: '/bin/sleep',
      args: ['300'],
      cwd: '/tmp',
      label,
      persistent: true,
    }),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  expect(data.persistent).toBe(true);
  return data;
}

describe('Spec 0116: Shellper cleanup E2E', () => {
  beforeAll(async () => {
    tower = await startTower(TEST_TOWER_PORT, {
      SHELLPER_CLEANUP_INTERVAL_MS: CLEANUP_INTERVAL_MS,
    });
    await waitForShellperReady(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    await cleanupAllTerminals(TEST_TOWER_PORT);
    await tower.stop();
    cleanupTestDb(TEST_TOWER_PORT);
  });

  it('periodic cleanup removes stale sockets during Tower runtime', async () => {
    // Step 1: Create a persistent terminal (spawns a shellper with a real socket)
    const terminal = await createPersistentTerminal(TEST_TOWER_PORT, 'cleanup-test');

    // Step 2: Get the shellper PID from terminal info
    const infoRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals/${terminal.id}`);
    expect(infoRes.ok).toBe(true);
    const termInfo = await infoRes.json();
    const shellperPid = termInfo.pid;
    expect(shellperPid).toBeGreaterThan(0);

    // Step 3: Verify socket exists in the isolated socket dir
    const socketsBefore = readdirSync(tower.socketDir).filter(f => f.startsWith('shellper-'));
    expect(socketsBefore.length).toBeGreaterThan(0);

    // Step 4: Externally kill the shellper (simulating an orphaned process)
    process.kill(shellperPid, 'SIGKILL');

    // Step 5: Wait for the periodic cleanup to fire (interval is 2s, wait up to 10s)
    let socketsAfter: string[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      socketsAfter = readdirSync(tower.socketDir).filter(f => f.startsWith('shellper-'));
      if (socketsAfter.length === 0) break;
    }

    // Step 6: Verify the stale socket was cleaned up
    expect(socketsAfter.length).toBe(0);
  }, 30_000);

  it('full lifecycle creates no orphan sockets', async () => {
    // Create a persistent terminal
    const terminal = await createPersistentTerminal(TEST_TOWER_PORT, 'lifecycle-test');

    // Verify socket exists
    const socketsBefore = readdirSync(tower.socketDir).filter(f => f.startsWith('shellper-'));
    expect(socketsBefore.length).toBeGreaterThan(0);

    // Kill terminal via API (proper cleanup path)
    const deleteRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals/${terminal.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(204);

    // Brief delay for cleanup
    await new Promise(r => setTimeout(r, 1000));

    // Verify no orphan sockets remain
    const socketsAfter = readdirSync(tower.socketDir).filter(f => f.startsWith('shellper-'));
    expect(socketsAfter.length).toBe(0);
  }, 15_000);
});

describe('Spec 0116: Tower graceful shutdown', () => {
  it('completes without hanging (validates clearInterval)', async () => {
    const port = 14701;
    const handle = await startTower(port, {
      SHELLPER_CLEANUP_INTERVAL_MS: CLEANUP_INTERVAL_MS,
    });
    await waitForShellperReady(port);

    // Create a persistent terminal to ensure the cleanup interval is active
    await createPersistentTerminal(port, 'shutdown-test');

    // Clean up terminals before shutdown
    await cleanupAllTerminals(port);

    // Send SIGTERM and verify the process exits within 5 seconds
    // A leaked setInterval would keep the Node.js event loop alive
    const exitPromise = new Promise<number | null>((resolve) => {
      handle.process.on('exit', (code) => resolve(code));
    });

    handle.process.kill('SIGTERM');

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);

    // Process should have exited, not timed out
    expect(exitCode).not.toBe('timeout');

    // Clean up
    cleanupTestDb(port);
    try {
      const { rmSync } = await import('node:fs');
      rmSync(handle.socketDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }, 20_000);
});
