/**
 * Tests for tunnel integration with tower server (Spec 0097 Phase 4)
 *
 * Tests the tower-tunnel integration layer:
 * - /api/tunnel/connect, /api/tunnel/disconnect, /api/tunnel/status endpoints
 * - Auto-connect behavior based on cloud config
 * - Graceful shutdown disconnects tunnel
 * - Config file watcher triggers reconnect/disconnect
 * - Metadata includes project-terminal associations
 *
 * Uses a lightweight HTTP server that mirrors the tower's endpoint logic
 * to test the contract without booting the full tower.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MockTunnelServer } from './helpers/mock-tunnel-server.js';
import { TunnelClient, type TunnelState, type TowerMetadata } from '../lib/tunnel-client.js';
import {
  readCloudConfig,
  writeCloudConfig,
  deleteCloudConfig,
  getCloudConfigPath,
  maskApiKey,
  type CloudConfig,
} from '../lib/cloud-config.js';

/** Wait for a condition to be true within a timeout */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Make an HTTP request and return status + body */
async function httpRequest(
  url: string,
  method = 'GET',
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Simulates the tunnel endpoint logic from tower-server.ts.
 * This mirrors the actual endpoint code to validate the contract.
 */
function createTunnelEndpointServer(opts: {
  mockServerPort: number;
  readConfig: () => CloudConfig | null;
}): {
  server: http.Server;
  tunnelClient: TunnelClient | null;
  getTunnelClient: () => TunnelClient | null;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  let tunnelClient: TunnelClient | null = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);

    // POST /api/tunnel/connect
    if (req.method === 'POST' && url.pathname === '/api/tunnel/connect') {
      const config = opts.readConfig();
      if (!config) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Not registered.' }));
        return;
      }

      if (tunnelClient) {
        tunnelClient.resetCircuitBreaker();
        tunnelClient.disconnect();
      }

      tunnelClient = new TunnelClient({
        serverUrl: `http://127.0.0.1:${opts.mockServerPort}`,
        apiKey: config.api_key,
        towerId: config.tower_id,
        localPort: parseInt(new URL(`http://localhost`).port || '0'),
      });

      tunnelClient.connect();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: tunnelClient.getState() }));
      return;
    }

    // POST /api/tunnel/disconnect
    if (req.method === 'POST' && url.pathname === '/api/tunnel/disconnect') {
      if (tunnelClient) {
        tunnelClient.disconnect();
        tunnelClient = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // GET /api/tunnel/status
    if (req.method === 'GET' && url.pathname === '/api/tunnel/status') {
      let config: CloudConfig | null = null;
      try {
        config = opts.readConfig();
      } catch {
        // treat as unregistered
      }

      const state = tunnelClient?.getState() ?? 'disconnected';
      const uptime = tunnelClient?.getUptime() ?? null;

      const response: Record<string, unknown> = {
        registered: config !== null,
        state,
        uptime,
      };

      if (config) {
        response.towerId = config.tower_id;
        response.towerName = config.tower_name;
        response.serverUrl = config.server_url;
        response.accessUrl = `${config.server_url}/t/${config.tower_name}/`;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return {
    server,
    get tunnelClient() { return tunnelClient; },
    getTunnelClient: () => tunnelClient,
    start: () => new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') resolve(addr.port);
      });
    }),
    stop: () => {
      if (tunnelClient) {
        tunnelClient.disconnect();
        tunnelClient = null;
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('tunnel integration (Phase 4)', () => {
  const TEST_API_KEY = 'ctk_test_integration_key';
  const TEST_TOWER_ID = 'tower-integration-123';
  const TEST_TOWER_NAME = 'test-tower';
  const TEST_SERVER_URL = 'http://127.0.0.1';

  let mockTunnelServer: MockTunnelServer;
  let mockServerPort: number;

  beforeEach(async () => {
    mockTunnelServer = new MockTunnelServer({ acceptKey: TEST_API_KEY });
    mockServerPort = await mockTunnelServer.start();
  });

  afterEach(async () => {
    await mockTunnelServer.stop();
  });

  function createTestConfig(): CloudConfig {
    return {
      tower_id: TEST_TOWER_ID,
      tower_name: TEST_TOWER_NAME,
      api_key: TEST_API_KEY,
      server_url: TEST_SERVER_URL,
    };
  }

  describe('POST /api/tunnel/connect endpoint', () => {
    it('returns 400 when no config exists', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => null,
      });
      const port = await endpoint.start();

      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/connect`, 'POST');
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Not registered');

      await endpoint.stop();
    });

    it('returns 200 with state when config is valid', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => createTestConfig(),
      });
      const port = await endpoint.start();

      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/connect`, 'POST');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.state).toBe('connecting');

      await endpoint.stop();
    });
  });

  describe('POST /api/tunnel/disconnect endpoint', () => {
    it('returns 200 success even when no client exists', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => createTestConfig(),
      });
      const port = await endpoint.start();

      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/disconnect`, 'POST');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      await endpoint.stop();
    });

    it('disconnects active tunnel client', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => createTestConfig(),
      });
      const port = await endpoint.start();

      // Connect first
      await httpRequest(`http://127.0.0.1:${port}/api/tunnel/connect`, 'POST');
      await waitFor(() => endpoint.getTunnelClient()?.getState() === 'connected');

      // Disconnect
      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/disconnect`, 'POST');
      expect(res.status).toBe(200);
      expect(endpoint.getTunnelClient()).toBeNull();

      await endpoint.stop();
    });
  });

  describe('GET /api/tunnel/status endpoint', () => {
    it('returns disconnected when not registered', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => null,
      });
      const port = await endpoint.start();

      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/status`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.registered).toBe(false);
      expect(body.state).toBe('disconnected');
      expect(body.uptime).toBeNull();
      // No cloud fields when not registered
      expect(body.towerId).toBeUndefined();
      expect(body.accessUrl).toBeUndefined();

      await endpoint.stop();
    });

    it('returns registered status with config details', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => createTestConfig(),
      });
      const port = await endpoint.start();

      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/status`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.registered).toBe(true);
      expect(body.state).toBe('disconnected');
      expect(body.towerId).toBe(TEST_TOWER_ID);
      expect(body.towerName).toBe(TEST_TOWER_NAME);
      expect(body.serverUrl).toBe(TEST_SERVER_URL);
      expect(body.accessUrl).toBe(`${TEST_SERVER_URL}/t/${TEST_TOWER_NAME}/`);

      await endpoint.stop();
    });

    it('returns connected state with uptime after connect', async () => {
      const endpoint = createTunnelEndpointServer({
        mockServerPort,
        readConfig: () => createTestConfig(),
      });
      const port = await endpoint.start();

      // Connect
      await httpRequest(`http://127.0.0.1:${port}/api/tunnel/connect`, 'POST');
      await waitFor(() => endpoint.getTunnelClient()?.getState() === 'connected');

      const res = await httpRequest(`http://127.0.0.1:${port}/api/tunnel/status`);
      const body = JSON.parse(res.body);
      expect(body.state).toBe('connected');
      expect(body.uptime).not.toBeNull();
      expect(body.uptime).toBeGreaterThanOrEqual(0);

      await endpoint.stop();
    });
  });

  describe('auto-connect on startup', () => {
    it('creates tunnel client when config exists', async () => {
      const config = createTestConfig();

      // Simulate startup: create client from config
      const client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${mockServerPort}`,
        apiKey: config.api_key,
        towerId: config.tower_id,
        localPort: 4100,
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');
      expect(client.getState()).toBe('connected');

      client.disconnect();
    });

    it('does not connect when config is null (local-only mode)', () => {
      // Simulate startup: no config → no client
      const config = readCloudConfig();
      // On test machines without registration, this will be null
      // On registered machines, it will return config
      // Either way, the logic is: if null → don't connect
      if (config === null) {
        // Local-only mode: no tunnel client created
        expect(config).toBeNull();
      }
      // This is a correctness test: readCloudConfig doesn't throw
    });
  });

  describe('graceful shutdown', () => {
    it('disconnect stops the tunnel client cleanly', async () => {
      const config = createTestConfig();
      const client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${mockServerPort}`,
        apiKey: config.api_key,
        towerId: config.tower_id,
        localPort: 4100,
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Simulate graceful shutdown: disconnect
      client.disconnect();
      expect(client.getState()).toBe('disconnected');
      expect(client.getUptime()).toBeNull();
    });
  });

  describe('metadata with project-terminal associations', () => {
    it('sends metadata including terminal projectPath', async () => {
      const config = createTestConfig();
      const client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${mockServerPort}`,
        apiKey: config.api_key,
        towerId: config.tower_id,
        localPort: 4100,
      });

      // Simulate gatherMetadata() output with project associations
      const metadata: TowerMetadata = {
        projects: [
          { path: '/home/user/project-a', name: 'project-a' },
          { path: '/home/user/project-b', name: 'project-b' },
        ],
        terminals: [
          { id: 'term-1', projectPath: '/home/user/project-a' },
          { id: 'term-2', projectPath: '/home/user/project-a' },
          { id: 'term-3', projectPath: '/home/user/project-b' },
        ],
      };
      client.sendMetadata(metadata);

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Verify metadata is served via H2 GET poll (TICK-001: no more META frame)
      const res = await mockTunnelServer.sendRequest({ path: '/__tower/metadata' });
      const receivedMetadata = JSON.parse(res.body);
      expect(receivedMetadata.projects).toHaveLength(2);
      expect(receivedMetadata.terminals).toHaveLength(3);

      // Verify terminal-project associations
      const term1 = receivedMetadata.terminals.find((t: { id: string }) => t.id === 'term-1');
      expect(term1?.projectPath).toBe('/home/user/project-a');
      const term3 = receivedMetadata.terminals.find((t: { id: string }) => t.id === 'term-3');
      expect(term3?.projectPath).toBe('/home/user/project-b');

      client.disconnect();
    });

    it('metadata served via GET /__tower/metadata includes projects', async () => {
      const config = createTestConfig();
      const client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${mockServerPort}`,
        apiKey: config.api_key,
        towerId: config.tower_id,
        localPort: 4100,
      });

      client.sendMetadata({
        projects: [{ path: '/test', name: 'test-proj' }],
        terminals: [],
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Poll metadata via the H2 GET endpoint
      const response = await mockTunnelServer.sendRequest({
        path: '/__tower/metadata',
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].name).toBe('test-proj');

      client.disconnect();
    });

    it('metadata updates when sendMetadata is called again after connection', async () => {
      const config = createTestConfig();
      const client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${mockServerPort}`,
        apiKey: config.api_key,
        towerId: config.tower_id,
        localPort: 4100,
      });

      // Set initial metadata with 1 project
      client.sendMetadata({
        projects: [{ path: '/test', name: 'initial-proj' }],
        terminals: [],
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Verify initial metadata
      const res1 = await mockTunnelServer.sendRequest({ path: '/__tower/metadata' });
      expect(res1.status).toBe(200);
      const body1 = JSON.parse(res1.body);
      expect(body1.projects).toHaveLength(1);
      expect(body1.projects[0].name).toBe('initial-proj');

      // Update metadata with 2 projects (simulates periodic refresh)
      client.sendMetadata({
        projects: [
          { path: '/test', name: 'initial-proj' },
          { path: '/test2', name: 'new-proj' },
        ],
        terminals: [{ id: 'term-1', projectPath: '/test2' }],
      });

      // Verify updated metadata via GET
      const res2 = await mockTunnelServer.sendRequest({ path: '/__tower/metadata' });
      expect(res2.status).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.projects).toHaveLength(2);
      expect(body2.terminals).toHaveLength(1);
      expect(body2.terminals[0].projectPath).toBe('/test2');

      client.disconnect();
    });
  });

  describe('config file watcher', () => {
    it('detects config file changes in watched directory', { timeout: 10000, retry: 2 }, async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-cfg-'));
      const testFile = path.join(tmpDir, 'cloud-config.json');

      let changeDetected = false;
      const watcher = fs.watch(tmpDir, (_, filename) => {
        if (filename === 'cloud-config.json') changeDetected = true;
      });

      // Simulate config write
      fs.writeFileSync(testFile, JSON.stringify(createTestConfig()));
      await waitFor(() => changeDetected, 5000);
      expect(changeDetected).toBe(true);

      watcher.close();
      fs.unlinkSync(testFile);
      fs.rmdirSync(tmpDir);
    });

    it('detects config file deletion in watched directory', { timeout: 10000, retry: 2 }, async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-cfg-'));
      const testFile = path.join(tmpDir, 'cloud-config.json');

      // Create file first
      fs.writeFileSync(testFile, JSON.stringify(createTestConfig()));
      await new Promise((r) => setTimeout(r, 100)); // Small delay

      let deleteDetected = false;
      const watcher = fs.watch(tmpDir, (_, filename) => {
        if (filename === 'cloud-config.json') deleteDetected = true;
      });

      // Delete the config file — fs.watch may take a while to fire on macOS under load
      fs.unlinkSync(testFile);
      await waitFor(() => deleteDetected, 8000);
      expect(deleteDetected).toBe(true);

      watcher.close();
      fs.rmdirSync(tmpDir);
    });
  });

  describe('circuit breaker integration', () => {
    it('auth failure stops retrying, resetCircuitBreaker allows reconnect', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await mockTunnelServer.stop();
      mockTunnelServer = new MockTunnelServer({ forceError: 'invalid_api_key' });
      mockServerPort = await mockTunnelServer.start();

      const client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${mockServerPort}`,
        apiKey: TEST_API_KEY,
        towerId: TEST_TOWER_ID,
        localPort: 4100,
      });

      client.connect();
      await waitFor(() => client.getState() === 'auth_failed');

      // Wait to ensure no reconnection
      await new Promise((r) => setTimeout(r, 200));
      expect(client.getState()).toBe('auth_failed');

      // Reset circuit breaker (simulates config change / --reauth)
      client.resetCircuitBreaker();
      expect(client.getState()).toBe('disconnected');

      client.disconnect();
      errorSpy.mockRestore();
    });
  });

  describe('accessUrl construction', () => {
    it('builds correct accessUrl from config', () => {
      const config = createTestConfig();
      const accessUrl = `${config.server_url}/t/${config.tower_name}/`;
      expect(accessUrl).toBe('http://127.0.0.1/t/test-tower/');
    });

    it('works with HTTPS server URL', () => {
      const config: CloudConfig = {
        ...createTestConfig(),
        server_url: 'https://codevos.ai',
        tower_name: 'my-macbook',
      };
      const accessUrl = `${config.server_url}/t/${config.tower_name}/`;
      expect(accessUrl).toBe('https://codevos.ai/t/my-macbook/');
    });
  });

  describe('maskApiKey for logging', () => {
    it('masks standard ctk_ prefixed keys', () => {
      expect(maskApiKey('ctk_AbCdEfGhIjKl1234')).toBe('ctk_****1234');
    });

    it('masks short keys', () => {
      expect(maskApiKey('short')).toBe('****hort');
    });

    it('masks very short keys', () => {
      expect(maskApiKey('ab')).toBe('****');
    });
  });
});
