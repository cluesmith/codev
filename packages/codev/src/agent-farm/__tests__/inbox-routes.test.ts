// Route-level tests for the inbox API (Spec 1313, Phase 7).
//
// Drives GET /api/inbox and POST /api/inbox/:id/dismiss through the real
// `handleRequest` dispatch against a REAL in-memory mailbox DB (getGlobalDb is the
// only db/index seam, remapped to an in-memory Database; db/mailbox is NOT mocked, so
// listHeld/dismiss run for real). Everything else tower-routes imports is stubbed —
// the standard tower-routes route-test harness. This covers the plan's integration
// case: held row → afx inbox shows it → dismiss → gone from the list, not delivered.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';

// The one db seam tower-routes uses: return a real in-memory DB, reseeded per test.
const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock('../db/index.js', () => ({ getGlobalDb: () => holder.db }));

// Stub the rest of the tower-routes import graph (standard route-test preamble).
vi.mock('../servers/tower-cron.js', () => ({
  getAllTasks: vi.fn(() => []),
  executeTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  getTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  loadWorkspaceTasks: vi.fn(() => []),
}));
vi.mock('../servers/tower-instances.js', () => ({
  getInstances: vi.fn(async () => []),
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
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
}));
vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  isResolveError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'code' in r),
}));
vi.mock('../utils/message-format.js', () => ({
  formatArchitectMessage: vi.fn((msg: string) => msg),
  formatBuilderMessage: vi.fn((id: string, msg: string) => `[${id}] ${msg}`),
}));
vi.mock('../utils/server-utils.js', () => ({
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

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(): RouteContext & { broadcastNotification: ReturnType<typeof vi.fn> } {
  return {
    log: vi.fn(),
    port: 4100,
    version: '9.9.9',
    startedAt: '2026-01-01T00:00:00.000Z',
    templatePath: null,
    reactDashboardPath: '/tmp/dash',
    hasReactDashboard: false,
    getShellperManager: () => null,
    broadcastNotification: vi.fn(),
    addSseClient: vi.fn(),
    removeSseClient: vi.fn(),
  } as RouteContext & { broadcastNotification: ReturnType<typeof vi.fn> };
}

function makeReq(method: string, url: string): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:4100' };
  return req;
}

function makeRes(): http.ServerResponse & { _body: string; _statusCode: number } {
  const res = new EventEmitter() as http.ServerResponse & { _body: string; _statusCode: number };
  res._body = '';
  res._statusCode = 200;
  res.writeHead = vi.fn((code: number) => {
    res._statusCode = code;
    return res;
  }) as unknown as http.ServerResponse['writeHead'];
  res.end = vi.fn((data?: string) => {
    if (data) res._body = data;
    return res;
  }) as unknown as http.ServerResponse['end'];
  res.setHeader = vi.fn() as unknown as http.ServerResponse['setHeader'];
  return res;
}

const WS = '/home/user/project';

function seedHeld(overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) {
  return mailbox.enqueue(
    holder.db,
    {
      workspacePath: WS,
      toAgent: 'spir-1',
      body: 'SECRET BODY — must never appear in the inbox list',
      formattedMessage: '[from architect] hi',
      fromAgent: 'architect',
      reason: 'busy',
      ...overrides,
    },
    now,
  );
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  holder.db = new Database(':memory:');
  holder.db.exec(GLOBAL_SCHEMA);
});
afterEach(() => holder.db.close());

describe('GET /api/inbox', () => {
  it('lists held rows as metadata only — never the message body (redaction)', async () => {
    const row = seedHeld({ reason: 'no-profile' });
    const res = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox'), res, makeCtx());

    expect(res._statusCode).toBe(200);
    const rows = JSON.parse(res._body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: row.id,
      workspacePath: WS,
      toAgent: 'spir-1',
      fromAgent: 'architect',
      reason: 'no-profile',
      escalated: false,
    });
    // Redaction: the raw body is never present anywhere in the payload.
    expect(res._body).not.toContain('SECRET BODY');
    expect(rows[0]).not.toHaveProperty('body');
    expect(rows[0]).not.toHaveProperty('formattedMessage');
  });

  it('normalizes the escalated flag from SQLite 0/1 to a boolean', async () => {
    const row = seedHeld();
    mailbox.markEscalated(holder.db, row.id, 2000);
    const res = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox'), res, makeCtx());
    expect((JSON.parse(res._body) as Array<{ escalated: boolean }>)[0].escalated).toBe(true);
  });

  it('scopes to ?workspace= when given (excludes other workspaces)', async () => {
    seedHeld({ workspacePath: WS });
    seedHeld({ workspacePath: '/other/ws' });
    const res = makeRes();
    await handleRequest(makeReq('GET', `/api/inbox?workspace=${encodeURIComponent(WS)}`), res, makeCtx());
    const rows = JSON.parse(res._body) as Array<{ workspacePath: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].workspacePath).toBe(WS);
  });

  it('normalizes the ?workspace= param so a non-canonical path still matches its held rows', async () => {
    seedHeld({ workspacePath: WS });
    // A trailing-slash variant of the same workspace: normalizeWorkspacePath (resolve)
    // canonicalizes it back to WS, so the row still matches. This is what lets the CLI
    // pass a raw workspace root (decision 8's default) that may differ from the stored
    // realpath key.
    const res = makeRes();
    await handleRequest(makeReq('GET', `/api/inbox?workspace=${encodeURIComponent(`${WS}/`)}`), res, makeCtx());
    const rows = JSON.parse(res._body) as Array<{ workspacePath: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].workspacePath).toBe(WS);
  });

  it('returns an empty array when nothing is held', async () => {
    const res = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox'), res, makeCtx());
    expect(JSON.parse(res._body)).toEqual([]);
  });
});

describe('POST /api/inbox/:id/dismiss', () => {
  it('integration: held row shows in the list, then dismiss removes it — dismissed, not delivered', async () => {
    const row = seedHeld();

    // Shows in the list.
    const before = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox'), before, makeCtx());
    expect((JSON.parse(before._body) as unknown[])).toHaveLength(1);

    // Dismiss.
    const ctx = makeCtx();
    const res = makeRes();
    await handleRequest(makeReq('POST', `/api/inbox/${row.id}/dismiss`), res, ctx);
    expect(res._statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true });

    // Gone from the list; the row is dismissed (NOT delivered).
    const after = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox'), after, makeCtx());
    expect(JSON.parse(after._body)).toEqual([]);
    expect(mailbox.getById(holder.db, row.id)?.status).toBe('dismissed');

    // The held-set changed → an overview-changed refresh fired.
    expect(ctx.broadcastNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overview-changed' }),
    );
  });

  it('404s when the id names no currently-held row, and does not broadcast', async () => {
    const ctx = makeCtx();
    const res = makeRes();
    await handleRequest(makeReq('POST', '/api/inbox/does-not-exist/dismiss'), res, ctx);
    expect(res._statusCode).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ error: 'NOT_FOUND' });
    expect(ctx.broadcastNotification).not.toHaveBeenCalled();
  });

  it('a dismissed row cannot be dismissed again (404 on the second attempt)', async () => {
    const row = seedHeld();
    await handleRequest(makeReq('POST', `/api/inbox/${row.id}/dismiss`), makeRes(), makeCtx());
    const res = makeRes();
    await handleRequest(makeReq('POST', `/api/inbox/${row.id}/dismiss`), res, makeCtx());
    expect(res._statusCode).toBe(404);
  });

  it('rejects a non-POST method with 405 and does not dismiss (state-changing route must not be GET-reachable)', async () => {
    const row = seedHeld();
    const ctx = makeCtx();
    const res = makeRes();
    await handleRequest(makeReq('GET', `/api/inbox/${row.id}/dismiss`), res, ctx);
    expect(res._statusCode).toBe(405);
    // The row is untouched — still held, never dismissed — and no indicator broadcast fired.
    expect(mailbox.getById(holder.db, row.id)?.status).toBe('held');
    expect(ctx.broadcastNotification).not.toHaveBeenCalled();
  });
});
