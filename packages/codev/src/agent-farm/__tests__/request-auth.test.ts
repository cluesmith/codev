/**
 * Request-authentication enforcement (advisory GHSA-xvjp-7748-v88v).
 *
 * Exercises the REAL server-side auth helpers (no isRequestAllowed stub): the
 * public-route allowlist, constant-time key comparison, CORS origin allowlist,
 * and the HTTP + WebSocket key checks. The expected key is controlled by mocking
 * codev-core's ensureLocalKey.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as http from 'node:http';
import { WS_MARKER_PROTOCOL, WS_KEY_PROTOCOL_PREFIX } from '@cluesmith/codev-types';

const TEST_KEY = 'a'.repeat(64);

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => TEST_KEY),
  readLocalKey: vi.fn(() => TEST_KEY),
}));

import {
  isPublicRoute,
  keysMatch,
  isAllowedOrigin,
  isRequestAllowed,
  isWebSocketAllowed,
  getExpectedKey,
  resetExpectedKeyCache,
} from '../utils/server-utils.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';

function req(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, url, headers } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  resetExpectedKeyCache();
  const mock = ensureLocalKey as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockReturnValue(TEST_KEY);
  delete process.env.CODEV_TOWER_ALLOWED_ORIGINS;
});

describe('isPublicRoute', () => {
  it('allows pre-auth probes and the dashboard shell (GET only)', () => {
    expect(isPublicRoute('GET', '/health')).toBe(true);
    expect(isPublicRoute('GET', '/api/version')).toBe(true);
    expect(isPublicRoute('GET', '/')).toBe(true);
    expect(isPublicRoute('GET', '/index.html')).toBe(true);
  });

  it('allows React SPA static assets under /workspace/<enc>/', () => {
    expect(isPublicRoute('GET', '/workspace/ENC/')).toBe(true);
    expect(isPublicRoute('GET', '/workspace/ENC/assets/app.js')).toBe(true);
    expect(isPublicRoute('GET', '/workspace/ENC/index.html')).toBe(true);
  });

  it('requires the key for workspace api / ws / file routes', () => {
    expect(isPublicRoute('GET', '/workspace/ENC/api/state')).toBe(false);
    expect(isPublicRoute('GET', '/workspace/ENC/ws/terminal/x')).toBe(false);
    expect(isPublicRoute('GET', '/workspace/ENC/file')).toBe(false);
  });

  it('requires the key for top-level api routes and all mutations', () => {
    expect(isPublicRoute('GET', '/api/terminals')).toBe(false);
    expect(isPublicRoute('GET', '/api/overview')).toBe(false);
    expect(isPublicRoute('POST', '/health')).toBe(false);
    expect(isPublicRoute('POST', '/')).toBe(false);
    expect(isPublicRoute('DELETE', '/workspace/ENC/assets/app.js')).toBe(false);
  });
});

describe('keysMatch', () => {
  it('matches identical keys', () => {
    expect(keysMatch(TEST_KEY, TEST_KEY)).toBe(true);
  });

  it('rejects different keys of equal length', () => {
    expect(keysMatch('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('rejects mismatched-length keys without throwing', () => {
    expect(() => keysMatch('short', TEST_KEY)).not.toThrow();
    expect(keysMatch('short', TEST_KEY)).toBe(false);
    expect(keysMatch('', TEST_KEY)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows loopback origins on any port', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4100')).toBe(true);
  });

  it('rejects arbitrary and https origins by default', () => {
    expect(isAllowedOrigin('https://example.com')).toBe(false);
    expect(isAllowedOrigin('http://evil.com:8080')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
  });

  it('allows operator-configured origins exactly', () => {
    process.env.CODEV_TOWER_ALLOWED_ORIGINS = 'https://tunnel.example.com, https://two.example.com';
    expect(isAllowedOrigin('https://tunnel.example.com')).toBe(true);
    expect(isAllowedOrigin('https://two.example.com')).toBe(true);
    expect(isAllowedOrigin('https://other.example.com')).toBe(false);
  });
});

describe('getExpectedKey', () => {
  it('caches and returns the issued key', () => {
    expect(getExpectedKey()).toBe(TEST_KEY);
    expect(getExpectedKey()).toBe(TEST_KEY);
    expect(ensureLocalKey).toHaveBeenCalledTimes(1);
  });

  it('fails closed (null) when the key cannot be issued', () => {
    (ensureLocalKey as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('unwritable');
    });
    expect(getExpectedKey()).toBeNull();
  });
});

describe('isRequestAllowed', () => {
  it('allows public routes with no key', () => {
    expect(isRequestAllowed(req('GET', '/health'))).toBe(true);
    expect(isRequestAllowed(req('GET', '/api/version'))).toBe(true);
  });

  it('rejects a privileged route with no key', () => {
    expect(isRequestAllowed(req('POST', '/api/terminals'))).toBe(false);
    expect(isRequestAllowed(req('GET', '/api/overview'))).toBe(false);
  });

  it('rejects a privileged route with a wrong key', () => {
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-web-key': 'b'.repeat(64) }))).toBe(false);
  });

  it('allows a privileged route with the correct key', () => {
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-web-key': TEST_KEY }))).toBe(true);
  });

  it('fails closed when the expected key is unavailable', () => {
    (ensureLocalKey as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('unwritable');
    });
    resetExpectedKeyCache();
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-web-key': TEST_KEY }))).toBe(false);
  });
});

describe('isWebSocketAllowed', () => {
  const marker = WS_MARKER_PROTOCOL;
  const tokenFor = (key: string) => `${WS_KEY_PROTOCOL_PREFIX}${key}`;

  it('allows an upgrade carrying the correct key subprotocol', () => {
    const headers = { 'sec-websocket-protocol': `${marker}, ${tokenFor(TEST_KEY)}` };
    expect(isWebSocketAllowed(req('GET', '/ws/terminal/x', headers))).toBe(true);
  });

  it('rejects a wrong key subprotocol', () => {
    const headers = { 'sec-websocket-protocol': `${marker}, ${tokenFor('b'.repeat(64))}` };
    expect(isWebSocketAllowed(req('GET', '/ws/terminal/x', headers))).toBe(false);
  });

  it('rejects an upgrade with only the marker and no key token', () => {
    expect(isWebSocketAllowed(req('GET', '/ws/terminal/x', { 'sec-websocket-protocol': marker }))).toBe(false);
  });

  it('rejects an upgrade with no subprotocol at all', () => {
    expect(isWebSocketAllowed(req('GET', '/ws/terminal/x'))).toBe(false);
  });

  it('fails closed regardless of Origin when the key is missing', () => {
    expect(isWebSocketAllowed(req('GET', '/ws/terminal/x', { origin: 'http://localhost:4100' }))).toBe(false);
  });
});
