/**
 * Phase 3 CLI Tests for Tower Single Daemon Architecture (Spec 0090)
 *
 * Tests for CLI commands using tower API:
 * - TowerClient functionality
 * - Workspace path encoding/decoding
 * - API request handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  TowerClient,
  encodeWorkspacePath,
  decodeWorkspacePath,
} from '../lib/tower-client.js';
import type { TowerHandle } from './helpers/tower-test-utils.js';
import {
  startTower,
  cleanupAllTerminals,
  cleanupTestDb,
} from './helpers/tower-test-utils.js';

// Test configuration
const TEST_TOWER_PORT = 14500;

// Tower handle
let tower: TowerHandle;
let testWorkspace: string;

/**
 * Create a test workspace directory
 */
function createTestWorkspace(): string {
  const workspacePath = mkdtempSync(resolve(tmpdir(), 'codev-cli-test-'));
  mkdirSync(resolve(workspacePath, 'codev'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.agent-farm'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, 'af-config.json'),
    JSON.stringify({ shell: { architect: 'bash', builder: 'bash', shell: 'bash' } })
  );
  return workspacePath;
}

/**
 * Clean up test workspace
 */
function cleanupTestWorkspace(workspacePath: string): void {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// PHASE 3 CLI TESTS
// ============================================================================

describe('CLI Tower Mode (Phase 3)', () => {
  beforeAll(async () => {
    testWorkspace = createTestWorkspace();
    tower = await startTower(TEST_TOWER_PORT);
  });

  afterAll(async () => {
    await cleanupAllTerminals(TEST_TOWER_PORT);
    await tower.stop();
    cleanupTestWorkspace(testWorkspace);
    cleanupTestDb(TEST_TOWER_PORT);
  });

  describe('encodeWorkspacePath / decodeWorkspacePath', () => {
    it('encodes and decodes simple paths', () => {
      const path = '/Users/test/project';
      const encoded = encodeWorkspacePath(path);
      const decoded = decodeWorkspacePath(encoded);
      expect(decoded).toBe(path);
    });

    it('handles paths with special characters', () => {
      const path = '/Users/test/my project (1)/sub-dir';
      const encoded = encodeWorkspacePath(path);
      const decoded = decodeWorkspacePath(encoded);
      expect(decoded).toBe(path);
    });

    it('handles Windows paths', () => {
      const path = 'C:\\Users\\test\\project';
      const encoded = encodeWorkspacePath(path);
      const decoded = decodeWorkspacePath(encoded);
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
        expect(typeof health!.activeWorkspaces).toBe('number');
      });
    });

    describe('listWorkspaces', () => {
      it('returns array of workspaces', async () => {
        const workspaces = await client.listWorkspaces();
        expect(Array.isArray(workspaces)).toBe(true);
      });
    });

    describe('activateWorkspace', () => {
      it('returns error for non-existent path', async () => {
        const result = await client.activateWorkspace('/nonexistent/path');
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe('deactivateWorkspace', () => {
      it('returns error for non-existent workspace', async () => {
        const result = await client.deactivateWorkspace('/nonexistent/path');
        expect(result.ok).toBe(false);
      });
    });

    describe('getWorkspaceStatus', () => {
      it('returns null for non-existent workspace', async () => {
        const status = await client.getWorkspaceStatus('/nonexistent/path');
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
      it('generates correct workspace URL', () => {
        const url = client.getWorkspaceUrl('/Users/test/project');
        expect(url).toMatch(/^http:\/\/localhost:\d+\/workspace\/.+\/$/);
      });

      it('generates correct WebSocket URL', () => {
        const url = client.getTerminalWsUrl('test-id');
        expect(url).toBe(`ws://localhost:${TEST_TOWER_PORT}/ws/terminal/test-id`);
      });
    });
  });
});
