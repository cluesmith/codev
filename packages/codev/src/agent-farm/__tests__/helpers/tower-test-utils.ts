/**
 * Test utilities for tower integration tests.
 * Phase 4 (Spec 0090): Tower-only architecture - no dashboard-server.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
const TOWER_START_TIMEOUT = 10_000;

export interface TowerHandle {
  port: number;
  process: ChildProcess;
  stop: () => Promise<void>;
}

export interface WorkspaceHandle {
  workspacePath: string;
  towerPort: number;
  encodedPath: string;
  deactivate: () => Promise<void>;
}

export interface TowerState {
  instances: Array<{
    workspacePath: string;
    workspaceName: string;
    running: boolean;
    terminals: Array<{
      type: string;
      id: string;
      label: string;
    }>;
  }>;
}

/**
 * Wait for a port to start listening
 */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const isUp = await isPortListening(port);
    if (isUp) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

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
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    const inUse = await isPortListening(port);
    if (!inUse) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Start the tower server for testing
 */
export async function startTower(port?: number): Promise<TowerHandle> {
  const actualPort = port ?? (await findAvailablePort(14100)); // Use high port for tests

  // Find tower-server.js path
  const towerPath = resolve(
    import.meta.dirname,
    '../../../dist/agent-farm/servers/tower-server.js'
  );

  const proc = spawn('node', [towerPath, String(actualPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Capture output for debugging
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));

  // Wait for tower to start
  const started = await waitForPort(actualPort, TOWER_START_TIMEOUT);
  if (!started) {
    proc.kill();
    throw new Error(`Tower failed to start on port ${actualPort}. stderr: ${stderr}`);
  }

  return {
    port: actualPort,
    process: proc,
    stop: async () => {
      proc.kill('SIGTERM');
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        proc.on('exit', () => resolve());
        setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 2000);
      });
    },
  };
}

/**
 * Create a temporary test workspace directory
 */
export function createTestWorkspace(): string {
  const workspacePath = mkdtempSync(resolve(tmpdir(), 'codev-test-'));

  // Create minimal codev structure
  mkdirSync(resolve(workspacePath, 'codev'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.agent-farm'), { recursive: true });

  // Create minimal af-config.json
  writeFileSync(
    resolve(workspacePath, 'af-config.json'),
    JSON.stringify({
      shell: { architect: 'bash', builder: 'bash', shell: 'bash' },
    })
  );

  return workspacePath;
}

/**
 * Clean up a test workspace directory
 */
export function cleanupTestWorkspace(workspacePath: string): void {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Ignore filesystem cleanup errors
  }
}

/**
 * Encode workspace path for tower proxy URL
 */
export function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64url');
}

/**
 * Activate a workspace via tower API
 * Phase 4: This replaces the old startDashboard function
 */
export async function activateWorkspace(
  towerPort: number,
  workspacePath: string
): Promise<WorkspaceHandle> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/api/workspaces/${encodedPath}/activate`,
    { method: 'POST' }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to activate workspace: ${error.error || response.status}`);
  }

  return {
    workspacePath,
    towerPort,
    encodedPath,
    deactivate: async () => {
      await fetch(
        `http://localhost:${towerPort}/api/workspaces/${encodedPath}/deactivate`,
        { method: 'POST' }
      );
    },
  };
}

/**
 * Deactivate a workspace via tower API
 */
export async function deactivateWorkspace(
  towerPort: number,
  workspacePath: string
): Promise<{ ok: boolean; stopped?: number[]; error?: string }> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/api/workspaces/${encodedPath}/deactivate`,
    { method: 'POST' }
  );
  return response.json();
}

/**
 * Get tower state via API
 */
export async function getTowerState(towerPort: number): Promise<TowerState> {
  const response = await fetch(`http://localhost:${towerPort}/api/status`);
  if (!response.ok) {
    throw new Error(`Failed to get tower state: ${response.status}`);
  }
  return response.json();
}

/**
 * Get workspace state via tower API
 */
export async function getWorkspaceState(
  towerPort: number,
  workspacePath: string
): Promise<{
  architect: { port: number; pid: number; terminalId?: string } | null;
  builders: Array<{ id: string; terminalId?: string }>;
  utils: Array<{ id: string; terminalId?: string }>;
  workspaceName?: string;
}> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/workspace/${encodedPath}/api/state`
  );
  if (!response.ok) {
    throw new Error(`Failed to get workspace state: ${response.status}`);
  }
  return response.json();
}

/**
 * Create a shell terminal for a workspace via tower API
 */
export async function createShellTerminal(
  towerPort: number,
  workspacePath: string
): Promise<{ id: string; terminalId: string }> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/workspace/${encodedPath}/api/tabs/shell`,
    { method: 'POST' }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create shell: ${error.error || response.status}`);
  }
  return response.json();
}

/**
 * Delete a terminal tab via tower API
 */
export async function deleteTerminal(
  towerPort: number,
  workspacePath: string,
  tabId: string
): Promise<void> {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const response = await fetch(
    `http://localhost:${towerPort}/workspace/${encodedPath}/api/tabs/${tabId}`,
    { method: 'DELETE' }
  );
  if (!response.ok && response.status !== 204) {
    const error = await response.json();
    throw new Error(`Failed to delete terminal: ${error.error || response.status}`);
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 200
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
