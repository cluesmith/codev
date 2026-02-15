/**
 * Bugfix #199: Dashboard zombie builder tab remains after builder cleanup
 *
 * When a builder's terminal session is killed, the /api/state endpoint
 * should stop returning that builder in its response. Previously, stale
 * entries persisted in the in-memory workspaceTerminals registry, causing
 * the dashboard to render empty "zombie" tabs.
 *
 * This test verifies that /api/state filters out builders (and shells)
 * whose terminal sessions are gone or exited.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';

const TEST_TOWER_PORT = 14500;
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

describe('Bugfix #199: Zombie builder tab removal', () => {
  beforeAll(async () => {
    // Create a temp directory to act as a fake workspace
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'bugfix-199-'));
    // Create minimal git repo structure so tower can activate
    mkdirSync(resolve(testProjectDir, '.git'), { recursive: true });
    writeFileSync(resolve(testProjectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    // Create codev dir and af-config so launchInstance doesn't need npx codev adopt
    mkdirSync(resolve(testProjectDir, 'codev'), { recursive: true });
    writeFileSync(
      resolve(testProjectDir, 'af-config.json'),
      JSON.stringify({ shell: { architect: 'bash', builder: 'bash', shell: 'bash' } })
    );

    towerProcess = await startTower(TEST_TOWER_PORT);
  }, 30_000);

  afterAll(async () => {
    await stopServer(towerProcess);
    towerProcess = null;
    // Kill tmux session created by Tower's launchInstance for this temp workspace
    if (testProjectDir) {
      const tmuxName = `architect-${basename(testProjectDir)}`;
      try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    // Clean up temp dir and test DB
    try { rmSync(testProjectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-wal`), { force: true }); } catch { /* ignore */ }
    try { rmSync(resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}.db-shm`), { force: true }); } catch { /* ignore */ }
  });

  it('removes stale builder from /api/state after terminal exits', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;
    const encodedPath = toBase64URL(testProjectDir);
    const workspaceApiBase = `${base}/workspace/${encodedPath}`;

    // Step 1: Activate the workspace
    const activateRes = await fetch(`${base}/api/workspaces/${encodedPath}/activate`, {
      method: 'POST',
    });
    expect(activateRes.ok).toBe(true);

    // Step 2: Create a builder terminal registered to this workspace
    // Use /bin/sleep so it stays alive long enough for us to query state
    const createRes = await fetch(`${base}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: '/bin/sleep',
        args: ['300'],
        label: 'test-builder',
        workspacePath: testProjectDir,
        type: 'builder',
        roleId: 'bugfix-199-test',
      }),
    });
    expect(createRes.status).toBe(201);
    const terminal = await createRes.json();
    expect(terminal.id).toBeDefined();

    // Step 3: Verify the builder appears in /api/state
    const stateRes1 = await fetch(`${workspaceApiBase}/api/state`);
    expect(stateRes1.ok).toBe(true);
    const state1 = await stateRes1.json();
    const builder1 = state1.builders.find((b: { id: string }) => b.id === 'bugfix-199-test');
    expect(builder1).toBeDefined();
    expect(builder1.terminalId).toBe(terminal.id);

    // Step 4: Kill the terminal session (simulates what af cleanup does)
    const deleteRes = await fetch(`${base}/api/terminals/${terminal.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(204);

    // Step 5: Verify the builder is gone from /api/state
    const stateRes2 = await fetch(`${workspaceApiBase}/api/state`);
    expect(stateRes2.ok).toBe(true);
    const state2 = await stateRes2.json();
    const builder2 = state2.builders.find((b: { id: string }) => b.id === 'bugfix-199-test');
    expect(builder2).toBeUndefined();
  }, 30_000);

  it('removes stale shell from /api/state after terminal exits', async () => {
    const base = `http://localhost:${TEST_TOWER_PORT}`;
    const encodedPath = toBase64URL(testProjectDir);
    const workspaceApiBase = `${base}/workspace/${encodedPath}`;

    // Create a shell terminal registered to this workspace
    const createRes = await fetch(`${base}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: '/bin/sleep',
        args: ['300'],
        label: 'test-shell',
        workspacePath: testProjectDir,
        type: 'shell',
        roleId: 'shell-199-test',
      }),
    });
    expect(createRes.status).toBe(201);
    const terminal = await createRes.json();

    // Verify the shell appears in /api/state
    const stateRes1 = await fetch(`${workspaceApiBase}/api/state`);
    expect(stateRes1.ok).toBe(true);
    const state1 = await stateRes1.json();
    const shell1 = state1.utils.find((u: { id: string }) => u.id === 'shell-199-test');
    expect(shell1).toBeDefined();

    // Kill the terminal
    const deleteRes = await fetch(`${base}/api/terminals/${terminal.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(204);

    // Verify the shell is gone from /api/state
    const stateRes2 = await fetch(`${workspaceApiBase}/api/state`);
    expect(stateRes2.ok).toBe(true);
    const state2 = await stateRes2.json();
    const shell2 = state2.utils.find((u: { id: string }) => u.id === 'shell-199-test');
    expect(shell2).toBeUndefined();
  }, 30_000);
});
