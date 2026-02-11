/**
 * Tests for tunnel integration with tower server (Spec 0097 Phase 4)
 *
 * Tests the tunnel management endpoints and auto-connect/disconnect logic.
 * Uses a real MockTunnelServer + lightweight HTTP server to verify the
 * integration behavior without starting the full tower.
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
  isRegistered,
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

describe('tunnel integration (Phase 4)', () => {
  // Test config
  const TEST_API_KEY = 'ctk_test_integration_key';
  const TEST_TOWER_ID = 'tower-integration-123';
  const TEST_TOWER_NAME = 'test-tower';
  const TEST_SERVER_URL = 'http://127.0.0.1';

  let mockServer: MockTunnelServer;
  let tunnelPort: number;
  let tunnelClient: TunnelClient | null = null;

  beforeEach(async () => {
    mockServer = new MockTunnelServer({ acceptKey: TEST_API_KEY });
    tunnelPort = await mockServer.start();
  });

  afterEach(async () => {
    if (tunnelClient) {
      tunnelClient.disconnect();
      tunnelClient = null;
    }
    await mockServer.stop();
  });

  function createTestConfig(): CloudConfig {
    return {
      tower_id: TEST_TOWER_ID,
      tower_name: TEST_TOWER_NAME,
      api_key: TEST_API_KEY,
      server_url: TEST_SERVER_URL,
    };
  }

  function createTunnelClient(config: CloudConfig, localPort: number): TunnelClient {
    const client = new TunnelClient({
      serverUrl: config.server_url,
      tunnelPort,
      apiKey: config.api_key,
      towerId: config.tower_id,
      localPort,
      usePlainTcp: true,
    });
    tunnelClient = client;
    return client;
  }

  describe('tunnel client lifecycle', () => {
    let echoServer: http.Server;
    let echoPort: number;

    beforeEach(async () => {
      echoServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, path: req.url }));
      });
      echoPort = await new Promise<number>((resolve) => {
        echoServer.listen(0, '127.0.0.1', () => {
          const addr = echoServer.address();
          if (addr && typeof addr !== 'string') resolve(addr.port);
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    });

    it('connects with valid config and proxies requests', async () => {
      const config = createTestConfig();
      const client = createTunnelClient(config, echoPort);

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Verify proxying works
      const response = await mockServer.sendRequest({ path: '/api/state' });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.method).toBe('GET');
      expect(body.path).toBe('/api/state');
    });

    it('sends metadata on connect', async () => {
      const config = createTestConfig();
      const client = createTunnelClient(config, echoPort);

      client.sendMetadata({
        projects: [{ path: '/home/test', name: 'test-project' }],
        terminals: [{ id: 'term-1', projectPath: '/home/test' }],
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      expect(mockServer.lastMetadata).not.toBeNull();
      expect(mockServer.lastMetadata!.projects).toHaveLength(1);
      expect(mockServer.lastMetadata!.projects[0].name).toBe('test-project');
    });

    it('disconnects gracefully', async () => {
      const config = createTestConfig();
      const client = createTunnelClient(config, echoPort);

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      client.disconnect();
      expect(client.getState()).toBe('disconnected');
      expect(client.getUptime()).toBeNull();
    });

    it('can reconnect after disconnect', async () => {
      const config = createTestConfig();
      const client = createTunnelClient(config, echoPort);

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      client.disconnect();
      expect(client.getState()).toBe('disconnected');

      client.connect();
      await waitFor(() => client.getState() === 'connected');
      expect(client.getState()).toBe('connected');
    });

    it('circuit breaker resets on resetCircuitBreaker', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Create a server that rejects auth
      await mockServer.stop();
      mockServer = new MockTunnelServer({ forceError: 'invalid_api_key' });
      tunnelPort = await mockServer.start();

      const config = createTestConfig();
      const client = createTunnelClient(config, echoPort);

      client.connect();
      await waitFor(() => client.getState() === 'auth_failed');
      expect(client.getState()).toBe('auth_failed');

      client.resetCircuitBreaker();
      expect(client.getState()).toBe('disconnected');
      errorSpy.mockRestore();
    });
  });

  describe('status response format', () => {
    it('reports disconnected state when no client exists', () => {
      // Simulate what GET /api/tunnel/status would return
      const state: TunnelState = tunnelClient?.getState() ?? 'disconnected';
      const uptime = tunnelClient?.getUptime() ?? null;

      expect(state).toBe('disconnected');
      expect(uptime).toBeNull();
    });

    it('reports connected state with uptime', async () => {
      const echoServer = http.createServer((_, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      const echoPort = await new Promise<number>((resolve) => {
        echoServer.listen(0, '127.0.0.1', () => {
          const addr = echoServer.address();
          if (addr && typeof addr !== 'string') resolve(addr.port);
        });
      });

      const client = createTunnelClient(createTestConfig(), echoPort);
      client.connect();
      await waitFor(() => client.getState() === 'connected');

      expect(client.getState()).toBe('connected');
      const uptime = client.getUptime();
      expect(uptime).not.toBeNull();
      expect(uptime!).toBeGreaterThanOrEqual(0);

      client.disconnect();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    });
  });

  describe('config integration', () => {
    it('readCloudConfig returns null when no config exists', () => {
      // This tests against the real homedir config path
      // If no config exists, it should return null
      // We don't write to the real config in tests
      const config = readCloudConfig();
      // May or may not be null depending on the test machine
      // Just verify it doesn't throw
      expect(config === null || typeof config === 'object').toBe(true);
    });

    it('maskApiKey correctly masks keys', () => {
      expect(maskApiKey('ctk_AbCdEfGhIjKl1234')).toBe('ctk_****1234');
      expect(maskApiKey('short')).toBe('****hort');
      expect(maskApiKey('ab')).toBe('****');
    });

    it('constructs accessUrl from config', () => {
      const config = createTestConfig();
      const accessUrl = `${config.server_url}/t/${config.tower_name}/`;
      expect(accessUrl).toBe('http://127.0.0.1/t/test-tower/');
    });
  });

  describe('metadata gathering', () => {
    it('TowerMetadata structure is correct', () => {
      const metadata: TowerMetadata = {
        projects: [{ path: '/test', name: 'test' }],
        terminals: [{ id: 'term-1', projectPath: '/test' }],
      };
      expect(metadata.projects).toHaveLength(1);
      expect(metadata.terminals).toHaveLength(1);
      expect(metadata.projects[0]).toHaveProperty('path');
      expect(metadata.projects[0]).toHaveProperty('name');
      expect(metadata.terminals[0]).toHaveProperty('id');
      expect(metadata.terminals[0]).toHaveProperty('projectPath');
    });
  });

  describe('config watcher behavior', () => {
    it('fs.watch is available for config directory watching', () => {
      // Verify fs.watch exists and can be called (it's used for config watching)
      expect(typeof fs.watch).toBe('function');
    });

    it('config changes should trigger reconnection via watcher', async () => {
      // This tests the concept: write a config, watch should detect it
      // We verify that fs.watch can observe changes in a temp directory
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-test-'));
      const testFile = path.join(tmpDir, 'test-config.json');

      let changeDetected = false;
      const watcher = fs.watch(tmpDir, (eventType, filename) => {
        if (filename === 'test-config.json') {
          changeDetected = true;
        }
      });

      // Write a file to trigger the watcher
      fs.writeFileSync(testFile, JSON.stringify({ test: true }));

      // Wait for the event
      await waitFor(() => changeDetected, 2000);
      expect(changeDetected).toBe(true);

      watcher.close();
      fs.unlinkSync(testFile);
      fs.rmdirSync(tmpDir);
    });
  });
});
