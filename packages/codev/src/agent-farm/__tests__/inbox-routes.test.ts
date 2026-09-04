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
import { handleRequest, handleInboxList } from '../servers/tower-routes.js';
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

describe('GET /api/inbox/:id', () => {
  it('returns the full row INCLUDING the body (the show view surfaces bodies, unlike the list)', async () => {
    const row = seedHeld({ reason: 'no-live-pty' });
    const res = makeRes();
    await handleRequest(makeReq('GET', `/api/inbox/${row.id}`), res, makeCtx());

    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: row.id,
      workspacePath: WS,
      toAgent: 'spir-1',
      fromAgent: 'architect',
      status: 'held',
      reason: 'no-live-pty',
      escalated: false,
      // The single-row view DELIBERATELY carries the body — the exact contrast with the
      // list's redaction. This is the reconciled behavior (Spec 1313 Redaction rule +
      // decision 8): `afx inbox show <id>` is the sanctioned body-display surface.
      body: 'SECRET BODY — must never appear in the inbox list',
    });
  });

  it('normalizes the escalated flag from SQLite 0/1 to a boolean', async () => {
    const row = seedHeld();
    mailbox.markEscalated(holder.db, row.id, 2000);
    const res = makeRes();
    await handleRequest(makeReq('GET', `/api/inbox/${row.id}`), res, makeCtx());
    expect((JSON.parse(res._body) as { escalated: boolean }).escalated).toBe(true);
  });

  it('shows a row of ANY status — a dismissed row is still inspectable by id (audit)', async () => {
    const row = seedHeld();
    mailbox.dismiss(holder.db, row.id, 5000);
    const res = makeRes();
    await handleRequest(makeReq('GET', `/api/inbox/${row.id}`), res, makeCtx());
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body) as { status: string; resolvedAt: number | null };
    expect(body.status).toBe('dismissed');
    expect(body.resolvedAt).toBe(5000);
  });

  it('404s when the id names no row', async () => {
    const res = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox/does-not-exist'), res, makeCtx());
    expect(res._statusCode).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('rejects a non-GET method with 405 (the single-row view is read-only)', async () => {
    const row = seedHeld();
    const res = makeRes();
    // PUT /api/inbox/:id has no /dismiss suffix, so it falls through to the show route,
    // which must reject any non-GET method rather than act on it.
    await handleRequest(makeReq('PUT', `/api/inbox/${row.id}`), res, makeCtx());
    expect(res._statusCode).toBe(405);
  });
});

// ============================================================================
// Issue 1450 — the WORKSPACE-SCOPED inbox route (/workspace/<b64>/api/inbox)
//
// The dashboard is served under /workspace/<base64-path>/ and calls its API with relative
// `./api/...`, which lands in the workspace-scoped dispatcher rather than the Tower-level
// route table. Before this change that dispatcher had no `inbox` branch, so the held-mail
// popover's fetch 404'd. These tests pin the branch's scoping, its read-only-ness, and the
// non-reachability that the redaction argument depends on.
//
// `WS` ('/home/user/project') does not exist on disk, so `normalizeWorkspacePath` falls back
// to `resolve()` and returns it unchanged — the seeded rows and the decoded prefix agree.
// The harness mocks `decodeWorkspacePath` as plain base64url (see the preamble).
// ============================================================================

/** The dashboard's URL for a workspace's held mail. */
function wsInboxUrl(workspace: string, suffix = ''): string {
  return `/workspace/${Buffer.from(workspace).toString('base64url')}/api/inbox${suffix}`;
}

describe('GET /workspace/<b64>/api/inbox (Issue 1450)', () => {
  it('lists the held rows for the workspace named in the URL prefix', async () => {
    const row = seedHeld();
    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS)), res, makeCtx());

    expect(res._statusCode).toBe(200);
    const rows = JSON.parse(res._body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: row.id,
      workspacePath: WS,
      toAgent: 'spir-1',
      fromAgent: 'architect',
      reason: 'busy',
      escalated: false,
    });
  });

  it('never surfaces the message body (Spec 1313 redaction rule)', async () => {
    seedHeld();
    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS)), res, makeCtx());

    expect(res._body).not.toContain('SECRET BODY');
    expect(JSON.parse(res._body)[0]).not.toHaveProperty('body');
  });

  it('scopes to the URL workspace — another workspace\'s held mail is excluded', async () => {
    const mine = seedHeld();
    seedHeld({ workspacePath: '/home/user/other-project', toAgent: 'other-1' });

    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS)), res, makeCtx());

    const rows = JSON.parse(res._body) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mine.id);
  });

  it('ignores ?workspace= — the prefix wins, so a query param cannot redirect the scope', async () => {
    const mine = seedHeld();
    seedHeld({ workspacePath: '/home/user/other-project', toAgent: 'other-1' });

    const res = makeRes();
    await handleRequest(
      makeReq('GET', `${wsInboxUrl(WS)}?workspace=${encodeURIComponent('/home/user/other-project')}`),
      res,
      makeCtx(),
    );

    const rows = JSON.parse(res._body) as Array<{ id: string; workspacePath: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mine.id);
    expect(rows[0].workspacePath).toBe(WS);
  });

  it('an EMPTY override scopes to nothing rather than widening to every workspace', async () => {
    // Defensive: the dispatcher 400s a missing prefix, so a blank override is unreachable
    // from the route today. But "unreachable" is a property of the caller, and the safe
    // failure for a scoped call is zero rows, never every workspace's held mail.
    seedHeld();
    seedHeld({ workspacePath: '/home/user/other-project', toAgent: 'other-1' });

    const res = makeRes();
    handleInboxList(res, new URL('http://localhost/api/inbox'), '');

    expect(JSON.parse(res._body)).toEqual([]);
  });

  it('lists pre-due --delay rows too, so the popover can group them as scheduled', async () => {
    // This is the asymmetry Issue 1450's popover has to render: `listHeld` (this route) has
    // no not_before filter, while `heldSummaryForWorkspace` (the badge count) does. The
    // count is therefore a LOWER BOUND on this list's length, by design.
    const due = seedHeld({ toAgent: 'due-agent' });
    const preDue = seedHeld({ toAgent: 'scheduled-agent', notBefore: 9_999_999_999_999 });

    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS)), res, makeCtx());

    const rows = JSON.parse(res._body) as Array<{ id: string; notBefore: number | null }>;
    expect(rows.map((r) => r.id).sort()).toEqual([due.id, preDue.id].sort());
    expect(rows.find((r) => r.id === preDue.id)?.notBefore).toBe(9_999_999_999_999);

    // And the count surface excludes it — the two numbers legitimately differ.
    expect(mailbox.heldSummaryForWorkspace(holder.db, WS, 2000).total).toBe(1);
  });

  it('omits rows that are no longer held', async () => {
    const kept = seedHeld({ toAgent: 'kept' });
    const dismissed = seedHeld({ toAgent: 'gone' });
    mailbox.dismiss(holder.db, dismissed.id, 5000);

    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS)), res, makeCtx());

    const rows = JSON.parse(res._body) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(kept.id);
  });

  it('returns an empty list (not an error) when nothing is held', async () => {
    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS)), res, makeCtx());
    expect(res._statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
  });

  // -------------------------------------------------------------- non-reachability
  // The branch matches 'inbox' EXACTLY. These three assertions are what let the dashboard
  // be described as a metadata-only, read-only surface: the body route and the mutating
  // route simply do not exist under the workspace prefix.

  it('does not expose the body-bearing single-row route under the workspace prefix', async () => {
    const row = seedHeld();
    const res = makeRes();
    await handleRequest(makeReq('GET', wsInboxUrl(WS, `/${row.id}`)), res, makeCtx());

    expect(res._statusCode).toBe(404);
    expect(res._body).not.toContain('SECRET BODY');
  });

  it('does not expose dismiss under the workspace prefix — and the row survives', async () => {
    const row = seedHeld();
    const res = makeRes();
    await handleRequest(makeReq('POST', wsInboxUrl(WS, `/${row.id}/dismiss`)), res, makeCtx());

    expect(res._statusCode).toBe(404);
    expect(mailbox.listHeld(holder.db, WS)).toHaveLength(1); // still held, not dismissed
  });

  it('rejects a non-GET method on the list route without mutating anything', async () => {
    seedHeld();
    const res = makeRes();
    await handleRequest(makeReq('POST', wsInboxUrl(WS)), res, makeCtx());

    expect(res._statusCode).toBe(404); // no POST branch → falls through to the API 404
    expect(mailbox.listHeld(holder.db, WS)).toHaveLength(1);
  });

  it('leaves the Tower-level route behaviour unchanged (regression guard)', async () => {
    const mine = seedHeld();
    seedHeld({ workspacePath: '/home/user/other-project', toAgent: 'other-1' });

    // Explicit ?workspace= still scopes...
    const scoped = makeRes();
    await handleRequest(
      makeReq('GET', `/api/inbox?workspace=${encodeURIComponent(WS)}`),
      scoped,
      makeCtx(),
    );
    const scopedRows = JSON.parse(scoped._body) as Array<{ id: string }>;
    expect(scopedRows).toHaveLength(1);
    expect(scopedRows[0].id).toBe(mine.id);

    // ...and omitting it still lists every workspace (the direct-caller convenience).
    const all = makeRes();
    await handleRequest(makeReq('GET', '/api/inbox'), all, makeCtx());
    expect(JSON.parse(all._body)).toHaveLength(2);
  });
});
