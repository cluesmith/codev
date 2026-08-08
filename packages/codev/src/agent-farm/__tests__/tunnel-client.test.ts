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
  CONNECT_TIMEOUT_MS,
  AUTH_RETRY_INTERVAL_MS,
  sanitizeRemoteDetail,
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

// === Regression: #1372 — wedges after sustained uplink flap ===

describe('#1372 self-healing', () => {
  let blackhole: net.Server | null = null;
  let client: TunnelClient | null = null;

  afterEach(async () => {
    client?.disconnect();
    client = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (blackhole) {
      const srv = blackhole;
      blackhole = null;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  /**
   * The wedge itself. A server that accepts the TCP connection and never answers
   * the HTTP upgrade is what an uplink flap leaves behind (stale NAT/conntrack
   * entry): no `error`, no `close`, and the heartbeat isn't armed until
   * `connected`. Without the watchdog the client sits in `connecting` forever and
   * only a brand-new TunnelClient recovers it.
   */
  it('connect watchdog tears down and reschedules a hung `connecting` attempt', async () => {
    const sockets: net.Socket[] = [];
    blackhole = net.createServer((sock) => {
      sockets.push(sock);
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => blackhole!.listen(0, '127.0.0.1', () => r()));
    const port = (blackhole.address() as net.AddressInfo).port;

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ shouldAdvanceTime: true });

    client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      apiKey: 'ctk_test',
      towerId: 't',
      localPort: 4100,
    });

    const transitions: Array<{ state: string; reason?: string }> = [];
    client.onStateChange((state, _prev, reason) => transitions.push({ state, reason }));

    client.connect();

    // Let the TCP connection establish; the upgrade never completes.
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getState()).toBe('connecting');

    // Watchdog fires — this is the assertion that fails without the fix.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);

    expect(client.getState()).toBe('disconnected');
    const timedOut = transitions.find((t) => t.reason?.includes('connect timeout'));
    expect(timedOut).toBeDefined();
    expect(timedOut!.state).toBe('disconnected');

    // ...and it actually retries. A watchdog that only tore down would trade a
    // wedged `connecting` for a wedged `disconnected`. consecutiveFailures is 1
    // here, so the next attempt is due within calculateBackoff(1).
    await vi.advanceTimersByTimeAsync(calculateBackoff(1, () => 0.999) + 100);
    expect(client.getState()).toBe('connecting');

    for (const s of sockets) s.destroy();
  }, 20000);

  /** A watchdog that tore down a healthy connection would be worse than the bug. */
  it('disarms the connect watchdog once the tunnel reaches `connected`', async () => {
    const server = new MockTunnelServer({});
    const port = await server.start();
    const echo = http.createServer((_req, res) => res.end());
    const echoPort = await startServer(echo);

    try {
      client = new TunnelClient({
        serverUrl: `http://127.0.0.1:${port}`,
        apiKey: 'ctk_test',
        towerId: '',
        localPort: echoPort,
      });

      client.connect();
      await waitFor(() => client!.getState() === 'connected');

      expect((client as unknown as { connectTimeout: unknown }).connectTimeout).toBeNull();
    } finally {
      client?.disconnect();
      client = null;
      await server.stop();
      await stopServer(echo);
    }
  }, 20000);

  /**
   * `auth_failed` used to be terminal, so a single misclassified auth error
   * during a blip became a permanent cloud outage. Driven through the private
   * handler (as the heartbeat tests do) so the clock is fully deterministic.
   */
  it('auth circuit breaker half-opens and retries after AUTH_RETRY_INTERVAL_MS', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    const c = createClient();
    const reasons: Array<string | undefined> = [];
    c.onStateChange((_state, _prev, reason) => reasons.push(reason));

    const priv = c as unknown as {
      handleAuthError: (reason: string) => void;
      doConnect: () => void;
    };
    const doConnect = vi.spyOn(priv, 'doConnect').mockImplementation(() => {});

    priv.handleAuthError('invalid_api_key');
    expect(c.getState()).toBe('auth_failed');

    // Still parked right up to the interval — this is a long retry, not a flap.
    vi.advanceTimersByTime(AUTH_RETRY_INTERVAL_MS - 1);
    expect(c.getState()).toBe('auth_failed');
    expect(doConnect).not.toHaveBeenCalled();

    // Half-open. Fails without the fix: the old breaker never rearmed.
    vi.advanceTimersByTime(1);
    expect(c.getState()).toBe('disconnected');
    expect(doConnect).toHaveBeenCalledTimes(1);
    expect(reasons.some((r) => r?.includes('half-open'))).toBe(true);

    // A genuinely revoked key re-parks and rearms, so the cycle is sustainable.
    priv.handleAuthError('invalid_api_key');
    expect(c.getState()).toBe('auth_failed');
    vi.advanceTimersByTime(AUTH_RETRY_INTERVAL_MS);
    expect(doConnect).toHaveBeenCalledTimes(2);

    c.disconnect();
  });

  /**
   * The watchdog tears attempts down mid-flight, so an `auth_ok` queued before
   * cleanup can still arrive. Unguarded it would resurrect the dead socket —
   * clobbering the h2 handles and flipping state back to `connected` while a
   * reconnect is already pending. (Raised by codex in CMAP review of #1373.)
   */
  it('ignores a late auth response from a timed-out attempt', () => {
    vi.useFakeTimers();
    const c = createClient();

    // Stand in for the socket the watchdog is about to discard.
    const staleWs = createMockWs();
    (staleWs as unknown as { send: () => void }).send = vi.fn();
    (c as unknown as { ws: WebSocket | null }).ws = staleWs;
    (c as unknown as { state: string }).state = 'connecting';

    const priv = c as unknown as {
      onWsOpen: (ws: WebSocket) => void;
      startH2Server: (ws: WebSocket) => void;
      ws: WebSocket | null;
    };
    const startH2Server = vi.spyOn(priv, 'startH2Server');

    priv.onWsOpen(staleWs);

    // Watchdog fires: cleanup() drops the socket and the client moves on.
    priv.ws = null;
    (c as unknown as { state: string }).state = 'disconnected';

    // The in-flight auth_ok lands after the teardown.
    staleWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok', towerId: 'zombie' })));

    expect(startH2Server).not.toHaveBeenCalled();
    expect(c.getState()).toBe('disconnected');
    expect((c as unknown as { h2Session: unknown }).h2Session).toBeNull();
    expect((c as unknown as { wsStream: unknown }).wsStream).toBeNull();

    c.disconnect();
  });

  it('sanitizes remote-supplied text before it reaches a log line', () => {
    // A relay could otherwise forge log lines or inflate the log.
    expect(sanitizeRemoteDetail('going away\nTunnel: connected → forged')).toBe(
      'going away Tunnel: connected → forged',
    );
    expect(sanitizeRemoteDetail('a\r\nb\tc\u0000d')).toBe('a  b c d');
    // U+2028/U+2029 act as line terminators in many log and JSON consumers,
    // and bidi overrides can visually reorder a log line (Trojan-Source style).
    expect(sanitizeRemoteDetail('a\u2028b\u2029c')).toBe('a b c');
    expect(sanitizeRemoteDetail('a\u202eb\u2066c')).toBe('a b c');
    expect(sanitizeRemoteDetail('a'.repeat(200))).toHaveLength(121); // 120 + ellipsis
    expect(sanitizeRemoteDetail('  tidy  ')).toBe('tidy');
  });

  /**
   * Every relay-controlled string that reaches a transition reason must be
   * sanitized, not just the close frame. (Raised by codex in CMAP round 2.)
   */
  it.each([
    ['auth_error reason', { type: 'auth_error', reason: 'nope\ninjected' }],
    ['unexpected type', { type: 'weird\ninjected' }],
  ])('sanitizes the %s carried into the transition reason', (_label, payload) => {
    vi.useFakeTimers();
    const c = createClient();
    const ws = createMockWs();
    (ws as unknown as { send: () => void }).send = vi.fn();
    (c as unknown as { ws: WebSocket | null }).ws = ws;
    (c as unknown as { state: string }).state = 'connecting';

    const reasons: Array<string | undefined> = [];
    c.onStateChange((_s, _p, reason) => reasons.push(reason));

    (c as unknown as { onWsOpen: (w: WebSocket) => void }).onWsOpen(ws);
    ws.emit('message', Buffer.from(JSON.stringify(payload)));

    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r ?? '').not.toMatch(/[\u0000-\u001f\u007f]/);

    c.disconnect();
  });

  it('bounds an oversized malformed auth response instead of echoing it', () => {
    vi.useFakeTimers();
    const c = createClient();
    const ws = createMockWs();
    (ws as unknown as { send: () => void }).send = vi.fn();
    (c as unknown as { ws: WebSocket | null }).ws = ws;
    (c as unknown as { state: string }).state = 'connecting';

    const reasons: Array<string | undefined> = [];
    c.onStateChange((_s, _p, reason) => reasons.push(reason));

    (c as unknown as { onWsOpen: (w: WebSocket) => void }).onWsOpen(ws);
    // Not JSON, and far too large to echo into the tower log.
    ws.emit('message', Buffer.from('<html>' + 'x'.repeat(100_000) + '</html>'));

    const reason = reasons.find((r) => r?.includes('invalid auth response'));
    expect(reason).toBeDefined();
    expect(reason!.length).toBeLessThan(200);

    c.disconnect();
  });

  /**
   * A revoked key re-parks every 15 minutes forever. Raising the same alarm
   * each time would be crying wolf. (Raised by claude in CMAP round 2.)
   */
  it('raises the auth alarm once, not on every half-open re-park', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    const c = createClient();
    const reasons: Array<string | undefined> = [];
    c.onStateChange((_s, _p, reason) => reasons.push(reason));

    const priv = c as unknown as { handleAuthError: (r: string) => void; doConnect: () => void };
    vi.spyOn(priv, 'doConnect').mockImplementation(() => {});

    // Three full park → half-open → re-park cycles, as a revoked key produces.
    priv.handleAuthError('invalid_api_key');
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(AUTH_RETRY_INTERVAL_MS);
      expect(c.getState()).toBe('disconnected');
      priv.handleAuthError('invalid_api_key');
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Later re-parks are tagged so the tower log can stay quiet too.
    expect(reasons.filter((r) => r?.includes('half-open retry failed'))).toHaveLength(2);

    c.disconnect();
    errorSpy.mockRestore();
  });

  /**
   * Cancelling the pending half-open retry without scheduling a fresh attempt
   * would leave a standalone caller worse off than before the fix.
   * (Raised by claude in CMAP round 2.)
   */
  it('resetCircuitBreaker schedules a reconnect rather than just cancelling', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    const c = createClient();
    const priv = c as unknown as { handleAuthError: (r: string) => void; doConnect: () => void };
    const doConnect = vi.spyOn(priv, 'doConnect').mockImplementation(() => {});

    priv.handleAuthError('invalid_api_key');
    expect(c.getState()).toBe('auth_failed');

    c.resetCircuitBreaker();
    expect(c.getState()).toBe('disconnected');

    // Counter was reset, so this is a first-attempt backoff — well under the
    // 15-minute half-open interval it replaced.
    vi.advanceTimersByTime(calculateBackoff(0, () => 0.999) + 1);
    expect(doConnect).toHaveBeenCalled();

    c.disconnect();
  });

  /**
   * A malformed serverUrl throws inside `new URL()` — after the state is
   * already `connecting`. Unguarded that recreates the exact wedge this PR
   * closes, with no watchdog armed. (Raised by codex in CMAP round 3.)
   */
  it('does not wedge in `connecting` when the server URL is malformed', () => {
    vi.useFakeTimers();

    const c = new TunnelClient({
      serverUrl: 'not a url',
      apiKey: 'ctk_test',
      towerId: 't',
      localPort: 4100,
    });
    const reasons: Array<string | undefined> = [];
    c.onStateChange((_s, _p, reason) => reasons.push(reason));

    expect(() => c.connect()).not.toThrow();
    expect(c.getState()).toBe('disconnected');
    expect(reasons.some((r) => r?.includes('websocket construction failed'))).toBe(true);

    // And it keeps retrying rather than parking silently.
    const doConnect = vi.spyOn(
      c as unknown as { doConnect: () => void },
      'doConnect',
    ).mockImplementation(() => {});
    vi.advanceTimersByTime(calculateBackoff(1, () => 0.999) + 1);
    expect(doConnect).toHaveBeenCalled();

    c.disconnect();
  });

  it('state transitions carry a failure reason', async () => {
    // Nothing is listening on this port — ECONNREFUSED.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${deadPort}`,
      apiKey: 'ctk_test',
      towerId: 't',
      localPort: 4100,
    });

    const reasons: Array<string | undefined> = [];
    client.onStateChange((_state, _prev, reason) => reasons.push(reason));

    client.connect();
    await waitFor(() => reasons.some((r) => r?.startsWith('connection error')));

    expect(reasons.some((r) => r?.includes('ECONNREFUSED'))).toBe(true);
  }, 15000);

  /**
   * The failure counter must be incremented *before* the delay is computed —
   * indexing the backoff curve one attempt behind retried faster than intended
   * for the whole life of the flap.
   */
  it('increments consecutiveFailures before computing the backoff delay', () => {
    const c = createClient();
    const seenAtScheduleTime: number[] = [];
    (c as unknown as { scheduleReconnect: () => void }).scheduleReconnect = () => {
      seenAtScheduleTime.push((c as unknown as { consecutiveFailures: number }).consecutiveFailures);
    };

    (c as unknown as { handleConnectionError: (e: Error) => void })
      .handleConnectionError(new Error('boom'));
    (c as unknown as { handleConnectionError: (e: Error) => void })
      .handleConnectionError(new Error('boom again'));

    expect(seenAtScheduleTime).toEqual([1, 2]);
  });
});
