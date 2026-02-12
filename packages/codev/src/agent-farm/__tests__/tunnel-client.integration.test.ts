/**
 * Integration tests for tunnel-client with mock tunnel server (Spec 0097 Phase 3)
 *
 * Tests the full tunnel connection flow: auth handshake, HTTP proxying,
 * path blocklist, circuit breaker, and reconnection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { MockTunnelServer } from './helpers/mock-tunnel-server.js';
import { TunnelClient, type TunnelState } from '../lib/tunnel-client.js';

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

/** Create a simple HTTP server that echoes requests */
function createEchoServer(): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'true' });
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          headers: req.headers,
          body,
        }),
      );
    });
  });
}

/** Start a server on a random port and return the port */
async function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        resolve(addr.port);
      }
    });
  });
}

/** Stop a server */
async function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe('tunnel-client integration', () => {
  let mockServer: MockTunnelServer;
  let echoServer: http.Server;
  let echoPort: number;
  let client: TunnelClient;
  const stateChanges: Array<{ state: TunnelState; prev: TunnelState }> = [];

  beforeEach(async () => {
    stateChanges.length = 0;

    // Start echo HTTP server (simulates localhost:4100)
    echoServer = createEchoServer();
    echoPort = await startServer(echoServer);
  });

  afterEach(async () => {
    if (client) client.disconnect();
    if (mockServer) await mockServer.stop();
    await stopServer(echoServer);
    vi.restoreAllMocks();
  });

  async function setupTunnel(serverOpts: ConstructorParameters<typeof MockTunnelServer>[0] = {}): Promise<void> {
    mockServer = new MockTunnelServer(serverOpts);
    const port = await mockServer.start();

    client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      apiKey: serverOpts.acceptKey ?? 'ctk_test_key',
      towerId: '',
      localPort: echoPort,
    });

    client.onStateChange((state, prev) => {
      stateChanges.push({ state, prev });
    });
  }

  describe('auth handshake', () => {
    it('connects successfully with valid key', async () => {
      await setupTunnel({ acceptKey: 'ctk_test_key' });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      expect(client.getState()).toBe('connected');
      expect(stateChanges).toContainEqual({ state: 'connecting', prev: 'disconnected' });
      expect(stateChanges).toContainEqual({ state: 'connected', prev: 'connecting' });
    });

    it('transitions through connecting state', async () => {
      await setupTunnel();

      client.connect();
      // Should go through connecting first
      await waitFor(() => stateChanges.some((s) => s.state === 'connecting'));
      await waitFor(() => client.getState() === 'connected');
    });

    it('reports uptime after connection', async () => {
      await setupTunnel();

      expect(client.getUptime()).toBeNull();
      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const uptime = client.getUptime();
      expect(uptime).not.toBeNull();
      expect(uptime!).toBeGreaterThanOrEqual(0);
      expect(uptime!).toBeLessThan(5000);
    });
  });

  describe('circuit breaker', () => {
    it('sets auth_failed state on invalid API key', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setupTunnel({ forceError: 'invalid_api_key' });

      client.connect();
      await waitFor(() => client.getState() === 'auth_failed');

      expect(client.getState()).toBe('auth_failed');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('API key is invalid or revoked'),
      );
      errorSpy.mockRestore();
    });

    it('does not retry after auth failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setupTunnel({ forceError: 'invalid_api_key' });

      client.connect();
      await waitFor(() => client.getState() === 'auth_failed');

      // Wait a bit to ensure no reconnection attempt
      await new Promise((r) => setTimeout(r, 200));

      // State should still be auth_failed
      expect(client.getState()).toBe('auth_failed');
      // Should only have gone through connecting → auth_failed
      const authFailedCount = stateChanges.filter((s) => s.state === 'auth_failed').length;
      expect(authFailedCount).toBe(1);
      errorSpy.mockRestore();
    });

    it('can be reset to allow reconnection', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setupTunnel({ forceError: 'invalid_api_key' });

      client.connect();
      await waitFor(() => client.getState() === 'auth_failed');

      client.resetCircuitBreaker();
      expect(client.getState()).toBe('disconnected');
      errorSpy.mockRestore();
    });
  });

  describe('rate limiting', () => {
    it('retries after rate_limited response (stays disconnected, not auth_failed)', async () => {
      await setupTunnel({ forceError: 'rate_limited' });

      client.connect();
      await waitFor(() => client.getState() === 'disconnected' && stateChanges.length >= 2);

      // Should have gone connecting → disconnected (not auth_failed)
      expect(client.getState()).toBe('disconnected');
      expect(stateChanges).toContainEqual({ state: 'connecting', prev: 'disconnected' });
      expect(stateChanges).toContainEqual({ state: 'disconnected', prev: 'connecting' });
      // Should NOT have triggered circuit breaker
      const authFailed = stateChanges.filter((s) => s.state === 'auth_failed');
      expect(authFailed).toHaveLength(0);
    });

  });

  describe('HTTP proxying', () => {
    it('proxies GET request to local server', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        path: '/api/state',
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.method).toBe('GET');
      expect(body.path).toBe('/api/state');
    });

    it('proxies POST request with body', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        method: 'POST',
        path: '/api/launch',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: '/test' }),
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.method).toBe('POST');
      expect(body.body).toBe('{"projectPath":"/test"}');
    });

    it('preserves response headers (filtering hop-by-hop)', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({ path: '/test' });

      expect(response.headers['x-echo']).toBe('true');
      expect(response.headers['content-type']).toBe('application/json');
      // Hop-by-hop headers should not be present
      expect(response.headers['connection']).toBeUndefined();
      expect(response.headers['transfer-encoding']).toBeUndefined();
    });
  });

  describe('path blocklist', () => {
    it('returns 403 for /api/tunnel/connect', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        method: 'POST',
        path: '/api/tunnel/connect',
      });

      expect(response.status).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('local-only');
    });

    it('returns 403 for /api/tunnel/disconnect', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        method: 'POST',
        path: '/api/tunnel/disconnect',
      });

      expect(response.status).toBe(403);
    });

    it('returns 403 for /api/tunnel/status', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        path: '/api/tunnel/status',
      });

      expect(response.status).toBe(403);
    });

    it('allows /api/state through (not in blocklist)', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        path: '/api/state',
      });

      expect(response.status).toBe(200);
    });
  });

  describe('reconnection', () => {
    it('reconnects after server disconnects', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Simulate disconnect
      mockServer.disconnectAll();
      await waitFor(() => client.getState() === 'disconnected');

      // Start a new mock server on the same port
      const oldPort = mockServer.port;
      await mockServer.stop();
      mockServer = new MockTunnelServer();
      await new Promise<void>((resolve, reject) => {
        (mockServer as any).httpServer.listen(oldPort, '127.0.0.1', () => resolve());
        (mockServer as any).httpServer.on('error', reject);
      });
      mockServer.port = oldPort;

      // Client should reconnect automatically
      await waitFor(() => client.getState() === 'connected', 10000);
      expect(client.getState()).toBe('connected');
    });
  });

  describe('disconnect', () => {
    it('gracefully disconnects', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      client.disconnect();
      expect(client.getState()).toBe('disconnected');
      expect(client.getUptime()).toBeNull();
    });

    it('does not reconnect after disconnect', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      client.disconnect();

      // Wait to ensure no reconnection
      await new Promise((r) => setTimeout(r, 500));
      expect(client.getState()).toBe('disconnected');
    });

    it('can reconnect after deliberate disconnect', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      client.disconnect();
      expect(client.getState()).toBe('disconnected');

      // Re-connect should work
      client.connect();
      await waitFor(() => client.getState() === 'connected');
      expect(client.getState()).toBe('connected');
    });
  });

  describe('metadata', () => {
    it('serves initial metadata via GET /__tower/metadata after connect', async () => {
      await setupTunnel();

      // Set metadata before connecting — served via H2 GET poll
      client.sendMetadata({
        projects: [{ path: '/test/project', name: 'test' }],
        terminals: [{ id: 'term-1', projectPath: '/test/project' }],
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Fetch metadata via H2 GET (how codevos.ai polls)
      const res = await mockServer.sendRequest({ path: '/__tower/metadata' });
      const metadata = JSON.parse(res.body);
      expect(metadata.projects).toHaveLength(1);
      expect(metadata.projects[0].name).toBe('test');
      expect(metadata.terminals).toHaveLength(1);
    });

    it('serves empty metadata when none is set', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Fetch metadata — should be empty defaults
      const res = await mockServer.sendRequest({ path: '/__tower/metadata' });
      const metadata = JSON.parse(res.body);
      expect(metadata.projects).toEqual([]);
      expect(metadata.terminals).toEqual([]);
    });

    it('serves metadata via GET /__tower/metadata for polling', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Update metadata after connection (will be served on GET poll)
      client.sendMetadata({
        projects: [{ path: '/updated', name: 'updated' }],
        terminals: [],
      });

      const response = await mockServer.sendRequest({
        path: '/__tower/metadata',
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].name).toBe('updated');
    });

    it('pushes metadata via outbound HTTP POST on connect', async () => {
      await setupTunnel();

      client.sendMetadata({
        projects: [{ path: '/pushed', name: 'pushed-project' }],
        terminals: [],
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Wait for the async HTTP POST to arrive
      await waitFor(() => mockServer.lastPushedMetadata !== null);

      expect(mockServer.lastPushedMetadata!.projects).toHaveLength(1);
      expect(mockServer.lastPushedMetadata!.projects[0].name).toBe('pushed-project');
    });

    it('pushes metadata via HTTP POST when sendMetadata called while connected', async () => {
      await setupTunnel();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Clear any initial push
      mockServer.lastPushedMetadata = null;

      client.sendMetadata({
        projects: [{ path: '/live-update', name: 'live' }],
        terminals: [{ id: 't1', projectPath: '/live-update' }],
      });

      await waitFor(() => mockServer.lastPushedMetadata !== null);

      expect(mockServer.lastPushedMetadata!.projects[0].name).toBe('live');
      expect(mockServer.lastPushedMetadata!.terminals).toHaveLength(1);
    });
  });

  describe('WebSocket CONNECT proxy', () => {
    let wsServer: http.Server;
    let wsPort: number;
    let upgradeSockets: net.Socket[];

    beforeEach(async () => {
      upgradeSockets = [];
      // Create a simple WebSocket-like echo server using raw HTTP upgrade
      wsServer = http.createServer();
      wsServer.on('upgrade', (req, socket, head) => {
        upgradeSockets.push(socket);
        // Accept the WebSocket upgrade with a minimal response
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n',
        );

        // Echo back any data received
        socket.on('data', (data) => {
          socket.write(data);
        });

        socket.on('error', () => {
          // Ignore errors
        });
      });

      wsPort = await startServer(wsServer);
    });

    afterEach(async () => {
      // Destroy upgrade sockets first (they keep the server alive)
      for (const s of upgradeSockets) {
        if (!s.destroyed) s.destroy();
      }
      await stopServer(wsServer);
    });

    it('proxies WebSocket CONNECT with bidirectional data', async () => {
      // Use the WebSocket server port as the local port for this test
      mockServer = new MockTunnelServer();
      const port = await mockServer.start();

      client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${port}`,
        apiKey: 'ctk_test_key',
        towerId: '',
        localPort: wsPort,
      });

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Send a CONNECT request through the tunnel
      const stream = mockServer.sendConnect('/ws/terminal/test');

      // Wait for the 200 response
      await new Promise<void>((resolve, reject) => {
        stream.on('response', (headers) => {
          expect(headers[':status']).toBe(200);
          resolve();
        });
        stream.on('error', reject);
        setTimeout(() => reject(new Error('CONNECT timeout')), 5000);
      });

      // Send data through the stream and expect echo
      const echoed = await new Promise<string>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          resolve(chunk.toString('utf-8'));
        });
        stream.write('hello tunnel');
        setTimeout(() => reject(new Error('Echo timeout')), 5000);
      });

      expect(echoed).toBe('hello tunnel');
      stream.destroy();
    });
  });
});
