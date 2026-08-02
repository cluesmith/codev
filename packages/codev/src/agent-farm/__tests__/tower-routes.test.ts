/**
 * Unit tests for tower-routes.ts (Spec 0105 Phase 6)
 *
 * Tests: route dispatch (handleRequest routing), CORS headers, security
 * checks, SSE events wiring, health check, terminal list, dashboard,
 * workspace path decoding, and 404 fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { handleRequest, startSendBuffer, stopSendBuffer } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';
import { shutdownDelayedSends, pendingDelayedSendCount } from '../servers/delayed-send.js';
import { submitToSession, resetSubmissionChains } from '../servers/session-submit.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockGetInstances, mockGetTerminalManager, mockGetSession,
  mockListSessions, mockGetWorkspaceTerminalsEntry, mockGetTerminalsForWorkspace,
  mockGetRehydratedTerminalsEntry,
  mockIsSessionPersistent, mockGetNextShellId,
  mockResolveTarget, mockBroadcastMessage, mockIsResolveError,
  mockParseJsonBody,
  mockOverviewGetOverview, mockOverviewInvalidate,
  mockReadCloudConfig,
  mockComputeAnalytics,
  mockGetKnownWorkspacePaths,
  mockIsStartupReconcileSettled } = vi.hoisted(() => ({
  mockGetInstances: vi.fn(),
  mockGetTerminalManager: vi.fn(),
  mockGetSession: vi.fn(),
  mockListSessions: vi.fn(),
  mockGetWorkspaceTerminalsEntry: vi.fn(),
  mockGetTerminalsForWorkspace: vi.fn(),
  mockGetRehydratedTerminalsEntry: vi.fn(async () => ({
    architects: new Map(),
    builders: new Map(),
    shells: new Map(),
    fileTabs: new Map(),
  })),
  mockIsSessionPersistent: vi.fn(),
  mockGetNextShellId: vi.fn(),
  mockResolveTarget: vi.fn(),
  mockBroadcastMessage: vi.fn(),
  mockIsResolveError: vi.fn((r: any) => 'code' in r),
  mockParseJsonBody: vi.fn(async () => ({})),
  mockOverviewGetOverview: vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] })),
  mockOverviewInvalidate: vi.fn(),
  mockReadCloudConfig: vi.fn(),
  mockComputeAnalytics: vi.fn(),
  mockGetKnownWorkspacePaths: vi.fn(() => []),
  mockIsStartupReconcileSettled: vi.fn(() => true),
}));

vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: (...args: unknown[]) => mockReadCloudConfig(...args),
}));

vi.mock('../servers/tower-instances.js', () => ({
  getInstances: mockGetInstances,
  getKnownWorkspacePaths: (...args: unknown[]) => mockGetKnownWorkspacePaths(...args),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  // Issue #1261: routes that need the instances module ask this first, so a
  // wired-up Tower is the default for every route test here.
  instancesReady: vi.fn(() => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
  addArchitect: vi.fn(async () => ({ success: true, name: 'sibling', terminalId: 'term-arch-sibling' })),
  removeArchitect: vi.fn(async () => ({ success: true })),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: mockGetTerminalManager,
  getWorkspaceTerminalsEntry: mockGetWorkspaceTerminalsEntry,
  getNextShellId: mockGetNextShellId,
  saveTerminalSession: vi.fn(),
  isSessionPersistent: mockIsSessionPersistent,
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  deleteFileTab: vi.fn(),
  getTerminalsForWorkspace: mockGetTerminalsForWorkspace,
  getRehydratedTerminalsEntry: mockGetRehydratedTerminalsEntry,
  isStartupReconcileSettled: mockIsStartupReconcileSettled,
}));

vi.mock('../servers/tower-tunnel.js', () => ({
  handleTunnelEndpoint: vi.fn(async (_req: unknown, res: any, _sub: string) => {
    res.writeHead(200);
    res.end('tunnel');
  }),
}));

vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: (...args: unknown[]) => mockResolveTarget(...args),
  broadcastMessage: (...args: unknown[]) => mockBroadcastMessage(...args),
  isResolveError: (r: any) => mockIsResolveError(r),
}));

vi.mock('../servers/tower-utils.js', () => ({
  isRateLimited: vi.fn(() => false),
  normalizeWorkspacePath: (p: string) => p,
  getLanguageForExt: (ext: string) => ext,
  getMimeTypeForFile: () => 'application/octet-stream',
  serveStaticFile: vi.fn(() => false),
}));

vi.mock('../utils/server-utils.js', () => ({
  isRequestAllowed: vi.fn(() => true),
  parseJsonBody: (...args: unknown[]) => mockParseJsonBody(...args),
}));

vi.mock('../servers/analytics.js', () => ({
  computeAnalytics: (...args: unknown[]) => mockComputeAnalytics(...args),
  clearAnalyticsCache: vi.fn(),
}));

vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = mockOverviewGetOverview;
    invalidate = mockOverviewInvalidate;
  },
}));

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    log: vi.fn(),
    port: 4100,
    version: '9.9.9',
    startedAt: '2026-01-01T00:00:00.000Z',
    templatePath: '/tmp/tower.html',
    reactDashboardPath: '/tmp/dashboard/dist',
    hasReactDashboard: false,
    getShellperManager: () => null,
    broadcastNotification: vi.fn(),
    addSseClient: vi.fn(() => true),
    removeSseClient: vi.fn(),
    ...overrides,
  };
}

function makeReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:4100', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes(): { res: http.ServerResponse; body: () => string; statusCode: () => number; headers: () => Record<string, string> } {
  const chunks: string[] = [];
  let code = 200;
  const hdrs: Record<string, string> = {};

  const res = {
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      code = status;
      if (h) Object.assign(hdrs, h);
    }),
    setHeader: vi.fn((k: string, v: string) => { hdrs[k] = v; }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    write: vi.fn((data: string) => { chunks.push(data); }),
  } as any;

  return {
    res,
    body: () => chunks.join(''),
    statusCode: () => code,
    headers: () => hdrs,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('tower-routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstances.mockResolvedValue([]);
    mockGetTerminalManager.mockReturnValue({
      listSessions: mockListSessions.mockReturnValue([]),
      getSession: mockGetSession.mockReturnValue(null),
    });
    mockGetWorkspaceTerminalsEntry.mockReturnValue({
      architects: new Map(),
      shells: new Map(),
      builders: new Map(),
      fileTabs: new Map(),
    });
    mockGetTerminalsForWorkspace.mockResolvedValue({ terminals: [] });
  });

  // =========================================================================
  // Security / CORS
  // =========================================================================

  describe('security and CORS', () => {
    it('returns 403 when isRequestAllowed returns false', async () => {
      const { isRequestAllowed } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);

      const req = makeReq('GET', '/health');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(403);
    });

    it('sets CORS headers for localhost origin', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://localhost:3000' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
      expect(headers()['Access-Control-Allow-Methods']).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    });

    it('sets CORS headers for https origin', async () => {
      const req = makeReq('GET', '/health', { origin: 'https://example.com' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBe('https://example.com');
    });

    it('does not set CORS origin for non-matching origins', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://evil.com:8080' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('handles OPTIONS preflight', async () => {
      const req = makeReq('OPTIONS', '/api/terminals');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });
  });

  // =========================================================================
  // Health check
  // =========================================================================

  describe('GET /health', () => {
    it('returns healthy status with workspace counts', async () => {
      mockGetInstances.mockResolvedValue([
        { running: true, workspacePath: '/a' },
        { running: false, workspacePath: '/b' },
      ]);

      const req = makeReq('GET', '/health');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.status).toBe('healthy');
      expect(parsed.activeWorkspaces).toBe(1);
      expect(parsed.totalWorkspaces).toBe(2);
    });

    it('reports readiness from the startup-reconcile barrier (#997)', async () => {
      mockGetInstances.mockResolvedValue([]);

      // Pre-reconcile: barrier not yet settled → ready:false
      mockIsStartupReconcileSettled.mockReturnValueOnce(false);
      const notReady = makeRes();
      await handleRequest(makeReq('GET', '/health'), notReady.res, makeCtx());
      expect(JSON.parse(notReady.body()).ready).toBe(false);

      // Post-reconcile: barrier settled → ready:true
      mockIsStartupReconcileSettled.mockReturnValueOnce(true);
      const ready = makeRes();
      await handleRequest(makeReq('GET', '/health'), ready.res, makeCtx());
      expect(JSON.parse(ready.body()).ready).toBe(true);
    });
  });

  // =========================================================================
  // Version probe (#983)
  // =========================================================================

  describe('GET /api/version', () => {
    it('returns the running Tower version and start time from context', async () => {
      const req = makeReq('GET', '/api/version');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx({ version: '3.2.1', startedAt: '2026-06-06T12:00:00.000Z' }));

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed).toEqual({ version: '3.2.1', startedAt: '2026-06-06T12:00:00.000Z' });
    });
  });

  // =========================================================================
  // Terminal list
  // =========================================================================

  describe('GET /api/terminals', () => {
    it('returns terminal list', async () => {
      mockListSessions.mockReturnValue([{ id: 'term-1' }]);

      const req = makeReq('GET', '/api/terminals');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.terminals).toEqual([{ id: 'term-1' }]);
    });
  });

  // =========================================================================
  // API status
  // =========================================================================

  describe('GET /api/status', () => {
    it('returns instances', async () => {
      mockGetInstances.mockResolvedValue([{ workspacePath: '/p', running: true }]);

      const req = makeReq('GET', '/api/status');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.instances).toHaveLength(1);
    });
  });

  // =========================================================================
  // SSE events
  // =========================================================================

  describe('GET /api/events', () => {
    it('registers SSE client via context callbacks', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      expect(ctx.addSseClient).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));
    });

    it('removes SSE client on close', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      // Simulate client disconnect
      req.emit('close');

      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('removes SSE client on res close (Bugfix #580)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();
      // Make res an EventEmitter so it can emit 'close'
      const resEmitter = new EventEmitter();
      Object.assign(res, { on: resEmitter.on.bind(resEmitter), emit: resEmitter.emit.bind(resEmitter) });

      await handleRequest(req, res, ctx);

      // Simulate response close (without request close)
      resEmitter.emit('close');

      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('removes SSE client on res error (Bugfix #580)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();
      const resEmitter = new EventEmitter();
      Object.assign(res, { on: resEmitter.on.bind(resEmitter), emit: resEmitter.emit.bind(resEmitter) });

      await handleRequest(req, res, ctx);

      // Simulate a write error on the response
      resEmitter.emit('error', new Error('EPIPE'));

      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('only cleans up once even if multiple close events fire (Bugfix #580)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();
      const resEmitter = new EventEmitter();
      Object.assign(res, { on: resEmitter.on.bind(resEmitter), emit: resEmitter.emit.bind(resEmitter) });

      await handleRequest(req, res, ctx);

      // Fire close on both req and res
      req.emit('close');
      resEmitter.emit('close');
      resEmitter.emit('error', new Error('EPIPE'));

      // Should only clean up once despite three events
      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when addSseClient rejects at capacity (Bugfix #1124)', async () => {
      const ctx = makeCtx({ addSseClient: vi.fn(() => false) });
      const req = makeReq('GET', '/api/events');
      const { res, statusCode, headers, body } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(503);
      expect(headers()['Retry-After']).toBe('5');
      expect(body()).toContain('capacity');
      expect(ctx.removeSseClient).not.toHaveBeenCalled();
    });

    it('sends retry directive to space out reconnections (Bugfix #1124)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res, body } = makeRes();

      await handleRequest(req, res, ctx);

      expect(body()).toContain('retry: 5000');
    });

    it('does not register cleanup listeners when rejected (Bugfix #1124)', async () => {
      const ctx = makeCtx({ addSseClient: vi.fn(() => false) });
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      // After rejection, close events should not call removeSseClient
      req.emit('close');
      expect(ctx.removeSseClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Notify
  // =========================================================================

  describe('POST /api/notify', () => {
    it('broadcasts notification via context', async () => {
      mockParseJsonBody.mockResolvedValueOnce({
        type: 'gate',
        title: 'Gate ready',
        body: 'Spec approval needed',
        workspace: '/my/workspace',
      });

      const ctx = makeCtx();
      const req = makeReq('POST', '/api/notify');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'gate',
        title: 'Gate ready',
        body: 'Spec approval needed',
        workspace: '/my/workspace',
      });
    });

    it('returns 400 when title or body is missing', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ type: 'info' });

      const req = makeReq('POST', '/api/notify');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });
  });

  // =========================================================================
  // Dashboard
  // =========================================================================

  describe('GET /', () => {
    it('returns 500 when template read fails', async () => {
      // Use a non-existent template path — fs.readFileSync will throw
      const req = makeReq('GET', '/');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx({ templatePath: '/nonexistent/tower.html' }));

      expect(statusCode()).toBe(500);
      expect(body()).toContain('Error loading template');
    });

    it('returns 500 when template path is null', async () => {
      const req = makeReq('GET', '/');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx({ templatePath: null }));

      expect(statusCode()).toBe(500);
    });
  });

  // =========================================================================
  // Workspace routes - path decoding
  // =========================================================================

  describe('workspace routes', () => {
    it('returns 400 for missing encoded path', async () => {
      const req = makeReq('GET', '/workspace/');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });

    it('returns 400 for invalid base64url path', async () => {
      // "relative/path" decodes to non-absolute path
      const encoded = Buffer.from('relative/path').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });

    it('dispatches to workspace API state route', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed).toHaveProperty('architect');
      expect(parsed).toHaveProperty('builders');
      expect(parsed).toHaveProperty('utils');
    });

    it('includes lastDataAt in shell entries of /api/state response (Spec 467)', async () => {
      const now = Date.now();
      mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
        architects: new Map(),
        shells: new Map([['shell-1', 'term-abc']]),
        builders: new Map(),
        fileTabs: new Map(),
      });
      mockGetSession.mockReturnValue({
        label: 'Shell 1',
        pid: 1234,
        lastDataAt: now,
      });
      mockIsSessionPersistent.mockReturnValue(false);

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.utils).toHaveLength(1);
      expect(parsed.utils[0]).toMatchObject({
        id: 'shell-1',
        name: 'Shell 1',
        lastDataAt: now,
      });
    });

    it('returns tower_name as hostname instead of os.hostname() (Bugfix #470)', async () => {
      mockReadCloudConfig.mockReturnValue({
        tower_id: 'test-id',
        tower_name: 'mac',
        api_key: 'test-key',
        server_url: 'https://cloud.codevos.ai',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      const parsed = JSON.parse(body());
      expect(parsed.hostname).toBe('mac');
    });

    it('returns undefined hostname when no cloud config (Bugfix #470)', async () => {
      mockReadCloudConfig.mockReturnValue(null);

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      const parsed = JSON.parse(body());
      expect(parsed.hostname).toBeUndefined();
    });

    it('returns undefined hostname when cloud config throws (Bugfix #470)', async () => {
      mockReadCloudConfig.mockImplementation(() => { throw new Error('invalid JSON'); });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.hostname).toBeUndefined();
    });
  });

  // =========================================================================
  // 404 fallback
  // =========================================================================

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const req = makeReq('GET', '/unknown/path');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
    });
  });

  // =========================================================================
  // API workspaces
  // =========================================================================

  describe('GET /api/workspaces', () => {
    it('returns workspace list', async () => {
      mockGetInstances.mockResolvedValue([
        { workspacePath: '/p1', workspaceName: 'p1', running: true, proxyUrl: null, terminals: [] },
      ]);

      const req = makeReq('GET', '/api/workspaces');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.workspaces).toHaveLength(1);
      expect(parsed.workspaces[0].name).toBe('p1');
    });
  });

  // =========================================================================
  // Rate limiting on activate
  // =========================================================================

  describe('POST /api/workspaces/:path/activate', () => {
    it('returns 429 when rate limited', async () => {
      const { isRateLimited } = await import('../servers/tower-utils.js');
      (isRateLimited as any).mockReturnValueOnce(true);

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/activate`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(429);
      expect(JSON.parse(body()).error).toContain('Too many activations');
    });

    it('launches instance when not rate limited', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/activate`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });

    it('returns 400 with error body when launchInstance fails', async () => {
      const { launchInstance } = await import('../servers/tower-instances.js');
      (launchInstance as any).mockResolvedValueOnce({
        success: false,
        error: 'Failed to create architect terminal: spawn claude ENOENT',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/activate`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      const json = JSON.parse(body());
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Failed to create architect terminal/);
      expect(json.error).toMatch(/spawn claude ENOENT/);
    });
  });

  // =========================================================================
  // Spec 823: architects-updated SSE emission on add/remove
  // =========================================================================

  describe('Spec 823: architects-updated SSE emission', () => {
    const workspacePath = '/test/workspace';
    const encoded = Buffer.from(workspacePath).toString('base64url');

    it('handleAddArchitect emits architects-updated on success', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ name: 'ob-refine' });
      const ctx = makeCtx();
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleAddArchitect does NOT emit on failure', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ name: 'bogus' });
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Workspace not running',
      });

      const ctx = makeCtx();
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      // Failure status comes through, broadcast does NOT fire.
      expect(statusCode()).toBe(404);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });

    it('handleRemoveArchitect emits architects-updated on success', async () => {
      const ctx = makeCtx();
      const req = makeReq('DELETE', `/api/workspaces/${encoded}/architects/ob-refine`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleRemoveArchitect does NOT emit on failure', async () => {
      const { removeArchitect } = await import('../servers/tower-instances.js');
      (removeArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Cannot remove main architect',
      });

      const ctx = makeCtx();
      const req = makeReq('DELETE', `/api/workspaces/${encoded}/architects/main`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(400);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });

    it('emit body carries the workspace path so subscribers can disambiguate', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ name: 'team-a' });
      const ctx = makeCtx();
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      const callArg = (ctx.broadcastNotification as any).mock.calls[0][0];
      const parsedBody = JSON.parse(callArg.body);
      expect(parsedBody.workspace).toBe(workspacePath);
      expect(callArg.workspace).toBe(workspacePath);
    });

    // iter-1 review Codex finding: cover the two workspace-scoped remove
    // paths that emit architects-updated. These are the dashboard close-button
    // path (`DELETE /workspace/<encoded>/api/architects/:name`) and the mobile
    // TabBar close path (`DELETE /workspace/<encoded>/api/tabs/architect:<name>`).
    // The /api/workspaces/<encoded>/architects/... routes go through
    // handleRemoveArchitect (tested above); these alternate routes share the
    // same emit contract.

    it('handleWorkspaceRoutes DELETE /api/architects/:name emits architects-updated', async () => {
      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/architects/ob-refine`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleWorkspaceRoutes DELETE /api/architects/:name does NOT emit on failure', async () => {
      const { removeArchitect } = await import('../servers/tower-instances.js');
      (removeArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Cannot remove main architect',
      });

      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/architects/main`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(400);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });

    it('handleWorkspaceTabDelete /api/tabs/architect:<name> emits architects-updated', async () => {
      // The tabId 'architect:<name>' branch in handleWorkspaceTabDelete (Spec
      // 786 PR iter-1) routes through removeArchitect() and must emit the
      // architects-updated event on success so VSCode refreshes.
      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/tabs/architect:ob-refine`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      // handleWorkspaceTabDelete writes 204 (No Content) on success.
      expect(statusCode()).toBe(204);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleWorkspaceTabDelete /api/tabs/architect:<name> does NOT emit on failure', async () => {
      const { removeArchitect } = await import('../servers/tower-instances.js');
      (removeArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Architect not found',
      });

      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/tabs/architect:bogus`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(404);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Annotate vendor route (Bugfix #269)
  // =========================================================================

  describe('annotate vendor route', () => {
    const workspacePath = '/test/workspace';
    const encoded = Buffer.from(workspacePath).toString('base64url');
    const tabId = 'test-tab';

    beforeEach(() => {
      mockGetWorkspaceTerminalsEntry.mockReturnValue({
        architects: new Map(),
        shells: new Map(),
        builders: new Map(),
        fileTabs: new Map([[tabId, { path: '/test/workspace/src/main.ts' }]]),
      });
    });

    it('serves vendor JS files with correct content type', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/prism.min.js`);
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(headers()['Content-Type']).toBe('application/javascript');
    });

    it('serves vendor CSS files with correct content type', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/prism-tomorrow.min.css`);
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(headers()['Content-Type']).toBe('text/css');
    });

    it('blocks path traversal in vendor route', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/..%2F..%2Fpackage.json`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });

    it('returns 404 for non-existent vendor files', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/nonexistent.js`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
    });

    it('rejects vendor files with disallowed extensions', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/secret.txt`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });
  });

  // =========================================================================
  // GET /api/terminals/:id — the wire contract for quiescence (Spec 1273)
  // =========================================================================

  describe('GET /api/terminals/:id (Spec 1273 — lastDataAt on the wire)', () => {
    // Testing `session.info` alone would not pin this: the whole point of the
    // phase is that the field reaches a *client*, so afx reset can measure
    // output quiescence instead of assuming a builder's turn has ended before
    // typing /clear into its terminal. This asserts the serialised response.
    it('serialises lastDataAt as an epoch-ms number', async () => {
      const lastDataAt = 1_753_660_000_000;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          info: {
            id: 'term-42', pid: 4242, cols: 80, rows: 24, label: 'builder',
            status: 'running', createdAt: '2026-07-28T00:00:00.000Z', lastDataAt,
          },
        }),
        listSessions: () => [],
      });

      const req = makeReq('GET', '/api/terminals/term-42');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(typeof parsed.lastDataAt).toBe('number');
      expect(parsed.lastDataAt).toBe(lastDataAt);
    });

    it('returns 404 for an unknown terminal rather than a body without lastDataAt', async () => {
      mockGetTerminalManager.mockReturnValue({
        getSession: () => undefined,
        listSessions: () => [],
      });

      const req = makeReq('GET', '/api/terminals/term-gone');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
      expect(JSON.parse(body()).error).toBe('NOT_FOUND');
    });
  });

  // DELETE /api/terminals/:id (Bugfix #290)
  // =========================================================================

  describe('DELETE /api/terminals/:id', () => {
    const terminalId = 'term-123';

    it('removes terminal from both SQLite and in-memory registry on success', async () => {
      const { killTerminalWithShellper } = await import('../servers/tower-instances.js');
      (killTerminalWithShellper as any).mockResolvedValueOnce(true);

      const req = makeReq('DELETE', `/api/terminals/${terminalId}`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(204);
      const { deleteTerminalSession, removeTerminalFromRegistry } = await import('../servers/tower-terminals.js');
      expect(deleteTerminalSession).toHaveBeenCalledWith(terminalId);
      expect(removeTerminalFromRegistry).toHaveBeenCalledWith(terminalId);
    });

    it('does not call cleanup functions when terminal not found', async () => {
      const { killTerminalWithShellper } = await import('../servers/tower-instances.js');
      (killTerminalWithShellper as any).mockResolvedValueOnce(false);

      const req = makeReq('DELETE', `/api/terminals/${terminalId}`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
      const { deleteTerminalSession, removeTerminalFromRegistry } = await import('../servers/tower-terminals.js');
      expect(deleteTerminalSession).not.toHaveBeenCalled();
      expect(removeTerminalFromRegistry).not.toHaveBeenCalled();
    });

    // Issue #1261: "Tower isn't wired up yet" is not "no such terminal".
    // Answering 404 sent callers off hunting for a terminal that was there all
    // along; 503 + Retry-After tells them to try again instead.
    it('returns 503 rather than 404 when the instances module is not wired yet', async () => {
      const { instancesReady, killTerminalWithShellper } = await import('../servers/tower-instances.js');
      (instancesReady as any).mockReturnValueOnce(false);

      const req = makeReq('DELETE', `/api/terminals/${terminalId}`);
      const { res, statusCode, body, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(503);
      expect(headers()['Retry-After']).toBe('1');
      expect(JSON.parse(body()).error).toBe('STARTING_UP');
      // And it must not have tried to kill anything on the way out.
      expect(killTerminalWithShellper).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Overview endpoints (Spec 0126 Phase 4)
  // =========================================================================

  describe('GET /api/overview', () => {
    it('returns overview data with workspace from query param', async () => {
      mockOverviewGetOverview.mockResolvedValueOnce({
        builders: [{ id: '42', issueNumber: 42 }],
        pendingPRs: [],
        backlog: [],
      });

      const req = makeReq('GET', '/api/overview?workspace=/test/workspace');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.builders).toHaveLength(1);
      expect(mockOverviewGetOverview).toHaveBeenCalledWith('/test/workspace', expect.any(Set));
    });

    it('returns empty data when no workspace is known', async () => {
      const req = makeReq('GET', '/api/overview');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.builders).toEqual([]);
      expect(parsed.pendingPRs).toEqual([]);
      expect(parsed.backlog).toEqual([]);
      // Issue 1104: the no-workspace branch must still honor the full
      // OverviewData contract — `architects` is required ('never undefined'),
      // and `recentlyClosed` likewise — so consumers don't have to branch.
      expect(parsed.recentlyClosed).toEqual([]);
      expect(parsed.architects).toEqual([]);
    });

    it('works via workspace-scoped route', async () => {
      mockOverviewGetOverview.mockResolvedValueOnce({
        builders: [{ id: '99', issueNumber: 99 }],
        pendingPRs: [],
        backlog: [],
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/overview`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.builders).toHaveLength(1);
    });

    it('refresh works via workspace-scoped route', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/workspace/${encoded}/api/overview/refresh`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).ok).toBe(true);
      expect(mockOverviewInvalidate).toHaveBeenCalled();
    });

    it('falls back to first known workspace when no query param', async () => {
      mockGetKnownWorkspacePaths.mockReturnValueOnce(['/my/workspace']);
      mockOverviewGetOverview.mockResolvedValueOnce({
        builders: [],
        pendingPRs: [],
        backlog: [],
      });

      const req = makeReq('GET', '/api/overview');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(mockOverviewGetOverview).toHaveBeenCalledWith('/my/workspace', expect.any(Set));
    });

    it('enriches the payload with the architect roster, main-first, dead sessions skipped (Issue 1104)', async () => {
      // Roster registration order is vscode → main → dead; `main` must surface
      // at index 0 and the dead (sessionless) registration must be dropped.
      mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
        architects: new Map([['vscode', 't-vscode'], ['main', 't-main'], ['dead', 't-dead']]),
        builders: new Map(),
        shells: new Map(),
        fileTabs: new Map(),
      });
      mockGetTerminalManager.mockReturnValue({ getSession: mockGetSession });
      mockGetSession.mockImplementation((id: string) =>
        id === 't-dead' ? undefined : { pid: 100, lastDataAt: 0 });
      mockIsSessionPersistent.mockReturnValue(false);
      mockOverviewGetOverview.mockResolvedValueOnce({ builders: [], pendingPRs: [], backlog: [] });

      const req = makeReq('GET', '/api/overview?workspace=/test/workspace');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.architects.map((a: { name: string }) => a.name)).toEqual(['main', 'vscode']);
    });

    it('emits an empty architect roster when the workspace has no architects (Issue 1104)', async () => {
      mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
        architects: new Map(),
        builders: new Map(),
        shells: new Map(),
        fileTabs: new Map(),
      });
      mockGetTerminalManager.mockReturnValue({ getSession: mockGetSession });
      mockOverviewGetOverview.mockResolvedValueOnce({ builders: [], pendingPRs: [], backlog: [] });

      const req = makeReq('GET', '/api/overview?workspace=/test/workspace');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).architects).toEqual([]);
    });
  });

  describe('POST /api/overview/refresh', () => {
    it('invalidates cache and returns ok', async () => {
      const req = makeReq('POST', '/api/overview/refresh');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).ok).toBe(true);
      expect(mockOverviewInvalidate).toHaveBeenCalledTimes(1);
    });

    it('broadcasts overview-changed SSE event on refresh (Bugfix #388)', async () => {
      const req = makeReq('POST', '/api/overview/refresh');
      const { res } = makeRes();
      const ctx = makeCtx();
      await handleRequest(req, res, ctx);

      expect(ctx.broadcastNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'overview-changed' }),
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('catches and reports errors from route handlers', async () => {
      mockGetInstances.mockRejectedValue(new Error('db error'));

      const ctx = makeCtx();
      const req = makeReq('GET', '/health');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(500);
      expect(JSON.parse(body()).error).toBe('db error');
      expect(ctx.log).toHaveBeenCalledWith('ERROR', expect.stringContaining('db error'));
    });
  });

  // ==========================================================================
  // POST /api/send — endpoint-level validation and error contract
  // ==========================================================================

  describe('POST /api/send', () => {
    it('returns 400 INVALID_PARAMS when "to" is missing', async () => {
      mockParseJsonBody.mockResolvedValue({ message: 'hello' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
      expect(JSON.parse(body()).message).toContain('to');
    });

    it('returns 400 INVALID_PARAMS when "message" is missing', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
      expect(JSON.parse(body()).message).toContain('message');
    });

    it('returns 400 INVALID_PARAMS when "to" is empty string', async () => {
      mockParseJsonBody.mockResolvedValue({ to: '  ', message: 'hello' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
    });

    it('returns 404 NOT_FOUND when target agent not found', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'unknown', message: 'test', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'Agent not found' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(404);
      expect(JSON.parse(body()).error).toBe('NOT_FOUND');
    });

    it('returns 409 AMBIGUOUS when multiple agents match', async () => {
      mockParseJsonBody.mockResolvedValue({ to: '42', message: 'test', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'AMBIGUOUS', message: 'Multiple matches' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(409);
      expect(JSON.parse(body()).error).toBe('AMBIGUOUS');
    });

    it('returns 400 INVALID_PARAMS when no workspace context (NO_CONTEXT)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'test' });
      mockResolveTarget.mockReturnValue({ code: 'NO_CONTEXT', message: 'No project context' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      // NO_CONTEXT is mapped to INVALID_PARAMS per plan's error contract
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
    });

    // Spec 755 Phase 3: `from` must be forwarded to resolveTarget so the
    // resolver can apply affinity-aware architect routing. Without this
    // assertion a future refactor could drop sender-awareness silently.
    it('forwards `from` (sender) to resolveTarget for affinity-aware routing (Spec 755)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect',
        message: 'hi',
        from: 'spir-100',
        workspace: '/tmp/ws',
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-arch-sibling',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: vi.fn(), pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockResolveTarget).toHaveBeenCalledWith('architect', '/tmp/ws', 'spir-100');
    });

    it('forwards undefined `from` when sender is not supplied (non-builder send)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'cron', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-arch-main',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: vi.fn(), pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockResolveTarget).toHaveBeenCalledWith('architect', '/tmp/ws', undefined);
    });

    it('returns 200 with ok:true on successful send', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.resolvedTo).toBe('architect');
      expect(parsed.terminalId).toBe('term-001');
      expect(parsed.deferred).toBe(false);
      expect(mockWrite).toHaveBeenCalled();
    });

    it('returns 503 TERMINAL_NOT_WRITABLE instead of a false success when the shellper connection is down (#1198)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-zombie',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: false, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(503);
      const parsed = JSON.parse(body());
      expect(parsed.error).toBe('TERMINAL_NOT_WRITABLE');
      expect(mockWrite).not.toHaveBeenCalled();
    });

    // Spec 1273: `escape` delivers a bare ESC keystroke straight to the PTY.
    // The buffer-bypass assertion is the load-bearing one — an interrupt that can
    // be deferred because someone recently typed in that terminal is not an
    // interrupt, and a wedged builder is precisely the case where you cannot wait.
    it('writes a bare ESC and never defers it, even when the user is actively typing (Spec 1273)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: '1273', message: '\x1b', workspace: '/tmp/ws', options: { escape: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-wedged',
        workspacePath: '/tmp/ws',
        agent: 'builder-aspir-1273',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        // isUserIdle() === false is what forces deferral on the normal send path.
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => false, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.deferred).toBe(false);
      // ESC written immediately and unformatted — no header/wrapper text.
      expect(mockWrite).toHaveBeenCalledWith('\x1b');
      expect(mockWrite.mock.calls[0][0]).toBe('\x1b');
    });

    it('accepts a lone ESC message body without tripping the non-empty guard (Spec 1273)', async () => {
      // The ESC recovery depends on `\x1b` surviving handleSend's trim(); a 400
      // here would mean the only mid-turn recovery had been silently broken.
      mockParseJsonBody.mockResolvedValue({
        to: '1273', message: '\x1b', workspace: '/tmp/ws', options: { escape: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-wedged',
        workspacePath: '/tmp/ws',
        agent: 'builder-aspir-1273',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: vi.fn(), pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });

    it('fails loudly on a non-writable terminal instead of reporting a delivered ESC (Spec 1273)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: '1273', message: '\x1b', workspace: '/tmp/ws', options: { escape: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-zombie',
        workspacePath: '/tmp/ws',
        agent: 'builder-aspir-1273',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: false, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(503);
      expect(JSON.parse(body()).error).toBe('TERMINAL_NOT_WRITABLE');
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('leaves normal sends unaffected when escape is absent (Spec 1273 regression guard)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      // Formatted, not a bare ESC.
      expect(mockWrite).toHaveBeenCalled();
      expect(mockWrite.mock.calls[0][0]).not.toBe('\x1b');
    });

    it('returns deferred:true when user is actively typing (Spec 403)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => false, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.deferred).toBe(true);
      // Message should NOT be written to session when deferred
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('delivers immediately when interrupt:true even if user is typing (Spec 403)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'urgent', workspace: '/tmp/ws',
        options: { interrupt: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => false, composing: true }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.deferred).toBe(false);
      // Should have written Ctrl+C and the message
      expect(mockWrite).toHaveBeenCalled();
    });

    it('delivers message + Enter as a single atomic write (Bugfix #481)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res } = makeRes();

      await handleRequest(req, res, ctx);
      // Message is written first, then \r is sent SEPARATELY after a delay, so
      // the PTY processes the paste before receiving Enter (Bugfix #492/#481).
      // That separation is the property this test exists to protect.
      const writeCalls = mockWrite.mock.calls.map(c => c[0] as string);
      expect(writeCalls[0]).toContain('hello');
      expect(writeCalls[0]).not.toMatch(/\r$/); // Enter is never appended

      // UPDATED (Spec 1273 verify): this previously asserted `length === 1` —
      // i.e. that the route returned BEFORE the Enter was written. That was the
      // bug, not the contract: an awaited send resolving before its own
      // submission is how `afx reset` got `/clear` welded onto the front of the
      // next message and never cleared anything. `/api/send` now awaits the
      // submission, so by the time the request resolves the Enter HAS landed.
      //
      // Asserted as properties rather than an exact count, because the
      // formatted message may be paced line-by-line (Bugfix #584).
      expect(writeCalls.length).toBeGreaterThan(1);
      expect(writeCalls.at(-1)).toBe('\r');
    });

    it('delivers message without Enter when noEnter is set (Bugfix #481)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'hello', workspace: '/tmp/ws',
        options: { noEnter: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res } = makeRes();

      await handleRequest(req, res, ctx);
      const writeCalls = mockWrite.mock.calls;
      expect(writeCalls.length).toBe(1);
      // Should NOT end with \r when noEnter is set
      expect(writeCalls[0][0]).not.toMatch(/\r$/);
    });

    it('delivers immediately when user is idle even if composing (Bugfix #492)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      // Bugfix #492: composing gets stuck true after non-Enter keystrokes.
      // Idle threshold alone is sufficient — deliver immediately.
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => true, composing: true }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.deferred).toBe(false);
      // Message SHOULD be written — user is idle (Bugfix #492)
      expect(mockWrite).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /api/send — delayed delivery (Spec 1307)
  // =========================================================================

  // These use their own terminal id. The SendBuffer in tower-routes.ts is
  // module-level state shared across this file, and earlier tests deliberately
  // leave messages queued for `term-001` — which a delayed send would then
  // correctly queue behind, masking what these tests are checking.
  describe('POST /api/send with deliverAfter', () => {
    beforeEach(() => {
      shutdownDelayedSends();
    });

    afterEach(() => {
      shutdownDelayedSends();
      // Drains anything these tests left queued, so the module-level SendBuffer
      // does not leak state into later describes.
      stopSendBuffer();
      vi.useRealTimers();
    });

    function idleSession(write: ReturnType<typeof vi.fn>) {
      return { write, pid: 1234, writable: true, isUserIdle: () => true, composing: false };
    }

    it('responds scheduled:true and writes nothing yet', async () => {
      vi.useFakeTimers();
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: '/arch-init main', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 15 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-083', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => idleSession(mockWrite), listSessions: () => [],
      });
      const { res, statusCode, body } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.scheduled).toBe(true);
      expect(parsed.deliverAfter).toBe(15);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('delivers once the delay elapses', async () => {
      vi.useFakeTimers();
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'later', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 15 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-084', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => idleSession(mockWrite), listSessions: () => [],
      });
      const { res } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
      expect(mockWrite).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockWrite).toHaveBeenCalled();
    });

    it('re-fetches the session at delivery and drops gracefully when it is gone', async () => {
      // The reason delivery must not close over a PtySession: between scheduling
      // and delivery the session can die, and writes to a stale reference go
      // nowhere silently.
      vi.useFakeTimers();
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'later', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 5 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-085', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      let alive = true;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => (alive ? idleSession(mockWrite) : undefined),
        listSessions: () => [],
      });
      const { res, statusCode } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
      expect(statusCode()).toBe(200);

      alive = false;
      await expect(vi.advanceTimersByTimeAsync(5_000)).resolves.not.toThrow();
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('does not write to a session that became unwritable during the wait', async () => {
      vi.useFakeTimers();
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'later', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 5 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-086', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      let writable = true;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ ...idleSession(mockWrite), writable }),
        listSessions: () => [],
      });
      const { res } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
      writable = false;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('rejects an invalid delay before scheduling anything', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'x', workspace: '/tmp/ws',
        options: { deliverAfter: 0 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-087', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const { res, statusCode, body } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
      expect(pendingDelayedSendCount()).toBe(0);
    });

    it('rejects NaN delays', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'x', workspace: '/tmp/ws',
        options: { deliverAfter: NaN },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-088', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const { res, statusCode } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

      expect(statusCode()).toBe(400);
      expect(pendingDelayedSendCount()).toBe(0);
    });

    it('refuses escape combined with a delay rather than silently ignoring one', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'x', workspace: '/tmp/ws',
        options: { escape: true, deliverAfter: 5 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-089', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const { res, statusCode, body } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).message).toMatch(/escape cannot be combined with a delay/);
      expect(pendingDelayedSendCount()).toBe(0);
    });

    it('AUTHORISES at request time: a refused target never schedules', async () => {
      // The security-relevant property. A delayed send must not be able to defer
      // an authorization check past the conditions that would fail it — so a
      // resolveTarget refusal (e.g. the builder-spoofing check on
      // `architect:<name>`) must stop the request before anything is scheduled.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:other', message: 'x', workspace: '/tmp/ws', from: 'aspir-1307',
        options: { deliverAfter: 15 },
      });
      // Mirrors what the real resolver returns for this refusal
      // (tower-messages.ts:229) — 'NOT_FOUND', not a 'FORBIDDEN' code that does
      // not exist. `isResolveError` only checks for `code`, so the assertion
      // held either way, but a mock that does not match production is a
      // half-truth waiting to mislead the next reader.
      mockResolveTarget.mockReturnValue({
        code: 'NOT_FOUND',
        message: 'builder aspir-1307 may only address its own spawning architect',
      });
      const { res, statusCode } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

      expect(statusCode()).not.toBe(200);
      expect(pendingDelayedSendCount()).toBe(0);
    });

    it('defers the interrupt WITH the message rather than firing it now', async () => {
      // Otherwise the Ctrl+C lands immediately — interrupting the sender's own
      // turn — and the message arrives alone N seconds later.
      vi.useFakeTimers();
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'later', workspace: '/tmp/ws',
        options: { raw: true, interrupt: true, deliverAfter: 5 },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-091', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => idleSession(mockWrite), listSessions: () => [],
      });
      const { res } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
      expect(mockWrite).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockWrite.mock.calls[0][0]).toBe('\x03');
    });

    it('ORDERING: a delayed message never overtakes an earlier buffered one', async () => {
      // The regression guard for the one hazard in Spec 1307 that a manual
      // re-send cannot repair. Exercised against the REAL route and the REAL
      // module-level SendBuffer — an equivalent test that re-implements the
      // shouldDefer predicate locally would keep passing if the shipped
      // predicate regressed, which is exactly what review caught.
      vi.useFakeTimers();
      const mockWrite = vi.fn();
      let typing = true;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          write: mockWrite, pid: 1234, writable: true,
          isUserIdle: () => !typing, composing: false,
        }),
        listSessions: () => [],
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-fifo-001', workspacePath: '/tmp/ws', agent: 'architect',
      });

      // 1. /clear is sent while the user is typing → buffered by Spec 403.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: '/clear', workspace: '/tmp/ws', options: { raw: true },
      });
      const first = makeRes();
      await handleRequest(makeReq('POST', '/api/send'), first.res, makeCtx());
      expect(JSON.parse(first.body()).deferred).toBe(true);
      expect(mockWrite).not.toHaveBeenCalled();

      // 2. /arch-init is scheduled for +15s.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: '/arch-init main', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 15 },
      });
      const second = makeRes();
      await handleRequest(makeReq('POST', '/api/send'), second.res, makeCtx());
      expect(JSON.parse(second.body()).scheduled).toBe(true);

      // 3. The user stops typing BEFORE the delayed message comes due. The
      //    buffer's flush timer is not running yet, so /clear is still queued.
      //    This isolates the `hasPending` term specifically: the session is
      //    idle, so only that term can prevent a direct write.
      typing = false;
      await vi.advanceTimersByTimeAsync(15_000);

      // Nothing has bypassed the queue.
      const writesBeforeFlush = mockWrite.mock.calls.map(c => String(c[0])).join('');
      expect(writesBeforeFlush).not.toContain('/arch-init');

      // 4. Draining the buffer delivers them in the order they were sent.
      startSendBuffer(() => {});
      await vi.advanceTimersByTimeAsync(600);
      const order = mockWrite.mock.calls.map(c => String(c[0])).join('|');
      expect(order.indexOf('/clear')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('/arch-init')).toBeGreaterThan(order.indexOf('/clear'));
    });

    it('ORDERING: a delayed --interrupt also queues, carrying its Ctrl+C', async () => {
      // An immediate --interrupt deliberately bypasses buffering. A DELAYED one
      // must not, or it reintroduces the same inversion through a side door.
      vi.useFakeTimers();
      const mockWrite = vi.fn();
      let typing = true;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          write: mockWrite, pid: 1234, writable: true,
          isUserIdle: () => !typing, composing: false,
        }),
        listSessions: () => [],
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-fifo-002', workspacePath: '/tmp/ws', agent: 'architect',
      });

      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'first', workspace: '/tmp/ws', options: { raw: true },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'urgent', workspace: '/tmp/ws',
        options: { raw: true, interrupt: true, deliverAfter: 5 },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      typing = false;
      await vi.advanceTimersByTimeAsync(5_000);

      // The Ctrl+C has NOT jumped the queue.
      expect(mockWrite.mock.calls.map(c => c[0])).not.toContain('\x03');

      startSendBuffer(() => {});
      await vi.advanceTimersByTimeAsync(1_000);
      const writes = mockWrite.mock.calls.map(c => c[0]);
      const ctrlC = writes.indexOf('\x03');
      const firstIdx = writes.findIndex(w => String(w).includes('first'));
      const urgentIdx = writes.findIndex(w => String(w).includes('urgent'));
      // Order: first → Ctrl+C → urgent. The interrupt lands directly ahead of
      // its own payload, not ahead of the whole queue.
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(ctrlC).toBeGreaterThan(firstIdx);
      expect(urgentIdx).toBeGreaterThan(ctrlC);
    });

    it('ORDERING: two simultaneous delayed sends do not interleave their writes', async () => {
      // Against the REAL route and the REAL paced writer. The unit-level chain
      // test used an artificially async callback, so it proved the chain waits
      // for the CALLBACK — not for the writes the callback schedules.
      // writeMessageToSession returns after SCHEDULING its pacing and trailing
      // Enter, so without waiting out that window two due messages produce
      // "firstsecond\r\r" rather than two messages.
      vi.useFakeTimers();
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => idleSession(mockWrite), listSessions: () => [],
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-serial-001', workspacePath: '/tmp/ws', agent: 'architect',
      });

      for (const text of ['first', 'second']) {
        mockParseJsonBody.mockResolvedValue({
          to: 'architect:main', message: text, workspace: '/tmp/ws',
          options: { raw: true, deliverAfter: 5 },
        });
        await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());
      }

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(2_000);

      const writes = mockWrite.mock.calls.map(c => String(c[0]));
      const firstIdx = writes.findIndex(w => w.includes('first'));
      const secondIdx = writes.findIndex(w => w.includes('second'));

      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);

      // The decisive assertion: everything belonging to the FIRST message —
      // including its trailing Enter — lands before the second begins. An
      // Enter appearing after 'second' would mean the writes interleaved.
      const enterAfterFirst = writes.findIndex((w, i) => i > firstIdx && w === '\r');
      expect(enterAfterFirst).toBeGreaterThan(firstIdx);
      expect(enterAfterFirst).toBeLessThan(secondIdx);
    });

    it('ORDERING: a delayed send due MID-FLUSH does not write into the flush', async () => {
      // The window `hasPending` used to miss. flush() drops a session's queue as
      // soon as it has SCHEDULED its paced writes, so between that moment and
      // the trailing Enter landing, the queue looks empty. A delayed /arch-init
      // due in that window used to write into the middle of the /clear being
      // delivered — yielding "/clear/arch-init main" on one line, so the clear
      // never executes at all.
      vi.useFakeTimers();
      const mockWrite = vi.fn();
      let typing = true;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          write: mockWrite, pid: 1234, writable: true,
          isUserIdle: () => !typing, composing: false,
        }),
        listSessions: () => [],
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-midflush-001', workspacePath: '/tmp/ws', agent: 'architect',
      });

      // The /clear must be long enough that its paced writes span a real
      // window: writeMessageToSession spaces lines 10ms apart and adds the
      // Enter 80ms after the last one, so 150 lines ≈ 1.57s of writing. A
      // short message completes in ~0.1s and the delayed send lands cleanly
      // after it — which is why an earlier version of this test passed with
      // the guard removed. Mutation testing caught that.
      const clearBody = Array.from({ length: 150 }, (_, i) => `CLEAR-${i}`).join('\n');
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: clearBody,
        workspace: '/tmp/ws', options: { raw: true },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      // Due at ~1s: after the flush starts (~0.5s), well before it finishes.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'ARCHINIT', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 1 },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      // User goes idle; the buffer flush starts writing the /clear.
      typing = false;
      startSendBuffer(() => {});
      await vi.advanceTimersByTimeAsync(600);   // flush fires, schedules writes
      await vi.advanceTimersByTimeAsync(1_000); // /arch-init comes due MID-write
      await vi.advanceTimersByTimeAsync(5_000); // everything settles

      const writes = mockWrite.mock.calls.map(c => String(c[0]));
      const joined = writes.join('');
      const archIdx = joined.indexOf('ARCHINIT');
      const lastClearIdx = joined.lastIndexOf('CLEAR-149');

      expect(archIdx).toBeGreaterThanOrEqual(0);
      expect(lastClearIdx).toBeGreaterThanOrEqual(0);
      // Every part of the clear lands before the re-orientation begins.
      expect(archIdx).toBeGreaterThan(lastClearIdx);
    });

    it('ORDERING: a delayed --interrupt due MID-FLUSH does not split into the flush', async () => {
      // Review regression: deleting busyUntil made hasPending queue-only, and a
      // delayed --interrupt wrote its Ctrl+C DIRECTLY (outside the lock) before
      // its payload. Due mid-flush, that Ctrl+C landed inside the flush's
      // stream, separated from its own payload. The fix folds the Ctrl+C into
      // the payload's submitToSession reservation, so the whole interrupt+
      // message queues behind the flush as a unit.
      vi.useFakeTimers();
      const mockWrite = vi.fn();
      let typing = true;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          write: mockWrite, pid: 1234, writable: true,
          isUserIdle: () => !typing, composing: false,
        }),
        listSessions: () => [],
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-midflush-int', workspacePath: '/tmp/ws', agent: 'architect',
      });

      const clearBody = Array.from({ length: 150 }, (_, i) => `CLEAR-${i}`).join('\n');
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: clearBody, workspace: '/tmp/ws', options: { raw: true },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      // A delayed INTERRUPT due mid-flush.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'URGENT', workspace: '/tmp/ws',
        options: { raw: true, interrupt: true, deliverAfter: 1 },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      typing = false;
      startSendBuffer(() => {});
      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);

      const writes = mockWrite.mock.calls.map(c => String(c[0]));
      const ctrlCIdx = writes.indexOf('\x03');
      const lastClear = writes.map((w, i) => w.includes('CLEAR-149') ? i : -1).filter(i => i >= 0).pop() ?? -1;
      const urgentIdx = writes.findIndex(w => w.includes('URGENT'));

      // The Ctrl+C did not jump into the flush: it lands after the whole clear,
      // and directly ahead of its own payload.
      expect(lastClear).toBeGreaterThanOrEqual(0);
      expect(ctrlCIdx).toBeGreaterThan(lastClear);
      expect(urgentIdx).toBeGreaterThan(ctrlCIdx);
    });

    it('CANCELLATION: a delayed send whose lock wait outlasts shutdown does not write', async () => {
      // The route-site `stillLive` guard, exercised where it lives. The
      // delayed-send unit test only checks the predicate's value; this drives
      // the real deliverOrBuffer and asserts the WRITE is skipped.
      //
      // Window: the delayed timer fires (generation check passes), delivery
      // enters deliverOrBuffer and calls submitToSession, which QUEUES behind an
      // occupier already holding this session's lock. Shutdown then bumps the
      // generation. When the lock frees, the guard inside the reservation sees
      // stillLive() === false and returns without writing.
      vi.useFakeTimers();
      resetSubmissionChains();
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          write: mockWrite, pid: 1234, writable: true,
          isUserIdle: () => true, composing: false,
        }),
        listSessions: () => [],
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-cancel-lock', workspacePath: '/tmp/ws', agent: 'architect',
      });

      // Occupy the session's lock for 10s so any later submission queues behind it.
      void submitToSession('term-cancel-lock', () => 10_000);

      // A delayed send due at 1s — it will queue behind the occupier.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'CANARYMSG', workspace: '/tmp/ws',
        options: { raw: true, deliverAfter: 1 },
      });
      await handleRequest(makeReq('POST', '/api/send'), makeRes().res, makeCtx());

      await vi.advanceTimersByTimeAsync(1_000); // delayed timer fires, queues on the lock
      shutdownDelayedSends();                    // shutdown while it waits
      await vi.advanceTimersByTimeAsync(15_000); // occupier frees; queued delivery runs its guard

      // The guard skipped the write: CANARYMSG never reached the session.
      const wrote = mockWrite.mock.calls.map(c => String(c[0])).join('');
      expect(wrote).not.toContain('CANARYMSG');
    });

    it('leaves undelayed sends on the immediate path', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect:main', message: 'now', workspace: '/tmp/ws', options: { raw: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-delay-096', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => idleSession(mockWrite), listSessions: () => [],
      });
      const { res, body } = makeRes();

      await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

      const parsed = JSON.parse(body());
      expect(parsed.scheduled).toBe(false);
      expect(mockWrite).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /api/analytics (Spec 456)
  // =========================================================================

  describe('GET /api/analytics', () => {
    const fakeStats = {
      timeRange: '7d',
      activity: { prsMerged: 5, medianTimeToMergeHours: 2.5, issuesClosed: 4, medianTimeToCloseBugsHours: 1.2, projectsByProtocol: { spir: { count: 2, avgWallClockHours: 36 }, bugfix: { count: 1, avgWallClockHours: 2.5 } } },
      consultation: { totalCount: 10, totalCostUsd: 0.5, costByModel: {}, avgLatencySeconds: 12, successRate: 90, byModel: [], byReviewType: {}, byProtocol: {} },
    };

    beforeEach(() => {
      mockComputeAnalytics.mockResolvedValue(fakeStats);
      mockGetKnownWorkspacePaths.mockReturnValue(['/tmp/workspace']);
    });

    it('dispatches GET /api/analytics and returns JSON', async () => {
      const req = makeReq('GET', '/api/analytics?range=7');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.activity.prsMerged).toBe(5);
      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '7', false);
    });

    it('returns 400 for invalid range', async () => {
      const req = makeReq('GET', '/api/analytics?range=999');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toMatch(/Invalid range/);
      expect(mockComputeAnalytics).not.toHaveBeenCalled();
    });

    it('defaults range to 7 when omitted', async () => {
      const req = makeReq('GET', '/api/analytics');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '7', false);
    });

    it('passes refresh=true when refresh=1 query param is set', async () => {
      const req = makeReq('GET', '/api/analytics?range=30&refresh=1');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '30', true);
    });

    it('returns default empty response when no workspace is available', async () => {
      mockGetKnownWorkspacePaths.mockReturnValue([]);

      const req = makeReq('GET', '/api/analytics?range=30');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.timeRange).toBe('30d');
      expect(parsed.activity.prsMerged).toBe(0);
      expect(parsed.activity).not.toHaveProperty('activeBuilders');
      expect(mockComputeAnalytics).not.toHaveBeenCalled();
    });

    it('accepts range=all', async () => {
      const req = makeReq('GET', '/api/analytics?range=all');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', 'all', false);
    });

    it('accepts range=1 (24h)', async () => {
      const req = makeReq('GET', '/api/analytics?range=1');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '1', false);
    });
  });

  // Spec 755: POST /api/workspaces/:encodedPath/architects
  describe('POST /api/workspaces/:path/architects (Spec 755)', () => {
    it('returns 200 with success body when addArchitect succeeds', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: true,
        name: 'sibling',
        terminalId: 'term-arch-sibling',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({ name: 'sibling' });

      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed).toEqual({ success: true, name: 'sibling', terminalId: 'term-arch-sibling' });
      expect(addArchitect).toHaveBeenCalledWith('/test/workspace', 'sibling');
    });

    it('passes through undefined name to auto-number', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: true,
        name: 'architect-2',
        terminalId: 'term-arch-2',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({});

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(addArchitect).toHaveBeenCalledWith('/test/workspace', undefined);
    });

    it('returns 404 when workspace is not running', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: false,
        error: "Workspace '/test/workspace' is not running. Start it with 'afx workspace start' first.",
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({});

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
    });

    it('returns 400 on validation error (e.g., collision)', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: false,
        error: "Architect 'sibling' is already registered in this workspace.",
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({ name: 'sibling' });

      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      const parsed = JSON.parse(body());
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('already registered');
    });

    it('returns 405 for non-POST methods', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/api/workspaces/${encoded}/architects`);

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(405);
    });

    it('returns 400 for malformed workspace path encoding', async () => {
      const req = makeReq('POST', `/api/workspaces/relative-path/architects`);

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });
  });
});
