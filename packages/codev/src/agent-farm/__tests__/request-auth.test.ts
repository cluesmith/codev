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
  isAllowedHost,
  isRequestAllowed,
  isWebSocketAllowed,
  selectWsSubprotocol,
  getExpectedKey,
  resetExpectedKeyCache,
} from '../utils/server-utils.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';

function req(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  // Default to a loopback Host so the Host guard passes unless a test overrides it.
  return { method, url, headers: { host: 'localhost:4100', ...headers } } as unknown as http.IncomingMessage;
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
    expect(isPublicRoute('GET', '/workspace/ENC')).toBe(true); // bare, no trailing slash
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

  it('makes only the annotator shell + vendor public; its data/media routes stay keyed', () => {
    // Shell (iframe navigation) and vendor libs (<script>/<link>) — public.
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB/')).toBe(true);
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB')).toBe(true);
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB/vendor/prism.min.js')).toBe(true);
    // Data + media reads and the save write — keyed (fetched/loaded with the key).
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB/file')).toBe(false);
    expect(isPublicRoute('POST', '/workspace/ENC/api/annotate/TAB/save')).toBe(false);
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB/api/mtime')).toBe(false);
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB/api/image')).toBe(false);
    expect(isPublicRoute('GET', '/workspace/ENC/api/annotate/TAB/api/model')).toBe(false);
  });

  it('defaults an unknown future workspace GET subpath to private unless it is a static asset', () => {
    // Regression guard for the deny-list shape under /workspace/: a genuinely
    // new *data* route (e.g. api/*) must not become public by accident.
    expect(isPublicRoute('GET', '/workspace/ENC/api/something-new')).toBe(false);
    // Plain asset-looking paths remain public (SPA static serving).
    expect(isPublicRoute('GET', '/workspace/ENC/assets/new.css')).toBe(true);
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

describe('isAllowedHost', () => {
  it('allows loopback hosts (with or without port)', () => {
    expect(isAllowedHost('localhost:4100')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('127.0.0.1:4100')).toBe(true);
    expect(isAllowedHost('[::1]:4100')).toBe(true);
  });

  it('rejects a rebound / arbitrary host', () => {
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost('evil.com:4100')).toBe(false);
    expect(isAllowedHost('attacker.localhost.evil.com:4100')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it('allows operator-configured origin hosts', () => {
    process.env.CODEV_TOWER_ALLOWED_ORIGINS = 'https://tunnel.example.com';
    expect(isAllowedHost('tunnel.example.com')).toBe(true);
    expect(isAllowedHost('tunnel.example.com:443')).toBe(true);
    expect(isAllowedHost('other.example.com')).toBe(false);
  });

  it('allows IP-literal (not DNS-name) Hosts in BRIDGE_MODE, keeping the rebinding guard', () => {
    process.env.BRIDGE_MODE = '1';
    try {
      // A LAN client reaches Tower by IP — allowed on a bridge bind.
      expect(isAllowedHost('192.168.1.5:4100')).toBe(true);
      expect(isAllowedHost('[fe80::1]:4100')).toBe(true);
      // DNS rebinding needs a host NAME — still rejected even in bridge mode.
      expect(isAllowedHost('phone.local')).toBe(false);
      expect(isAllowedHost('attacker.com:4100')).toBe(false);
      // The key check is separate and still mandatory for keyed routes.
      expect(isRequestAllowed(req('POST', '/api/terminals', { host: '192.168.1.5:4100' }))).toBe(false);
      expect(isRequestAllowed(req('POST', '/api/terminals', { host: '192.168.1.5:4100', 'codev-tower-key': TEST_KEY }))).toBe(true);
    } finally {
      delete process.env.BRIDGE_MODE;
    }
  });

  it('rejects a malformed bracketed IPv6 Host', () => {
    expect(isAllowedHost('[::1]evil')).toBe(false);
  });
});

describe('isRequestAllowed Host guard', () => {
  it('rejects even a public route when the Host is not allowed (DNS-rebinding guard)', () => {
    expect(isRequestAllowed(req('GET', '/health', { host: 'evil.com' }))).toBe(false);
  });

  it('rejects a keyed request with a valid key but a bad Host', () => {
    expect(isRequestAllowed(req('POST', '/api/terminals', { host: 'evil.com', 'codev-tower-key': TEST_KEY }))).toBe(false);
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
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-tower-key': 'b'.repeat(64) }))).toBe(false);
  });

  it('allows a privileged route with the correct key', () => {
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-tower-key': TEST_KEY }))).toBe(true);
  });

  it('accepts the legacy codev-web-key header too (dual-accept for one release)', () => {
    // An already-installed client bundling an older sdk still sends codev-web-key.
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-web-key': TEST_KEY }))).toBe(true);
  });

  it('fails closed when the expected key is unavailable', () => {
    (ensureLocalKey as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('unwritable');
    });
    resetExpectedKeyCache();
    expect(isRequestAllowed(req('POST', '/api/terminals', { 'codev-tower-key': TEST_KEY }))).toBe(false);
  });
});

describe('selectWsSubprotocol (marker echo)', () => {
  const marker = WS_MARKER_PROTOCOL;
  const tokenFor = (key: string) => `${WS_KEY_PROTOCOL_PREFIX}${key}`;

  it('echoes the marker when offered, and NEVER the key token', () => {
    const offered = new Set([marker, tokenFor(TEST_KEY)]);
    const selected = selectWsSubprotocol(offered);
    expect(selected).toBe(marker);
    expect(selected).not.toContain(WS_KEY_PROTOCOL_PREFIX); // the secret is never echoed
  });

  it('selects nothing when the marker is absent', () => {
    expect(selectWsSubprotocol(new Set([tokenFor(TEST_KEY)]))).toBe(false);
    expect(selectWsSubprotocol(new Set())).toBe(false);
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
