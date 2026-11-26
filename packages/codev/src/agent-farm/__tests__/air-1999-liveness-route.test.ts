/**
 * GET /api/liveness (#1999): the probe every CLI command sends before it talks to Tower.
 *
 * The claim is that the route does no work, so the heavy functions behind `/health` are spies
 * here: the instance list, the process census and the global.db handle. The same spies are
 * asked of `/health` first, so a spy that is not wired to what the routes really call fails
 * that control instead of passing the liveness test by accident.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { GLOBAL_CURRENT_VERSION } from '../db/migrations.js';
import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';
import { isPublicRoute } from '../utils/server-utils.js';

const heavy = vi.hoisted(() => ({
  db: null as unknown as import('better-sqlite3').Database,
  getInstances: vi.fn(async () => [{ running: true, workspacePath: '/a' }]),
  listProcessCensus: vi.fn(async () => []),
  getGlobalDb: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock('../servers/tower-instances.js', () => ({
  getInstances: heavy.getInstances,
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../servers/process-census.js', () => ({ listProcessCensus: heavy.listProcessCensus }));
vi.mock('../db/index.js', () => ({ getGlobalDb: heavy.getGlobalDb, getDb: heavy.getDb }));

// Stub the rest of the tower-routes import graph (standard route-test preamble).
vi.mock('../servers/tower-cron.js', () => ({
  getAllTasks: vi.fn(() => []),
  executeTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  getTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  loadWorkspaceTasks: vi.fn(() => []),
}));
vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: vi.fn(() => ({ getSession: vi.fn(), listSessions: vi.fn(() => []) })),
  getWorkspaceTerminalsEntry: vi.fn(),
  getNextShellId: vi.fn(),
  saveTerminalSession: vi.fn(),
  isSessionPersistent: vi.fn(),
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  removeFileTab: vi.fn(),
  getTerminalsForWorkspace: vi.fn(() => []),
  isStartupReconcileSettled: vi.fn(() => true),
}));
vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  isResolveError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'code' in r),
}));
vi.mock('../utils/message-format.js', () => ({
  formatArchitectMessage: vi.fn((_to: string, msg: string) => msg),
  formatArchitectToBuilderMessage: vi.fn((_to: string, msg: string) => msg),
  formatBuilderMessage: vi.fn((id: string, to: string, msg: string) => `[${id} → ${to}] ${msg}`),
}));
vi.mock('../utils/server-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/server-utils.js')>()),
  parseJsonBody: vi.fn(async () => ({})),
  isRequestAllowed: vi.fn(() => true),
}));
vi.mock('../servers/tower-tunnel.js', () => ({
  initTunnel: vi.fn(),
  shutdownTunnel: vi.fn(),
  handleTunnelEndpoint: vi.fn(),
}));
vi.mock('../servers/tower-websocket.js', () => ({ setupUpgradeHandler: vi.fn() }));
vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] }));
    invalidate = vi.fn();
  },
}));
vi.mock('../../terminal/session-manager.js', () => ({ SessionManager: class {} }));
vi.mock('../../terminal/index.js', () => ({ DEFAULT_COLS: 120, defaultSessionOptions: {} }));
vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  encodeWorkspacePath: (p: string) => Buffer.from(p).toString('base64url'),
  decodeWorkspacePath: (p: string) => Buffer.from(p, 'base64url').toString(),
}));

/** A context whose shellper manager is live, so `/health` reaches its census. */
function makeCtx(getShellperManager: RouteContext['getShellperManager']): RouteContext {
  return {
    log: vi.fn(),
    port: 4100,
    version: '3.4.0',
    startedAt: '2026-11-26T00:00:00.000Z',
    templatePath: null,
    reactDashboardPath: '/tmp/dash',
    hasReactDashboard: false,
    getShellperManager,
    broadcastNotification: vi.fn(),
    addSseClient: vi.fn(() => true),
    removeSseClient: vi.fn(),
  };
}

function makeReq(method: string, url: string): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:4100' };
  return req;
}

function makeRes(): { res: http.ServerResponse; status: () => number; body: () => string } {
  let status = 200;
  let body = '';
  const res = new EventEmitter() as http.ServerResponse;
  res.writeHead = vi.fn((code: number) => {
    status = code;
    return res;
  }) as unknown as http.ServerResponse['writeHead'];
  res.end = vi.fn((data?: string) => {
    if (data) body = data;
    return res;
  }) as unknown as http.ServerResponse['end'];
  res.setHeader = vi.fn() as unknown as http.ServerResponse['setHeader'];
  return { res, status: () => status, body: () => body };
}

describe('GET /api/liveness (#1999)', () => {
  let getShellperManager: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    heavy.db = new Database(':memory:');
    heavy.db.exec(GLOBAL_SCHEMA);
    heavy.getGlobalDb.mockImplementation(() => heavy.db);
    heavy.getDb.mockImplementation(() => heavy.db);
    getShellperManager = vi.fn(() => ({ socketDir: '/tmp/shellper-sockets' }));
  });

  it('control: /health calls the instance list, the census and global.db, so the spies are live', async () => {
    const { res, status } = makeRes();
    await handleRequest(makeReq('GET', '/health'), res, makeCtx(getShellperManager as never));

    expect(status()).toBe(200);
    expect(heavy.getInstances).toHaveBeenCalled();
    expect(heavy.listProcessCensus).toHaveBeenCalled();
    expect(heavy.getGlobalDb).toHaveBeenCalled();
  });

  it('calls none of them: no instance list, no process census, no database read', async () => {
    const prepare = vi.spyOn(heavy.db, 'prepare');
    const { res, status } = makeRes();
    await handleRequest(makeReq('GET', '/api/liveness'), res, makeCtx(getShellperManager as never));

    expect(status()).toBe(200);
    expect(heavy.getInstances).not.toHaveBeenCalled();
    expect(heavy.listProcessCensus).not.toHaveBeenCalled();
    expect(heavy.getGlobalDb).not.toHaveBeenCalled();
    expect(heavy.getDb).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(getShellperManager).not.toHaveBeenCalled();
  });

  it("answers the running Tower's version, schema version and start time", async () => {
    const { res, body } = makeRes();
    await handleRequest(makeReq('GET', '/api/liveness'), res, makeCtx(getShellperManager as never));

    expect(JSON.parse(body())).toEqual({
      status: 'alive',
      version: '3.4.0',
      schemaVersion: GLOBAL_CURRENT_VERSION,
      startedAt: '2026-11-26T00:00:00.000Z',
    });
  });

  it('is public, like the /health it replaces as the probe, and only for GET', () => {
    expect(isPublicRoute('GET', '/api/liveness')).toBe(true);
    expect(isPublicRoute('POST', '/api/liveness')).toBe(false);
  });
});
