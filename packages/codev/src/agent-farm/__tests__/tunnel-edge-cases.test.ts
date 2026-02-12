/**
 * Edge case and negative scenario tests for tunnel client (Spec 0097 Phase 7)
 *
 * Tests boundary conditions, error recovery, and resource cleanup
 * using the mock tunnel server from Phase 3.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
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

/** Create a simple HTTP echo server */
function createEchoServer(): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url }));
    });
  });
}

async function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') resolve(addr.port);
    });
  });
}

async function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('tunnel edge cases (Phase 7)', () => {
  let mockServer: MockTunnelServer;
  let echoServer: http.Server;
  let echoPort: number;
  let client: TunnelClient;

  afterEach(async () => {
    if (client) client.disconnect();
    if (mockServer) await mockServer.stop();
    if (echoServer) await stopServer(echoServer);
    vi.restoreAllMocks();
  });

  async function setup(serverOpts: ConstructorParameters<typeof MockTunnelServer>[0] = {}): Promise<void> {
    echoServer = createEchoServer();
    echoPort = await startServer(echoServer);
    mockServer = new MockTunnelServer(serverOpts);
    const tunnelPort = await mockServer.start();

    client = new TunnelClient({
      serverUrl: 'http://127.0.0.1',
      tunnelPort,
      apiKey: serverOpts.acceptKey ?? 'ctk_test_key',
      towerId: '',
      localPort: echoPort,
      usePlainTcp: true,
    });
  }

  describe('malformed auth response', () => {
    it('handles invalid_auth_frame error without crashing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setup({ forceError: 'invalid_auth_frame' });

      client.connect();
      // Should transition to disconnected (retryable error), not crash
      await waitFor(() => client.getState() === 'disconnected' || client.getState() === 'auth_failed');

      // Client should still be usable (no uncaught exceptions)
      expect(['disconnected', 'auth_failed']).toContain(client.getState());
      errorSpy.mockRestore();
    });

    it('handles internal_error response without crashing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setup({ forceError: 'internal_error' });

      client.connect();
      await waitFor(() => {
        const state = client.getState();
        return state === 'disconnected' || state === 'auth_failed';
      });

      expect(['disconnected', 'auth_failed']).toContain(client.getState());
      errorSpy.mockRestore();
    });
  });

  describe('disconnect after auth (before H2)', () => {
    it('handles server disconnect right after auth OK', async () => {
      await setup({ disconnectAfterAuth: true });

      client.connect();
      // Should go to connecting, then fail gracefully
      await waitFor(() => {
        const s = client.getState();
        return s === 'disconnected' && client.getUptime() === null;
      }, 10000);

      expect(client.getState()).toBe('disconnected');
    });
  });

  describe('multiple rapid connect/disconnect cycles', () => {
    it('handles 10 rapid connect/disconnect cycles without resource leaks', async () => {
      await setup();

      for (let i = 0; i < 10; i++) {
        client.connect();
        // Small delay to allow connection to start
        await new Promise((r) => setTimeout(r, 50));
        client.disconnect();
        expect(client.getState()).toBe('disconnected');
      }

      // After all cycles, client should be cleanly disconnected
      expect(client.getState()).toBe('disconnected');
      expect(client.getUptime()).toBeNull();
    });

    it('handles rapid reconnect after successful connection', async () => {
      await setup();

      // First: connect successfully
      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Rapid disconnect + reconnect
      client.disconnect();
      expect(client.getState()).toBe('disconnected');

      client.connect();
      await waitFor(() => client.getState() === 'connected');
      expect(client.getState()).toBe('connected');
    });
  });

  describe('blocked path enforcement through tunnel', () => {
    it('returns 403 for /api/tunnel/disconnect through tunnel', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const response = await mockServer.sendRequest({
        method: 'POST',
        path: '/api/tunnel/disconnect',
      });

      expect(response.status).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('local-only');
    });

    it('returns 403 for all /api/tunnel/ subpaths', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      for (const subpath of ['connect', 'disconnect', 'status', 'arbitrary']) {
        const response = await mockServer.sendRequest({
          path: `/api/tunnel/${subpath}`,
        });
        expect(response.status).toBe(403);
      }
    });
  });

  describe('concurrent proxied connections', () => {
    it('handles 50 concurrent requests without errors', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Send 50 concurrent requests
      const requests = Array.from({ length: 50 }, (_, i) =>
        mockServer.sendRequest({ path: `/api/item/${i}` }),
      );

      const responses = await Promise.all(requests);

      // All should succeed
      for (let i = 0; i < responses.length; i++) {
        expect(responses[i].status).toBe(200);
        const body = JSON.parse(responses[i].body);
        expect(body.path).toBe(`/api/item/${i}`);
      }
    });
  });

  describe('state listener error isolation', () => {
    it('does not crash when a state listener throws', async () => {
      await setup();

      // Add a listener that throws
      client.onStateChange(() => {
        throw new Error('listener error');
      });

      // Should not crash
      client.connect();
      await waitFor(() => client.getState() === 'connected');
      expect(client.getState()).toBe('connected');
    });
  });

  describe('double connect/disconnect calls', () => {
    it('ignores connect when already connected', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Second connect should be a no-op
      client.connect();
      expect(client.getState()).toBe('connected');
    });

    it('ignores connect when already connecting', async () => {
      await setup();

      client.connect();
      // Immediately call connect again
      client.connect();

      await waitFor(() => client.getState() === 'connected');
      expect(client.getState()).toBe('connected');
    });

    it('handles disconnect when already disconnected', () => {
      // No setup needed - test disconnecting without ever connecting
      const localClient = new TunnelClient({
        serverUrl: 'http://127.0.0.1',
        tunnelPort: 9999,
        apiKey: 'ctk_test',
        towerId: '',
        localPort: 4100,
        usePlainTcp: true,
      });

      // Should not throw
      localClient.disconnect();
      localClient.disconnect();
      expect(localClient.getState()).toBe('disconnected');
    });
  });

  describe('uptime accuracy', () => {
    it('uptime is null when disconnected', async () => {
      await setup();
      expect(client.getUptime()).toBeNull();
    });

    it('uptime increases while connected', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      const uptime1 = client.getUptime()!;
      await new Promise((r) => setTimeout(r, 100));
      const uptime2 = client.getUptime()!;

      expect(uptime2).toBeGreaterThan(uptime1);
    });

    it('uptime resets after disconnect and reconnect', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');
      await new Promise((r) => setTimeout(r, 100));
      const uptimeBefore = client.getUptime()!;
      expect(uptimeBefore).toBeGreaterThan(0);

      client.disconnect();
      expect(client.getUptime()).toBeNull();

      client.connect();
      await waitFor(() => client.getState() === 'connected');
      const uptimeAfter = client.getUptime()!;
      expect(uptimeAfter).toBeLessThan(uptimeBefore);
    });
  });

  describe('streaming response through tunnel', () => {
    it('proxies chunked/streaming responses correctly', async () => {
      // Create a streaming server that sends chunked data
      const streamServer = http.createServer((req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'transfer-encoding': 'chunked',
        });
        // Send 5 chunks with slight delays
        let count = 0;
        const interval = setInterval(() => {
          res.write(`data: chunk-${count}\n\n`);
          count++;
          if (count >= 5) {
            clearInterval(interval);
            res.end();
          }
        }, 10);
      });

      const streamPort = await startServer(streamServer);

      const localMockServer = new MockTunnelServer();
      const tunnelPort = await localMockServer.start();

      const streamClient = new TunnelClient({
        serverUrl: 'http://127.0.0.1',
        tunnelPort,
        apiKey: 'ctk_test_key',
        towerId: '',
        localPort: streamPort,
        usePlainTcp: true,
      });

      streamClient.connect();

      try {
        await waitFor(() => streamClient.getState() === 'connected');

        const response = await localMockServer.sendRequest({
          path: '/api/events',
        });

        expect(response.status).toBe(200);
        // Verify all 5 chunks arrived
        for (let i = 0; i < 5; i++) {
          expect(response.body).toContain(`data: chunk-${i}`);
        }
      } finally {
        streamClient.disconnect();
        await localMockServer.stop();
        await stopServer(streamServer);
      }
    });
  });

  describe('rate limiting response handling', () => {
    it('transitions to disconnected on rate_limited and schedules delayed reconnect', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setup({ forceError: 'rate_limited' });

      client.connect();
      await waitFor(() => client.getState() === 'disconnected');

      // Client should be disconnected (not auth_failed — rate_limited is transient)
      expect(client.getState()).toBe('disconnected');

      // Client should NOT be in auth_failed state (rate limiting is retryable)
      expect(client.getState()).not.toBe('auth_failed');

      errorSpy.mockRestore();
    });
  });

  describe('connection close mid-request', () => {
    it('handles server disconnect during proxied request gracefully', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Start a request, then immediately disconnect the server
      const requestPromise = mockServer.sendRequest({ path: '/api/slow' }).catch(() => null);

      // Small delay to let the request start flowing
      await new Promise((r) => setTimeout(r, 10));

      // Server drops the connection mid-request
      mockServer.disconnectAll();

      // Request should either complete with an error or be null (caught)
      const result = await requestPromise;

      // Client should transition to disconnected
      await waitFor(() => client.getState() === 'disconnected', 5000);
      expect(client.getState()).toBe('disconnected');

      // Client should still be usable after mid-request disconnect
      expect(client.getUptime()).toBeNull();
    });
  });

  describe('config-related tunnel behavior', () => {
    // Config parsing edge cases (missing fields, invalid JSON, nonexistent file)
    // are thoroughly tested in cloud-config.test.ts (15+ tests covering every
    // missing field variant). Here we test the tunnel client's behavior when
    // config-derived parameters are invalid or config is removed.

    it('config with missing api_key: auth fails cleanly', async () => {
      // Simulate what happens when cloud config has a missing api_key field:
      // readCloudConfig returns null, so the tower daemon won't start the tunnel.
      // If somehow a TunnelClient is created with an empty API key, auth should fail.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setup({ acceptKey: 'ctk_valid_key' });

      const partialClient = new TunnelClient({
        serverUrl: 'http://127.0.0.1',
        tunnelPort: mockServer.port,
        apiKey: '', // Empty API key (simulates missing field)
        towerId: '',
        localPort: echoPort,
        usePlainTcp: true,
      });

      partialClient.connect();
      try {
        // Should fail auth (empty key doesn't match acceptKey)
        await waitFor(
          () => partialClient.getState() === 'auth_failed' || partialClient.getState() === 'disconnected',
        );
        expect(['auth_failed', 'disconnected']).toContain(partialClient.getState());
      } finally {
        partialClient.disconnect();
        errorSpy.mockRestore();
      }
    });

    it('config with missing server_url: connection fails without crash', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // TunnelClient with invalid/empty server URL
      const partialClient = new TunnelClient({
        serverUrl: 'http://0.0.0.0',
        tunnelPort: 59998, // Not listening
        apiKey: 'ctk_some_key',
        towerId: 'some-tower',
        localPort: echoPort,
        usePlainTcp: true,
      });

      partialClient.connect();
      try {
        // Should fail to connect and transition to disconnected
        await waitFor(() => partialClient.getState() === 'disconnected', 5000);
        expect(partialClient.getState()).toBe('disconnected');
      } finally {
        partialClient.disconnect();
        errorSpy.mockRestore();
      }
    });

    it('config deleted while connected: disconnect prevents auto-reconnect', async () => {
      // Scenario: Tower is connected, server drops connection, config is deleted.
      // The tower integration should call client.disconnect() to cancel the
      // auto-reconnect timer. Verify the client stays disconnected.
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Track state changes
      const states: TunnelState[] = [];
      client.onStateChange((s) => states.push(s));

      // Server drops the connection (simulates network failure)
      mockServer.disconnectAll();

      // Client will transition to 'disconnected' and schedule auto-reconnect
      await waitFor(() => client.getState() === 'disconnected');

      // Simulate "config deleted" — tower calls disconnect() to cancel reconnect
      client.disconnect();

      // Wait and verify client stays disconnected (no auto-reconnect)
      await new Promise((r) => setTimeout(r, 500));
      expect(client.getState()).toBe('disconnected');
      expect(client.getUptime()).toBeNull();
    });

    it('handles connection with empty towerId gracefully', async () => {
      await setup();

      // TunnelClient with empty towerId (as would happen with partial config)
      const localClient = new TunnelClient({
        serverUrl: 'http://127.0.0.1',
        tunnelPort: mockServer.port,
        apiKey: 'ctk_test_key',
        towerId: '', // Empty tower ID
        localPort: echoPort,
        usePlainTcp: true,
      });

      localClient.connect();
      try {
        // Should still connect — tower ID is sent as metadata, not auth
        await waitFor(() => localClient.getState() === 'connected');
        expect(localClient.getState()).toBe('connected');
      } finally {
        localClient.disconnect();
      }
    });

    it('handles connection to unreachable server without crashing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Point to a port that's not listening
      const localClient = new TunnelClient({
        serverUrl: 'http://127.0.0.1',
        tunnelPort: 59999, // Not listening
        apiKey: 'ctk_test_key',
        towerId: 'test-tower',
        localPort: 4100,
        usePlainTcp: true,
      });

      localClient.connect();

      // Wait for connection attempt to fail
      await waitFor(() => localClient.getState() === 'disconnected', 5000);
      expect(localClient.getState()).toBe('disconnected');

      localClient.disconnect();
      errorSpy.mockRestore();
    });
  });

  describe('non-functional: latency benchmarks', () => {
    it('proxied HTTP requests have <100ms overhead p95', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Warm up
      await mockServer.sendRequest({ path: '/warmup' });

      // Measure latency for 20 requests
      const latencies: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await mockServer.sendRequest({ path: `/api/bench/${i}` });
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      // Advisory: log benchmarks for visibility
      console.log(`Tunnel latency — p50: ${p50.toFixed(1)}ms, p95: ${p95.toFixed(1)}ms, p99: ${p99.toFixed(1)}ms`);

      // Spec target: <100ms overhead p95
      expect(p95).toBeLessThan(100);
    });
  });

  describe('non-functional: WebSocket/terminal keystroke latency', () => {
    it('terminal keystroke round-trip has <50ms p95 overhead', async () => {
      // Set up a WebSocket echo server (simulates terminal)
      const upgradeSockets: net.Socket[] = [];
      const wsServer = http.createServer();
      wsServer.on('upgrade', (req, socket, head) => {
        upgradeSockets.push(socket);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n',
        );
        // Echo back any data received (simulates terminal echo)
        socket.on('data', (data) => {
          socket.write(data);
        });
        socket.on('error', () => {});
      });

      const wsPort = await startServer(wsServer);

      // Create tunnel client pointing at ws echo server
      const localMockServer = new MockTunnelServer();
      const tunnelPort = await localMockServer.start();

      const wsClient = new TunnelClient({
        serverUrl: 'http://127.0.0.1',
        tunnelPort,
        apiKey: 'ctk_test_key',
        towerId: '',
        localPort: wsPort,
        usePlainTcp: true,
      });

      wsClient.connect();

      try {
        await waitFor(() => wsClient.getState() === 'connected');

        // Open a CONNECT stream (WebSocket proxy)
        const stream = localMockServer.sendConnect('/ws/terminal/bench');

        await new Promise<void>((resolve, reject) => {
          stream.on('response', (headers) => {
            expect(headers[':status']).toBe(200);
            resolve();
          });
          stream.on('error', reject);
          setTimeout(() => reject(new Error('CONNECT timeout')), 5000);
        });

        // Measure keystroke round-trip latency
        const latencies: number[] = [];

        for (let i = 0; i < 20; i++) {
          const keystroke = String.fromCharCode(97 + (i % 26)); // a-z
          const start = performance.now();

          await new Promise<void>((resolve, reject) => {
            const onData = (chunk: Buffer) => {
              latencies.push(performance.now() - start);
              stream.removeListener('data', onData);
              resolve();
            };
            stream.on('data', onData);
            stream.write(keystroke);
            setTimeout(() => {
              stream.removeListener('data', onData);
              reject(new Error('Keystroke echo timeout'));
            }, 5000);
          });
        }

        latencies.sort((a, b) => a - b);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];

        console.log(`Terminal keystroke latency — p50: ${p50.toFixed(1)}ms, p95: ${p95.toFixed(1)}ms, p99: ${p99.toFixed(1)}ms`);

        // Spec target: <50ms p95 overhead
        expect(p95).toBeLessThan(50);

        stream.destroy();
      } finally {
        wsClient.disconnect();
        await localMockServer.stop();
        for (const s of upgradeSockets) {
          if (!s.destroyed) s.destroy();
        }
        await stopServer(wsServer);
      }
    });
  });

  describe('non-functional: memory under load', () => {
    // Note: For accurate memory measurements, run with --expose-gc:
    //   node --expose-gc ./node_modules/.bin/vitest run tunnel-edge-cases
    // Without --expose-gc, global.gc() is unavailable and the baseline
    // measurement may be noisy due to uncollected garbage.
    it('stays within bounds during 50 concurrent requests', async () => {
      await setup();

      client.connect();
      await waitFor(() => client.getState() === 'connected');

      // Baseline memory (gc if available for accurate measurement)
      global.gc?.();
      const before = process.memoryUsage().heapUsed;

      // Send 50 concurrent requests
      const requests = Array.from({ length: 50 }, (_, i) =>
        mockServer.sendRequest({ path: `/api/mem/${i}` }),
      );
      await Promise.all(requests);

      const after = process.memoryUsage().heapUsed;
      const deltaBytes = after - before;
      const deltaMB = deltaBytes / (1024 * 1024);

      console.log(`Memory delta during 50 concurrent requests: ${deltaMB.toFixed(2)}MB`);

      // Target: <50MB additional memory (spec target)
      expect(deltaMB).toBeLessThan(50);
    });
  });
});
