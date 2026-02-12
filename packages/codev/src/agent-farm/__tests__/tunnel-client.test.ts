/**
 * Unit tests for tunnel-client module (Spec 0097 Phase 3)
 *
 * Tests pure functions: backoff calculation, path blocklist, hop-by-hop filtering
 */

import { describe, it, expect } from 'vitest';
import {
  calculateBackoff,
  isBlockedPath,
  filterHopByHopHeaders,
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
