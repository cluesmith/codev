// Tests for cron API route handlers (Spec 399 Phase 3)
// Tests handleCronList, handleCronTaskAction, enable/disable

import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockGetAllTasks, mockExecuteTask, mockGetTaskId, mockDbPrepare } = vi.hoisted(() => ({
  mockGetAllTasks: vi.fn(() => []),
  mockExecuteTask: vi.fn(async () => ({ result: 'success', output: 'ok' })),
  mockGetTaskId: vi.fn((ws: string, name: string) => `${ws}:${name}`),
  mockDbPrepare: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
    run: vi.fn(),
  }),
}));

vi.mock('../servers/tower-cron.js', () => ({
  getAllTasks: () => mockGetAllTasks(),
  executeTask: (task: unknown) => mockExecuteTask(task),
  getTaskId: (ws: string, name: string) => mockGetTaskId(ws, name),
  loadWorkspaceTasks: vi.fn(() => []),
}));

vi.mock('../db/index.js', () => ({
  getGlobalDb: () => ({ prepare: mockDbPrepare }),
}));

// Mock everything else that tower-routes imports
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
  getTerminalManager: vi.fn(() => ({
    getSession: vi.fn(),
    listSessions: vi.fn(() => []),
  })),
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

vi.mock('../servers/tower-websocket.js', () => ({
  setupUpgradeHandler: vi.fn(),
}));

vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] }));
    invalidate = vi.fn();
  },
}));

vi.mock('../../terminal/session-manager.js', () => ({
  SessionManager: class {},
}));

vi.mock('../../terminal/index.js', () => ({
  DEFAULT_COLS: 120,
  defaultSessionOptions: {},
}));

vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  encodeWorkspacePath: (p: string) => Buffer.from(p).toString('base64url'),
  decodeWorkspacePath: (p: string) => Buffer.from(p, 'base64url').toString(),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(): RouteContext {
  return {
    log: vi.fn(),
    port: 4100,
    templatePath: null,
    reactDashboardPath: '/tmp/dash',
    hasReactDashboard: false,
    getShellperManager: () => null,
    broadcastNotification: vi.fn(),
    addSseClient: vi.fn(),
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

function makeRes(): http.ServerResponse & { _body: string; _statusCode: number } {
  const res = new EventEmitter() as http.ServerResponse & { _body: string; _statusCode: number };
  res._body = '';
  res._statusCode = 200;
  res.writeHead = vi.fn((code: number) => {
    res._statusCode = code;
    return res;
  });
  res.end = vi.fn((data?: string) => {
    if (data) res._body = data;
    return res;
  });
  res.setHeader = vi.fn();
  return res;
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockDbPrepare.mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
    run: vi.fn(),
  });
});

describe('GET /api/cron/tasks', () => {
  it('returns empty list when no tasks', async () => {
    mockGetAllTasks.mockReturnValue([]);
    const req = makeReq('GET', '/api/cron/tasks');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
  });

  it('returns tasks with merged SQLite state', async () => {
    mockGetAllTasks.mockReturnValue([
      {
        name: 'CI Check',
        schedule: '*/30 * * * *',
        enabled: true,
        command: 'echo test',
        message: 'Test',
        target: 'architect',
        timeout: 30,
        workspacePath: '/ws',
      },
    ]);
    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ last_run: 1000, last_result: 'success', enabled: 1 }),
      run: vi.fn(),
    });

    const req = makeReq('GET', '/api/cron/tasks');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('CI Check');
    expect(body[0].workspacePath).toBe('/ws');
    expect(body[0].last_run).toBe(1000);
    expect(body[0].last_result).toBe('success');
  });

  it('filters by workspace query param', async () => {
    mockGetAllTasks.mockReturnValue([
      { name: 'Task A', schedule: '@hourly', enabled: true, command: 'a', message: 'A', target: 'architect', timeout: 30, workspacePath: '/ws1' },
      { name: 'Task B', schedule: '@hourly', enabled: true, command: 'b', message: 'B', target: 'architect', timeout: 30, workspacePath: '/ws2' },
    ]);

    const req = makeReq('GET', '/api/cron/tasks?workspace=/ws1');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    const body = JSON.parse(res._body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Task A');
  });
});

describe('GET /api/cron/tasks/:name/status', () => {
  it('returns task status details', async () => {
    mockGetAllTasks.mockReturnValue([
      { name: 'CI Check', schedule: '*/30 * * * *', enabled: true, command: 'echo test', message: 'Test', target: 'architect', timeout: 30, workspacePath: '/ws' },
    ]);
    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ last_run: 2000, last_result: 'success', last_output: 'output text', enabled: 1 }),
      run: vi.fn(),
    });

    const req = makeReq('GET', '/api/cron/tasks/CI%20Check/status?workspace=/ws');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.name).toBe('CI Check');
    expect(body.last_output).toBe('output text');
    expect(body.command).toBe('echo test');
  });

  it('returns 404 for unknown task', async () => {
    mockGetAllTasks.mockReturnValue([]);
    const req = makeReq('GET', '/api/cron/tasks/nonexistent/status');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());
    expect(res._statusCode).toBe(404);
  });
});

describe('POST /api/cron/tasks/:name/run', () => {
  it('triggers task execution', async () => {
    mockGetAllTasks.mockReturnValue([
      { name: 'CI Check', schedule: '*/30 * * * *', enabled: true, command: 'echo test', message: 'Test', target: 'architect', timeout: 30, workspacePath: '/ws' },
    ]);
    mockExecuteTask.mockResolvedValue({ result: 'success', output: 'done' });

    const req = makeReq('POST', '/api/cron/tasks/CI%20Check/run?workspace=/ws');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.ok).toBe(true);
    expect(body.result).toBe('success');
    expect(mockExecuteTask).toHaveBeenCalled();
  });
});

describe('POST /api/cron/tasks/:name/enable', () => {
  it('enables a task in SQLite', async () => {
    mockGetAllTasks.mockReturnValue([
      { name: 'CI Check', schedule: '*/30 * * * *', enabled: true, command: 'echo test', message: 'Test', target: 'architect', timeout: 30, workspacePath: '/ws' },
    ]);
    const mockRun = vi.fn();
    mockDbPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined), run: mockRun });

    const req = makeReq('POST', '/api/cron/tasks/CI%20Check/enable?workspace=/ws');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.enabled).toBe(true);
    expect(mockRun).toHaveBeenCalled();
  });
});

describe('POST /api/cron/tasks/:name/disable', () => {
  it('disables a task in SQLite', async () => {
    mockGetAllTasks.mockReturnValue([
      { name: 'CI Check', schedule: '*/30 * * * *', enabled: true, command: 'echo test', message: 'Test', target: 'architect', timeout: 30, workspacePath: '/ws' },
    ]);
    const mockRun = vi.fn();
    mockDbPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined), run: mockRun });

    const req = makeReq('POST', '/api/cron/tasks/CI%20Check/disable?workspace=/ws');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.enabled).toBe(false);
    expect(mockRun).toHaveBeenCalled();
  });
});

describe('ambiguous task name', () => {
  it('returns 409 when multiple tasks match without workspace filter', async () => {
    mockGetAllTasks.mockReturnValue([
      { name: 'CI Check', schedule: '@hourly', enabled: true, command: 'a', message: 'A', target: 'architect', timeout: 30, workspacePath: '/ws1' },
      { name: 'CI Check', schedule: '@hourly', enabled: true, command: 'b', message: 'B', target: 'architect', timeout: 30, workspacePath: '/ws2' },
    ]);

    const req = makeReq('GET', '/api/cron/tasks/CI%20Check/status');
    const res = makeRes();
    await handleRequest(req, res, makeCtx());

    expect(res._statusCode).toBe(409);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('AMBIGUOUS');
  });
});
