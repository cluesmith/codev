/**
 * Issue #1227: E2E tests for the on-demand husk routes (GET
 * /api/shellpers/husks preview, POST /api/shellpers/husks/sweep apply) and
 * the /health fleet-observability fields. Uses a long periodic-sweep interval
 * so the timer never races the manual preview/apply calls under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { TowerHandle } from './helpers/tower-test-utils.js';
import { startTower, cleanupAllTerminals, cleanupTestDb } from './helpers/tower-test-utils.js';

const TEST_TOWER_PORT = 14712;
// Long enough that the periodic timer never fires during this test file.
const NO_PERIODIC_INTERFERENCE_MS = '3600000';

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
  const info = await infoRes.json();
  return { id: created.id, pid: info.pid };
}

function unregisterAndOrphan(port: number, shellperPid: number): void {
  const dbPath = resolve(homedir(), '.agent-farm', `test-${port}.db`);
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.prepare('DELETE FROM terminal_sessions WHERE shellper_pid = ?').run(shellperPid);
  db.close();

  const childPids = execFileSync('pgrep', ['-P', String(shellperPid)], { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => parseInt(s, 10));
  for (const childPid of childPids) {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* already dead */ }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Issue #1227: on-demand husk routes + /health fleet fields', () => {
  beforeAll(async () => {
    tower = await startTower(TEST_TOWER_PORT, {
      SHELLPER_HUSK_SWEEP_INTERVAL_MS: NO_PERIODIC_INTERFERENCE_MS,
      SHELLPER_HUSK_GRACE_MS: '0',
    });
    await waitForShellperReady(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    if (!tower) return;
    await cleanupAllTerminals(TEST_TOWER_PORT);
    await tower.stop();
    cleanupTestDb(TEST_TOWER_PORT);
  });

  it('preview lists a genuine husk without killing it, apply then reaps it', async () => {
    const terminal = await createPersistentTerminal(TEST_TOWER_PORT, 'routes-e2e');
    const shellperPid = terminal.pid;
    expect(isAlive(shellperPid)).toBe(true);

    unregisterAndOrphan(TEST_TOWER_PORT, shellperPid);
    // Let the childless state settle before probing.
    await new Promise((r) => setTimeout(r, 300));

    // Preview: must list the candidate but must NOT kill it.
    const previewRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/shellpers/husks`);
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.candidates.map((c: { pid: number }) => c.pid)).toContain(shellperPid);
    expect(isAlive(shellperPid)).toBe(true);

    // /health must report it as unregistered too (same registry lookup).
    const healthRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/health`);
    const health = await healthRes.json();
    expect(health.unregisteredShellperCount).toBeGreaterThanOrEqual(1);
    expect(typeof health.fleetRssKb).toBe('number');
    expect(health.fleetRssKb).toBeGreaterThan(0);

    // Apply: must actually reap it.
    const sweepRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/shellpers/husks/sweep`, { method: 'POST' });
    expect(sweepRes.status).toBe(200);
    const sweep = await sweepRes.json();
    expect(sweep.pids).toContain(shellperPid);

    let stillAlive = true;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      stillAlive = isAlive(shellperPid);
      if (!stillAlive) break;
    }
    expect(stillAlive).toBe(false);
  }, 30_000);
});
