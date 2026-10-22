/**
 * Spec 1595, phase 5: agent state served on the overview.
 *
 * Integration through the real `handleRequest` dispatch: lifecycle reports are
 * posted to `POST /api/agent-lifecycle` (real route, real resolver over an
 * in-memory `global.db`, real store), liveness is the real tracker over a fake
 * process snapshot, and `GET /api/overview` projects both onto the registered
 * builders and architects. Only the terminal registry, the PTY sessions and the
 * overview's discovery cache are stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { TOWER_KEY_HEADER, type OverviewBuilder, type OverviewData } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../../db/schema.js';

const h = vi.hoisted(() => ({
  db: null as unknown as import('better-sqlite3').Database,
  builders: [] as Array<Record<string, unknown>>,
  entry: {
    architects: new Map<string, string>(),
    builders: new Map<string, string>(),
    shells: new Map<string, string>(),
    fileTabs: new Map<string, unknown>(),
  },
  sessions: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../db/index.js', () => ({ getGlobalDb: () => h.db }));
vi.mock('../tower-cron.js', () => ({
  getAllTasks: vi.fn(() => []),
  executeTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  getTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  loadWorkspaceTasks: vi.fn(() => []),
}));
vi.mock('../tower-instances.js', () => ({
  getInstances: vi.fn(async () => []),
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: vi.fn(() => ({
    getSession: (id: string) => h.sessions.get(id),
    listSessions: vi.fn(() => []),
  })),
  getWorkspaceTerminalsEntry: vi.fn(),
  getRehydratedTerminalsEntry: vi.fn(async () => h.entry),
  getNextShellId: vi.fn(),
  saveTerminalSession: vi.fn(),
  isSessionPersistent: vi.fn(() => true),
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  removeFileTab: vi.fn(),
  getTerminalsForWorkspace: vi.fn(() => []),
}));
vi.mock('../tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  isResolveError: vi.fn(() => false),
}));
vi.mock('../tower-tunnel.js', () => ({
  initTunnel: vi.fn(),
  shutdownTunnel: vi.fn(),
  handleTunnelEndpoint: vi.fn(),
}));
vi.mock('../tower-websocket.js', () => ({ setupUpgradeHandler: vi.fn() }));
vi.mock('../overview.js', async (importActual) => ({
  ...(await importActual<typeof import('../overview.js')>()),
  // Discovery is stubbed: each request gets fresh copies of the listed builders,
  // as the real cache's per-request discovery does.
  OverviewCache: class {
    getOverview = vi.fn(async () => ({
      builders: h.builders.map(b => ({ ...b })),
      pendingPRs: [],
      backlog: [],
      recentlyClosed: [],
      architects: [],
    }));
    invalidate = vi.fn();
  },
}));
vi.mock('../../../terminal/session-manager.js', () => ({ SessionManager: class {} }));
vi.mock('../../../terminal/index.js', () => ({ DEFAULT_COLS: 120, defaultSessionOptions: {} }));

const { builderRoleId } = await import('../overview.js');
const { resetExpectedKeyCache } = await import('../../utils/server-utils.js');

type RouteContext = import('../tower-routes.js').RouteContext;
type Census = Array<{ pid: number; ppid: number }>;

const KEY = 'a'.repeat(64);
const WS = '/nonexistent-spec-1595-overview/workspace';
const NOW = Date.now();

const SPIR_DIR = 'spir-1595-agent-attention';
const SPIR_WORKTREE = `${WS}/.builders/${SPIR_DIR}`;
const SPIR_ROLE = 'builder-spir-1595';
const LEGACY_DIR = 'bugfix-42-fix-thing';
const LEGACY_WORKTREE = `${WS}/.builders/${LEGACY_DIR}`;
const LEGACY_ROLE = 'builder-bugfix-42';

/** The shellper pid of each builder session; its launch loop is pid + 1, the agent pid + 2. */
const SPIR_SHELLPER = 1000;
const LEGACY_SHELLPER = 2000;
const ARCHITECT_SHELLPER = 3000;

function session(pid: number, lastDataAt: number = NOW) {
  return { pid, shellperBacked: true, status: 'running', awaitingRestart: false, lastDataAt, label: 'x' };
}

/** A shellper → launch loop → agent chain for a builder. */
function builderTree(shellper: number): Census {
  return [
    { pid: shellper, ppid: 1 },
    { pid: shellper + 1, ppid: shellper },
    { pid: shellper + 2, ppid: shellper + 1 },
  ];
}

/** A shellper → agent chain for an architect. */
function architectTree(shellper: number): Census {
  return [{ pid: shellper, ppid: 1 }, { pid: shellper + 1, ppid: shellper }];
}

function overviewBuilder(dir: string, storedId: string, fields: Partial<OverviewBuilder> = {}): Record<string, unknown> {
  return {
    id: dir,
    issueId: null,
    issueTitle: null,
    phase: 'phase_5',
    protocolPhase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: `${WS}/.builders/${dir}`,
    roleId: builderRoleId(storedId, dir),
    protocol: 'spir',
    planPhases: [],
    progress: 0,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: null,
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: null,
    area: 'Uncategorized',
    prReady: false,
    ...fields,
  };
}

function makeReq(method: string, url: string, body = ''): http.IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as unknown as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:4100', [TOWER_KEY_HEADER]: KEY };
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

/**
 * One Tower process: its route module, store and liveness. `boot()` imports them
 * fresh after `vi.resetModules()`, so a second boot is a restarted Tower: new
 * in-memory state, the same `global.db`.
 */
async function boot() {
  vi.resetModules();
  const routes = await import('../tower-routes.js');
  const store = await import('../agent-state/store.js');
  const liveness = await import('../agent-state/liveness.js');
  const identity = await import('../agent-state/identity.js');
  const broadcast = await import('../agent-state/broadcast.js');
  identity.invalidateAgentIdentityMemo();
  return { routes, store, liveness, broadcast };
}

describe('GET /api/overview serves agentState (Spec 1595)', () => {
  const originalKey = process.env.CODEV_TOWER_KEY;
  let tower: Awaited<ReturnType<typeof boot>>;
  let census: Census;

  async function post(body: Record<string, unknown>): Promise<number> {
    const res = makeRes();
    await tower.routes.handleRequest(makeReq('POST', '/api/agent-lifecycle', JSON.stringify(body)), res, makeCtx());
    return res.status;
  }

  function report(worktreePath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { agent: { kind: 'builder', worktreePath }, sessionId: 'session-1', event: 'turn-started', at: NOW, ...overrides };
  }

  async function overview(): Promise<OverviewData> {
    const res = makeRes();
    await tower.routes.handleRequest(
      makeReq('GET', `/api/overview?workspace=${encodeURIComponent(WS)}`),
      res,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    return JSON.parse(res.body) as OverviewData;
  }

  function builderRow(data: OverviewData, roleId: string): OverviewBuilder {
    const row = data.builders.find(b => b.roleId === roleId);
    expect(row).toBeDefined();
    return row!;
  }

  /** Start this Tower's liveness over the stubbed registry and sweep it to a settled verdict. */
  async function settleLiveness(): Promise<void> {
    const tracker = tower.liveness.startAgentLiveness({
      agents: () => tower.liveness.registeredAgents(
        new Map([[WS, h.entry as never]]),
        (terminalId) => h.sessions.get(terminalId) as never,
        (p) => p,
      ),
      census: async () => census,
    });
    await tracker.sweep();
    await tracker.sweep();
  }

  beforeEach(async () => {
    process.env.CODEV_TOWER_KEY = KEY;
    resetExpectedKeyCache();
    h.db = new Database(':memory:');
    h.db.exec(GLOBAL_SCHEMA);
    const insertBuilder = h.db.prepare(
      `INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status)
       VALUES (?, ?, 'b', ?, 'branch', 'spec', 'implementing')`,
    );
    insertBuilder.run(WS, SPIR_ROLE, SPIR_WORKTREE);
    // A legacy row: its stored id predates role-shaped ids.
    insertBuilder.run(WS, 'bugfix-42', LEGACY_WORKTREE);
    h.db.prepare(
      `INSERT INTO architect (workspace_path, id, pid, port, cmd) VALUES (?, 'main', 1, 0, 'claude')`,
    ).run(WS);

    h.builders = [overviewBuilder(SPIR_DIR, SPIR_ROLE), overviewBuilder(LEGACY_DIR, 'bugfix-42')];
    h.entry.builders = new Map([[SPIR_ROLE, 'term-spir'], [LEGACY_ROLE, 'term-legacy']]);
    h.entry.architects = new Map([['main', 'term-main']]);
    h.sessions = new Map([
      ['term-spir', session(SPIR_SHELLPER)],
      ['term-legacy', session(LEGACY_SHELLPER)],
      ['term-main', session(ARCHITECT_SHELLPER, NOW - 1234)],
    ]);
    census = [...builderTree(SPIR_SHELLPER), ...builderTree(LEGACY_SHELLPER), ...architectTree(ARCHITECT_SHELLPER)];

    tower = await boot();
  });

  afterEach(() => {
    tower.liveness.stopAgentLiveness();
    h.db.close();
    if (originalKey === undefined) delete process.env.CODEV_TOWER_KEY;
    else process.env.CODEV_TOWER_KEY = originalKey;
    resetExpectedKeyCache();
  });

  it('serves null before anything is reported or swept', async () => {
    const data = await overview();
    expect(builderRow(data, SPIR_ROLE).agentState).toBeNull();
    expect(data.architects[0].agentState).toBeNull();
  });

  it('joins a report to its overview row for a role-shaped and a legacy stored id', async () => {
    expect(await post(report(SPIR_WORKTREE))).toBe(204);
    expect(await post(report(LEGACY_WORKTREE, {
      event: 'needs-input',
      needsInput: { kind: 'permission', tool: 'Bash', summary: 'npm test' },
    }))).toBe(204);
    await settleLiveness();

    const data = await overview();
    expect(builderRow(data, SPIR_ROLE).agentState).toMatchObject({
      state: 'working', source: 'harness', alive: true, activity: 'working',
    });
    expect(builderRow(data, LEGACY_ROLE).agentState).toMatchObject({
      state: 'needs-input',
      needsInput: { kind: 'permission', tool: 'Bash', summary: 'npm test' },
    });
  });

  it('serves the architect its state and its session lastDataAt', async () => {
    const status = await post({
      agent: { kind: 'architect', workspacePath: WS, name: 'main' },
      sessionId: 'arch-session',
      event: 'turn-ended',
      at: NOW,
    });
    expect(status).toBe(204);
    await settleLiveness();

    const [main] = (await overview()).architects;
    expect(main.name).toBe('main');
    expect(main.agentState).toMatchObject({ state: 'idle', alive: true, source: 'harness' });
    expect(main.lastDataAt).toBe(new Date(NOW - 1234).toISOString());
  });

  it('SC8: a blocked builder keeps its gate fields and is served blocked, even while working', async () => {
    const blockedSince = '2026-10-21T01:02:03.000Z';
    h.builders = [overviewBuilder(SPIR_DIR, SPIR_ROLE, {
      blocked: 'plan review', blockedGate: 'plan-approval', blockedSince,
    })];
    expect(await post(report(SPIR_WORKTREE))).toBe(204);
    await settleLiveness();

    const row = builderRow(await overview(), SPIR_ROLE);
    expect(row.blocked).toBe('plan review');
    expect(row.blockedGate).toBe('plan-approval');
    expect(row.blockedSince).toBe(blockedSince);
    expect(row.agentState).toMatchObject({ state: 'blocked', since: blockedSince, source: 'tower', activity: 'working' });
  });

  it('SC7: a registered builder with no PTY session is served dead', async () => {
    h.sessions.delete('term-spir');
    await settleLiveness();

    const row = builderRow(await overview(), SPIR_ROLE);
    expect(row.lastDataAt).toBeNull();
    expect(row.agentState).toMatchObject({ state: 'dead', alive: false, source: 'tower' });
  });

  it('SC7: a builder whose launch loop has no agent beneath it is served dead over its last report', async () => {
    expect(await post(report(SPIR_WORKTREE))).toBe(204);
    census = census.filter(p => p.pid !== SPIR_SHELLPER + 2);
    await settleLiveness();

    expect(builderRow(await overview(), SPIR_ROLE).agentState).toMatchObject({
      state: 'dead', alive: false, activity: 'working',
    });
  });

  it('SC14: a complete or verified builder whose agent is gone is never dead', async () => {
    h.builders = [
      overviewBuilder(SPIR_DIR, SPIR_ROLE, { phase: 'complete' }),
      overviewBuilder(LEGACY_DIR, 'bugfix-42', { phase: 'verified' }),
    ];
    h.sessions.delete('term-spir');
    h.sessions.delete('term-legacy');
    expect(await post(report(LEGACY_WORKTREE, { event: 'turn-ended' }))).toBe(204);
    await settleLiveness();

    const data = await overview();
    expect(builderRow(data, SPIR_ROLE).agentState).toBeNull();
    expect(builderRow(data, LEGACY_ROLE).agentState).toMatchObject({ state: 'idle', alive: false });
  });

  it('a posted event changes the next overview response and fires one overview-changed', async () => {
    await settleLiveness();
    const notify = vi.fn();
    const listener = tower.broadcast.coalesceAgentStateChanges(notify, 200);
    tower.store.agentStateStore.on(tower.store.AGENT_STATE_CHANGED, listener);
    try {
      expect(builderRow(await overview(), SPIR_ROLE).agentState).toBeNull();

      expect(await post(report(SPIR_WORKTREE, { at: NOW - 1 }))).toBe(204);
      expect(builderRow(await overview(), SPIR_ROLE).agentState).toMatchObject({ state: 'working', source: 'harness' });
      expect(await post(report(SPIR_WORKTREE, { event: 'turn-ended' }))).toBe(204);
      expect(builderRow(await overview(), SPIR_ROLE).agentState).toMatchObject({ state: 'idle', source: 'harness' });
      expect(notify).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(WS);
    } finally {
      tower.store.agentStateStore.off(tower.store.AGENT_STATE_CHANGED, listener);
    }
  });

  it('Test 6: after a Tower restart no reported state is served, and liveness still serves dead', async () => {
    expect(await post(report(SPIR_WORKTREE, {
      event: 'needs-input', needsInput: { kind: 'question' },
    }))).toBe(204);
    expect(await post(report(LEGACY_WORKTREE))).toBe(204);
    await settleLiveness();
    expect(builderRow(await overview(), SPIR_ROLE).agentState?.state).toBe('needs-input');

    tower.liveness.stopAgentLiveness();
    tower = await boot();
    h.sessions.delete('term-legacy');

    expect(builderRow(await overview(), SPIR_ROLE).agentState).toBeNull();
    await settleLiveness();
    const data = await overview();
    expect(builderRow(data, SPIR_ROLE).agentState).toBeNull();
    expect(builderRow(data, LEGACY_ROLE).agentState).toMatchObject({
      state: 'dead', source: 'tower', activity: null, activityAt: null,
    });
  });
});
