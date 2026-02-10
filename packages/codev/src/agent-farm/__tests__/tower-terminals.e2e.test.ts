/**
 * Phase 2 Terminal Tests for Tower Single Daemon Architecture (Spec 0090)
 *
 * Tests for tower-managed terminal sessions:
 * - Terminal creation via tower API
 * - WebSocket connection to terminals
 * - Terminal lifecycle management
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

// Test configuration
const TEST_TOWER_PORT = 14400;
const STARTUP_TIMEOUT = 15_000;

// Paths to server scripts
const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

// Server process
let towerProcess: ChildProcess | null = null;

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
 * Wait for a port to start listening
 */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Start tower server
 */
async function startTower(port: number): Promise<ChildProcess> {
  const proc = spawn('node', [TOWER_SERVER_PATH, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, NODE_ENV: 'test' },
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

/**
 * Stop a server process
 */
async function stopServer(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

// ============================================================================
// PHASE 2 TERMINAL TESTS
// ============================================================================

describe('Tower Terminal Management (Phase 2)', () => {
  beforeAll(async () => {
    towerProcess = await startTower(TEST_TOWER_PORT);
  });

  afterAll(async () => {
    await stopServer(towerProcess);
    towerProcess = null;
  });

  describe('POST /api/terminals', () => {
    it('creates a new terminal session', async () => {
      const response = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/echo',
          args: ['hello'],
          label: 'test-terminal',
        }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.id).toBeDefined();
      expect(data.label).toBe('test-terminal');
      expect(data.wsPath).toMatch(/^\/ws\/terminal\/[a-f0-9-]+$/);
    });

    it('creates terminal with default shell', async () => {
      const response = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.id).toBeDefined();
      expect(data.pid).toBeGreaterThan(0);
    });
  });

  describe('GET /api/terminals', () => {
    it('lists all terminals', async () => {
      const response = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.terminals).toBeDefined();
      expect(Array.isArray(data.terminals)).toBe(true);
    });
  });

  describe('GET /api/terminals/:id', () => {
    it('returns terminal info for valid ID', async () => {
      // First create a terminal
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'info-test' }),
      });
      const created = await createRes.json();

      // Then get its info
      const response = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/terminals/${created.id}`
      );
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.id).toBe(created.id);
      expect(data.label).toBe('info-test');
    });

    it('returns 404 for non-existent terminal', async () => {
      const response = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/terminals/nonexistent-id`
      );
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/terminals/:id', () => {
    it('kills and removes a terminal', async () => {
      // Create a terminal
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'delete-test' }),
      });
      const created = await createRes.json();

      // Delete it
      const deleteRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/terminals/${created.id}`,
        { method: 'DELETE' }
      );
      expect(deleteRes.status).toBe(204);

      // Verify it's gone
      const getRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/terminals/${created.id}`
      );
      expect(getRes.status).toBe(404);
    });
  });

  describe('WebSocket /ws/terminal/:id', () => {
    it('connects to a terminal session', async () => {
      // Create a terminal
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'ws-test' }),
      });
      const created = await createRes.json();

      // Connect via WebSocket
      const ws = new WebSocket(`ws://localhost:${TEST_TOWER_PORT}${created.wsPath}`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);

        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('receives terminal output', async () => {
      // Create a terminal with bash that will output something after we connect
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: '/bin/bash',
          args: ['-c', 'sleep 0.1 && echo test-output && sleep 1'],
          label: 'output-test',
        }),
      });
      const created = await createRes.json();

      // Connect and wait for output
      const ws = new WebSocket(`ws://localhost:${TEST_TOWER_PORT}${created.wsPath}`);
      ws.binaryType = 'arraybuffer';

      const receivedData = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No data received')), 5000);
        let data = '';

        ws.on('message', (rawData: ArrayBuffer) => {
          const buffer = Buffer.from(rawData);
          // Skip the frame prefix byte (0x01 for data)
          if (buffer[0] === 0x01) {
            data += buffer.subarray(1).toString('utf-8');
            if (data.includes('test-output')) {
              clearTimeout(timeout);
              resolve(data);
            }
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(receivedData).toContain('test-output');
      ws.close();
    });

    it('returns 404 for non-existent terminal WebSocket', async () => {
      const ws = new WebSocket(
        `ws://localhost:${TEST_TOWER_PORT}/ws/terminal/nonexistent-id`
      );

      await new Promise<void>((resolve) => {
        ws.on('error', () => {
          // Expected - connection should fail
          resolve();
        });
        ws.on('close', () => {
          resolve();
        });
      });

      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    });
  });

  describe('POST /api/terminals/:id/resize', () => {
    it('resizes a terminal', async () => {
      // Create a terminal
      const createRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'resize-test', cols: 80, rows: 24 }),
      });
      const created = await createRes.json();

      // Resize it
      const resizeRes = await fetch(
        `http://localhost:${TEST_TOWER_PORT}/api/terminals/${created.id}/resize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: 120, rows: 40 }),
        }
      );
      expect(resizeRes.ok).toBe(true);

      const data = await resizeRes.json();
      expect(data.cols).toBe(120);
      expect(data.rows).toBe(40);
    });
  });
});
