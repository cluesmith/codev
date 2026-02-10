/**
 * Phase 3 CLI Tests for Tower Single Daemon Architecture (Spec 0090)
 *
 * Tests for CLI commands using tower API:
 * - TowerClient functionality
 * - Project path encoding/decoding
 * - API request handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import {
  TowerClient,
  encodeProjectPath,
  decodeProjectPath,
} from '../lib/tower-client.js';

// Test configuration
const TEST_TOWER_PORT = 14500;
const STARTUP_TIMEOUT = 15_000;

// Paths to server scripts
const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

// Server process
let towerProcess: ChildProcess | null = null;
let testProject: string;

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

/**
 * Create a test project directory
 */
function createTestProject(): string {
  const projectPath = mkdtempSync(resolve(tmpdir(), 'codev-cli-test-'));
  mkdirSync(resolve(projectPath, 'codev'), { recursive: true });
  mkdirSync(resolve(projectPath, '.agent-farm'), { recursive: true });
  writeFileSync(
    resolve(projectPath, 'af-config.json'),
    JSON.stringify({ shell: { architect: 'bash', builder: 'bash', shell: 'bash' } })
  );
  return projectPath;
}

/**
 * Clean up test project
 */
function cleanupTestProject(projectPath: string): void {
  try {
    rmSync(projectPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// PHASE 3 CLI TESTS
// ============================================================================

describe('CLI Tower Mode (Phase 3)', () => {
  beforeAll(async () => {
    testProject = createTestProject();
    towerProcess = await startTower(TEST_TOWER_PORT);
  });

  afterAll(async () => {
    await stopServer(towerProcess);
    towerProcess = null;
    cleanupTestProject(testProject);
  });

  describe('encodeProjectPath / decodeProjectPath', () => {
    it('encodes and decodes simple paths', () => {
      const path = '/Users/test/project';
      const encoded = encodeProjectPath(path);
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe(path);
    });

    it('handles paths with special characters', () => {
      const path = '/Users/test/my project (1)/sub-dir';
      const encoded = encodeProjectPath(path);
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe(path);
    });

    it('handles Windows paths', () => {
      const path = 'C:\\Users\\test\\project';
      const encoded = encodeProjectPath(path);
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe(path);
    });
  });

  describe('TowerClient', () => {
    let client: TowerClient;

    beforeAll(() => {
      client = new TowerClient(TEST_TOWER_PORT);
    });

    describe('isRunning', () => {
      it('returns true when tower is running', async () => {
        const running = await client.isRunning();
        expect(running).toBe(true);
      });

      it('returns false when tower port is wrong', async () => {
        const wrongClient = new TowerClient(59999);
        const running = await wrongClient.isRunning();
        expect(running).toBe(false);
      });
    });

    describe('getHealth', () => {
      it('returns health status', async () => {
        const health = await client.getHealth();
        expect(health).not.toBeNull();
        expect(health!.status).toBe('healthy');
        expect(typeof health!.uptime).toBe('number');
        expect(typeof health!.activeProjects).toBe('number');
      });
    });

    describe('listProjects', () => {
      it('returns array of projects', async () => {
        const projects = await client.listProjects();
        expect(Array.isArray(projects)).toBe(true);
      });
    });

    describe('activateProject', () => {
      it('returns error for non-existent path', async () => {
        const result = await client.activateProject('/nonexistent/path');
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe('deactivateProject', () => {
      it('returns error for non-existent project', async () => {
        const result = await client.deactivateProject('/nonexistent/path');
        expect(result.ok).toBe(false);
      });
    });

    describe('getProjectStatus', () => {
      it('returns null for non-existent project', async () => {
        const status = await client.getProjectStatus('/nonexistent/path');
        expect(status).toBeNull();
      });
    });

    describe('terminal operations', () => {
      it('creates and lists terminals', async () => {
        const terminal = await client.createTerminal({
          command: '/bin/echo',
          args: ['test'],
          label: 'cli-test',
        });

        expect(terminal).not.toBeNull();
        expect(terminal!.id).toBeDefined();
        expect(terminal!.label).toBe('cli-test');

        const terminals = await client.listTerminals();
        expect(terminals.some((t) => t.id === terminal!.id)).toBe(true);
      });

      it('gets terminal info', async () => {
        const created = await client.createTerminal({
          label: 'info-test',
        });

        const terminal = await client.getTerminal(created!.id);
        expect(terminal).not.toBeNull();
        expect(terminal!.id).toBe(created!.id);
      });

      it('kills terminal', async () => {
        const created = await client.createTerminal({
          label: 'kill-test',
        });

        const killed = await client.killTerminal(created!.id);
        expect(killed).toBe(true);

        const terminal = await client.getTerminal(created!.id);
        expect(terminal).toBeNull();
      });

      it('resizes terminal', async () => {
        const created = await client.createTerminal({
          cols: 80,
          rows: 24,
          label: 'resize-test',
        });

        const resized = await client.resizeTerminal(created!.id, 120, 40);
        expect(resized).not.toBeNull();
        expect(resized!.cols).toBe(120);
        expect(resized!.rows).toBe(40);
      });
    });

    describe('URL generation', () => {
      it('generates correct project URL', () => {
        const url = client.getProjectUrl('/Users/test/project');
        expect(url).toMatch(/^http:\/\/localhost:\d+\/project\/.+\/$/);
      });

      it('generates correct WebSocket URL', () => {
        const url = client.getTerminalWsUrl('test-id');
        expect(url).toBe(`ws://localhost:${TEST_TOWER_PORT}/ws/terminal/test-id`);
      });
    });
  });
});
