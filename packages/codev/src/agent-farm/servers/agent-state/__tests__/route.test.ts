/**
 * Spec 1595, Test 2 (route half) and Test 6 (persistence half):
 * `POST /api/agent-lifecycle`.
 *
 * The validation cases drive `handleAgentLifecycle` directly with an injected
 * store and resolver. The end-to-end cases go through the real `handleRequest`
 * dispatch, so the key check is the real `isRequestAllowed` choke point, and the
 * real resolver reads a real in-memory `global.db` (the standard tower-routes
 * harness: everything else tower-routes imports is stubbed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../../../db/schema.js';

const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock('../../../db/index.js', () => ({ getGlobalDb: () => holder.db }));

vi.mock('../../tower-cron.js', () => ({
  getAllTasks: vi.fn(() => []),
  executeTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  getTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  loadWorkspaceTasks: vi.fn(() => []),
}));
vi.mock('../../tower-instances.js', () => ({
  getInstances: vi.fn(async () => []),
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../tower-terminals.js', () => ({
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
vi.mock('../../tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  isResolveError: vi.fn(() => false),
}));
vi.mock('../../tower-tunnel.js', () => ({
  initTunnel: vi.fn(),
  shutdownTunnel: vi.fn(),
  handleTunnelEndpoint: vi.fn(),
}));
vi.mock('../../tower-websocket.js', () => ({ setupUpgradeHandler: vi.fn() }));
vi.mock('../../overview.js', async (importActual) => ({
  ...(await importActual<typeof import('../../overview.js')>()),
  OverviewCache: class {
    getOverview = vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] }));
    invalidate = vi.fn();
  },
}));
vi.mock('../../../../terminal/session-manager.js', () => ({ SessionManager: class {} }));
vi.mock('../../../../terminal/index.js', () => ({ DEFAULT_COLS: 120, defaultSessionOptions: {} }));

const { handleRequest } = await import('../../tower-routes.js');
const { resetExpectedKeyCache } = await import('../../../utils/server-utils.js');
const { AgentStateStore, agentStateStore } = await import('../store.js');
const { handleAgentLifecycle, MAX_LIFECYCLE_BODY_BYTES } = await import('../route.js');
const { invalidateAgentIdentityMemo } = await import('../identity.js');
type RouteContext = import('../../tower-routes.js').RouteContext;

const KEY = 'a'.repeat(64);
const WS = '/nonexistent-spec-1595/workspace';
const WORKTREE = `${WS}/.builders/spir-1595-agent-attention`;
const NOW = Date.now();

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: { kind: 'builder', worktreePath: WORKTREE },
    sessionId: 'session-1',
    event: 'turn-started',
    at: NOW,
    ...overrides,
  };
}

function makeReq(body: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage;
  req.method = 'POST';
  req.url = '/api/agent-lifecycle';
  req.headers = { host: 'localhost:4100', ...headers };
  return req;
}

function makeRes(): http.ServerResponse & { status: number; body: string } {
  const res = new EventEmitter() as http.ServerResponse & { status: number; body: string };
  res.status = 0;
  res.body = '';
  res.writeHead = vi.fn((code: number) => {
    res.status = code;
    return res;
  }) as unknown as http.ServerResponse['writeHead'];
  res.end = vi.fn((data?: string) => {
    if (data) res.body = data;
    return res;
  }) as unknown as http.ServerResponse['end'];
  res.setHeader = vi.fn() as unknown as http.ServerResponse['setHeader'];
  return res;
}

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

// ============================================================================
// Validation, driven directly
// ============================================================================

describe('handleAgentLifecycle: validation', () => {
  const RESOLVED = { workspacePath: WS, agentId: 'builder-spir-1595' };
  let store: InstanceType<typeof AgentStateStore>;
  let resolve: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new AgentStateStore(() => NOW);
    resolve = vi.fn(() => RESOLVED);
  });

  async function post(body: unknown): Promise<{ status: number; body: string }> {
    const res = makeRes();
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    await handleAgentLifecycle(makeReq(raw), res, { store, resolve });
    return { status: res.status, body: res.body };
  }

  it('applies a valid report and answers an empty 204', async () => {
    const res = await post(report({ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash', summary: 'pnpm test' } }));
    expect(res).toEqual({ status: 204, body: '' });
    expect(resolve).toHaveBeenCalledWith({ kind: 'builder', worktreePath: WORKTREE });
    expect(store.get(WS, 'builder-spir-1595')).toMatchObject({
      activity: 'needs-input',
      needsInput: { kind: 'permission', tool: 'Bash', summary: 'pnpm test' },
    });
  });

  it('accepts an architect identity', async () => {
    const res = await post(report({ agent: { kind: 'architect', workspacePath: WS, name: 'main' } }));
    expect(res.status).toBe(204);
    expect(resolve).toHaveBeenCalledWith({ kind: 'architect', workspacePath: WS, name: 'main' });
  });

  const malformed: Array<[string, unknown]> = [
    ['invalid JSON', '{not json'],
    ['a non-object body', '[]'],
    ['an unknown top-level key', report({ extra: 1 })],
    ['an unknown identity key', report({ agent: { kind: 'builder', worktreePath: WORKTREE, cwd: '/x' } })],
    ['an unknown identity kind', report({ agent: { kind: 'shell', worktreePath: WORKTREE } })],
    ['a relative worktree path', report({ agent: { kind: 'builder', worktreePath: 'repo/.builders/x' } })],
    ['an unknown event', report({ event: 'PreToolUse' })],
    ['a missing sessionId', report({ sessionId: undefined })],
    ['an empty sessionId', report({ sessionId: '' })],
    ['a non-finite at', report({ at: 'soon' })],
    ['a zero at', report({ at: 0 })],
    ['needsInput on a non-needs-input event', report({ needsInput: { kind: 'permission' } })],
    ['backgroundWork on a non-turn-ended event', report({ backgroundWork: true })],
    ['a non-boolean backgroundWork', report({ event: 'turn-ended', backgroundWork: 'yes' })],
    ['an unknown needs-input kind', report({ event: 'needs-input', needsInput: { kind: 'menu' } })],
    ['an unknown needs-input key', report({ event: 'needs-input', needsInput: { kind: 'other', html: '<b>' } })],
    ['a control character in the summary', report({ event: 'needs-input', needsInput: { kind: 'permission', summary: 'a\nb' } })],
  ];
  for (const [label, body] of malformed) {
    it(`rejects ${label} with a 400 and only a code`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(Object.keys(JSON.parse(res.body))).toEqual(['error']);
      expect(resolve).not.toHaveBeenCalled();
    });
  }

  const overLimit: Array<[string, Record<string, unknown>]> = [
    ['worktreePath over 4096', { agent: { kind: 'builder', worktreePath: `/${'p'.repeat(4096)}` } }],
    ['workspacePath over 4096', { agent: { kind: 'architect', workspacePath: `/${'p'.repeat(4096)}`, name: 'main' } }],
    ['name over 128', { agent: { kind: 'architect', workspacePath: WS, name: 'n'.repeat(129) } }],
    ['sessionId over 128', { sessionId: 's'.repeat(129) }],
    ['tool over 64', { event: 'needs-input', needsInput: { kind: 'permission', tool: 't'.repeat(65) } }],
    ['summary over 200', { event: 'needs-input', needsInput: { kind: 'permission', summary: 's'.repeat(201) } }],
  ];
  for (const [label, overrides] of overLimit) {
    it(`rejects a field over its limit: ${label}`, async () => {
      expect((await post(report(overrides))).status).toBe(400);
    });
  }

  it('accepts fields exactly at their limits', async () => {
    const res = await post(report({
      sessionId: 's'.repeat(128),
      event: 'needs-input',
      needsInput: { kind: 'permission', tool: 't'.repeat(64), summary: 's'.repeat(200) },
    }));
    expect(res.status).toBe(204);
  });

  it('rejects a body over 8 KB with a 413', async () => {
    const res = await post(JSON.stringify(report({ pad: 'x'.repeat(MAX_LIFECYCLE_BODY_BYTES) })));
    expect(res.status).toBe(413);
  });

  it('rejects an unknown agent with a 404 and leaves the store empty', async () => {
    resolve.mockReturnValue(null);
    const res = await post(report());
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'UNKNOWN_AGENT' });
    expect(store.get(WS, 'builder-spir-1595')).toBeUndefined();
  });

  it('rejects a far-future hook time and ignores an older one', async () => {
    expect((await post(report({ at: NOW + 61_000 }))).status).toBe(400);
    expect(store.get(WS, 'builder-spir-1595')).toBeUndefined();

    expect((await post(report({ event: 'turn-ended', at: NOW }))).status).toBe(204);
    expect((await post(report({ event: 'turn-started', at: NOW - 1 }))).status).toBe(204);
    expect(store.get(WS, 'builder-spir-1595')?.activity).toBe('idle');

    expect((await post(report({ sessionId: 'session-0', event: 'turn-started', at: NOW }))).status).toBe(204);
    expect(store.get(WS, 'builder-spir-1595')).toMatchObject({ sessionId: 'session-1', activity: 'idle' });
  });
});

// ============================================================================
// End to end through handleRequest: auth, real resolver, no persistence
// ============================================================================

describe('POST /api/agent-lifecycle through handleRequest', () => {
  const originalKey = process.env.CODEV_TOWER_KEY;

  beforeEach(() => {
    process.env.CODEV_TOWER_KEY = KEY;
    resetExpectedKeyCache();
    invalidateAgentIdentityMemo();
    holder.db = new Database(':memory:');
    holder.db.exec(GLOBAL_SCHEMA);
    holder.db.prepare(
      `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status)
       VALUES (?, 'builder-spir-1595', 'b', ?, 'builder/spir-1595', 'spec', 'implementing')`,
    ).run(WS, WORKTREE);
    agentStateStore.drop(WS, 'builder-spir-1595');
  });

  afterEach(() => {
    holder.db.close();
    if (originalKey === undefined) delete process.env.CODEV_TOWER_KEY;
    else process.env.CODEV_TOWER_KEY = originalKey;
    resetExpectedKeyCache();
  });

  async function send(body: Record<string, unknown>, headers: Record<string, string>) {
    const res = makeRes();
    await handleRequest(makeReq(JSON.stringify(body), headers), res, makeCtx());
    return res;
  }

  it('rejects a report without the key, before it reaches the store', async () => {
    const res = await send(report(), {});
    expect(res.status).toBe(401);
    expect(agentStateStore.get(WS, 'builder-spir-1595')).toBeUndefined();
  });

  it('rejects a report with a wrong key', async () => {
    const res = await send(report(), { [TOWER_KEY_HEADER]: 'b'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('applies a keyed report for a registered builder under its canonical id, writing nothing to global.db', async () => {
    const changesBefore = holder.db.prepare('SELECT total_changes() AS n').get() as { n: number };
    const res = await send(report({ agent: { kind: 'builder', worktreePath: `${WORKTREE}/` } }), { [TOWER_KEY_HEADER]: KEY });
    expect(res.status).toBe(204);
    expect(agentStateStore.get(WS, 'builder-spir-1595')?.activity).toBe('working');

    const changesAfter = holder.db.prepare('SELECT total_changes() AS n').get() as { n: number };
    expect(changesAfter.n).toBe(changesBefore.n);
    const tables = holder.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.some(t => /agent.?state|lifecycle/i.test(t.name))).toBe(false);
  });

  it('rejects a keyed report for an unregistered builder', async () => {
    const res = await send(report({ agent: { kind: 'builder', worktreePath: `${WS}/.builders/bugfix-9-x` } }), { [TOWER_KEY_HEADER]: KEY });
    expect(res.status).toBe(404);
  });
});

describe('a fresh store', () => {
  it('holds no state for any agent (nothing is loaded from a previous Tower)', () => {
    const fresh = new AgentStateStore();
    expect(fresh.get(WS, 'builder-spir-1595')).toBeUndefined();
    expect(fresh.get(WS, 'main')).toBeUndefined();
  });
});
