/**
 * Issue #1261: Tower must not serve API requests before its internal
 * dependency wiring is complete.
 *
 * Tower binds its port first — the port is the single-Tower mutex and the
 * thing every readiness probe checks — but binding used to mean "serving".
 * Requests landing between the bind and `initInstances()` were answered by a
 * half-wired Tower: `DELETE /api/terminals/:id` returned 404 for a terminal
 * that existed, because `killTerminalWithShellper()` bails when `_deps` is
 * null and the route reads that `false` as "not found".
 *
 * These tests widen that window to a known duration with
 * AF_TEST_BOOT_DELAY_MS, so the race is deterministic rather than a function
 * of how long the boot's disk work takes on the machine running the suite.
 * That is why the bug hid from CI: fresh runners boot fast enough that the
 * window closed before the test's first request arrived.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startTower,
  cleanupAllTerminals,
  cleanupTestDb,
  type TowerHandle,
} from './helpers/tower-test-utils.js';

const TEST_TOWER_PORT = 14107;

// Long enough that no plausible scheduling delay lets a request slip in after
// wiring completes; short enough to keep the suite quick.
const BOOT_DELAY_MS = 1500;

let tower: TowerHandle | null = null;

afterEach(async () => {
  if (tower) {
    await cleanupAllTerminals(tower.port);
    await tower.stop();
    cleanupTestDb(tower.port);
    tower = null;
  }
});

describe('Tower startup readiness (Issue #1261)', () => {
  it('does not answer DELETE /api/terminals/:id with a spurious 404 during startup', async () => {
    tower = await startTower(
      TEST_TOWER_PORT,
      { AF_TEST_BOOT_DELAY_MS: String(BOOT_DELAY_MS) },
      { returnAtBind: true },
    );

    // Both requests are issued inside the delayed window. Before the fix the
    // DELETE returned 404 while the terminal was demonstrably still there.
    const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'readiness-1261' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const deleteRes = await fetch(
      `http://localhost:${TEST_TOWER_PORT}/api/terminals/${created.id}`,
      { method: 'DELETE' },
    );
    expect(deleteRes.status).toBe(204);

    // And the delete really happened — a 204 that killed nothing would be a
    // different lie with the same status code.
    const getRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals/${created.id}`);
    expect(getRes.status).toBe(404);
  }, 30_000);

  it('holds requests issued at bind time until wiring completes', async () => {
    tower = await startTower(
      TEST_TOWER_PORT,
      { AF_TEST_BOOT_DELAY_MS: String(BOOT_DELAY_MS) },
      { returnAtBind: true },
    );

    // `afx tower start` polls /api/status and treats 200 as "Tower is up".
    // That signal was dishonest: /api/status answered 200 during the window
    // because getInstances() returns [] when the module isn't wired. The gate
    // makes the first 200 mean what the CLI assumes it means.
    const started = Date.now();
    const statusRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/status`);
    const elapsed = Date.now() - started;

    expect(statusRes.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(BOOT_DELAY_MS * 0.8);
  }, 30_000);
});
