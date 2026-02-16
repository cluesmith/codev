/**
 * E2E Test: Tower stop/start reconnection (Spec 0122)
 *
 * Validates that shellper-backed terminal sessions survive Tower restarts.
 * Flow: Start Tower → create workspace + shell → stop Tower → start Tower → verify reconnection.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  waitForPort,
  encodeWorkspacePath,
  cleanupTestDb,
} from './helpers/tower-test-utils.js';

const TEST_TOWER_PORT = 14800;
// 3 levels up from src/agent-farm/__tests__/ to packages/codev/
const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js',
);

// Shared state across tests in the describe block
let socketDir: string;
let workspacePath: string;
let shellTerminalId: string;
let shellperPid: number;

/**
 * Create a test workspace in a non-temp location so reconciliation
 * doesn't skip it (reconcileTerminalSessions filters /tmp, /var/folders).
 */
function createTestWorkspace(): string {
  const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');
  mkdirSync(testBase, { recursive: true });
  const wp = mkdtempSync(resolve(testBase, 'codev-reconnect-'));
  mkdirSync(resolve(wp, 'codev'), { recursive: true });
  mkdirSync(resolve(wp, '.agent-farm'), { recursive: true });
  writeFileSync(
    resolve(wp, 'af-config.json'),
    JSON.stringify({ shell: { architect: 'bash', builder: 'bash', shell: 'bash' } }),
  );
  return wp;
}

/**
 * Start a Tower process with explicit socketDir and DB.
 * Returns the child process — caller manages lifecycle.
 */
function spawnTower(port: number, sockDir: string): ChildProcess {
  return spawn('node', [TOWER_SERVER_PATH, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AF_TEST_DB: `test-${port}.db`,
      SHELLPER_SOCKET_DIR: sockDir,
    },
  });
}

/**
 * Stop a Tower process gracefully (SIGTERM) and wait for exit.
 */
async function stopTower(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);
  });
}

/**
 * Kill all terminals for a workspace before cleanup.
 */
async function cleanupTerminals(port: number, wp: string): Promise<void> {
  const encoded = encodeWorkspacePath(wp);
  try {
    const res = await fetch(
      `http://localhost:${port}/workspace/${encoded}/api/state`,
    );
    if (!res.ok) return;
    // Just delete all terminals via the terminals API
    const listRes = await fetch(`http://localhost:${port}/api/terminals`);
    if (listRes.ok) {
      const { terminals } = await listRes.json();
      for (const t of terminals) {
        await fetch(`http://localhost:${port}/api/terminals/${t.id}`, { method: 'DELETE' });
      }
    }
  } catch { /* Tower may be down */ }
}

// ============================================================================
// Tests
// ============================================================================

describe('Tower stop/start reconnection (Spec 0122)', () => {
  let tower1: ChildProcess | null = null;
  let tower2: ChildProcess | null = null;

  afterAll(async () => {
    // Kill any remaining Tower processes
    if (tower2) {
      await cleanupTerminals(TEST_TOWER_PORT, workspacePath).catch(() => {});
      await stopTower(tower2);
    }
    if (tower1) {
      try { tower1.kill('SIGKILL'); } catch { /* already exited */ }
    }

    // Clean up workspace and DB
    if (workspacePath && existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
    if (socketDir && existsSync(socketDir)) {
      rmSync(socketDir, { recursive: true, force: true });
    }
    cleanupTestDb(TEST_TOWER_PORT);
  });

  it('reconnects shellper sessions after Tower restart', async () => {
    // ---- Setup ----
    socketDir = mkdtempSync('/tmp/codev-sock-reconnect-');
    workspacePath = createTestWorkspace();
    const encoded = encodeWorkspacePath(workspacePath);

    // ---- Phase 1: Start Tower #1 and create a shellper-backed terminal ----
    tower1 = spawnTower(TEST_TOWER_PORT, socketDir);

    let stderr1 = '';
    tower1.stderr?.on('data', (d) => (stderr1 += d.toString()));

    const started1 = await waitForPort(TEST_TOWER_PORT, 15000);
    expect(started1).toBe(true);

    // Activate workspace
    const activateRes = await fetch(
      `http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encoded}/activate`,
      { method: 'POST' },
    );
    expect(activateRes.ok).toBe(true);

    // Create a shell terminal (shellper-backed)
    const shellRes = await fetch(
      `http://localhost:${TEST_TOWER_PORT}/workspace/${encoded}/api/tabs/shell`,
      { method: 'POST' },
    );
    expect(shellRes.ok).toBe(true);
    const shellData = await shellRes.json();
    shellTerminalId = shellData.terminalId;
    expect(shellTerminalId).toBeDefined();

    // Verify terminal exists and has a PID
    const termInfoRes = await fetch(
      `http://localhost:${TEST_TOWER_PORT}/api/terminals/${shellTerminalId}`,
    );
    expect(termInfoRes.ok).toBe(true);
    const termInfo = await termInfoRes.json();
    expect(termInfo.pid).toBeGreaterThan(0);
    expect(termInfo.persistent).toBe(true);
    shellperPid = termInfo.pid;

    // Verify the workspace state shows the shell
    const stateRes1 = await fetch(
      `http://localhost:${TEST_TOWER_PORT}/workspace/${encoded}/api/state`,
    );
    expect(stateRes1.ok).toBe(true);
    const state1 = await stateRes1.json();
    expect(state1.utils?.length).toBeGreaterThanOrEqual(1);

    // ---- Phase 2: Stop Tower #1 (shellper survives) ----
    await stopTower(tower1);
    tower1 = null;

    // Verify shellper process is still alive
    try {
      process.kill(shellperPid, 0); // Signal 0 = check if alive
    } catch {
      throw new Error(`Shellper process ${shellperPid} died after Tower shutdown`);
    }

    // Wait a beat to ensure port is released
    await new Promise((r) => setTimeout(r, 500));

    // ---- Phase 3: Start Tower #2 (same port, DB, socket dir) ----
    tower2 = spawnTower(TEST_TOWER_PORT, socketDir);

    let stderr2 = '';
    tower2.stderr?.on('data', (d) => (stderr2 += d.toString()));

    const started2 = await waitForPort(TEST_TOWER_PORT, 15000);
    expect(started2).toBe(true);

    // ---- Phase 4: Verify reconnection ----
    // Wait for reconciliation to complete (it runs during startup)
    await new Promise((r) => setTimeout(r, 2000));

    // The workspace should appear in the workspace list with its terminals
    const stateRes2 = await fetch(
      `http://localhost:${TEST_TOWER_PORT}/workspace/${encoded}/api/state`,
    );
    expect(stateRes2.ok).toBe(true);
    const state2 = await stateRes2.json();

    // The shell terminal should be reconnected
    expect(state2.utils?.length).toBeGreaterThanOrEqual(1);

    // Verify we can still interact with a terminal (it has a valid ID)
    const termList = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`);
    expect(termList.ok).toBe(true);
    const { terminals } = await termList.json();
    expect(terminals.length).toBeGreaterThanOrEqual(1);

    // Find our reconnected terminal — it will have a new ID after reconnection
    // but should have the same shellper PID
    const reconnected = terminals.find(
      (t: { pid: number; persistent: boolean }) => t.pid === shellperPid && t.persistent,
    );
    expect(reconnected).toBeDefined();
    expect(reconnected.pid).toBe(shellperPid);
    expect(reconnected.persistent).toBe(true);
  }, 45000);
});
