/**
 * Unit tests for tower-routes.ts (Spec 0105 Phase 6)
 *
 * Tests: route dispatch (handleRequest routing), CORS headers, security
 * checks, SSE events wiring, health check, terminal list, dashboard,
 * workspace path decoding, and 404 fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';

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
      // Message is written first, then \r is sent separately after a 50ms delay
      // so the PTY processes the multi-line paste before receiving Enter (Bugfix #492).
      const writeCalls = mockWrite.mock.calls;
      expect(writeCalls.length).toBe(1); // Initial write (message only)
      expect(writeCalls[0][0]).not.toMatch(/\r$/); // No \r in initial write
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
