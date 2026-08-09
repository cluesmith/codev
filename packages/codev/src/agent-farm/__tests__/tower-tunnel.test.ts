/**
 * Unit tests for tower-tunnel.ts (Spec 0105 Phase 2, Spec 0107 Phase 2)
 *
 * Tests: handleTunnelEndpoint (connect, connect/callback, disconnect, status, 404),
 * initTunnel / shutdownTunnel lifecycle, OAuth initiation, smart reconnect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  initTunnel,
  shutdownTunnel,
  handleTunnelEndpoint,
  type TunnelDeps,
} from '../servers/tower-tunnel.js';

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted ensures these exist before vi.mock factories run)
// ---------------------------------------------------------------------------

const {
  mockReadCloudConfig,
  mockWriteCloudConfig,
  mockDeleteCloudConfig,
  mockGetCloudConfigPath,
  mockGetOrCreateMachineId,
  mockMaskApiKey,
  mockConnect,
  mockDisconnect,
  mockGetState,
  mockGetUptime,
  mockSendMetadata,
  mockOnStateChange,
  mockResetCircuitBreaker,
  mockFsWatch,
  mockFsWatcherClose,
  mockCreatePendingRegistration,
  mockConsumePendingRegistration,
  mockRedeemToken,
  mockValidateDeviceName,
  mockFetch,
} = vi.hoisted(() => ({
  mockReadCloudConfig: vi.fn(),
  mockWriteCloudConfig: vi.fn(),
  mockDeleteCloudConfig: vi.fn(),
  mockGetCloudConfigPath: vi.fn().mockReturnValue('/tmp/test-cloud-config/cloud-config.json'),
  mockGetOrCreateMachineId: vi.fn().mockReturnValue('machine-id-1234'),
  mockMaskApiKey: vi.fn((key: string) => `***${key.slice(-4)}`),
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
  mockGetState: vi.fn().mockReturnValue('disconnected'),
  mockGetUptime: vi.fn().mockReturnValue(null),
  mockSendMetadata: vi.fn(),
  mockOnStateChange: vi.fn(),
  mockResetCircuitBreaker: vi.fn(),
  mockFsWatch: vi.fn(),
  mockFsWatcherClose: vi.fn(),
  mockCreatePendingRegistration: vi.fn().mockReturnValue('test-nonce-1234'),
  mockConsumePendingRegistration: vi.fn(),
  mockRedeemToken: vi.fn(),
  mockValidateDeviceName: vi.fn().mockReturnValue({ valid: true }),
  mockFetch: vi.fn(),
}));

vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: (...args: unknown[]) => mockReadCloudConfig(...args),
  writeCloudConfig: (...args: unknown[]) => mockWriteCloudConfig(...args),
  deleteCloudConfig: (...args: unknown[]) => mockDeleteCloudConfig(...args),
  getCloudConfigPath: (...args: unknown[]) => mockGetCloudConfigPath(...args),
  getOrCreateMachineId: (...args: unknown[]) => mockGetOrCreateMachineId(...args),
  maskApiKey: (...args: unknown[]) => mockMaskApiKey(...args),
  DEFAULT_CLOUD_URL: 'https://cloud.codevos.ai',
}));

vi.mock('../lib/tunnel-client.js', () => ({
  TUNNEL_PROXY_HEADER: 'x-codev-tunnel-proxy',
  AUTH_RETRY_FAILED_MARKER: 'half-open retry failed',
  TunnelClient: class MockTunnelClient {
    connect = mockConnect;
    disconnect = mockDisconnect;
    getState = mockGetState;
    getUptime = mockGetUptime;
    sendMetadata = mockSendMetadata;
    onStateChange = mockOnStateChange;
    resetCircuitBreaker = mockResetCircuitBreaker;
  },
}));

vi.mock('../lib/nonce-store.js', () => ({
  createPendingRegistration: (...args: unknown[]) => mockCreatePendingRegistration(...args),
  consumePendingRegistration: (...args: unknown[]) => mockConsumePendingRegistration(...args),
}));

vi.mock('../lib/token-exchange.js', () => ({
  redeemToken: (...args: unknown[]) => mockRedeemToken(...args),
}));

vi.mock('../lib/device-name.js', () => ({
  validateDeviceName: (...args: unknown[]) => mockValidateDeviceName(...args),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      watch: (...args: unknown[]) => {
        mockFsWatch(...args);
        return { close: mockFsWatcherClose };
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<TunnelDeps> = {}): TunnelDeps {
  return {
    port: 4100,
    log: vi.fn(),
    workspaceTerminals: new Map(),
    terminalManager: null,
    ...overrides,
  };
}

/** Create a mock IncomingMessage with optional body, URL, headers and peer address */
function makeReq(
  method: string,
  opts?: {
    body?: string;
    url?: string;
    host?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  },
): http.IncomingMessage {
  const readable = new Readable();
  if (opts?.body) {
    readable.push(opts.body);
  }
  readable.push(null); // end stream

  const req = Object.assign(readable, {
    method,
    url: opts?.url || '/',
    headers: { host: opts?.host || 'localhost:4100', ...(opts?.headers ?? {}) },
    socket: { remoteAddress: opts?.remoteAddress ?? '127.0.0.1' },
  });
  return req as unknown as http.IncomingMessage;
}

/** Join every message passed to a mocked deps.log into one searchable string. */
function loggedText(deps: TunnelDeps): string {
  return (deps.log as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => String(call[1]))
    .join('\n');
}

function makeRes(): { res: http.ServerResponse; body: () => string; statusCode: () => number } {
  let written = '';
  let code = 0;
  const res = {
    writeHead: vi.fn((status: number) => { code = status; }),
    end: vi.fn((data?: string) => { if (data) written += data; }),
  } as unknown as http.ServerResponse;
  return {
    res,
    body: () => written,
    statusCode: () => code,
  };
}

const FAKE_CONFIG = {
  api_key: 'sk-test-1234abcd',
  tower_id: 'tower-abc',
  tower_name: 'my-tower',
  server_url: 'https://codevos.ai',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tower-tunnel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no cloud config (unregistered)
    mockReadCloudConfig.mockReturnValue(null);
  });

  afterEach(() => {
    // Always clean up module state between tests
    shutdownTunnel();
  });

  // =========================================================================
  // handleTunnelEndpoint
  // =========================================================================

  describe('handleTunnelEndpoint', () => {
    describe('GET status (unregistered)', () => {
      it('returns registered: false when no cloud config exists', async () => {
        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('GET'), res, 'status');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.registered).toBe(false);
        expect(parsed.state).toBe('disconnected');
        expect(parsed.uptime).toBeNull();
      });

      it('includes hostname in status response', async () => {
        const { res, body } = makeRes();
        await handleTunnelEndpoint(makeReq('GET'), res, 'status');

        const parsed = JSON.parse(body());
        expect(parsed.hostname).toBeDefined();
        expect(typeof parsed.hostname).toBe('string');
      });
    });

    describe('GET status (registered)', () => {
      it('returns registration details and tunnel state', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('GET'), res, 'status');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.registered).toBe(true);
        expect(parsed.towerId).toBe('tower-abc');
        expect(parsed.towerName).toBe('my-tower');
        expect(parsed.serverUrl).toBe('https://codevos.ai');
        expect(parsed.accessUrl).toBe('https://codevos.ai/t/my-tower/');
      });
    });

    describe('GET status (corrupted config)', () => {
      it('returns registered: false when readCloudConfig throws', async () => {
        mockReadCloudConfig.mockImplementation(() => { throw new Error('parse error'); });

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('GET'), res, 'status');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.registered).toBe(false);
      });
    });

    describe('POST connect (smart reconnect)', () => {
      it('returns 503 when called before initTunnel (startup guard)', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'connect');

        expect(statusCode()).toBe(503);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/still starting/i);
      });

      it('returns 400 when not registered and no body', async () => {
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        mockReadCloudConfig.mockReturnValue(null);
        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/not registered/i);
        expect(parsed.error).toMatch(/afx tower connect/i);
      });

      it('reconnects when registered and no body', async () => {
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        mockGetState.mockReturnValue('connecting');

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'connect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(true);
        expect(mockConnect).toHaveBeenCalled();
      });
    });

    describe('POST connect (OAuth initiation)', () => {
      beforeEach(async () => {
        mockValidateDeviceName.mockReturnValue({ valid: true });
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });
      });

      it('returns authUrl for valid body with name', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: 'my-tower', origin: 'http://localhost:4100' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.authUrl).toBeDefined();
        expect(parsed.authUrl).toContain('https://cloud.codevos.ai/towers/register');
        expect(parsed.authUrl).toContain('callback=');
        // Nonce is embedded in the callback URL (not a top-level authUrl param)
        const decodedCallback = decodeURIComponent(parsed.authUrl.split('callback=')[1]);
        expect(decodedCallback).toContain('nonce=test-nonce-1234');
        expect(mockCreatePendingRegistration).toHaveBeenCalledWith('my-tower', 'https://cloud.codevos.ai');
      });

      it('uses custom serverUrl when provided', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: 'staging-tower', serverUrl: 'https://staging.codevos.ai' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.authUrl).toContain('https://staging.codevos.ai/towers/register');
        expect(mockCreatePendingRegistration).toHaveBeenCalledWith('staging-tower', 'https://staging.codevos.ai');
      });

      it('returns 400 when name is present but empty', async () => {
        mockValidateDeviceName.mockReturnValue({ valid: false, error: 'Device name is required.' });

        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: '' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
      });

      it('returns 400 for invalid device name', async () => {
        mockValidateDeviceName.mockReturnValue({ valid: false, error: 'Device name must start and end with a letter or number.' });

        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: '-bad-name-' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('letter or number');
      });

      it('returns 400 for invalid JSON in request body', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: '{not valid json',
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/invalid json/i);
      });

      it('returns 400 for malformed origin URL', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: 'my-tower', origin: 'not-a-url' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/invalid origin/i);
      });

      it('returns 400 for non-HTTPS serverUrl', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: 'my-tower', serverUrl: 'http://insecure.example.com' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/https/i);
      });

      it('allows localhost serverUrl without HTTPS', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: 'my-tower', serverUrl: 'http://localhost:3000' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.authUrl).toContain('http://localhost:3000/towers/register');
      });

      it('returns 400 for invalid serverUrl', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('POST', {
          body: JSON.stringify({ name: 'my-tower', serverUrl: 'not-a-url' }),
        });
        await handleTunnelEndpoint(req, res, 'connect');

        expect(statusCode()).toBe(400);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/invalid server url/i);
      });
    });

    describe('GET connect/callback', () => {
      beforeEach(async () => {
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });
      });

      it('returns error HTML when token is missing', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('GET', { url: '/api/tunnel/connect/callback?nonce=test-nonce' });
        await handleTunnelEndpoint(req, res, 'connect/callback');

        expect(statusCode()).toBe(400);
        expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
        expect(body()).toContain('Missing token or nonce');
      });

      it('returns error HTML when nonce is missing', async () => {
        const { res, body, statusCode } = makeRes();
        const req = makeReq('GET', { url: '/api/tunnel/connect/callback?token=some-token' });
        await handleTunnelEndpoint(req, res, 'connect/callback');

        expect(statusCode()).toBe(400);
        expect(body()).toContain('Missing token or nonce');
      });

      it('returns error HTML for invalid/expired nonce', async () => {
        mockConsumePendingRegistration.mockReturnValue(null);

        const { res, body, statusCode } = makeRes();
        const req = makeReq('GET', { url: '/api/tunnel/connect/callback?token=tok&nonce=expired' });
        await handleTunnelEndpoint(req, res, 'connect/callback');

        expect(statusCode()).toBe(400);
        expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
        expect(body()).toContain('Invalid or expired');
      });

      it('completes registration with valid nonce and token', async () => {
        mockConsumePendingRegistration.mockReturnValue({
          nonce: 'valid-nonce',
          name: 'my-tower',
          serverUrl: 'https://cloud.codevos.ai',
          createdAt: Date.now(),
        });
        mockRedeemToken.mockResolvedValue({ towerId: 'tower-123', apiKey: 'ctk_NewKey' });
        mockReadCloudConfig.mockReturnValue({
          tower_id: 'tower-123',
          tower_name: 'my-tower',
          api_key: 'ctk_NewKey',
          server_url: 'https://cloud.codevos.ai',
        });

        const { res, body, statusCode } = makeRes();
        const req = makeReq('GET', { url: '/api/tunnel/connect/callback?token=valid-tok&nonce=valid-nonce' });
        await handleTunnelEndpoint(req, res, 'connect/callback');

        expect(statusCode()).toBe(200);
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
        expect(body()).toContain('Connected to Codev Cloud');
        expect(body()).toContain('my-tower');
        expect(body()).toContain('meta http-equiv="refresh"');

        expect(mockRedeemToken).toHaveBeenCalledWith('https://cloud.codevos.ai', 'valid-tok', 'my-tower', 'machine-id-1234');
        expect(mockWriteCloudConfig).toHaveBeenCalledWith({
          tower_id: 'tower-123',
          tower_name: 'my-tower',
          api_key: 'ctk_NewKey',
          server_url: 'https://cloud.codevos.ai',
        });
        expect(mockConnect).toHaveBeenCalled();
      });

      it('returns error HTML when token redemption fails', async () => {
        mockConsumePendingRegistration.mockReturnValue({
          nonce: 'valid-nonce',
          name: 'my-tower',
          serverUrl: 'https://cloud.codevos.ai',
          createdAt: Date.now(),
        });
        mockRedeemToken.mockRejectedValue(new Error('Registration failed (401): Unauthorized'));

        const { res, body, statusCode } = makeRes();
        const req = makeReq('GET', { url: '/api/tunnel/connect/callback?token=bad-tok&nonce=valid-nonce' });
        await handleTunnelEndpoint(req, res, 'connect/callback');

        expect(statusCode()).toBe(500);
        expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'text/html' });
        expect(body()).toContain('Registration Failed');
        expect(body()).toContain('Unauthorized');
      });
    });

    describe('POST disconnect', () => {
      let fetchSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(null, { status: 200 }),
        );
      });

      afterEach(() => {
        fetchSpy.mockRestore();
      });

      it('returns success when not connected (no config)', async () => {
        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'disconnect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(true);
        expect(mockDeleteCloudConfig).toHaveBeenCalled();
      });

      it('deregisters server-side and deletes local config', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);

        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        // Reconnect so tunnelClient is set
        mockGetState.mockReturnValue('connected');

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'disconnect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(true);
        expect(parsed.warning).toBeUndefined();

        // Verify server-side deregister was called
        expect(fetchSpy).toHaveBeenCalledWith(
          'https://codevos.ai/api/towers/tower-abc',
          expect.objectContaining({ method: 'DELETE' }),
        );

        // Verify local config deleted
        expect(mockDeleteCloudConfig).toHaveBeenCalled();
      });

      it('returns warning when server-side DELETE returns non-OK status', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));

        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'disconnect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(true);
        expect(parsed.warning).toBeDefined();
        expect(parsed.warning).toContain('500');
        expect(mockDeleteCloudConfig).toHaveBeenCalled();
      });

      it('returns warning when server-side deregister fails with network error', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        fetchSpy.mockRejectedValue(new Error('Network error'));

        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'disconnect');

        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(true);
        expect(parsed.warning).toBeDefined();
        expect(parsed.warning).toContain('Server-side deregister failed');

        // Local config should still be deleted
        expect(mockDeleteCloudConfig).toHaveBeenCalled();
      });

      it('returns error when local config deletion fails', async () => {
        mockReadCloudConfig.mockReturnValue(null);
        mockDeleteCloudConfig.mockImplementation(() => { throw new Error('EACCES'); });

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'disconnect');

        expect(statusCode()).toBe(500);
        const parsed = JSON.parse(body());
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('Failed to delete local config');
      });
    });

    // =====================================================================
    // #1370: source attribution + proxied-request rejection
    // =====================================================================

    describe('source attribution (#1370)', () => {
      let fetchSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(null, { status: 200 }),
        );
      });

      afterEach(() => {
        fetchSpy.mockRestore();
      });

      it('logs remote address, user-agent and origin for a disconnect', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res } = makeRes();
        await handleTunnelEndpoint(
          makeReq('POST', {
            remoteAddress: '192.168.1.50',
            headers: { 'user-agent': 'Mozilla/5.0 Chrome', origin: 'http://localhost:4100' },
          }),
          res,
          'disconnect',
        );

        const log = loggedText(deps);
        expect(log).toContain('Tunnel disconnect requested');
        expect(log).toContain('remote=192.168.1.50');
        expect(log).toContain('via=local');
        expect(log).toContain('ua="Mozilla/5.0 Chrome"');
        expect(log).toContain('origin=http://localhost:4100');
      });

      it('logs attribution for a connect', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res } = makeRes();
        await handleTunnelEndpoint(
          makeReq('POST', { headers: { 'user-agent': 'codev-vscode/1.0' } }),
          res,
          'connect',
        );

        const log = loggedText(deps);
        expect(log).toContain('Tunnel connect requested');
        expect(log).toContain('ua="codev-vscode/1.0"');
      });

      it('records ua="none" when no user-agent is sent', async () => {
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res } = makeRes();
        await handleTunnelEndpoint(makeReq('POST'), res, 'disconnect');

        expect(loggedText(deps)).toContain('ua="none"');
      });

      it('strips control characters from a hostile user-agent', async () => {
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res } = makeRes();
        await handleTunnelEndpoint(
          makeReq('POST', { headers: { 'user-agent': 'evil\nINFO forged log line' } }),
          res,
          'disconnect',
        );

        const log = loggedText(deps);
        expect(log).toContain('evil INFO forged log line');
        expect(log).not.toContain('evil\nINFO');
      });

      it('rejects a tunnel-proxied disconnect with 403 and does not deregister', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });
        mockDeleteCloudConfig.mockClear();

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(
          makeReq('POST', { headers: { 'x-codev-tunnel-proxy': '1' } }),
          res,
          'disconnect',
        );

        expect(statusCode()).toBe(403);
        expect(JSON.parse(body()).error).toContain('local-only');
        // The destructive work must not have happened.
        expect(mockDeleteCloudConfig).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(loggedText(deps)).toContain('REJECTED');
      });

      it('rejects a tunnel-proxied connect with 403', async () => {
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(
          makeReq('POST', { headers: { 'x-codev-tunnel-proxy': '1' } }),
          res,
          'connect',
        );

        expect(statusCode()).toBe(403);
        expect(JSON.parse(body()).success).toBe(false);
      });
    });

    describe('unknown endpoint', () => {
      it('returns 404 for unknown tunnel sub-path', async () => {
        const { res, body, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('GET'), res, 'unknown');

        expect(statusCode()).toBe(404);
        const parsed = JSON.parse(body());
        expect(parsed.error).toBe('Not found');
      });

      it('returns 404 for wrong method on connect', async () => {
        const { res, statusCode } = makeRes();
        await handleTunnelEndpoint(makeReq('DELETE'), res, 'connect');
        expect(statusCode()).toBe(404);
      });
    });
  });

  // =========================================================================
  // initTunnel / shutdownTunnel lifecycle
  // =========================================================================

  describe('initTunnel', () => {
    it('operates in local-only mode when no cloud config exists', async () => {
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      expect(deps.log).toHaveBeenCalledWith('INFO', 'No cloud config found, operating in local-only mode');
      // No tunnel client should be created
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('connects tunnel when cloud config exists', async () => {
      mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      expect(mockConnect).toHaveBeenCalled();
      expect(mockSendMetadata).toHaveBeenCalled();
    });

    /**
     * The breaker half-opens every 15 minutes (#1372), so a genuinely revoked
     * key re-parks forever. Only the first park may raise the alarm.
     */
    it('logs the auth-failure alarm once, not on every half-open re-park', async () => {
      mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      const onState = mockOnStateChange.mock.calls[0][0] as (
        s: string, p: string, reason?: string,
      ) => void;

      onState('auth_failed', 'connecting', 'auth rejected: invalid_api_key');
      onState('disconnected', 'auth_failed', 'auth circuit breaker half-open, retrying');
      onState('auth_failed', 'connecting', 'auth rejected: invalid_api_key (half-open retry failed)');

      const alarms = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([level, msg]) => level === 'ERROR' && String(msg).includes('invalid or revoked'),
      );
      expect(alarms).toHaveLength(1);
    });

    it('includes the transition reason in the tunnel state log line', async () => {
      mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      const onState = mockOnStateChange.mock.calls[0][0] as (
        s: string, p: string, reason?: string,
      ) => void;
      onState('disconnected', 'connecting', 'connect timeout after 20000ms');

      expect(deps.log).toHaveBeenCalledWith(
        'INFO',
        'Tunnel: connecting → disconnected (connect timeout after 20000ms)',
      );
    });

    it('handles cloud config read failure gracefully', async () => {
      mockReadCloudConfig.mockImplementation(() => { throw new Error('ENOENT'); });
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      expect(deps.log).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('Failed to read cloud config'),
      );
    });
  });

  describe('shutdownTunnel', () => {
    it('is safe to call without prior init', () => {
      expect(() => shutdownTunnel()).not.toThrow();
    });

    it('disconnects tunnel client after init+connect', async () => {
      mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      shutdownTunnel();

      expect(mockDisconnect).toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith('INFO', 'Disconnecting tunnel...');
    });

    it('clears module state so subsequent init works', async () => {
      const deps1 = makeDeps();
      await initTunnel(deps1, { getInstances: async () => [] });
      shutdownTunnel();

      // Second init should work cleanly
      const deps2 = makeDeps();
      await initTunnel(deps2, { getInstances: async () => [] });
      expect(deps2.log).toHaveBeenCalledWith('INFO', 'No cloud config found, operating in local-only mode');
    });
  });

  // =========================================================================
  // Config watcher debouncing
  // =========================================================================

  describe('config watcher debouncing', () => {
    it('starts watching config directory on initTunnel', async () => {
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      // initTunnel calls startConfigWatcher which calls fs.watch
      expect(mockFsWatch).toHaveBeenCalled();
    });

    it('stops watcher on shutdownTunnel', async () => {
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      shutdownTunnel();

      // shutdownTunnel calls stopConfigWatcher which closes the watcher
      expect(mockFsWatcherClose).toHaveBeenCalled();
    });

    it('debounces rapid config changes via setTimeout', async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps();
        await initTunnel(deps, { getInstances: async () => [] });

        // Grab the watcher callback from the fs.watch mock call
        const watchCall = mockFsWatch.mock.calls[0];
        expect(watchCall).toBeDefined();
        const watchCallback = watchCall[1] as (eventType: string, filename: string) => void;
        const configFileName = 'cloud-config.json';

        // Fire multiple rapid events (simulating rapid file writes)
        mockReadCloudConfig.mockReturnValue(FAKE_CONFIG);
        watchCallback('change', configFileName);
        watchCallback('change', configFileName);
        watchCallback('change', configFileName);

        // Before debounce timeout fires, no reconnection should have happened
        // (clear previous call count from initTunnel itself)
        const connectCallsBefore = mockConnect.mock.calls.length;

        // Advance past the 500ms debounce window
        await vi.advanceTimersByTimeAsync(600);

        // Only ONE reconnection should have occurred despite 3 events
        const connectCallsAfter = mockConnect.mock.calls.length;
        expect(connectCallsAfter - connectCallsBefore).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores events for non-config files', async () => {
      const deps = makeDeps();
      await initTunnel(deps, { getInstances: async () => [] });

      const watchCall = mockFsWatch.mock.calls[0];
      const watchCallback = watchCall[1] as (eventType: string, filename: string) => void;

      // Fire event for a different file
      const connectCallsBefore = mockConnect.mock.calls.length;
      watchCallback('change', 'other-file.json');

      // No reconnection should happen
      expect(mockConnect.mock.calls.length).toBe(connectCallsBefore);
    });
  });
});
