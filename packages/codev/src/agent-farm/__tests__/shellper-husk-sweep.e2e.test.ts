/**
 * Issue #1227: E2E tests for the periodic husk-sweep timer wired into
 * tower-server.ts. Unit coverage for the predicate itself
 * (findHuskShellpers/computeRegisteredShellperPids/sweepShellperHusks) lives
 * in shellper-husk-sweep.test.ts with injected seams; this file exercises the
 * real setInterval + real process signals a unit test can't reach.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { TowerHandle } from './helpers/tower-test-utils.js';
import { startTower, cleanupAllTerminals, cleanupTestDb } from './helpers/tower-test-utils.js';

const TEST_TOWER_PORT = 14710;
// Short interval + zero grace so a genuine husk (created below) is reaped on
// the very next tick, without waiting anywhere near the 1-hour production default.
const HUSK_SWEEP_INTERVAL_MS = '1500';
const HUSK_GRACE_MS = '0';

let tower: TowerHandle;

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
          await fetch(`http://localhost:${port}/api/terminals/${data.id}`, { method: 'DELETE' });
          return;
        }
      }
    } catch { /* server not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Shellper manager not ready within ${timeoutMs}ms`);
}

/**
 * Creates a persistent terminal AND registers it in terminal_sessions —
 * unlike shellper-cleanup.e2e.test.ts's bare `persistent:true` (which spawns a
 * shellper but skips the DB row, see tower-routes.ts:627-638), this test needs
 * a real row to delete, so `workspacePath`/`type`/`roleId` must be present.
 *
 * The create response's own `pid` field is a stale snapshot (-1) taken before
 * shellper attach populates it — a separate GET, same as
 * shellper-cleanup.e2e.test.ts's `termInfo.pid`, is required for the real
 * shellper PID.
 */
async function createPersistentTerminal(port: number, label: string): Promise<{ id: string; pid: number }> {
  const res = await fetch(`http://localhost:${port}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: '/bin/sleep', args: ['300'], cwd: '/tmp', label, persistent: true,
      workspacePath: '/tmp', type: 'shell', roleId: label,
    }),
  });
  expect(res.status).toBe(201);
  const created = await res.json();

  const infoRes = await fetch(`http://localhost:${port}/api/terminals/${created.id}`);
  expect(infoRes.ok).toBe(true);
  const info = await infoRes.json();
  return { id: created.id, pid: info.pid };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Issue #1227: husk-sweep periodic timer E2E', () => {
  beforeAll(async () => {
    tower = await startTower(TEST_TOWER_PORT, {
      SHELLPER_HUSK_SWEEP_INTERVAL_MS: HUSK_SWEEP_INTERVAL_MS,
      SHELLPER_HUSK_GRACE_MS: HUSK_GRACE_MS,
    });
    await waitForShellperReady(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    if (!tower) return;
    await cleanupAllTerminals(TEST_TOWER_PORT);
    await tower.stop();
    cleanupTestDb(TEST_TOWER_PORT);
  });

  it('reaps a genuine husk (unregistered + childless) on the next periodic tick', async () => {
    // Create a real persistent terminal: a live shellper with a live PTY child.
    const terminal = await createPersistentTerminal(TEST_TOWER_PORT, 'husk-sweep-e2e');
    const shellperPid = terminal.pid;
    expect(isAlive(shellperPid)).toBe(true);

    // Make it "unregistered": delete its terminal_sessions row directly, the
    // same divergence a Tower restart's reconciliation produces when it can't
    // re-adopt a shellper (the exact scenario Issue #1227 describes) — the
    // shellper survives the deletion because SessionManager never disconnects
    // it just because a DB row disappeared.
    const dbPath = resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db`);
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    const deleted = db.prepare('DELETE FROM terminal_sessions WHERE shellper_pid = ?').run(shellperPid);
    db.close();
    expect(deleted.changes).toBe(1);

    // Make it "childless": kill the PTY child (not the shellper itself). The
    // shellper's deliberate post-#905/#1198 lingering behavior means it stays
    // up and keeps answering its socket after its child exits — which is
    // exactly what makes it invisible to killOrphanedShellpers().
    const childPids = execFileSync('pgrep', ['-P', String(shellperPid)], { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => parseInt(s, 10));
    expect(childPids.length).toBeGreaterThan(0);
    for (const childPid of childPids) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already dead */ }
    }

    // Unregistered + childless + zero grace: the next periodic tick (≤1.5s)
    // must reap the shellper itself.
    let stillAlive = true;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      stillAlive = isAlive(shellperPid);
      if (!stillAlive) break;
    }
    expect(stillAlive).toBe(false);
  }, 30_000);
});

describe('Issue #1227: husk-sweep graceful shutdown', () => {
  it('completes without hanging (validates the new interval is cleared)', async () => {
    const port = 14711;
    const handle = await startTower(port, {
      SHELLPER_HUSK_SWEEP_INTERVAL_MS: HUSK_SWEEP_INTERVAL_MS,
      SHELLPER_HUSK_GRACE_MS: HUSK_GRACE_MS,
    });
    await waitForShellperReady(port);
    await createPersistentTerminal(port, 'husk-sweep-shutdown-test');
    await cleanupAllTerminals(port);

    const exitPromise = new Promise<number | null>((resolvePromise) => {
      handle.process.on('exit', (code) => resolvePromise(code));
    });
    handle.process.kill('SIGTERM');

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<'timeout'>((resolvePromise) => setTimeout(() => resolvePromise('timeout'), 5000)),
    ]);

    expect(exitCode).not.toBe('timeout');

    cleanupTestDb(port);
    try {
      const { rmSync } = await import('node:fs');
      rmSync(handle.socketDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }, 20_000);
});
