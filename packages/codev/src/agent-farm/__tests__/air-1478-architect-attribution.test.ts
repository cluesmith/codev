// Issue #1478 — the architect's specific name must survive the trip from `afx send`
// to both attribution surfaces.
//
// Root cause: `commands/send.ts` collapsed every architect sender to the generic string
// `architect`, and `formatMessageForTarget`'s any → builder branch discarded `from`
// entirely — so even a corrected sender could not have surfaced in the composer header.
//
// Two layers under test here:
//   1. `formatArchitectMessage` / `architectHeaderLabel` — the header label itself
//      (pure; every sender shape, including the ones that must stay unattributed).
//   2. The REAL /api/send route — a message from `architect:main` to a builder with no
//      live PTY lands in the mailbox carrying both the sender identity (`from_agent`,
//      which is what `afx inbox` renders) and the attributed composer header.
//
// The `afx inbox` rendering of that identity is covered in inbox-cli.test.ts; the
// send-side `from` value in send.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  architectHeaderLabel,
  formatArchitectMessage,
  formatBuilderMessage,
} from '../utils/message-format.js';

// ============================================================================
// 1. The header label (pure)
// ============================================================================

describe('architectHeaderLabel (issue #1478)', () => {
  it('names the specific architect carried as `architect:<name>`', () => {
    expect(architectHeaderLabel('architect:main')).toBe('ARCHITECT:main');
    expect(architectHeaderLabel('architect:feedback')).toBe('ARCHITECT:feedback');
    expect(architectHeaderLabel('architect-3')).toBe('ARCHITECT');
  });

  it('falls back to the bare label for senders that are not an architect identity', () => {
    // An unattributed call (cron's architect-framed paths, older callers) and a
    // builder → builder send both keep the historical header — this change is about
    // naming the architect, not relabelling every sender.
    expect(architectHeaderLabel(undefined)).toBe('ARCHITECT');
    expect(architectHeaderLabel('builder-air-1478')).toBe('ARCHITECT');
    // A malformed identity with no name after the colon must not render `ARCHITECT:`.
    expect(architectHeaderLabel('architect:')).toBe('ARCHITECT');
    expect(architectHeaderLabel('architect:   ')).toBe('ARCHITECT');
  });
});

describe('formatArchitectMessage (issue #1478)', () => {
  it('puts the architect name in the composer header', () => {
    const out = formatArchitectMessage('ship it', undefined, false, 'architect:feedback');
    expect(out).toMatch(/^### \[ARCHITECT:feedback INSTRUCTION \| .+\] ###\n/);
    expect(out).toContain('ship it');
    expect(out.endsWith('###############################')).toBe(true);
  });

  it('is unchanged when no sender is supplied (back-compat)', () => {
    const out = formatArchitectMessage('ship it');
    expect(out).toMatch(/^### \[ARCHITECT INSTRUCTION \| .+\] ###\n/);
  });

  it('keeps raw mode unattributed — body only, no header (issue #1478 note)', () => {
    expect(formatArchitectMessage('ship it', undefined, true, 'architect:main')).toBe('ship it');
  });

  it('still appends attached file content under an attributed header', () => {
    const out = formatArchitectMessage('review this', 'FILE BODY', false, 'architect:main');
    expect(out).toContain('ARCHITECT:main INSTRUCTION');
    expect(out).toContain('Attached content:\n```\nFILE BODY\n```');
  });

  it('leaves the builder → architect direction untouched (it already carried its sender)', () => {
    expect(formatBuilderMessage('builder-air-1478', 'done')).toMatch(
      /^### \[BUILDER builder-air-1478 MESSAGE \| .+\] ###\n/,
    );
  });
});

// ============================================================================
// 2. The route: /api/send → mailbox row (identity + composer header)
// ============================================================================
//
// Standard tower-routes route-test preamble (mirrors inbox-routes.test.ts), with two
// deliberate differences: `utils/message-format.js` is NOT mocked (the formatting is
// what's under test), and `resolveAgentInRegistry` is stubbed so the send takes the
// registry hold path — a known builder with no live PTY. That path exercises
// `formatMessageForTarget` and the `fromAgent` carrier without needing a live PTY.

const holder = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  body: {} as Record<string, unknown>,
}));
vi.mock('../db/index.js', () => ({ getGlobalDb: () => holder.db }));

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
const { mockResolveTarget, mockResolveInRegistry } = vi.hoisted(() => ({
  mockResolveTarget: vi.fn(),
  mockResolveInRegistry: vi.fn(),
}));
vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: mockResolveTarget,
  resolveAgentInRegistry: mockResolveInRegistry,
  broadcastMessage: vi.fn(),
  isResolveError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'code' in r),
}));
vi.mock('../utils/server-utils.js', () => ({
  parseJsonBody: vi.fn(async () => holder.body),
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

import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';

const WS = '/home/user/project';
const BUILDER = 'builder-air-1478';

function makeCtx(): RouteContext {
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
  } as unknown as RouteContext;
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

/** POST /api/send with `from`, taking the registry hold path (no live PTY). */
async function sendFrom(from: string | undefined, message = 'ship it') {
  holder.body = { to: BUILDER, message, from, workspace: WS, fromWorkspace: WS };
  const res = makeRes();
  await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
  return res;
}

describe('POST /api/send — architect identity reaches the mailbox (issue #1478)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    holder.db = new Database(':memory:');
    holder.db.exec(GLOBAL_SCHEMA);
    // Target is a KNOWN builder with no live PTY → the send holds, and the held row
    // carries exactly the identity + formatting the two surfaces render.
    mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
    mockResolveInRegistry.mockReturnValue({ kind: 'builder', agent: BUILDER, workspacePath: WS });
  });
  afterEach(() => holder.db.close());

  it('stores the specific architect as from_agent — what `afx inbox` renders', async () => {
    const res = await sendFrom('architect:feedback');

    expect(res._statusCode).toBe(200);
    const { mailboxId } = JSON.parse(res._body) as { mailboxId: string };
    const row = mailbox.getById(holder.db, mailboxId)!;
    // The carrier: pre-fix this was the generic 'architect' for every architect.
    expect(row.from_agent).toBe('architect:feedback');
    expect(row.to_agent).toBe(BUILDER);
  });

  it('names the architect in the delivered composer header (the any → builder branch)', async () => {
    const res = await sendFrom('architect:main');

    const { mailboxId } = JSON.parse(res._body) as { mailboxId: string };
    const row = mailbox.getById(holder.db, mailboxId)!;
    // `formatMessageForTarget` used to drop `from` on this branch entirely.
    expect(row.formatted_message).toMatch(/^### \[ARCHITECT:main INSTRUCTION \| .+\] ###\n/);
    expect(row.formatted_message).toContain('ship it');
    // The stored body stays the raw message — only the framing gained the name.
    expect(row.body).toBe('ship it');
  });

  it('leaves a builder → builder send on the bare ARCHITECT header', async () => {
    const res = await sendFrom('builder-spir-109');

    const { mailboxId } = JSON.parse(res._body) as { mailboxId: string };
    const row = mailbox.getById(holder.db, mailboxId)!;
    expect(row.formatted_message).toMatch(/^### \[ARCHITECT INSTRUCTION \| .+\] ###\n/);
    expect(row.from_agent).toBe('builder-spir-109');
  });

  it('passes the sender to resolveTarget unchanged, so affinity routing still sees it', async () => {
    await sendFrom('architect:main');
    expect(mockResolveTarget).toHaveBeenCalledWith(BUILDER, WS, 'architect:main');
  });
});
