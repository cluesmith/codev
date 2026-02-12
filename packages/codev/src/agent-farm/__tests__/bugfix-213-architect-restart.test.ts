/**
 * Bugfix #213: Architect does not auto-restart after accidental exit
 *
 * Root cause: The exit handler captured a stale `entry` reference from the
 * projectTerminals Map. getTerminalsForProject() periodically replaces the
 * Map entry with a fresh object (on each dashboard poll), so the exit
 * handler's `entry.architect = undefined` modified an orphaned object
 * instead of the current Map entry. This caused launchInstance() to see
 * the dead session ID still set on the current entry, skipping restart.
 *
 * Additionally, the in-memory merge in getTerminalsForProject() did not
 * check session status, so dead sessions (kept for 30s in pty-manager)
 * were propagated to fresh entries.
 *
 * Fix:
 * 1. Exit handler re-reads the entry from the Map via getProjectTerminalsEntry()
 * 2. In-memory merge checks session.status === 'running' before preserving
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';

const TEST_TOWER_PORT = 14513;
const STARTUP_TIMEOUT = 15_000;

const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

let towerProcess: ChildProcess | null = null;
let testProjectDir: string;

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

async function getProjectState(port: number, projectDir: string): Promise<{
  architect: { terminalId?: string; pid?: number } | null;
  builders: Array<{ id: string; terminalId?: string }>;
  utils: Array<{ id: string; terminalId?: string }>;
}> {
  const base = `http://localhost:${port}`;
  const encodedPath = toBase64URL(projectDir);
  const res = await fetch(`${base}/project/${encodedPath}/api/state`);
  if (!res.ok) throw new Error(`GET /api/state failed: ${res.status}`);
  return res.json();
}

describe('Bugfix #213: Architect auto-restart after exit', () => {
  beforeAll(async () => {
    // Create a temp project with af-config.json using a short-lived command
    // sleep 7 gives >5s uptime (avoiding crash loop protection) while
    // keeping the test fast
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'bugfix-213-'));
    mkdirSync(resolve(testProjectDir, '.git'), { recursive: true });
    writeFileSync(resolve(testProjectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(resolve(testProjectDir, 'af-config.json'), JSON.stringify({
      shell: { architect: '/bin/sleep 7', builder: 'echo', shell: 'bash' },
    }));

    towerProcess = await startTower(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    await stopServer(towerProcess);
    towerProcess = null;
    // Kill any tmux sessions created for this temp project
    if (testProjectDir) {
      const tmuxName = `architect-${basename(testProjectDir)}`;
      try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    try { rmSync(testProjectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-wal`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-shm`), { force: true }); } catch { /* ignore */ }
  });

  it('restarts architect after the process exits naturally', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;
    const encodedPath = toBase64URL(testProjectDir);

    // Step 1: Activate the project → creates architect running "sleep 7"
    const activateRes = await fetch(`${base}/api/projects/${encodedPath}/activate`, {
      method: 'POST',
    });
    expect(activateRes.ok).toBe(true);

    // Step 2: Wait for architect to appear and get its terminal ID
    let originalTerminalId: string | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await getProjectState(TEST_TOWER_PORT, testProjectDir);
      if (state.architect?.terminalId) {
        originalTerminalId = state.architect.terminalId;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(originalTerminalId).toBeDefined();

    // Step 3: Poll /api/state a few times to force getTerminalsForProject()
    // to replace the in-memory entry (this is what causes the stale reference
    // bug — each poll creates a new freshEntry object in the Map)
    for (let i = 0; i < 3; i++) {
      await getProjectState(TEST_TOWER_PORT, testProjectDir);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Step 4: Wait for "sleep 7" to finish + 2s restart delay + margin
    // Total: ~7s (sleep) + 2s (restart delay) + 3s (margin) = ~12s
    const sleepStart = Date.now();
    const totalWait = 14_000; // generous margin for CI
    let newTerminalId: string | undefined;
    let foundNew = false;

    while (Date.now() - sleepStart < totalWait) {
      const state = await getProjectState(TEST_TOWER_PORT, testProjectDir);
      if (state.architect?.terminalId && state.architect.terminalId !== originalTerminalId) {
        newTerminalId = state.architect.terminalId;
        foundNew = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // The architect should have been restarted with a new terminal ID
    expect(foundNew).toBe(true);
    expect(newTerminalId).toBeDefined();
    expect(newTerminalId).not.toBe(originalTerminalId);
  }, 45_000);
});
