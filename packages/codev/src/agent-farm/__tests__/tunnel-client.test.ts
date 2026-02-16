/**
 * Unit tests for tunnel-client module (Spec 0097 Phase 3, Spec 0109)
 *
 * Tests pure functions: backoff calculation, path blocklist, hop-by-hop filtering
 * Tests heartbeat logic: ping/pong cycle, timeout, cleanup, race conditions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import {
  calculateBackoff,
  isBlockedPath,
  filterHopByHopHeaders,
  TunnelClient,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from '../lib/tunnel-client.js';
import { MockTunnelServer } from './helpers/mock-tunnel-server.js';

describe('tunnel-client unit tests', () => {
  describe('calculateBackoff', () => {
    // Use a fixed random function for deterministic tests
    const fixedRandom = () => 0.5; // Always returns 500ms jitter

    it('returns ~1500ms for first attempt (1000 + 500 jitter)', () => {
      expect(calculateBackoff(0, fixedRandom)).toBe(1500);
    });

    it('returns ~2500ms for second attempt (2000 + 500 jitter)', () => {
      expect(calculateBackoff(1, fixedRandom)).toBe(2500);
    });

    it('returns ~4500ms for third attempt (4000 + 500 jitter)', () => {
      expect(calculateBackoff(2, fixedRandom)).toBe(4500);
    });

    it('returns ~8500ms for fourth attempt', () => {
      expect(calculateBackoff(3, fixedRandom)).toBe(8500);
    });

    it('returns ~16500ms for fifth attempt', () => {
      expect(calculateBackoff(4, fixedRandom)).toBe(16500);
    });

    it('caps at 60000ms', () => {
      // 2^6 * 1000 = 64000, + 500 = 64500, capped at 60000
      expect(calculateBackoff(6, fixedRandom)).toBe(60000);
    });

    it('caps at 60000ms for higher attempts below 10', () => {
      expect(calculateBackoff(9, fixedRandom)).toBe(60000);
    });

    it('returns 300000ms (5 min) after 10 consecutive failures', () => {
      expect(calculateBackoff(10, fixedRandom)).toBe(300000);
    });

    it('returns 300000ms for attempts well beyond 10', () => {
      expect(calculateBackoff(50, fixedRandom)).toBe(300000);
    });

    it('jitter range is 0 to 999ms', () => {
      // Random = 0 → jitter = 0
      expect(calculateBackoff(0, () => 0)).toBe(1000);
      // Random = 0.999 → jitter = 999
      expect(calculateBackoff(0, () => 0.999)).toBe(1999);
    });

    it('uses Math.random by default (result within expected range)', () => {
      const result = calculateBackoff(0);
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThan(2000);
    });
  });

  describe('isBlockedPath', () => {
    it('blocks /api/tunnel/connect', () => {
      expect(isBlockedPath('/api/tunnel/connect')).toBe(true);
    });

    it('blocks /api/tunnel/disconnect', () => {
      expect(isBlockedPath('/api/tunnel/disconnect')).toBe(true);
    });

    it('blocks /api/tunnel/status', () => {
      expect(isBlockedPath('/api/tunnel/status')).toBe(true);
    });

    it('blocks /api/tunnel/ prefix with any suffix', () => {
      expect(isBlockedPath('/api/tunnel/anything')).toBe(true);
    });

    it('allows /api/workspaces', () => {
      expect(isBlockedPath('/api/workspaces')).toBe(false);
    });

    it('allows /api/state', () => {
      expect(isBlockedPath('/api/state')).toBe(false);
    });

    it('allows root path', () => {
      expect(isBlockedPath('/')).toBe(false);
    });

    it('allows /api/tunnel without trailing slash', () => {
      // Only paths starting with /api/tunnel/ are blocked
      expect(isBlockedPath('/api/tunnel')).toBe(false);
    });

    it('blocks percent-encoded slash bypass: /api%2Ftunnel/status', () => {
      expect(isBlockedPath('/api%2Ftunnel/status')).toBe(true);
    });

    it('blocks percent-encoded slash bypass: /api%2Ftunnel/connect', () => {
      expect(isBlockedPath('/api%2Ftunnel/connect')).toBe(true);
    });

    it('blocks case-variant encoding: /api%2ftunnel/status', () => {
      expect(isBlockedPath('/api%2ftunnel/status')).toBe(true);
    });

    it('blocks path with dot segments: /api/tunnel/../tunnel/status', () => {
      expect(isBlockedPath('/api/tunnel/../tunnel/status')).toBe(true);
    });

    it('blocks encoded tunnel path: /%61pi/tunnel/status', () => {
      // %61 = 'a', so /%61pi/tunnel/status decodes to /api/tunnel/status
      expect(isBlockedPath('/%61pi/tunnel/status')).toBe(true);
    });
  });

  describe('filterHopByHopHeaders', () => {
    it('removes connection header', () => {
      const result = filterHopByHopHeaders({ connection: 'keep-alive', 'content-type': 'text/html' });
      expect(result).toEqual({ 'content-type': 'text/html' });
    });

    it('removes keep-alive header', () => {
      const result = filterHopByHopHeaders({ 'keep-alive': 'timeout=5', host: 'localhost' });
      expect(result).toEqual({ host: 'localhost' });
    });

    it('removes transfer-encoding header', () => {
      const result = filterHopByHopHeaders({ 'transfer-encoding': 'chunked', 'content-length': '100' });
      expect(result).toEqual({ 'content-length': '100' });
    });

    it('removes all hop-by-hop headers', () => {
      const input = {
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'proxy-authenticate': 'Basic',
        'proxy-authorization': 'Basic abc',
        te: 'trailers',
        trailers: 'x-checksum',
        'transfer-encoding': 'chunked',
        upgrade: 'h2c',
        'content-type': 'application/json',
        'x-custom': 'value',
      };
      const result = filterHopByHopHeaders(input);
      expect(result).toEqual({
        'content-type': 'application/json',
        'x-custom': 'value',
      });
    });

    it('is case-insensitive for header names', () => {
      const result = filterHopByHopHeaders({ Connection: 'close', 'Content-Type': 'text/html' });
      // "Connection" lowercased is "connection" which is hop-by-hop
      // But our function uses key.toLowerCase(), so it works
      expect(result).toEqual({ 'Content-Type': 'text/html' });
    });

    it('preserves array-valued headers', () => {
      const result = filterHopByHopHeaders({ 'set-cookie': ['a=1', 'b=2'] });
      expect(result).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
    });

    it('skips undefined values', () => {
      const result = filterHopByHopHeaders({ 'content-type': 'text/html', 'x-missing': undefined });
      expect(result).toEqual({ 'content-type': 'text/html' });
    });

    it('returns empty object for empty input', () => {
      expect(filterHopByHopHeaders({})).toEqual({});
    });
  });
});

/**
 * Creates a mock WebSocket object with EventEmitter capabilities
 * for testing heartbeat logic.
 */
function createMockWs(): WebSocket & EventEmitter {
  const emitter = new EventEmitter();
  // Save original before overriding
  const originalRemoveAll = emitter.removeAllListeners.bind(emitter);
  const mock = Object.assign(emitter, {
    readyState: WebSocket.OPEN,
    ping: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn((event?: string) => {
      if (event) {
        originalRemoveAll(event);
      } else {
        originalRemoveAll();
      }
      return mock;
    }),
  });
  return mock as unknown as WebSocket & EventEmitter;
}

function createClient(): TunnelClient {
  return new TunnelClient({
    serverUrl: 'https://test.example.com',
    apiKey: 'ctk_test',
    towerId: 'test-tower',
    localPort: 4100,
  });
}

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends ping at PING_INTERVAL_MS intervals', () => {
    const client = createClient();
    const ws = createMockWs();

    // Set internal state so heartbeat can function
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    expect(ws.ping).not.toHaveBeenCalled();

    // Advance to first ping
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Emit pong to clear timeout
    ws.emit('pong');

    // Advance to second ping
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.ping).toHaveBeenCalledTimes(2);

    (client as any).stopHeartbeat();
  });

  it('clears timeout when pong is received (no reconnect)', () => {
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    // Trigger ping
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Emit pong before timeout
    ws.emit('pong');

    // Advance past pong timeout — should NOT trigger reconnect
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect((client as any).state).toBe('connected');

    (client as any).stopHeartbeat();
  });

  it('triggers reconnect on pong timeout with console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    // Trigger ping
    vi.advanceTimersByTime(PING_INTERVAL_MS);

    // Do NOT emit pong — let timeout fire
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);

    expect(warnSpy).toHaveBeenCalledWith('Tunnel heartbeat: pong timeout, reconnecting');
    expect((client as any).state).toBe('disconnected');
    // Verify reconnect was scheduled (scheduleReconnect sets reconnectTimer)
    expect((client as any).reconnectTimer).not.toBeNull();
  });

  it('stops timers on cleanup()', () => {
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    expect((client as any).pingInterval).not.toBeNull();

    (client as any).cleanup();

    expect((client as any).pingInterval).toBeNull();
    expect((client as any).pongTimeout).toBeNull();
    expect((client as any).heartbeatWs).toBeNull();
  });

  it('stops timers on disconnect()', () => {
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    expect((client as any).pingInterval).not.toBeNull();

    client.disconnect();

    expect((client as any).pingInterval).toBeNull();
    expect((client as any).pongTimeout).toBeNull();
    expect((client as any).heartbeatWs).toBeNull();
  });

  it('stale WebSocket guard: old ws timeout does not reconnect new connection', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient();
    const oldWs = createMockWs();
    const newWs = createMockWs();

    // Start heartbeat with old ws
    (client as any).ws = oldWs;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(oldWs);

    // Trigger ping on old ws — this arms a pong timeout
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(oldWs.ping).toHaveBeenCalledTimes(1);

    // Capture the pong timeout reference before replacing
    const oldPongTimeout = (client as any).pongTimeout;
    expect(oldPongTimeout).not.toBeNull();

    // Simulate new connection replacing the old one WITHOUT calling stopHeartbeat.
    // This mimics the race: old timeout is still pending while new ws is active.
    // We manually clear the interval to avoid new pings, but leave the old timeout armed.
    clearInterval((client as any).pingInterval);
    (client as any).pingInterval = null;
    (client as any).ws = newWs;
    (client as any).state = 'connected';

    // Old pong timeout fires — but oldWs !== this.ws (now newWs), so the guard prevents reconnect
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);

    expect(warnSpy).not.toHaveBeenCalled();
    expect((client as any).state).toBe('connected');

    // Clean up
    clearTimeout((client as any).pongTimeout);
    (client as any).pongTimeout = null;
  });

  it('duplicate startHeartbeat calls do not create duplicate timers or listeners', () => {
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';

    (client as any).startHeartbeat(ws);
    const firstInterval = (client as any).pingInterval;

    (client as any).startHeartbeat(ws);
    const secondInterval = (client as any).pingInterval;

    // The interval was replaced (old one cleared)
    expect(secondInterval).not.toBe(firstInterval);

    // Only one ping should fire after one interval
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Check that pong listener count is not accumulating
    expect(ws.listenerCount('pong')).toBe(1);

    (client as any).stopHeartbeat();
  });

  it('ws.ping() throw does not crash and pong timeout handles detection', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';

    // Make ping throw
    (ws.ping as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Socket in transitional state');
    });

    (client as any).startHeartbeat(ws);

    // Trigger ping — should not crash
    vi.advanceTimersByTime(PING_INTERVAL_MS);

    // Pong timeout should still be armed and fire
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledWith('Tunnel heartbeat: pong timeout, reconnecting');
    expect((client as any).state).toBe('disconnected');
  });

  it('concurrent close + timeout: only one reconnect', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    // Spy on scheduleReconnect to count calls
    const reconnectSpy = vi.spyOn(client as any, 'scheduleReconnect');

    // Trigger ping — arms a pong timeout
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect((client as any).pongTimeout).not.toBeNull();

    // Simulate native close event (as doConnect's ws.on('close') would do).
    // cleanup() calls stopHeartbeat() which clears the pong timeout,
    // then scheduleReconnect() sets exactly one reconnect timer.
    (client as any).cleanup();
    (client as any).setState('disconnected');
    (client as any).consecutiveFailures++;
    (client as any).scheduleReconnect();

    // The pong timeout was cleared by cleanup → stopHeartbeat
    expect((client as any).pongTimeout).toBeNull();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    // Clear the reconnect timer so advancing time doesn't trigger doConnect
    (client as any).clearReconnectTimer();

    // Advance past the pong timeout window — the cleared timeout must not fire.
    // This exercises the actual race: close already handled, pong timeout window
    // elapses, no second reconnect or warn is triggered.
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);

    // The heartbeat timeout was cleared by cleanup, so warn was never called
    // and scheduleReconnect was not called a second time
    expect(warnSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    // State is still disconnected — no second cleanup/reconnect cycle
    expect((client as any).state).toBe('disconnected');
  });

  it('normal pong does not produce any log output (silent success)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient();
    const ws = createMockWs();
    (client as any).ws = ws;
    (client as any).state = 'connected';
    (client as any).startHeartbeat(ws);

    // Trigger ping
    vi.advanceTimersByTime(PING_INTERVAL_MS);

    // Emit pong (success case)
    ws.emit('pong');

    // Advance past the would-be timeout
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);

    // No warn should have been called
    expect(warnSpy).not.toHaveBeenCalled();
    expect((client as any).state).toBe('connected');

    (client as any).stopHeartbeat();
  });
});

// === Integration tests (consolidated from tunnel-client.integration.test.ts) ===

/** Wait for a condition to be true within a timeout */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 10000,
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
function createIntegrationEchoServer(): http.Server {
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

describe('tunnel-client integration', () => {
  let mockServer: MockTunnelServer;
  let echoServer: http.Server;
  let echoPort: number;
  let integrationClient: TunnelClient;

  beforeEach(async () => {
    echoServer = createIntegrationEchoServer();
    echoPort = await startServer(echoServer);
  });

  afterEach(async () => {
    if (integrationClient) integrationClient.disconnect();
    if (mockServer) await mockServer.stop();
    await stopServer(echoServer);
    vi.restoreAllMocks();
  });

  async function setupTunnel(serverOpts: ConstructorParameters<typeof MockTunnelServer>[0] = {}): Promise<void> {
    mockServer = new MockTunnelServer(serverOpts);
    const port = await mockServer.start();

    integrationClient = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      apiKey: serverOpts.acceptKey ?? 'ctk_test_key',
      towerId: '',
      localPort: echoPort,
    });
  }

  describe('circuit breaker', () => {
    it('sets auth_failed state on invalid API key', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setupTunnel({ forceError: 'invalid_api_key' });

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'auth_failed');

      expect(integrationClient.getState()).toBe('auth_failed');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('API key is invalid or revoked'),
      );
      errorSpy.mockRestore();
    });

    it('does not retry after auth failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setupTunnel({ forceError: 'invalid_api_key' });

      const stateChanges: Array<{ state: string; prev: string }> = [];
      integrationClient.onStateChange((state, prev) => {
        stateChanges.push({ state, prev });
      });

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'auth_failed');

      // Wait a bit to ensure no reconnection attempt
      await new Promise((r) => setTimeout(r, 200));

      // State should still be auth_failed
      expect(integrationClient.getState()).toBe('auth_failed');
      const authFailedCount = stateChanges.filter((s) => s.state === 'auth_failed').length;
      expect(authFailedCount).toBe(1);
      errorSpy.mockRestore();
    });

    it('can be reset to allow reconnection', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setupTunnel({ forceError: 'invalid_api_key' });

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'auth_failed');

      integrationClient.resetCircuitBreaker();
      expect(integrationClient.getState()).toBe('disconnected');
      errorSpy.mockRestore();
    });
  });

  describe('HTTP proxying', () => {
    it('proxies GET request to local server', async () => {
      await setupTunnel();

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

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

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      const response = await mockServer.sendRequest({
        method: 'POST',
        path: '/api/launch',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: '/test' }),
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.method).toBe('POST');
      expect(body.body).toBe('{"workspacePath":"/test"}');
    });

    it('preserves response headers (filtering hop-by-hop)', async () => {
      await setupTunnel();

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      const response = await mockServer.sendRequest({ path: '/test' });

      expect(response.headers['x-echo']).toBe('true');
      expect(response.headers['content-type']).toBe('application/json');
      // Hop-by-hop headers should not be present
      expect(response.headers['connection']).toBeUndefined();
      expect(response.headers['transfer-encoding']).toBeUndefined();
    });
  });

  describe('reconnection', () => {
    it('reconnects after server disconnects', async () => {
      await setupTunnel();

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      // Simulate disconnect
      mockServer.disconnectAll();
      await waitFor(() => integrationClient.getState() === 'disconnected');

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
      await waitFor(() => integrationClient.getState() === 'connected', 10000);
      expect(integrationClient.getState()).toBe('connected');
    });
  });

  describe('metadata', () => {
    it('serves initial metadata via GET /__tower/metadata after connect', async () => {
      await setupTunnel();

      integrationClient.sendMetadata({
        workspaces: [{ path: '/test/project', name: 'test' }],
        terminals: [{ id: 'term-1', workspacePath: '/test/project' }],
      });

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      const res = await mockServer.sendRequest({ path: '/__tower/metadata' });
      const metadata = JSON.parse(res.body);
      expect(metadata.workspaces).toHaveLength(1);
      expect(metadata.workspaces[0].name).toBe('test');
      expect(metadata.terminals).toHaveLength(1);
    });

    it('serves empty metadata when none is set', async () => {
      await setupTunnel();

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      const res = await mockServer.sendRequest({ path: '/__tower/metadata' });
      const metadata = JSON.parse(res.body);
      expect(metadata.workspaces).toEqual([]);
      expect(metadata.terminals).toEqual([]);
    });

    it('serves metadata via GET /__tower/metadata for polling', async () => {
      await setupTunnel();

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      integrationClient.sendMetadata({
        workspaces: [{ path: '/updated', name: 'updated' }],
        terminals: [],
      });

      const response = await mockServer.sendRequest({
        path: '/__tower/metadata',
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.workspaces).toHaveLength(1);
      expect(body.workspaces[0].name).toBe('updated');
    });

    it('pushes metadata via outbound HTTP POST on connect', async () => {
      await setupTunnel();

      integrationClient.sendMetadata({
        workspaces: [{ path: '/pushed', name: 'pushed-project' }],
        terminals: [],
      });

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      await waitFor(() => mockServer.lastPushedMetadata !== null);

      expect(mockServer.lastPushedMetadata!.workspaces).toHaveLength(1);
      expect(mockServer.lastPushedMetadata!.workspaces[0].name).toBe('pushed-project');
    });

    it('pushes metadata via HTTP POST when sendMetadata called while connected', async () => {
      await setupTunnel();

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      mockServer.lastPushedMetadata = null;

      integrationClient.sendMetadata({
        workspaces: [{ path: '/live-update', name: 'live' }],
        terminals: [{ id: 't1', workspacePath: '/live-update' }],
      });

      await waitFor(() => mockServer.lastPushedMetadata !== null);

      expect(mockServer.lastPushedMetadata!.workspaces[0].name).toBe('live');
      expect(mockServer.lastPushedMetadata!.terminals).toHaveLength(1);
    });
  });

  describe('WebSocket CONNECT proxy', () => {
    let wsServer: http.Server;
    let wsPort: number;
    let upgradeSockets: net.Socket[];

    beforeEach(async () => {
      upgradeSockets = [];
      wsServer = http.createServer();
      wsServer.on('upgrade', (req, socket, head) => {
        upgradeSockets.push(socket);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n',
        );
        socket.on('data', (data) => {
          socket.write(data);
        });
        socket.on('error', () => {});
      });

      wsPort = await startServer(wsServer);
    });

    afterEach(async () => {
      for (const s of upgradeSockets) {
        if (!s.destroyed) s.destroy();
      }
      await stopServer(wsServer);
    });

    it('proxies WebSocket CONNECT with bidirectional data', async () => {
      mockServer = new MockTunnelServer();
      const port = await mockServer.start();

      integrationClient = new TunnelClient({
        serverUrl: `http://127.0.0.1:${port}`,
        apiKey: 'ctk_test_key',
        towerId: '',
        localPort: wsPort,
      });

      integrationClient.connect();
      await waitFor(() => integrationClient.getState() === 'connected');

      const stream = mockServer.sendConnect('/ws/terminal/test');

      await new Promise<void>((resolve, reject) => {
        stream.on('response', (headers) => {
          expect(headers[':status']).toBe(200);
          resolve();
        });
        stream.on('error', reject);
        setTimeout(() => reject(new Error('CONNECT timeout')), 5000);
      });

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

    it('returns 404 when WebSocket upgrade is refused by local server', async () => {
      const noUpgradeServer = http.createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      });
      const noUpgradePort = await startServer(noUpgradeServer);

      try {
        mockServer = new MockTunnelServer();
        const port = await mockServer.start();

        integrationClient = new TunnelClient({
          serverUrl: `http://127.0.0.1:${port}`,
          apiKey: 'ctk_test_key',
          towerId: '',
          localPort: noUpgradePort,
        });

        integrationClient.connect();
        await waitFor(() => integrationClient.getState() === 'connected');

        const stream = mockServer.sendConnect('/ws/terminal/nonexistent');

        const status = await new Promise<number>((resolve, reject) => {
          stream.on('response', (headers) => {
            resolve(headers[':status'] as number);
          });
          stream.on('error', reject);
          setTimeout(() => reject(new Error('Response timeout')), 5000);
        });

        expect(status).toBe(404);
        stream.destroy();
      } finally {
        await stopServer(noUpgradeServer);
      }
    });

    it('forwards custom headers through WebSocket CONNECT proxy', async () => {
      let receivedHeaders: http.IncomingHttpHeaders = {};
      const headerServer = http.createServer();
      headerServer.on('upgrade', (req, socket) => {
        receivedHeaders = req.headers;
        upgradeSockets.push(socket);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n',
        );
        socket.resume();
        socket.on('error', () => {});
      });
      const headerPort = await startServer(headerServer);

      try {
        mockServer = new MockTunnelServer();
        const port = await mockServer.start();

        integrationClient = new TunnelClient({
          serverUrl: `http://127.0.0.1:${port}`,
          apiKey: 'ctk_test_key',
          towerId: '',
          localPort: headerPort,
        });

        integrationClient.connect();
        await waitFor(() => integrationClient.getState() === 'connected');

        const stream = mockServer.sendConnect('/ws/terminal/test', {
          'x-session-resume': '42',
          'x-custom-header': 'test-value',
        });

        await new Promise<void>((resolve, reject) => {
          stream.on('response', (headers) => {
            expect(headers[':status']).toBe(200);
            resolve();
          });
          stream.on('error', reject);
          setTimeout(() => reject(new Error('CONNECT timeout')), 5000);
        });

        expect(receivedHeaders['x-session-resume']).toBe('42');
        expect(receivedHeaders['x-custom-header']).toBe('test-value');
        stream.destroy();
      } finally {
        for (const s of upgradeSockets) {
          if (!s.destroyed) s.destroy();
        }
        await stopServer(headerServer);
      }
    });
  });
});
