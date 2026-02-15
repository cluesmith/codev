/**
 * Unit tests for tunnel-client module (Spec 0097 Phase 3, Spec 0109)
 *
 * Tests pure functions: backoff calculation, path blocklist, hop-by-hop filtering
 * Tests heartbeat logic: ping/pong cycle, timeout, cleanup, race conditions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  calculateBackoff,
  isBlockedPath,
  filterHopByHopHeaders,
  TunnelClient,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from '../lib/tunnel-client.js';

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

    it('allows /api/projects', () => {
      expect(isBlockedPath('/api/projects')).toBe(false);
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

    // Trigger ping
    vi.advanceTimersByTime(PING_INTERVAL_MS);

    // Simulate native close event (as doConnect's ws.on('close') would do)
    // This sets ws to null via cleanup
    (client as any).cleanup();
    (client as any).setState('disconnected');
    (client as any).consecutiveFailures++;
    // At this point this.ws is null

    // Now the pong timeout fires — but ws !== this.ws (null), so it no-ops
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);

    // State should still be disconnected (not reconnected twice)
    expect((client as any).state).toBe('disconnected');
    // warn should NOT be called because the stale guard prevented it
    expect(warnSpy).not.toHaveBeenCalled();
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
