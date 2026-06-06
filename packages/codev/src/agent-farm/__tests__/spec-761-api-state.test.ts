/**
 * Spec 761 — Phase 1 tests for /api/state architects collection.
 *
 * Verifies:
 *  - `architects: ArchitectState[]` is emitted with one entry per registered architect.
 *  - The `main` architect is moved to index 0 when present.
 *  - The scalar `architect` field is preserved and points to architects[0].
 *  - Empty / no-architect workspaces emit `architects: []` and `architect: null`.
 *  - Architects whose PTY session is gone are skipped silently.
 *  - The response carries the new shared `name` field on every architect entry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';

// ============================================================================
// Mocks (same shape as tower-routes.test.ts; kept local for isolation)
// ============================================================================

const { mockGetTerminalManager, mockGetSession,
  mockGetRehydratedTerminalsEntry, mockIsSessionPersistent,
  mockReadCloudConfig } = vi.hoisted(() => ({
  mockGetTerminalManager: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetRehydratedTerminalsEntry: vi.fn(async () => ({
    architects: new Map(),
    builders: new Map(),
    shells: new Map(),
    fileTabs: new Map(),
  })),
  mockIsSessionPersistent: vi.fn(),
  mockReadCloudConfig: vi.fn(() => null),
}));

vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: (...args: unknown[]) => mockReadCloudConfig(...args),
}));

vi.mock('../servers/tower-instances.js', () => ({
  getInstances: vi.fn(),
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
  addArchitect: vi.fn(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: mockGetTerminalManager,
  getWorkspaceTerminalsEntry: vi.fn(),
  getNextShellId: vi.fn(),
  saveTerminalSession: vi.fn(),
  isSessionPersistent: mockIsSessionPersistent,
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  deleteFileTab: vi.fn(),
  getTerminalsForWorkspace: vi.fn(),
  getRehydratedTerminalsEntry: mockGetRehydratedTerminalsEntry,
}));

vi.mock('../servers/tower-tunnel.js', () => ({
  handleTunnelEndpoint: vi.fn(),
}));

vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: vi.fn(),
  broadcastMessage: vi.fn(),
  isResolveError: vi.fn(() => false),
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
  parseJsonBody: vi.fn(async () => ({})),
}));

vi.mock('../servers/analytics.js', () => ({
  computeAnalytics: vi.fn(),
  clearAnalyticsCache: vi.fn(),
}));

vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] }));
    invalidate = vi.fn();
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
    addSseClient: vi.fn(),
    removeSseClient: vi.fn(),
    ...overrides,
  };
}

function makeReq(url: string): http.IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost:4100' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes() {
  const chunks: string[] = [];
  let code = 200;
  const res = {
    writeHead: vi.fn((status: number) => { code = status; }),
    setHeader: vi.fn(),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    write: vi.fn((data: string) => { chunks.push(data); }),
  } as any;
  return {
    res,
    body: () => chunks.join(''),
    statusCode: () => code,
  };
}

const ENCODED_WS = Buffer.from('/test/workspace').toString('base64url');
const STATE_URL = `/workspace/${ENCODED_WS}/api/state`;

// ============================================================================
// Tests
// ============================================================================

describe('Spec 761: /api/state architects collection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTerminalManager.mockReturnValue({ getSession: mockGetSession });
    mockIsSessionPersistent.mockReturnValue(false);
  });

  it('returns architects: [] and architect: null when no architect is registered', async () => {
    mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
      architects: new Map(),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });

    const { res, statusCode, body } = makeRes();
    await handleRequest(makeReq(STATE_URL), res, makeCtx());

    expect(statusCode()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.architects).toEqual([]);
    expect(parsed.architect).toBeNull();
  });

  it('returns single-architect collection with main at index 0', async () => {
    mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
      architects: new Map([['main', 'term-main']]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });
    mockGetSession.mockImplementation((id: string) =>
      id === 'term-main' ? { label: 'Architect', pid: 4242 } : undefined,
    );

    const { res, body } = makeRes();
    await handleRequest(makeReq(STATE_URL), res, makeCtx());

    const parsed = JSON.parse(body());
    expect(parsed.architects).toHaveLength(1);
    expect(parsed.architects[0]).toMatchObject({
      name: 'main',
      terminalId: 'term-main',
      pid: 4242,
      port: 0,
      persistent: false,
    });
    expect(parsed.architect).toEqual(parsed.architects[0]);
  });

  it('returns two-architect collection with main first when main inserted second', async () => {
    // Insertion order: sibling first, then main. The handler must still place
    // main at index 0 of architects[].
    mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
      architects: new Map([
        ['sibling', 'term-sibling'],
        ['main', 'term-main'],
      ]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });
    mockGetSession.mockImplementation((id: string) =>
      id === 'term-main' ? { label: 'Architect', pid: 1111 }
      : id === 'term-sibling' ? { label: 'Architect', pid: 2222 }
      : undefined,
    );

    const { res, body } = makeRes();
    await handleRequest(makeReq(STATE_URL), res, makeCtx());

    const parsed = JSON.parse(body());
    expect(parsed.architects).toHaveLength(2);
    expect(parsed.architects[0].name).toBe('main');
    expect(parsed.architects[1].name).toBe('sibling');
    expect(parsed.architect).toEqual(parsed.architects[0]);
  });

  it('returns three architects with main first; non-main entries follow insertion order', async () => {
    mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
      architects: new Map([
        ['architect-2', 'term-a2'],
        ['main', 'term-main'],
        ['architect-3', 'term-a3'],
      ]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });
    mockGetSession.mockImplementation((id: string) =>
      id === 'term-main' ? { pid: 1 }
      : id === 'term-a2' ? { pid: 2 }
      : id === 'term-a3' ? { pid: 3 }
      : undefined,
    );

    const { res, body } = makeRes();
    await handleRequest(makeReq(STATE_URL), res, makeCtx());

    const parsed = JSON.parse(body());
    expect(parsed.architects.map((a: { name: string }) => a.name)).toEqual([
      'main', 'architect-2', 'architect-3',
    ]);
  });

  it('skips architects whose PTY session is gone (race / stale registration)', async () => {
    mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
      architects: new Map([
        ['main', 'term-main'],
        ['ghost', 'term-ghost'],
      ]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });
    // term-ghost has no session — should be silently skipped.
    mockGetSession.mockImplementation((id: string) =>
      id === 'term-main' ? { pid: 9 } : undefined,
    );

    const { res, body } = makeRes();
    await handleRequest(makeReq(STATE_URL), res, makeCtx());

    const parsed = JSON.parse(body());
    expect(parsed.architects).toHaveLength(1);
    expect(parsed.architects[0].name).toBe('main');
  });

  it('exposes architect (singular) scalar even when only a non-main architect is registered', async () => {
    // No main; first registered should land in both architects[0] and architect.
    mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
      architects: new Map([['sibling', 'term-sibling']]),
      builders: new Map(),
      shells: new Map(),
      fileTabs: new Map(),
    });
    mockGetSession.mockReturnValue({ pid: 77 });

    const { res, body } = makeRes();
    await handleRequest(makeReq(STATE_URL), res, makeCtx());

    const parsed = JSON.parse(body());
    expect(parsed.architects).toHaveLength(1);
    expect(parsed.architects[0].name).toBe('sibling');
    expect(parsed.architect.name).toBe('sibling');
    expect(parsed.architect.terminalId).toBe('term-sibling');
  });
});
