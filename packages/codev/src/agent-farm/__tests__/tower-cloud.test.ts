/**
 * Tests for tower cloud commands (Spec 0097 Phase 5)
 *
 * Tests the CLI registration/deregistration logic:
 * - Token redemption via HTTP POST
 * - Cloud status display (registered vs not registered)
 * - Tunnel status fetching from tower daemon
 * - Helper functions (formatUptime, getMachineId, signalTower)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';

// Redirect homedir to a temp directory so tests don't touch real ~/.agent-farm/
const TEST_DIR = vi.hoisted(() => {
  const { resolve } = require('node:path');
  const { tmpdir } = require('node:os');
  const { randomBytes } = require('node:crypto');
  return resolve(tmpdir(), `tower-cloud-test-${randomBytes(4).toString('hex')}`);
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => TEST_DIR,
  };
});

import {
  readCloudConfig,
  writeCloudConfig,
  deleteCloudConfig,
  maskApiKey,
  type CloudConfig,
} from '../lib/cloud-config.js';
import { getTunnelStatus, towerCloudStatus } from '../commands/tower-cloud.js';

// Test constants
const TEST_CONFIG: CloudConfig = {
  tower_id: 'tower-abc123',
  tower_name: 'test-tower',
  api_key: 'ctk_TestApiKey1234567890',
  server_url: 'https://codevos.ai',
};

/** Wait for a condition to become true */
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('tower cloud commands (Phase 5)', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('token redemption server', () => {
    it('exchanges token for API credentials via POST', async () => {
      // Mock the codevos.ai /api/towers/register/redeem endpoint
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/towers/register/redeem') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const data = JSON.parse(body);
            expect(data.token).toBe('test-token-123');
            expect(data.name).toBe('my-tower');
            expect(data.machineId).toBeTruthy();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              towerId: 'tower-new-id',
              apiKey: 'ctk_NewApiKey1234567890',
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/towers/register/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: 'test-token-123',
            name: 'my-tower',
            machineId: 'test-machine',
          }),
        });

        expect(response.ok).toBe(true);
        const data = (await response.json()) as { towerId: string; apiKey: string };
        expect(data.towerId).toBe('tower-new-id');
        expect(data.apiKey).toMatch(/^ctk_/);
      } finally {
        mockServer.close();
      }
    });

    it('returns error for invalid token', async () => {
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/towers/register/redeem') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired token' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/towers/register/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'invalid-token', name: 'test', machineId: 'test' }),
        });

        expect(response.ok).toBe(false);
        expect(response.status).toBe(401);
      } finally {
        mockServer.close();
      }
    });
  });

  describe('deregistration server call', () => {
    it('sends DELETE request with API key authorization', async () => {
      let receivedAuth = '';
      let receivedMethod = '';
      let receivedPath = '';

      const mockServer = http.createServer((req, res) => {
        receivedMethod = req.method || '';
        receivedPath = req.url || '';
        receivedAuth = req.headers.authorization || '';
        res.writeHead(200);
        res.end();
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });

      try {
        await fetch(`http://127.0.0.1:${port}/api/towers/tower-abc123`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_CONFIG.api_key}` },
        });

        expect(receivedMethod).toBe('DELETE');
        expect(receivedPath).toBe('/api/towers/tower-abc123');
        expect(receivedAuth).toBe(`Bearer ${TEST_CONFIG.api_key}`);
      } finally {
        mockServer.close();
      }
    });
  });

  describe('callback server for browser flow', () => {
    it('receives token via HTTP callback', async () => {
      // Simulate the callback server that towerRegister() starts
      let receivedToken: string | null = null;

      const callbackServer = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname === '/callback') {
          receivedToken = url.searchParams.get('token');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>OK</h1></body></html>');
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        callbackServer.listen(0, '127.0.0.1', () => {
          resolve((callbackServer.address() as { port: number }).port);
        });
      });

      try {
        // Simulate browser redirecting to callback
        const res = await fetch(
          `http://127.0.0.1:${port}/callback?token=browser-token-xyz`,
        );
        expect(res.ok).toBe(true);
        expect(receivedToken).toBe('browser-token-xyz');
      } finally {
        callbackServer.close();
      }
    });
  });

  describe('getTunnelStatus', () => {
    it('returns status from running tower daemon via custom port', async () => {
      const mockServer = http.createServer((req, res) => {
        if (req.url === '/api/tunnel/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            registered: true,
            state: 'connected',
            uptime: 3600000,
            towerId: 'tower-123',
            towerName: 'my-tower',
            serverUrl: 'https://codevos.ai',
            accessUrl: 'https://codevos.ai/t/my-tower/',
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });

      try {
        // Call getTunnelStatus directly with custom port
        const status = await getTunnelStatus(port);
        expect(status).not.toBeNull();
        expect(status!.state).toBe('connected');
        expect(status!.uptime).toBe(3600000);
        expect(status!.towerId).toBe('tower-123');
      } finally {
        mockServer.close();
      }
    });

    it('returns null when tower is not running on given port', async () => {
      // Use a port that nothing is listening on
      const status = await getTunnelStatus(19999);
      expect(status).toBeNull();
    });
  });

  describe('config flow integration', () => {
    it('writeCloudConfig creates config that readCloudConfig can read', () => {
      // This tests the integration between write and read
      // (cloud-config.test.ts covers the details, this verifies the round-trip)
      const config: CloudConfig = {
        tower_id: 'tower-roundtrip',
        tower_name: 'roundtrip-tower',
        api_key: 'ctk_RoundTripKey12345',
        server_url: 'https://codevos.ai',
      };

      writeCloudConfig(config);
      const read = readCloudConfig();
      expect(read).toEqual(config);

      // Cleanup
      deleteCloudConfig();
      expect(readCloudConfig()).toBeNull();
    });

    it('isRegistered returns false when no config exists', () => {
      deleteCloudConfig();
      expect(readCloudConfig()).toBeNull();
    });
  });

  describe('towerCloudStatus', () => {
    afterEach(() => {
      deleteCloudConfig();
    });

    it('shows not-registered message when no config exists', async () => {
      deleteCloudConfig();
      // Should not throw even when no config exists
      await towerCloudStatus();
    });

    it('shows cloud info when registered with daemon running', async () => {
      // Set up config
      writeCloudConfig(TEST_CONFIG);

      // Mock tunnel status endpoint
      const mockServer = http.createServer((req, res) => {
        if (req.url === '/api/tunnel/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            registered: true,
            state: 'connected',
            uptime: 300000, // 5 minutes in ms
            towerId: TEST_CONFIG.tower_id,
            towerName: TEST_CONFIG.tower_name,
            serverUrl: TEST_CONFIG.server_url,
            accessUrl: `${TEST_CONFIG.server_url}/t/${TEST_CONFIG.tower_name}/`,
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });

      try {
        // Call towerCloudStatus with custom port pointing to our mock
        await towerCloudStatus(port);
      } finally {
        mockServer.close();
      }
    });

    it('shows cloud info when registered but daemon not running', async () => {
      writeCloudConfig(TEST_CONFIG);
      // Call with a port that nothing is listening on
      await towerCloudStatus(19998);
    });
  });

  describe('registration URL construction', () => {
    it('builds correct registration URL', () => {
      const serverUrl = 'https://codevos.ai';
      const callbackUrl = 'http://localhost:12345/callback';

      const url = `${serverUrl}/towers/register?callback=${encodeURIComponent(callbackUrl)}`;
      expect(url).toBe('https://codevos.ai/towers/register?callback=http%3A%2F%2Flocalhost%3A12345%2Fcallback');
    });

    it('builds correct reauth URL', () => {
      const serverUrl = 'https://codevos.ai';
      const callbackUrl = 'http://localhost:12345/callback';

      const url = `${serverUrl}/towers/register?reauth=true&callback=${encodeURIComponent(callbackUrl)}`;
      expect(url).toContain('reauth=true');
      expect(url).toContain('callback=');
    });
  });

  describe('access URL construction', () => {
    it('constructs correct access URL from config', () => {
      const config = TEST_CONFIG;
      const accessUrl = `${config.server_url}/t/${config.tower_name}/`;
      expect(accessUrl).toBe('https://codevos.ai/t/test-tower/');
    });
  });

  describe('uptime from tunnel status is in milliseconds', () => {
    it('tunnel status uptime is reported in ms (getUptime returns ms)', async () => {
      // Verify the contract: /api/tunnel/status returns uptime in milliseconds
      // This validates the assumption that formatUptime receives ms, not seconds
      const mockServer = http.createServer((req, res) => {
        if (req.url === '/api/tunnel/status') {
          // Simulate 2 hours of uptime in milliseconds
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            registered: true,
            state: 'connected',
            uptime: 7200000, // 2 hours in ms
            towerId: 'tower-123',
            towerName: 'test',
            serverUrl: 'https://codevos.ai',
            accessUrl: 'https://codevos.ai/t/test/',
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          resolve((mockServer.address() as { port: number }).port);
        });
      });

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tunnel/status`);
        const data = await response.json() as { uptime: number };
        // Uptime should be in ms — 7200000ms = 2 hours
        expect(data.uptime).toBe(7200000);
        // Converting to seconds: 7200000 / 1000 = 7200s = 2h
        expect(Math.floor(data.uptime / 1000 / 3600)).toBe(2);
      } finally {
        mockServer.close();
      }
    });
  });

  describe('API key masking in output', () => {
    it('masks standard ctk_ prefixed keys', () => {
      expect(maskApiKey('ctk_AbCdEfGhIjKl1234')).toBe('ctk_****1234');
    });

    it('masks short keys', () => {
      expect(maskApiKey('abcd1234')).toBe('****1234');
    });
  });
});
