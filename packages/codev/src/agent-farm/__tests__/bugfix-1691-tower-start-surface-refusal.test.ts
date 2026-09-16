/**
 * Issue #1691 — `afx tower start` must surface the owner-guard refusal in the CLI,
 * not the generic 30s timeout.
 *
 * `towerStart` spawns the tower-server daemon detached and then polls its port for
 * readiness. When the #1629 owner-lock guard refuses, the daemon logs its teaching
 * error and `process.exit(1)`s within ~1s — but the old readiness wait only watched
 * the port, so it burned the full 30s budget and then printed a generic "failed to
 * respond within 30000ms", indistinguishable from a real hang (#1685 class). The
 * daemon's refusal reached only tower.log.
 *
 * The fix teaches the wait to distinguish three outcomes — started / exited /
 * timeout — by also watching the spawned daemon's liveness, and on a fast-exit it
 * reads back what the daemon appended to tower.log for THIS run and prints it
 * verbatim. These tests pin both halves: the pure outcome logic (fast-exit is
 * detected immediately, not after the 30s budget) and the launcher wiring (a
 * fast-exiting daemon's teaching error is surfaced on stderr and the CLI exits
 * non-zero within seconds).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway AGENT_FARM_DIR so tower.log (resolved from AGENT_FARM_DIR at module
// load) lives under our control, and a mutable holder for the spawn stub's child —
// both created in a hoisted block so the vi.mock factories below can reference them.
const h = vi.hoisted(() => {
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'af-1691-'));
  return { agentFarmDir: dir, spawn: { child: null as EventEmitter & { pid?: number; unref?: () => void } | null } };
});

vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  AGENT_FARM_DIR: h.agentFarmDir,
}));

vi.mock('../utils/config.js', () => ({
  getConfig: () => ({ serversDir: h.agentFarmDir }),
}));

// isPortInUse() = !isPortAvailable(); "available" keeps towerStart off the
// zombie-cleanup branch and straight onto the spawn path.
vi.mock('../utils/shell.js', () => ({
  isPortAvailable: vi.fn(async () => true),
}));

// The readiness probe uses http.request; a request that immediately errors makes
// isServerResponding() resolve false (the port never comes up on a refusal).
vi.mock('node:http', () => {
  const request = vi.fn(() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
    };
    return req;
  });
  return { default: { request }, request };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn(() => h.spawn.child) };
});

const LOG_FILE = path.join(h.agentFarmDir, 'tower.log');

const TEACHING_ERROR = [
  'Refusing to start: this global.db is already owned by a live Tower.',
  '  owner pid 12345 on port 4100 (host testhost)',
  '  shared database dir: /Users/test/.agent-farm',
  'A second Tower opening a live global.db hijacks and deletes its shellper sessions (Issue #1629).',
  'If you meant to run an isolated test Tower, set CODEV_AGENT_FARM_DIR (NOT AGENT_FARM_DIR) to a throwaway directory (#1515).',
  "Otherwise stop the existing Tower first ('afx tower stop'), or investigate pid 12345 if you believe it is stale.",
].join('\n');

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // A dummy compiled server so towerStart takes the `node <jsScript>` branch; spawn
  // is stubbed, so the file is never executed.
  fs.writeFileSync(path.join(h.agentFarmDir, 'tower-server.js'), '// stub');
  fs.rmSync(LOG_FILE, { force: true });
  h.spawn.child = null;
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(h.agentFarmDir, { recursive: true, force: true });
});

describe('waitForServerOutcome (#1691)', () => {
  it('returns "started" when the port answers readiness', async () => {
    const { waitForServerOutcome } = await import('../commands/tower.js');
    const outcome = await waitForServerOutcome(async () => true, () => true, {
      timeoutMs: 1000,
      intervalMs: 5,
    });
    expect(outcome).toBe('started');
  });

  it('returns "exited" the instant the daemon dies — it does NOT burn the 30s budget', async () => {
    const { waitForServerOutcome } = await import('../commands/tower.js');
    let alive = true;
    setTimeout(() => {
      alive = false;
    }, 10);

    const start = Date.now();
    // A 30s budget as in production; the fix must return far sooner than that.
    const outcome = await waitForServerOutcome(async () => false, () => alive, {
      timeoutMs: 30000,
      intervalMs: 10,
    });
    const elapsed = Date.now() - start;

    expect(outcome).toBe('exited');
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns "timeout" when the daemon stays alive but never answers', async () => {
    const { waitForServerOutcome } = await import('../commands/tower.js');
    const outcome = await waitForServerOutcome(async () => false, () => true, {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(outcome).toBe('timeout');
  });

  it('prefers "started" when the port answers in the same tick the daemon is seen to exit', async () => {
    const { waitForServerOutcome } = await import('../commands/tower.js');
    let readyCalls = 0;
    // First probe false (loop enters), daemon reported dead, re-probe true → started.
    const isReady = async () => ++readyCalls >= 2;
    const outcome = await waitForServerOutcome(isReady, () => false, {
      timeoutMs: 1000,
      intervalMs: 5,
    });
    expect(outcome).toBe('started');
  });
});

describe('towerStart fast-exit surfacing (#1691)', () => {
  it('surfaces the daemon refusal verbatim and exits non-zero within seconds', async () => {
    const { towerStart } = await import('../commands/tower.js');

    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 999999;
    child.unref = () => {};
    h.spawn.child = child;

    // Mimic the daemon: append its refusal to tower.log (the guard's format is
    // `[iso] [ERROR] <message>`), then exit before the port ever answers.
    setTimeout(() => {
      fs.appendFileSync(LOG_FILE, `[2026-09-17T00:00:00.000Z] [ERROR] ${TEACHING_ERROR}\n`);
      child.emit('exit', 1, null);
    }, 30);

    await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');

    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // The teaching error — not a generic timeout — is what the user sees.
    expect(stderr).toContain('Refusing to start: this global.db is already owned by a live Tower');
    expect(stderr).toContain('CODEV_AGENT_FARM_DIR');
    expect(stderr).toContain('exited during startup');
    expect(stderr).not.toContain('failed to respond within');
  });

  it('reports the fast-exit even when the daemon logged nothing', async () => {
    const { towerStart } = await import('../commands/tower.js');

    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 999998;
    child.unref = () => {};
    h.spawn.child = child;

    // Exit with no fresh log output.
    setTimeout(() => child.emit('exit', 1, null), 30);

    await expect(towerStart({ wait: true })).rejects.toThrow('process.exit:1');

    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(stderr).toContain('exited during startup');
    expect(stderr).toContain('No output was captured');
  });
});
