/**
 * Unit tests for tower-routes.ts (Spec 0105 Phase 6)
 *
 * Tests: route dispatch (handleRequest routing), CORS headers, security
 * checks, SSE events wiring, health check, terminal list, dashboard,
 * workspace path decoding, and 404 fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PASTE_BEGIN, PASTE_END } from '../servers/message-write.js';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { handleRequest, deliverCronMessage } from '../servers/tower-routes.js';
import { resetHostPlatformForTests } from '../../lib/platform.js';
import { setGitBashForTests } from '../../lib/platform/windows/git-bash-launch.js';
import { getWorkspaceTerminals } from '../servers/tower-terminals.js';
import type { DbMailbox } from '../db/types.js';
import { setArchitectByName, upsertBuilder } from '../state.js';
import { DECISIONS_TAB_SENDER } from '@cluesmith/codev-types';
import type { AddressBookResponse } from '@cluesmith/codev-types';
import type { RouteContext } from '../servers/tower-routes.js';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { MAX_MESSAGE_BYTES, MAX_SENDER_ID_LENGTH } from '../utils/message-format.js';
import { workspaceKey } from '../utils/workspace-path.js';
import { SessionScreen } from '../../terminal/session-screen.js';
// Issue #1473: a REAL PtySession for the raw-write route test. The claim under test is that the
// route's bytes reach the gate's input signal, and a session double cannot make that claim —
// it would only assert what the double was written to do.
import { PtySession } from '../../terminal/pty-session.js';
import type { IShellperClient } from '../../terminal/shellper-client.js';
// Spec 1313 round 3: the real delayed-send timer registry + per-session submission lock
// (NOT mocked) so the delayed-`--interrupt` reshape is exercised through the same singletons
// handleSend uses. shutdownDelayedSends() models a Tower restart (bumps the liveness
// generation); submitToSession lets a test pre-occupy a session's lock to drive the
// shutdown-during-lock-wait window deterministically.
import { shutdownDelayedSends } from '../servers/delayed-send.js';
import { submitToSession, trySubmitToSession, resetSubmissionChains } from '../servers/session-submit.js';
import { forceHostPlatform } from '../../__tests__/helpers/host-platform.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockGetInstances, mockGetTerminalManager, mockGetSession,
  mockListSessions, mockGetWorkspaceTerminalsEntry, mockGetTerminalsForWorkspace,
  mockGetRehydratedTerminalsEntry,
  mockIsSessionPersistent, mockGetNextShellId,
  mockResolveTarget, mockResolveAgentInRegistry, mockBroadcastMessage, mockIsResolveError,
  mockParseJsonBody,
  mockOverviewGetOverview, mockOverviewInvalidate,
  mockReadCloudConfig,
  mockComputeAnalytics,
  mockGetKnownWorkspacePaths,
  mockGetAllKnownWorkspacePaths,
  mockIsStartupReconcileSettled,
  mockWhenStartupReconcileSettled,
  sendDbHolder } = vi.hoisted(() => ({
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
  mockResolveAgentInRegistry: vi.fn(),
  mockBroadcastMessage: vi.fn(),
  mockIsResolveError: vi.fn((r: any) => 'code' in r),
  mockParseJsonBody: vi.fn(async () => ({})),
  mockOverviewGetOverview: vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] })),
  mockOverviewInvalidate: vi.fn(),
  mockReadCloudConfig: vi.fn(),
  mockComputeAnalytics: vi.fn(),
  mockGetKnownWorkspacePaths: vi.fn(() => []),
  mockGetAllKnownWorkspacePaths: vi.fn((): string[] => []),
  mockIsStartupReconcileSettled: vi.fn(() => true),
  mockWhenStartupReconcileSettled: vi.fn(async () => {}),
  // Holder for the in-memory global.db used by the Spec 1313 send path (mailbox
  // persist + gate delivery). Re-created per test in beforeEach.
  sendDbHolder: { db: null as unknown as import('better-sqlite3').Database },
}));

vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: (...args: unknown[]) => mockReadCloudConfig(...args),
}));

vi.mock('../servers/tower-instances.js', () => ({
  getInstances: mockGetInstances,
  getKnownWorkspacePaths: (...args: unknown[]) => mockGetKnownWorkspacePaths(...args),
  getAllKnownWorkspacePaths: (...args: unknown[]) => mockGetAllKnownWorkspacePaths(...args),
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
  whenStartupReconcileSettled: mockWhenStartupReconcileSettled,
}));

vi.mock('../servers/tower-tunnel.js', () => ({
  handleTunnelEndpoint: vi.fn(async (_req: unknown, res: any, _sub: string) => {
    res.writeHead(200);
    res.end('tunnel');
  }),
}));

vi.mock('../servers/tower-messages.js', async (importOriginal) => ({
  // Spec 1940: the route reads the address text itself, once, with the real parser, and
  // hands the resolvers the structured address. Only the resolvers are faked.
  parseTarget: (await importOriginal<typeof import('../servers/tower-messages.js')>()).parseTarget,
  // The real one: it decides whether a frame is a cross-workspace one, from the registry
  // and the terminal map, and never calls the faked resolvers.
  crossWorkspaceOrigin: (await importOriginal<typeof import('../servers/tower-messages.js')>()).crossWorkspaceOrigin,
  // The address book asks the permission rule on its own; it is the real one, as the
  // resolvers behind the route are wherever the address book is tested.
  refusalToAddress: (await importOriginal<typeof import('../servers/tower-messages.js')>()).refusalToAddress,
  // The real definition of a running workspace (Issue #1978), read off the faked terminal map.
  runningWorkspacePaths: (await importOriginal<typeof import('../servers/tower-messages.js')>()).runningWorkspacePaths,
  resolveTarget: (...args: unknown[]) => mockResolveTarget(...args),
  resolveAgentInRegistry: (...args: unknown[]) => mockResolveAgentInRegistry(...args),
  broadcastMessage: (...args: unknown[]) => mockBroadcastMessage(...args),
  isResolveError: (r: any) => mockIsResolveError(r),
}));

// Spec 1313: handleSend persists every send to global.db and delivers through the
// gate. Back it with a fresh in-memory DB per test so the mailbox ops are real
// (no over-mocking of the system under test); only the DB handle is injected.
vi.mock('../db/index.js', async (importActual) => ({
  ...(await importActual<typeof import('../db/index.js')>()),
  getGlobalDb: () => sendDbHolder.db,
  // getDb() aliases the global connection (Issue #1118), so the registry reads in state.ts
  // see the same in-memory rows as the mailbox.
  getDb: () => sendDbHolder.db,
}));

vi.mock('../servers/tower-utils.js', () => ({
  isRateLimited: vi.fn(() => false),
  normalizeWorkspacePath: (p: string) => p,
  getLanguageForExt: (ext: string) => ext,
  getMimeTypeForFile: () => 'application/octet-stream',
  serveStaticFile: vi.fn(() => false),
}));

// Keep the REAL request-auth helpers (CORS allowlist, key comparison, public-route
// list) under test; only stub isRequestAllowed so route tests need not thread a
// valid key, and parseJsonBody so bodies can be injected.
vi.mock('../utils/server-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/server-utils.js')>()),
  isRequestAllowed: vi.fn(() => true),
  parseJsonBody: (...args: unknown[]) => mockParseJsonBody(...args),
}));

// Issue #1869: the /ide session mint makes sure the IDE server is live first.
const { mockEnsureIdeServerLive, mockIdeAvailability } = vi.hoisted(() => ({
  mockEnsureIdeServerLive: vi.fn(),
  mockIdeAvailability: vi.fn(async () => false),
}));
vi.mock('../servers/ide-server.js', async (importActual) => ({
  ...(await importActual<typeof import('../servers/ide-server.js')>()),
  ensureIdeServerLive: (...args: unknown[]) => mockEnsureIdeServerLive(...args),
  ideAvailability: (...args: unknown[]) => mockIdeAvailability(...args),
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
    headersSent: false,
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      code = status;
      if (h) Object.assign(hdrs, h);
      res.headersSent = true;
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
/**
 * A mock PtySession the Spec 1313 render-gate can classify. `ring` is the rendered
 * composer content: `'❯ '` is a clean claude prompt (gate → deliver); `'❯ draft'`
 * is an occupied line (gate → hold busy). `command: 'claude'` resolves the profile.
 *
 * Round 2: the gate reads the session's persistent `gateScreen` mirror, not the ring, so the
 * mock feeds the rendered frame into a real {@link SessionScreen} (fed exactly the PTY bytes:
 * the composer line + the bounding rule the TUI draws below the input — the render-gate
 * requires that proven lower bound, else a bare marker is an indeterminate partial and is held).
 * `bytesWritten` is the monotone change token the delivery path samples.
 */
function gateSession(mockWrite: (data: string) => void, ring: string, writable = true, id = 'term-001') {
  const raw = `${ring}\r\n${'─'.repeat(20)}\r\n`;
  const gateScreen = new SessionScreen(80, 24);
  gateScreen.feed(raw);
  return {
    // The per-terminal submission lock's key (Issue #1365). It MUST be a real, distinct id:
    // this double reaches the live mailbox-wiring binding, and because the port is
    // structurally typed an omitted `id` would compile and silently key every lock on the
    // same `undefined` — serialization that looks present and is not. `submitMessagePaced`
    // throws on a missing id so that mistake fails loudly instead of quietly.
    id,
    // Model a live PTY: every write lands. The delivery path now threads the write's
    // boolean (Spec 1313 silent-loss fix), so a double whose write returned undefined
    // would read as a DROPPED write and be held. Wrap mockWrite so call-assertions still
    // see it while the write reports success.
    // Issue #1573: a real terminal ECHOES what is typed into it, and the delivery path now
    // requires that echo on the session's mirror before it will call a message delivered. The
    // double models it (input lines are `\n`-separated; a terminal renders them `\r\n`), so a
    // test asserting a delivery gets one — and a test that wants a terminal which SWALLOWS its
    // input can hand in a `write` that skips the feed.
    write: (data: string): boolean => { mockWrite(data); gateScreen.feed(data.replace(/\n/g, '\r\n')); return true; },
    pid: 1234,
    // A live PTY's session has not exited; whether it takes input is `writable`'s business.
    status: 'running' as const,
    writable,
    isUserIdle: () => true,
    composing: false,
    command: 'claude',
    launchArgs: [] as string[],
    cwd: '/tmp/ws',
    info: { cols: 80, rows: 24 },
    bytesWritten: raw.length,
    // Issue #1573 settle-before-write: epoch 0 is "this screen stopped painting long ago", the
    // normal state for a session sitting at an idle prompt. A test modelling a still-repainting
    // composer overrides it with a recent timestamp.
    lastDataAt: 0,
    // Issue #1473 input signals. This fake reaches the LIVE mailbox wiring, so both are
    // load-bearing at runtime, not just for the types: without `lastInputAt` the gate computes
    // `now() - undefined` → NaN, every comparison against NaN is false, the input settle reads
    // as unsettled, and every send test in this file would HOLD instead of delivering. Epoch 0
    // is "nobody has typed here since the epoch", the state an idle prompt is in.
    inputSeq: 0,
    lastInputAt: 0,
    gateScreen,
  };
}

// Tests
// ============================================================================

describe('tower-routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh in-memory global.db for the Spec 1313 send path (real mailbox ops).
    sendDbHolder.db = new Database(':memory:');
    sendDbHolder.db.exec(GLOBAL_SCHEMA);
    // Default: the registry fallback finds nothing (so a NOT_FOUND target 404s as
    // before, unless a test opts a known offline agent in).
    mockResolveAgentInRegistry.mockReturnValue({ code: 'NOT_FOUND', message: 'not registered' });
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
    it('returns 401 when isRequestAllowed returns false', async () => {
      const { isRequestAllowed } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);

      const req = makeReq('GET', '/api/terminals');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(401);
    });

    it('sets CORS headers for localhost origin', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://localhost:3000' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
      expect(headers()['Access-Control-Allow-Methods']).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    });

    it('does not reflect an arbitrary https origin (allowlist, not reflect-any)', async () => {
      const req = makeReq('GET', '/health', { origin: 'https://example.com' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('does not set CORS origin for non-matching origins', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://evil.com:8080' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('allows the codev-tower-key header in CORS', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://localhost:3000' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Headers']).toContain('codev-tower-key');
    });

    it('handles OPTIONS preflight', async () => {
      const req = makeReq('OPTIONS', '/api/terminals');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });
  });

  // =========================================================================
  // IDE forward cookie (Issue #1869)
  // =========================================================================

  describe('IDE forward cookie (Issue #1869)', () => {
    const KEY = 'd'.repeat(64);
    let savedKey: string | undefined;

    beforeEach(async () => {
      savedKey = process.env.CODEV_TOWER_KEY;
      process.env.CODEV_TOWER_KEY = KEY;
      mockEnsureIdeServerLive.mockResolvedValue(8200);
      const { resetExpectedKeyCache } = await import('../utils/server-utils.js');
      resetExpectedKeyCache();
    });

    afterEach(async () => {
      if (savedKey === undefined) delete process.env.CODEV_TOWER_KEY;
      else process.env.CODEV_TOWER_KEY = savedKey;
      const { resetExpectedKeyCache } = await import('../utils/server-utils.js');
      resetExpectedKeyCache();
    });

    it('POST /api/ide/session mints the HttpOnly, SameSite=Strict, Path=/ide cookie with an empty 204', async () => {
      const { ideForwardCookieValue } = await import('../utils/server-utils.js');
      const req = makeReq('POST', '/api/ide/session');
      const { res, statusCode, headers, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(204);
      expect(headers()['Set-Cookie']).toBe(`codev-ide-session=${ideForwardCookieValue()}; Path=/ide; HttpOnly; SameSite=Strict`);
      expect(headers()['Set-Cookie']).not.toContain(KEY);
      expect(body()).toBe('');
    });

    it('POST /api/ide/session waits for a live IDE server and 503s when none can be made live', async () => {
      mockEnsureIdeServerLive.mockResolvedValueOnce(null);
      const req = makeReq('POST', '/api/ide/session');
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockEnsureIdeServerLive).toHaveBeenCalled();
      expect(statusCode()).toBe(503);
      expect(headers()['Set-Cookie']).toBeUndefined();
    });

    it('POST /api/ide/session without the key is refused at the choke point', async () => {
      const { isRequestAllowed } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);
      const req = makeReq('POST', '/api/ide/session');
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(401);
      expect(headers()['Set-Cookie']).toBeUndefined();
    });

    it('POST /api/ide/session refuses a tunnel-borne request Tower-side', async () => {
      const req = makeReq('POST', '/api/ide/session', { 'x-codev-tunnel-proxy': '1' });
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(403);
      expect(headers()['Set-Cookie']).toBeUndefined();
    });

    it('GET /api/ide/session is 405', async () => {
      const req = makeReq('GET', '/api/ide/session');
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(405);
      expect(headers()['Set-Cookie']).toBeUndefined();
    });

    it('a refused /ide request logs path and reason, never the cookie value', async () => {
      const { isRequestAllowed, ideForwardCookieValue } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);
      const value = ideForwardCookieValue() as string;
      const req = makeReq('GET', '/ide/?folder=%2Fw', {
        cookie: `codev-ide-session=${value}`,
        origin: 'http://localhost:3000',
      });
      const ctx = makeCtx();
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(401);
      const logged = (ctx.log as any).mock.calls.map((c: unknown[]) => String(c[1])).join('\n');
      // Pathname only for /ide: no query string ever reaches the log.
      expect(logged).toContain('401 GET /ide/ —');
      expect(logged).not.toContain('folder=');
      expect(logged).toContain('cross-origin');
      expect(logged).not.toContain(value);
      expect(logged).not.toContain('codev-ide-session=');
    });

    it('a refused /ide request with a token in the query logs the pathname only', async () => {
      const { isRequestAllowed } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);
      const req = makeReq('GET', '/ide/stable-x?reconnectionToken=SECRET-RT&tkn=SECRET-TKN');
      const ctx = makeCtx();
      const { res } = makeRes();
      await handleRequest(req, res, ctx);

      const logged = (ctx.log as any).mock.calls.map((c: unknown[]) => String(c[1])).join('\n');
      expect(logged).toContain('401 GET /ide/stable-x —');
      expect(logged).not.toContain('SECRET');
    });

    it('a refused non-/ide request still logs its full target', async () => {
      const { isRequestAllowed } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);
      const req = makeReq('GET', '/api/terminals?x=1');
      const ctx = makeCtx();
      const { res } = makeRes();
      await handleRequest(req, res, ctx);

      const logged = (ctx.log as any).mock.calls.map((c: unknown[]) => String(c[1])).join('\n');
      expect(logged).toContain('401 GET /api/terminals?x=1 —');
    });

    it('INVARIANT: no response ever carries Access-Control-Allow-Credentials', async () => {
      const cases: Array<[string, string]> = [
        ['OPTIONS', '/ide/'],
        ['OPTIONS', '/api/ide/session'],
        ['POST', '/api/ide/session'],
        ['GET', '/health'],
      ];
      for (const [method, url] of cases) {
        const req = makeReq(method, url, { origin: 'http://localhost:3000' });
        const { res, headers } = makeRes();
        await handleRequest(req, res, makeCtx());
        const names = Object.keys(headers()).map((h) => h.toLowerCase());
        expect(names).not.toContain('access-control-allow-credentials');
      }
    });
  });

  // =========================================================================
  // Health check
  // =========================================================================

  describe('POST /api/shutdown (Spec 1658 Phase 4)', () => {
    function shutdownRes() {
      const made = makeRes();
      // The handler starts the shutdown once the answer is flushed.
      made.res.end = vi.fn((data?: string, cb?: () => void) => {
        made.res.write(data ?? '');
        cb?.();
      }) as any;
      return made;
    }

    it('answers 202 with the pid, then starts the shutdown, from loopback', async () => {
      const requestShutdown = vi.fn();
      for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const req = makeReq('POST', '/api/shutdown');
        (req.socket as any).remoteAddress = address;
        const { res, statusCode, body } = shutdownRes();
        await handleRequest(req, res, makeCtx({ requestShutdown }));
        expect(statusCode()).toBe(202);
        expect(JSON.parse(body())).toEqual({ pid: process.pid });
      }
      expect(requestShutdown).toHaveBeenCalledTimes(3);
    });

    it('refuses a peer that is not this machine and does not shut down', async () => {
      const requestShutdown = vi.fn();
      for (const address of ['203.0.113.7', '::ffff:198.51.100.5', '2001:db8::1', undefined]) {
        const req = makeReq('POST', '/api/shutdown');
        (req.socket as any).remoteAddress = address;
        const { res, statusCode } = shutdownRes();
        await handleRequest(req, res, makeCtx({ requestShutdown }));
        expect(statusCode()).toBe(403);
      }
      expect(requestShutdown).not.toHaveBeenCalled();
    });

    it('refuses a tunnel-borne request even with loopback and the key (the proxy stamps both)', async () => {
      const requestShutdown = vi.fn();
      const log = vi.fn();
      const req = makeReq('POST', '/api/shutdown', { 'x-codev-tunnel-proxy': '1' });
      (req.socket as any).remoteAddress = '127.0.0.1';
      const { res, statusCode } = shutdownRes();
      await handleRequest(req, res, makeCtx({ requestShutdown, log }));
      expect(statusCode()).toBe(403);
      expect(requestShutdown).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('arrived via tunnel proxy'));
    });

    it('logs a refused request without control characters from its user-agent', async () => {
      const log = vi.fn();
      const req = makeReq('POST', '/api/shutdown', { 'x-codev-tunnel-proxy': '1', 'user-agent': 'evil\r\n[ERROR] forged line' });
      const { res } = shutdownRes();
      await handleRequest(req, res, makeCtx({ requestShutdown: vi.fn(), log }));
      const line = log.mock.calls.find((c) => String(c[1]).includes('REJECTED'))![1] as string;
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).toContain('evil  [ERROR] forged line');
    });

    it('accepts a peer that is one of this machine\'s own addresses (bridge mode), and only those', async () => {
      const { isLocalMachineAddress } = await import('../servers/tower-routes.js');
      const interfaces = { eth0: [{ address: '192.168.1.20', family: 'IPv4' }, { address: 'fe80::1', family: 'IPv6' }] } as any;
      expect(isLocalMachineAddress('192.168.1.20', interfaces)).toBe(true);
      expect(isLocalMachineAddress('::ffff:192.168.1.20', interfaces)).toBe(true);
      expect(isLocalMachineAddress('fe80::1', interfaces)).toBe(true);
      expect(isLocalMachineAddress('fe80::1%eth0', interfaces)).toBe(true);
      expect(isLocalMachineAddress('127.0.0.1', interfaces)).toBe(true);
      expect(isLocalMachineAddress('192.168.1.21', interfaces)).toBe(false);
      expect(isLocalMachineAddress(undefined, interfaces)).toBe(false);
    });

    it('is 501 where no shutdown hook is wired', async () => {
      const { res, statusCode } = shutdownRes();
      await handleRequest(makeReq('POST', '/api/shutdown'), res, makeCtx());
      expect(statusCode()).toBe(501);
    });
  });

  describe('GET /health on Windows (Spec 1658 Phase 4)', () => {
    it('reports whether Tower runs inside a codev session; POSIX omits the field', async () => {
      mockGetInstances.mockResolvedValue([]);
      forceHostPlatform('linux');
      try {
        const posix = makeRes();
        await handleRequest(makeReq('GET', '/health'), posix.res, makeCtx());
        expect(JSON.parse(posix.body()).insideCodevSession).toBeUndefined();
      } finally {
        resetHostPlatformForTests();
      }

      forceHostPlatform('win32');
      try {
        const saved = process.env.CODEV_SHELLPER_SESSION;
        process.env.CODEV_SHELLPER_SESSION = 'sess-1';
        const win = makeRes();
        await handleRequest(makeReq('GET', '/health'), win.res, makeCtx());
        expect(JSON.parse(win.body()).insideCodevSession).toBe(true);
        if (saved === undefined) delete process.env.CODEV_SHELLPER_SESSION;
        else process.env.CODEV_SHELLPER_SESSION = saved;
      } finally {
        resetHostPlatformForTests();
      }
    });
  });

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
  // Terminal create: Tower's port on the final session env (Spec 1595)
  // =========================================================================

  describe('POST /api/terminals sets CODEV_TOWER_PORT on the final env', () => {
    const inheritedEnv = { PATH: '/usr/bin', CODEV_TOWER_PORT: '1', CLAUDECODE: '1' };

    it('non-persistent branch: overrides an inherited port, with or without a client env', async () => {
      const createSession = vi.fn(async () => ({ id: 'term-new', pid: 1 }));
      mockGetTerminalManager.mockReturnValue({ createSession });

      for (const env of [inheritedEnv, undefined]) {
        mockParseJsonBody.mockResolvedValueOnce({ command: 'bash', cwd: '/tmp', env });
        const { res, statusCode } = makeRes();
        await handleRequest(makeReq('POST', '/api/terminals'), res, makeCtx({ port: 4242 }));
        expect(statusCode()).toBe(201);
      }

      const [withClientEnv, withoutClientEnv] = createSession.mock.calls.map(c => (c[0] as { env: Record<string, string> }).env);
      expect(withClientEnv.CODEV_TOWER_PORT).toBe('4242');
      expect(withClientEnv.CLAUDECODE).toBeUndefined();
      expect(withClientEnv.PATH).toBe('/usr/bin');
      expect(withoutClientEnv).toEqual({ CODEV_TOWER_PORT: '4242' });
    });

    it('shellper branch: overrides an inherited port', async () => {
      const shellperCreate = vi.fn(async () => ({ waitForReplay: async () => Buffer.alloc(0) }));
      const shellperManager = {
        createSession: shellperCreate,
        getSessionInfo: () => ({ pid: 7, socketPath: '/tmp/s.sock', startTime: 1 }),
      };
      mockGetTerminalManager.mockReturnValue({
        createSessionRaw: vi.fn(() => ({ id: 'term-new', pid: 7 })),
        getSession: vi.fn(() => undefined),
      });
      mockParseJsonBody.mockResolvedValueOnce({ command: 'bash', cwd: '/tmp', env: inheritedEnv, persistent: true });

      const { res, statusCode } = makeRes();
      await handleRequest(makeReq('POST', '/api/terminals'), res, makeCtx({
        port: 4242,
        getShellperManager: () => shellperManager as unknown as ReturnType<RouteContext['getShellperManager']>,
      }));

      expect(statusCode()).toBe(201);
      const env = (shellperCreate.mock.calls[0][0] as { env: Record<string, string> }).env;
      expect(env.CODEV_TOWER_PORT).toBe('4242');
      expect(env.CLAUDECODE).toBeUndefined();
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

    // Issue #1914: the IDE signal rides the status payload, which the tunnel relays.
    it('carries ide { available, viaTunnel:false } for a local request', async () => {
      mockGetInstances.mockResolvedValue([]);
      mockIdeAvailability.mockResolvedValueOnce(true);

      const { res, body } = makeRes();
      await handleRequest(makeReq('GET', '/api/status'), res, makeCtx());

      expect(mockIdeAvailability).toHaveBeenLastCalledWith(false);
      expect(JSON.parse(body()).ide).toEqual({ available: true, viaTunnel: false });
    });

    it('asks for the tunnel rule and reports viaTunnel:true for a tunnel-borne request', async () => {
      mockGetInstances.mockResolvedValue([]);
      mockIdeAvailability.mockResolvedValueOnce(false);

      const { res, body } = makeRes();
      await handleRequest(makeReq('GET', '/api/status', { 'x-codev-tunnel-proxy': '1' }), res, makeCtx());

      expect(mockIdeAvailability).toHaveBeenLastCalledWith(true);
      expect(JSON.parse(body()).ide).toEqual({ available: false, viaTunnel: true });
    });

    it('exposes only the yes/no and the tunnel hint: no port, path, pid or token', async () => {
      mockGetInstances.mockResolvedValue([]);
      mockIdeAvailability.mockResolvedValueOnce(true);

      const { res, body } = makeRes();
      await handleRequest(makeReq('GET', '/api/status'), res, makeCtx());

      expect(Object.keys(JSON.parse(body()).ide).sort()).toEqual(['available', 'viaTunnel']);
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

    it('titles with the display name, not the slug, when they differ (Issue #1871)', async () => {
      mockReadCloudConfig.mockReturnValue({
        tower_id: 'test-id',
        tower_name: 'ana-s-mbp',
        display_name: "Ana's MBP",
        api_key: 'test-key',
        server_url: 'https://cloud.codevos.ai',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(JSON.parse(body()).hostname).toBe("Ana's MBP");
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

    describe('decisions (Spec 1819)', () => {
      const FIXTURE = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/decisions/issue-format.md'), 'utf8');
      let workspace: string;
      let encoded: string;
      let decisionsFile: string;
      let origHome: string | undefined;

      beforeEach(() => {
        workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-routes-decisions-')));
        encoded = Buffer.from(workspace).toString('base64url');
        decisionsFile = path.join(workspace, 'codev', 'state', 'pending-decisions.md');
        fs.mkdirSync(path.dirname(decisionsFile), { recursive: true });
        // The decisions path comes from loadConfig, which also reads ~/.codev/config.json.
        origHome = process.env.HOME;
        process.env.HOME = path.join(workspace, 'home');
      });

      afterEach(() => {
        process.env.HOME = origHome;
        fs.rmSync(workspace, { recursive: true, force: true });
      });

      async function request(method: string, sub: string) {
        const { res, statusCode, body } = makeRes();
        await handleRequest(makeReq(method, `/workspace/${encoded}/${sub}`), res, makeCtx());
        return { status: statusCode(), body: JSON.parse(body()) };
      }

      it('sets decisionsEnabled on /api/state from whether the file exists', async () => {
        expect((await request('GET', 'api/state')).body.decisionsEnabled).toBe(false);
        fs.writeFileSync(decisionsFile, FIXTURE);
        expect((await request('GET', 'api/state')).body.decisionsEnabled).toBe(true);
      });

      it('keeps /api/state working, with decisionsEnabled false, when the config is broken', async () => {
        fs.writeFileSync(decisionsFile, FIXTURE);
        fs.mkdirSync(path.join(workspace, '.codev'));
        fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), '{ not json');
        const { status, body } = await request('GET', 'api/state');
        expect(status).toBe(200);
        expect(body.decisionsEnabled).toBe(false);
        expect(body).toHaveProperty('builders');
        expect((await request('GET', 'api/decisions')).body.code).toBe('config-error');
      });

      it('dispatches GET api/decisions and POST api/decisions/rule', async () => {
        fs.writeFileSync(decisionsFile, FIXTURE);
        const read = await request('GET', 'api/decisions');
        expect(read.status).toBe(200);
        const item = read.body.document.items.find((i: { id: string }) => i.id === 'main-11');

        mockParseJsonBody.mockResolvedValueOnce({ id: 'main-11', word: 'accept', fingerprint: item.fingerprint });
        const written = await request('POST', 'api/decisions/rule');
        expect(written.status).toBe(200);
        expect(written.body.document.items.find((i: { id: string }) => i.id === 'main-11').currentRuling).toBe('accept');
        expect(fs.readFileSync(decisionsFile, 'utf8')).not.toBe(FIXTURE);
      });

      // #1828: a submit tells the hub architect through the mailbox — one row, gated.
      describe('the hub notice (#1828)', () => {
        const allRows = () => sendDbHolder.db.prepare('SELECT * FROM mailbox').all() as DbMailbox[];
        /** Register architects in the (in-memory) registry, in the order given. */
        const register = (...names: string[]) => {
          for (const name of names) setArchitectByName(workspace, name, { name, cmd: 'claude', startedAt: '2026-10-18T00:00:00.000Z' });
        };

        /** Submit a ruling for main-11 against a fresh copy of `text`. */
        async function submit(ruling: Record<string, unknown>, ctx = makeCtx(), text = FIXTURE) {
          fs.writeFileSync(decisionsFile, text);
          const item = (await request('GET', 'api/decisions')).body.document.items.find((i: { id: string }) => i.id === 'main-11');
          mockParseJsonBody.mockResolvedValueOnce({ id: 'main-11', fingerprint: item.fingerprint, ...ruling });
          const { res, statusCode, body } = makeRes();
          await handleRequest(makeReq('POST', `/workspace/${encoded}/api/decisions/rule`), res, ctx);
          return { status: statusCode(), body: JSON.parse(body()) };
        }

        afterEach(() => {
          vi.mocked(getWorkspaceTerminals).mockImplementation(() => new Map());
        });

        /** Route the workspace's live architects to clean prompts; returns each one's write spy. */
        function liveArchitects(...names: string[]): Record<string, ReturnType<typeof vi.fn>> {
          const writes = Object.fromEntries(names.map(name => [name, vi.fn()]));
          vi.mocked(getWorkspaceTerminals).mockImplementation(() => new Map([[workspace, {
            architects: new Map(names.map(name => [name, `term-arch-${name}`])),
            builders: new Map(),
            shells: new Map(),
            fileTabs: new Map(),
          }]]) as any);
          mockGetTerminalManager.mockReturnValue({
            listSessions: mockListSessions.mockReturnValue([]),
            getSession: (id: string) => {
              const name = names.find(n => id === `term-arch-${n}`);
              return name ? gateSession(writes[name], '❯ ', true, id) : null;
            },
          });
          return writes;
        }

        it('delivers exactly one mailbox row to a live main architect through the gate', async () => {
          const writes = liveArchitects('main');
          register('main');
          const ctx = makeCtx();

          const { status } = await submit({ word: 'accept', comment: 'ship it\nno new limits' }, ctx);
          expect(status).toBe(200);

          const rows = allRows();
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            workspace_path: workspace,
            to_agent: 'main',
            from_agent: 'decisions-tab',
            body: 'RULED main-11: accept\nship it\nno new limits',
            status: 'delivered',
          });
          expect(rows[0].formatted_message).toMatch(/^### \[USER via Decisions tab → main \| .+\] ###\nRULED main-11: accept\n/);
          // Spec 1940: the notice is Tower's own, to the `main` of the same workspace. It is the
          // one frame call site with no sending agent, and its frame is the whole of today's.
          expect(rows[0].formatted_message.replace(/\| \d{4}-\d\d-\d\dT[\d:.]+Z\]/, '| <time>]')).toBe(
            '### [USER via Decisions tab → main | <time>] ###\n' +
              'RULED main-11: accept\nship it\nno new limits\n' +
              '###############################',
          );
          expect(rows[0].from_workspace).toBe(workspace);
          expect(writes.main.mock.calls.map(([data]) => data).join('')).toContain('RULED main-11: accept');
          expect(ctx.log).toHaveBeenCalledWith('INFO', expect.stringMatching(/^Decisions notice delivered → main @ /));
        });

        it('holds the row for an offline main architect rather than telling a live sibling', async () => {
          const writes = liveArchitects('sibling');
          register('main', 'sibling');
          const ctx = makeCtx();

          expect((await submit({ comment: 'which branch?' }, ctx)).status).toBe(200);
          const rows = allRows();
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ to_agent: 'main', body: 'QUESTION main-11:\nwhich branch?', status: 'held', reason: 'no-live-pty' });
          expect(writes.sibling).not.toHaveBeenCalled();
          expect(ctx.log).toHaveBeenCalledWith('INFO', expect.stringMatching(/^Decisions notice held \(no-live-pty\) → main @ /));
        });

        it('tells no architect when none is named main, whatever the registration order (#1633)', async () => {
          // Registered zeta first, then alpha: neither "first registered" nor alphabetical
          // order may stand in for the hub.
          const writes = liveArchitects('zeta', 'alpha');
          register('zeta', 'alpha');
          const ctx = makeCtx();

          expect((await submit({ word: 'accept' }, ctx)).status).toBe(200);
          expect(fs.readFileSync(decisionsFile, 'utf8')).not.toBe(FIXTURE);
          expect(allRows()).toHaveLength(0);
          expect(writes.zeta).not.toHaveBeenCalled();
          expect(writes.alpha).not.toHaveBeenCalled();
          expect(ctx.log).toHaveBeenCalledWith('WARN', expect.stringContaining(`no architect named 'main' is registered in workspace ${workspace}`));
        });

        it('still writes the ruling, and logs, when the workspace has no architect', async () => {
          const ctx = makeCtx();
          const { status, body } = await submit({ word: 'accept' }, ctx);

          expect(status).toBe(200);
          expect(body.document.items.find((i: { id: string }) => i.id === 'main-11').currentRuling).toBe('accept');
          expect(allRows()).toHaveLength(0);
          expect(ctx.log).toHaveBeenCalledWith('WARN', expect.stringContaining('hub architect was not told'));
        });

        it('frames an /api/send from the Decisions-tab sender to an architect as the owner, never a builder', async () => {
          mockParseJsonBody.mockResolvedValueOnce({ to: 'architect', message: 'RULED main-11: accept', workspace, from: DECISIONS_TAB_SENDER });
          mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
          mockResolveAgentInRegistry.mockReturnValue({ workspacePath: workspace, agent: 'main', kind: 'architect' });
          const { res, body } = makeRes();
          await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());

          const row = mailbox.getById(sendDbHolder.db, JSON.parse(body()).mailboxId)!;
          expect(row.formatted_message).toMatch(/^### \[USER via Decisions tab → main \| .+\] ###\nRULED main-11: accept\n#+$/);
        });

        it('does not answer twice when the route fails after its response', async () => {
          // No `main`, so the notice fails; a log sink that throws on that WARN makes the route
          // itself throw after res.end(), into handleRequest's catch.
          const ctx = makeCtx({ log: vi.fn((level: string) => { if (level === 'WARN') throw new Error('log sink down'); }) });
          fs.writeFileSync(decisionsFile, FIXTURE);
          const item = (await request('GET', 'api/decisions')).body.document.items.find((i: { id: string }) => i.id === 'main-11');
          mockParseJsonBody.mockResolvedValueOnce({ id: 'main-11', word: 'accept', fingerprint: item.fingerprint });
          const { res, statusCode } = makeRes();
          await handleRequest(makeReq('POST', `/workspace/${encoded}/api/decisions/rule`), res, ctx);

          expect(ctx.log).toHaveBeenCalledWith('ERROR', 'Request error: log sink down');
          expect(res.writeHead).toHaveBeenCalledOnce();
          expect(statusCode()).toBe(200);
        });

        it('refuses, persisting nothing, a notice over the send limit', async () => {
          register('main');
          const word = 'x'.repeat(MAX_MESSAGE_BYTES);
          const text = FIXTURE.replace('**Your word:** `accept`', `**Your word:** \`${word}\``);
          expect(text).not.toBe(FIXTURE);
          const ctx = makeCtx();

          expect((await submit({ word }, ctx, text)).status).toBe(200);
          // The word is spliced in as a line of its own. Split on either ending: the
          // splice keeps the file's own (CRLF when git checks the fixture out on Windows).
          expect(fs.readFileSync(decisionsFile, 'utf8').split(/\r?\n/)).toContain(word);
          expect(allRows()).toHaveLength(0);
          expect(ctx.log).toHaveBeenCalledWith('WARN', expect.stringContaining('over the 49152-byte'));
        });
      });

      it('rejects both routes without the Tower key', async () => {
        fs.writeFileSync(decisionsFile, FIXTURE);
        const actual = await vi.importActual<typeof import('../utils/server-utils.js')>('../utils/server-utils.js');
        const { isRequestAllowed } = await import('../utils/server-utils.js');
        for (const [method, sub] of [['GET', 'api/decisions'], ['POST', 'api/decisions/rule']]) {
          (isRequestAllowed as any).mockImplementationOnce(actual.isRequestAllowed);
          const { res, statusCode, body } = makeRes();
          await handleRequest(makeReq(method, `/workspace/${encoded}/${sub}`), res, makeCtx());
          expect(statusCode()).toBe(401);
          expect(body()).toBe('Unauthorized');
        }
        expect(mockParseJsonBody).not.toHaveBeenCalled();
        expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(FIXTURE);
      });
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
  // #1809: deactivate still reaches a live stray builder-worktree workspace
  // =========================================================================

  describe('POST /api/workspaces/:path/deactivate', () => {
    const worktree = '/repo/.builders/pir-1802';
    const encoded = Buffer.from(worktree).toString('base64url');

    it('stops a stray worktree workspace that the filtered list excludes', async () => {
      const { stopInstance } = await import('../servers/tower-instances.js');
      mockGetKnownWorkspacePaths.mockReturnValueOnce([]);
      mockGetAllKnownWorkspacePaths.mockReturnValueOnce([worktree]);

      const req = makeReq('POST', `/api/workspaces/${encoded}/deactivate`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(stopInstance).toHaveBeenCalledWith(worktree);
    });

    it('still returns 404 for a path Tower has never seen', async () => {
      mockGetAllKnownWorkspacePaths.mockReturnValueOnce([]);

      const req = makeReq('POST', `/api/workspaces/${encoded}/deactivate`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
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
    // phase is that the field reaches a *client*, so afx refresh can measure
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

      expect(mockResolveTarget).toHaveBeenCalledWith({ kind: 'architect' }, { id: 'spir-100', workspace: '/tmp/ws' });
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

      expect(mockResolveTarget).toHaveBeenCalledWith({ kind: 'architect' }, { id: undefined, workspace: '/tmp/ws' });
    });

    it('returns 200 delivered:true on a successful send to a clean prompt (Spec 1313)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '), // clean, render-verified empty
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
      expect(parsed.delivered).toBe(true);
      expect(parsed.held).toBe(false);
      expect(parsed.deferred).toBe(false);
      expect(typeof parsed.mailboxId).toBe('string');
      expect(mockWrite).toHaveBeenCalled();
    });

    it('rejects an over-limit body loudly instead of paceing it onto the line (Issue #1573)', async () => {
      // Nothing between the CLI flag and the PTY bytes bounded message size before this. An
      // oversized body used to be written a line at a time and reported delivered whatever the
      // composer made of it — the #1564 shape. Truncating would reproduce that on purpose, so
      // the only honest answer is a refusal that names the limit.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect',
        message: 'x'.repeat(48 * 1024 + 1),
        workspace: '/tmp/ws',
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      const parsed = JSON.parse(body());
      expect(parsed.error).toBe('MESSAGE_TOO_LARGE');
      expect(parsed.message).toContain('49153 bytes');
      expect(parsed.message).toContain('48KB');
      // The target was never even resolved — nothing reached a terminal.
      expect(mockResolveTarget).not.toHaveBeenCalled();
    });

    it('accepts a body exactly at the limit and echoes bodyLength on the response (Issue #1573)', async () => {
      const message = 'x'.repeat(48 * 1024);
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message, workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(vi.fn(), '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      // The sender is told WHAT was sent, not merely that a send happened.
      expect(JSON.parse(body()).bodyLength).toBe(48 * 1024);
    });

    it('holds (no-live-pty) instead of dropping when the shellper connection is down (#1198, Spec 1313)', async () => {
      // Pre-1313 this returned 503 and dropped the message. Now the send is
      // persisted and held; the backstop redelivers when the connection recovers.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-zombie',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ ', /* writable */ false),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.held).toBe(true);
      expect(parsed.reason).toBe('no-live-pty');
      expect(typeof parsed.mailboxId).toBe('string');
      expect(mockWrite).not.toHaveBeenCalled(); // never written to a dead line
    });

    it('holds (no-live-pty) a normal send to a known offline agent instead of 404ing (Spec 1313 dead-session seam)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'spir-9', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      // The registry knows this builder even though it has no live PTY.
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.held).toBe(true);
      expect(parsed.reason).toBe('no-live-pty');
      expect(parsed.resolvedTo).toBe('spir-9');
      expect(typeof parsed.mailboxId).toBe('string');
      // And it is really persisted (drain-order query finds it).
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9')).toHaveLength(1);
    });

    // Issue #1478: the sender's identity must survive into the row both attribution
    // surfaces read — `from_agent` (what `afx inbox` renders) and `formatted_message`
    // (the builder's composer header). `formatMessageForTarget`'s any → builder branch
    // used to discard `from` entirely, so even a corrected sender could not surface.
    // The registry hold path is the cheapest route that formats AND persists.
    describe('architect identity in the persisted row (issue #1478)', () => {
      /** POST /api/send from `from` to an offline-but-known builder → held row. */
      async function heldRowFrom(from: string | undefined) {
        mockParseJsonBody.mockResolvedValue({ to: 'spir-9', message: 'ship it', workspace: '/tmp/ws', from });
        mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
        mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
        const { res, body } = makeRes();
        await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
        return mailbox.getById(sendDbHolder.db, JSON.parse(body()).mailboxId)!;
      }

      it('stores the specific architect as from_agent — the identity `afx inbox` renders', async () => {
        const row = await heldRowFrom('architect:feedback');
        // Pre-fix this was the generic 'architect' for every architect in the workspace.
        expect(row.from_agent).toBe('architect:feedback');
        expect(row.to_agent).toBe('spir-9');
      });

      it('names the architect in the composer header (the any → builder branch)', async () => {
        const row = await heldRowFrom('architect:main');
        // The recipient segment is #1574's; the name before it is this issue's. Both are
        // asserted here so a regression in either shows up as a header-shape failure.
        expect(row.formatted_message).toMatch(/^### \[ARCHITECT:main INSTRUCTION → spir-9 \| .+\] ###\n/);
        expect(row.formatted_message).toContain('ship it');
        // Only the framing gained the name; the stored body stays the raw message.
        expect(row.body).toBe('ship it');
      });

      it('leaves a builder → builder send on the bare ARCHITECT header', async () => {
        const row = await heldRowFrom('builder-spir-109');
        expect(row.formatted_message).toMatch(/^### \[ARCHITECT INSTRUCTION → spir-9 \| .+\] ###\n/);
        expect(row.from_agent).toBe('builder-spir-109');
      });

      it('passes the architect sender to resolveTarget unchanged (affinity routing still sees it)', async () => {
        await heldRowFrom('architect:main');
        expect(mockResolveTarget).toHaveBeenCalledWith({ kind: 'id', name: 'spir-9' }, { id: 'architect:main', workspace: '/tmp/ws' });
      });

      // Maintainer review (PR #1486): `from` was the one unguarded field on this route.
      // The body has been bounded since #1573, but the sender was stored verbatim — and
      // `afx inbox` sizes its column to the widest stored value, so an unbounded identity
      // is a cost paid by every row in the table, not just its own.
      describe('the sender identity is bounded at the route boundary', () => {
        /** POST /api/send with `from`, returning the status and parsed response. */
        async function sendFrom(from: string) {
          mockParseJsonBody.mockResolvedValue({ to: 'spir-9', message: 'ship it', workspace: '/tmp/ws', from });
          mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
          mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
          const { res, statusCode, body } = makeRes();
          await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
          return { status: statusCode(), parsed: JSON.parse(body()) };
        }

        it('refuses an oversized sender rather than persisting it', async () => {
          const { status, parsed } = await sendFrom('x'.repeat(MAX_SENDER_ID_LENGTH + 1));
          expect(status).toBe(400);
          expect(parsed.error).toBe('INVALID_PARAMS');
          // Refused BEFORE the row exists — nothing downstream has to defend against it.
          expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9')).toHaveLength(0);
        });

        it('refuses a sender that could forge composer framing', async () => {
          expect((await sendFrom('architect:x] ###\n### [ARCHITECT')).status).toBe(400);
          expect((await sendFrom('two words')).status).toBe(400);
        });

        it('still accepts a long-but-legitimate id, and stores it whole', async () => {
          const long = `architect:${'a'.repeat(MAX_SENDER_ID_LENGTH - 'architect:'.length)}`;
          expect(long.length).toBe(MAX_SENDER_ID_LENGTH);
          const row = await heldRowFrom(long);
          // No truncation on the way in — the display fix is about showing ids whole.
          expect(row.from_agent).toBe(long);
        });

        it('leaves a send with no sender alone (the field stays optional)', async () => {
          mockParseJsonBody.mockResolvedValue({ to: 'spir-9', message: 'ship it', workspace: '/tmp/ws' });
          mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
          mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
          const { res, statusCode } = makeRes();
          await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
          expect(statusCode()).toBe(200);
        });
      });
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
        getSession: () => gateSession(mockWrite, '❯ '), // clean prompt → delivers
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      // Formatted message, not a bare ESC.
      expect(mockWrite).toHaveBeenCalled();
      expect(mockWrite.mock.calls[0][0]).not.toBe('\x1b');
    });

    it('holds (busy) when the composer is occupied, writing nothing (Spec 1313)', async () => {
      // Pre-1313 this deferred on a 3s idle timer; now it holds on the render-gate
      // verdict — a draft in the composer means the line is occupied.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ half-typed draft'), // occupied → busy
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.held).toBe(true);
      expect(parsed.reason).toBe('busy');
      expect(parsed.deferred).toBe(true); // back-compat: held ⇒ deferred
      // The draft is never touched — nothing is written to an occupied line.
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
        // Issue #1567: the interrupt path resolves the recipient's write strategy from the
        // session's identity, which every real PtySession carries.
        getSession: () => ({
          write: mockWrite, pid: 1234, writable: true, isUserIdle: () => false, composing: true,
          command: 'claude', launchArgs: [] as string[], cwd: '/tmp/ws',
        }),
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

    // Issue #1567: the interrupt bypasses the GATE, not the per-harness write strategy.
    // Spec 1940 phase 2. Every other test in this file fakes the two resolvers; these run
    // the REAL ones behind the route, against the in-memory registry and a fake terminal
    // map, so what is asserted is what `afx send` gets back: the address is read once, the
    // recipient is found or held or refused, and each refusal has its own status.
    describe('addresses across workspaces (Spec 1940), with the real resolvers', () => {
      let root: string;
      let CODEV: string;
      let CLOUD: string;
      const BUILDER = 'builder-spir-100';
      const allRows = () => sendDbHolder.db.prepare('SELECT * FROM mailbox').all() as DbMailbox[];

      /**
       * Give these agents live terminals at a clean prompt. Returns each one's write spy,
       * keyed `<workspace basename>/<agent>`.
       */
      function liveAgents(agents: Record<string, { architects?: string[]; builders?: string[]; shells?: string[] }>) {
        const writes: Record<string, ReturnType<typeof vi.fn>> = {};
        const terminals = new Map<string, ReturnType<typeof vi.fn>>();
        const map = new Map(Object.entries(agents).map(([ws, { architects = [], builders = [], shells = [] }]) => {
          const ids = (names: string[]) => new Map(names.map((name) => {
            const key = `${path.basename(ws)}/${name}`;
            writes[key] = vi.fn();
            terminals.set(`term-${key}`, writes[key]);
            return [name, `term-${key}`] as const;
          }));
          return [ws, { architects: ids(architects), builders: ids(builders), shells: ids(shells), fileTabs: new Map() }] as const;
        }));
        vi.mocked(getWorkspaceTerminals).mockImplementation(() => map as any);
        mockGetTerminalManager.mockReturnValue({
          listSessions: mockListSessions.mockReturnValue([]),
          getSession: (id: string) => (terminals.has(id) ? gateSession(terminals.get(id)!, '❯ ', true, id) : null),
        });
        return writes;
      }

      /** POST /api/send as `from`, whose workspace is codev unless said otherwise. */
      async function send(to: string, from: string | undefined, extra: Record<string, unknown> = {}) {
        mockParseJsonBody.mockResolvedValue({ to, message: 'hello', from, workspace: CODEV, fromWorkspace: CODEV, ...extra });
        const { res, statusCode, body } = makeRes();
        await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
        return { status: statusCode(), body: JSON.parse(body()) };
      }

      beforeEach(async () => {
        const actual = await vi.importActual<typeof import('../servers/tower-messages.js')>('../servers/tower-messages.js');
        mockResolveTarget.mockImplementation(actual.resolveTarget as (...args: unknown[]) => unknown);
        mockResolveAgentInRegistry.mockImplementation(actual.resolveAgentInRegistry as (...args: unknown[]) => unknown);

        // realpath: on macOS the temp dir sits behind a symlink, and the registry keys rows
        // by the path as it is given. workspaceKey: on Windows the route keys a workspace by
        // its canonical spelling, and the temp dir is handed out in its short one
        // (`RUNNER~1` for `runneradmin`), so rows seeded under the
        // short spelling would belong to a workspace the route never looks up.
        root = workspaceKey(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'spec1940-routes-')));
        CODEV = path.join(root, 'codev');
        CLOUD = path.join(root, 'codev-cloud');
        fs.mkdirSync(path.join(CODEV, '.builders', 'spir-100'), { recursive: true });
        fs.mkdirSync(CLOUD);

        const architect = (name: string) => ({ name, cmd: 'claude', startedAt: '2026-11-23T00:00:00.000Z' });
        for (const name of ['main', 'review']) setArchitectByName(CODEV, name, architect(name));
        for (const name of ['main', 'review', 'tunnel']) setArchitectByName(CLOUD, name, architect(name));
        upsertBuilder({
          id: BUILDER,
          name: BUILDER,
          status: 'implementing',
          phase: 'implement',
          worktree: path.join(CODEV, '.builders', 'spir-100'),
          branch: 'builder/spir-100',
          type: 'spec',
          spawnedByArchitect: 'review',
        });
        liveAgents({
          [CODEV]: { architects: ['main', 'review'] },
          [CLOUD]: { architects: ['main', 'review', 'tunnel'], shells: ['shell-7'] },
        });
      });

      afterEach(() => {
        mockResolveTarget.mockReset();
        mockResolveAgentInRegistry.mockReset();
        vi.mocked(getWorkspaceTerminals).mockImplementation(() => new Map());
        fs.rmSync(root, { recursive: true, force: true });
      });

      it('delivers <workspace>:architect:<name> to that architect, as a same-workspace send would be', async () => {
        const writes = liveAgents({
          [CODEV]: { architects: ['main', 'review'] },
          [CLOUD]: { architects: ['main', 'review', 'tunnel'] },
        });
        const { status, body } = await send('codev-cloud:architect:tunnel', 'architect:review');

        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, delivered: true, resolvedTo: 'tunnel' });
        await vi.waitFor(() => expect(writes['codev-cloud/tunnel'].mock.calls.at(-1)?.[0]).toBe('\r'));
        expect(writes['codev-cloud/tunnel'].mock.calls.map((c) => c[0]).join('')).toContain('hello');
        for (const other of ['codev-cloud/main', 'codev-cloud/review', 'codev/main', 'codev/review']) {
          expect(writes[other]).not.toHaveBeenCalled();
        }
        expect(allRows()).toHaveLength(1);
        expect(allRows()[0]).toMatchObject({ workspace_path: CLOUD, to_agent: 'tunnel', from_agent: 'architect:review' });
      });

      // Issue #1633. With no `main`, the front door is the first registered. The live resolver
      // reads that off the terminal map and the registry off `getArchitects`, which sorted by
      // name: the same address reached `zeta` with terminals up and was held for `alpha` with
      // them down.
      describe('the front door of a workspace with no main, where name order is not registration order', () => {
        beforeEach(() => {
          for (const name of ['main', 'review', 'tunnel']) setArchitectByName(CLOUD, name, null);
          setArchitectByName(CLOUD, 'zeta', { name: 'zeta', cmd: 'claude', startedAt: '2026-01-01T00:00:00.000Z' });
          setArchitectByName(CLOUD, 'alpha', { name: 'alpha', cmd: 'claude', startedAt: '2026-06-01T00:00:00.000Z' });
        });

        it('delivers to the first registered when its terminal is live', async () => {
          const writes = liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { architects: ['zeta', 'alpha'] } });
          const { body } = await send('codev-cloud:architect', 'architect:review');

          expect(body).toMatchObject({ ok: true, resolvedTo: 'zeta' });
          expect(writes['codev-cloud/alpha']).not.toHaveBeenCalled();
        });

        it('holds for that same architect when no architect there has a live terminal', async () => {
          // The workspace is still known to Tower (a shell is up); its architects are not.
          liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { shells: ['shell-7'] } });
          const { status, body } = await send('codev-cloud:architect', 'architect:review');

          expect(status).toBe(200);
          expect(body).toMatchObject({ ok: true, held: true, reason: 'no-live-pty', resolvedTo: 'zeta' });
          expect(mailbox.findHeldForAgent(sendDbHolder.db, CLOUD, 'zeta')).toHaveLength(1);
          expect(mailbox.findHeldForAgent(sendDbHolder.db, CLOUD, 'alpha')).toHaveLength(0);
        });
      });

      it('holds it (no-live-pty) when the architect is registered and has no live terminal', async () => {
        const writes = liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { architects: ['main', 'review'] } });
        const { status, body } = await send('codev-cloud:architect:tunnel', 'architect:review');

        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, held: true, reason: 'no-live-pty', resolvedTo: 'tunnel' });
        expect(mailbox.findHeldForAgent(sendDbHolder.db, CLOUD, 'tunnel')).toHaveLength(1);
        // Held for `tunnel`, and not rerouted to the front door.
        expect(writes['codev-cloud/main']).not.toHaveBeenCalled();
        expect(mailbox.findHeldForAgent(sendDbHolder.db, CLOUD, 'main')).toHaveLength(0);
      });

      // Issue #1978: right after a restart the terminal map is empty until the startup
      // reconcile adopts each workspace's sessions, so a workspace that is coming back has no
      // terminal yet and would be refused as not running. The send waits for the reconcile.
      it('waits for the startup reconcile, so a workspace whose terminals are being adopted is not refused', async () => {
        vi.mocked(getWorkspaceTerminals).mockImplementation(() => new Map() as any);
        let settle!: () => void;
        mockWhenStartupReconcileSettled.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));

        const sending = send('codev-cloud:architect:tunnel', 'architect:review');
        await new Promise((r) => setTimeout(r, 20));
        expect(mockResolveTarget).not.toHaveBeenCalled();
        expect(allRows()).toHaveLength(0);

        // The reconcile adopts both workspaces' sessions, then settles.
        const writes = liveAgents({
          [CODEV]: { architects: ['main', 'review'] },
          [CLOUD]: { architects: ['main', 'review', 'tunnel'] },
        });
        settle();
        const { status, body } = await sending;

        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, delivered: true, resolvedTo: 'tunnel' });
        await vi.waitFor(() => expect(writes['codev-cloud/tunnel'].mock.calls.at(-1)?.[0]).toBe('\r'));
      });

      it('schedules it on the --delay path too, with no live terminal', async () => {
        liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { architects: ['main', 'review'] } });
        const { status, body } = await send('codev-cloud:architect:tunnel', 'architect:review', { options: { deliverAfter: 30 } });

        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, scheduled: true, resolvedTo: 'tunnel', terminalId: null });
        const row = mailbox.getById(sendDbHolder.db, body.mailboxId);
        expect(row).toMatchObject({ workspace_path: CLOUD, to_agent: 'tunnel', status: 'held', terminal_id: null });
        expect(row?.not_before).toBe(body.notBefore);
      });

      it('fails for an unknown architect name with a 404 that names the workspace, its architects and its front door', async () => {
        const { status, body } = await send('codev-cloud:architect:ghost', 'architect:review');
        expect(status).toBe(404);
        expect(body.error).toBe('NOT_FOUND');
        expect(body.message).toBe(
          "Architect 'ghost' not found in workspace 'codev-cloud'. " +
            'Architects there: main, review, tunnel. Front door: codev-cloud:architect.',
        );
        expect(allRows()).toHaveLength(0);
      });

      describe('the builder rule', () => {
        it('refuses a builder naming an architect in another workspace: 403, the front door named, nothing stored', async () => {
          for (const options of [undefined, { deliverAfter: 30 }]) {
            const { status, body } = await send('codev-cloud:architect:tunnel', BUILDER, options ? { options } : {});
            expect(status).toBe(403);
            expect(body.error).toBe('REFUSED');
            expect(body.message).toBe(
              `builder ${BUILDER} may only address its own spawning architect; ` +
                'reach that workspace through its front door: afx send codev-cloud:architect "…"',
            );
          }
          expect(allRows()).toHaveLength(0);
        });

        it('refuses the same when the architect has no live terminal: it is refused, not held', async () => {
          liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { architects: ['main'] } });
          const { status, body } = await send('codev-cloud:architect:tunnel', BUILDER);
          expect(status).toBe(403);
          expect(body.error).toBe('REFUSED');
          expect(allRows()).toHaveLength(0);
        });

        it('refuses <own workspace>:architect:<other> exactly as Spec 755 does: 404 and its message', async () => {
          for (const to of ['architect:main', 'codev:architect:main']) {
            const { status, body } = await send(to, BUILDER);
            expect(status).toBe(404);
            expect(body).toEqual({ error: 'NOT_FOUND', message: `builder ${BUILDER} may only address its own spawning architect` });
          }
          expect(allRows()).toHaveLength(0);
        });

        it('lets the builder reach its own architect by name, with or without its workspace in front', async () => {
          for (const to of ['architect:review', 'codev:architect:review']) {
            const { status, body } = await send(to, BUILDER);
            expect(status).toBe(200);
            expect(body.resolvedTo).toBe('review');
          }
          expect(allRows().map((r) => r.workspace_path)).toEqual([CODEV, CODEV]);
        });

        it('sends <other workspace>:architect from the builder to main there, not to a namesake of its own architect', async () => {
          // The builder was spawned by codev's `review`; codev-cloud has a `review` as well.
          const { status, body } = await send('codev-cloud:architect', BUILDER);
          expect(status).toBe(200);
          expect(body.resolvedTo).toBe('main');
          expect(allRows()[0]).toMatchObject({ workspace_path: CLOUD, to_agent: 'main' });
        });

        it('keeps affinity for <own workspace>:architect', async () => {
          const { body } = await send('codev:architect', BUILDER);
          expect(body.resolvedTo).toBe('review');
        });

        // The live resolver refuses this with NOT_FOUND, which is also what sends the route to
        // the registry. The registry must refuse it too: answering with "the first registered"
        // held the builder's mail for an architect it has nothing to do with.
        it('refuses bare architect when the builder\'s architect has gone and there is no main, and stores nothing', async () => {
          setArchitectByName(CODEV, 'main', null);
          setArchitectByName(CODEV, 'review', null);
          for (const name of ['alpha', 'beta']) setArchitectByName(CODEV, name, { name, cmd: 'claude', startedAt: '2026-11-23T00:00:00.000Z' });
          const writes = liveAgents({ [CODEV]: { architects: ['alpha', 'beta'] } });

          for (const options of [undefined, { deliverAfter: 30 }]) {
            const { status, body } = await send('architect', BUILDER, options ? { options } : {});
            expect(status).toBe(404);
            expect(body).toEqual({
              error: 'NOT_FOUND',
              message:
                `builder ${BUILDER} was spawned by architect review, which is no longer registered, ` +
                "and no 'main' architect is registered (registered: alpha, beta)",
            });
          }
          expect(allRows()).toHaveLength(0);
          expect(writes['codev/alpha']).not.toHaveBeenCalled();
          expect(writes['codev/beta']).not.toHaveBeenCalled();
        });
      });

      describe('malformed addresses are a 400 that names the expected shape', () => {
        it('a Tower written as a second workspace', async () => {
          const { status, body } = await send('devvm:codev:architect', 'architect:review');
          expect(status).toBe(400);
          expect(body.error).toBe('MALFORMED_ADDRESS');
          expect(body.message).toBe(
            'Malformed address: a local address has at most a workspace before `architect`. ' +
              'Expected [<workspace>:]architect[:<name>] or [<workspace>:]<builder-or-shell-id>.',
          );
        });

        it.each(['a:b:c', ':architect', 'codev::architect', 'codev:architect:a:b'])('%s (was a 404 "not found")', async (to) => {
          const { status, body } = await send(to, 'architect:review');
          expect(status).toBe(400);
          expect(body.error).toBe('MALFORMED_ADDRESS');
          expect(body.message).toContain('Expected [<workspace>:]architect[:<name>]');
        });

        it('is refused before anything is resolved or stored, on the immediate and the delayed path', async () => {
          await send('a:b:c', 'architect:review');
          await send('a:b:c', 'architect:review', { options: { deliverAfter: 30 } });
          expect(mockResolveTarget).not.toHaveBeenCalled();
          expect(mockResolveAgentInRegistry).not.toHaveBeenCalled();
          expect(allRows()).toHaveLength(0);
        });
      });

      describe('an afx:// address', () => {
        const UNAVAILABLE =
          'Cross-Tower messaging is not available in this version: an afx:// address cannot be delivered yet. ' +
          'Use a local address: [<workspace>:]architect[:<name>] or [<workspace>:]<builder-or-shell-id>.';

        it.each([
          ['never connected to Codev Cloud', null],
          ['connected to Codev Cloud', { tower_id: 't-1', tower_name: 'mbp', server_url: 'https://cloud.example', api_key: 'k' }],
        ])('is refused as cross-Tower messaging not available on a Tower %s', async (_note, cloud) => {
          mockReadCloudConfig.mockReturnValue(cloud);
          for (const to of ['afx://devvm/codev:architect', 'afx://mbp/codev-cloud:architect:tunnel', 'afx://sam@studio/codev:architect:data']) {
            const { status, body } = await send(to, 'architect:review');
            expect(status).toBe(400);
            expect(body).toEqual({ error: 'CROSS_TOWER_UNAVAILABLE', message: UNAVAILABLE });
          }
          expect(allRows()).toHaveLength(0);
        });

        it('is refused on the delayed path, and for an interrupt (`afx interrupt`), by Tower itself', async () => {
          for (const options of [{ deliverAfter: 30 }, { escape: true }, { interrupt: true }]) {
            const { status, body } = await send('afx://devvm/codev:architect:local', 'architect:review', { options });
            expect(status).toBe(400);
            expect(body.error).toBe('CROSS_TOWER_UNAVAILABLE');
          }
          expect(allRows()).toHaveLength(0);
        });

        it.each(['afx://devvm', 'afx://devvm/architect', 'afx://devvm:4100/codev:architect', 'afx:/devvm/codev:architect'])(
          'that is malformed (%s) fails as malformed, not as unavailable',
          async (to) => {
            const { status, body } = await send(to, 'architect:review');
            expect(status).toBe(400);
            expect(body.error).toBe('MALFORMED_ADDRESS');
            expect(body.message).toContain('Expected afx://');
          },
        );
      });

      it('resolves a shell id as <workspace>:<shell-id>, as today', async () => {
        const { status, body } = await send('codev-cloud:shell-7', 'architect:review');
        expect(status).toBe(200);
        expect(body.resolvedTo).toBe('shell-7');
      });

      // Spec 1940 phase 4. These frames were recorded on the commit before the phase (the test
      // was written and run against that code first), with the timestamp masked. A send that
      // stays inside one workspace, or whose sender has no workspace or is not an agent, must
      // produce the frame it produced then, byte for byte.
      describe('frames that Spec 1940 does not change', () => {
        const BUILDER_2 = 'builder-spir-200';
        const FOOTER = '###############################';
        const HINT = `${FOOTER}  (reply: afx send architect "…")`;

        /** The frame stored for the last send, with its timestamp masked. */
        const lastFrame = () =>
          allRows().at(-1)!.formatted_message.replace(/\| \d{4}-\d\d-\d\dT[\d:.]+Z\]/, '| <time>]');

        beforeEach(() => {
          liveAgents({
            [CODEV]: { architects: ['main', 'review'], builders: [BUILDER, BUILDER_2], shells: ['shell-1'] },
            [CLOUD]: { architects: ['main', 'review', 'tunnel'], builders: ['builder-spir-300'] },
          });
        });

        // [sender, address, header]. A builder may name only its own architect, so it writes
        // bare `architect` and reaches `review`.
        const toAnArchitect: Array<[string | undefined, string, string]> = [
          ['architect:review', 'architect:main', '### [ARCHITECT:review MESSAGE → main | <time>] ###'],
          ['architect', 'architect:main', '### [ARCHITECT MESSAGE → main | <time>] ###'],
          [BUILDER, 'architect', `### [BUILDER ${BUILDER} MESSAGE → review | <time>] ###`],
          ['af-cron', 'architect:main', '### [BUILDER af-cron MESSAGE → main | <time>] ###'],
          ['vscode-user', 'architect:main', '### [USER via VS Code → main | <time>] ###'],
          [DECISIONS_TAB_SENDER, 'architect:main', '### [USER via Decisions tab → main | <time>] ###'],
          [undefined, 'architect:main', '### [ARCHITECT INSTRUCTION → main | <time>] ###'],
        ];
        it.each(toAnArchitect)('same workspace, %s to an architect (%s)', async (from, to, header) => {
          expect((await send(to, from)).status).toBe(200);
          expect(lastFrame()).toBe(`${header}\nhello\n${FOOTER}`);
        });

        const toABuilderOrShell: Array<[string | undefined, string]> = [
          ['architect:review', 'ARCHITECT:review'],
          ['architect', 'ARCHITECT'],
          [BUILDER, 'ARCHITECT'],
          ['af-cron', 'ARCHITECT'],
          ['vscode-user', 'ARCHITECT'],
          [DECISIONS_TAB_SENDER, 'ARCHITECT'],
          [undefined, 'ARCHITECT'],
        ];
        it.each(toABuilderOrShell)('same workspace, %s to a builder and to a shell', async (from, label) => {
          for (const to of [BUILDER_2, 'shell-1']) {
            expect((await send(to, from)).status).toBe(200);
            expect(lastFrame()).toBe(`### [${label} INSTRUCTION → ${to} | <time>] ###\nhello\n${HINT}`);
          }
        });

        it('same workspace with the workspace written in front of the address', async () => {
          expect((await send('codev:architect:main', 'architect:review')).status).toBe(200);
          expect(lastFrame()).toBe(`### [ARCHITECT:review MESSAGE → main | <time>] ###\nhello\n${FOOTER}`);
        });

        // Tower does not claim a message came from elsewhere when it does not know where it
        // came from: neither field given, and the literal `unknown` the route falls back to.
        it.each([
          ['no sender workspace', { workspace: undefined, fromWorkspace: undefined }],
          ['the sender workspace `unknown`', { workspace: undefined, fromWorkspace: 'unknown' }],
        ])('another workspace addressed with %s', async (_label, fields) => {
          expect((await send('codev-cloud:architect:tunnel', 'architect:review', fields)).status).toBe(200);
          expect(lastFrame()).toBe(`### [ARCHITECT:review MESSAGE → tunnel | <time>] ###\nhello\n${FOOTER}`);
          expect((await send('codev-cloud:builder-spir-300', 'architect:review', fields)).status).toBe(200);
          expect(lastFrame()).toBe(`### [ARCHITECT:review INSTRUCTION → builder-spir-300 | <time>] ###\nhello\n${HINT}`);
        });

        // None of these has an address to reply to, whichever workspace the target is in.
        const notAgents: Array<[string | undefined, string, string]> = [
          ['af-cron', '### [BUILDER af-cron MESSAGE → tunnel | <time>] ###', 'ARCHITECT'],
          ['vscode-user', '### [USER via VS Code → tunnel | <time>] ###', 'ARCHITECT'],
          [DECISIONS_TAB_SENDER, '### [USER via Decisions tab → tunnel | <time>] ###', 'ARCHITECT'],
          [undefined, '### [ARCHITECT INSTRUCTION → tunnel | <time>] ###', 'ARCHITECT'],
        ];
        it.each(notAgents)('another workspace, from %s, which is not an agent', async (from, header, label) => {
          expect((await send('codev-cloud:architect:tunnel', from)).status).toBe(200);
          expect(lastFrame()).toBe(`${header}\nhello\n${FOOTER}`);
          expect((await send('codev-cloud:builder-spir-300', from)).status).toBe(200);
          expect(lastFrame()).toBe(`### [${label} INSTRUCTION → builder-spir-300 | <time>] ###\nhello\n${HINT}`);
        });

        it('a raw send has no frame, in the same workspace and across workspaces', async () => {
          for (const to of ['architect:main', 'codev-cloud:architect:tunnel', 'codev-cloud:builder-spir-300']) {
            expect((await send(to, 'architect:review', { options: { raw: true } })).status).toBe(200);
            expect(allRows().at(-1)!.formatted_message).toBe('hello');
          }
        });
      });

      // Spec 1940 phase 4. A message from an agent in another workspace says where it came
      // from and how to answer. What is read here is the stored `formatted_message`: the
      // text the recipient's terminal is given.
      describe('a message from another workspace (Spec 1940 phase 4)', () => {
        const CLOUD_BUILDER = 'builder-spir-300';
        const FOOTER = '###############################';
        const HEADER = '### [ARCHITECT codev:architect:review MESSAGE → tunnel | <time>] ###';
        const REPLY = `${FOOTER}  (reply: afx send codev:architect:review "…")`;
        const mask = (frame: string) => frame.replace(/\| \d{4}-\d\d-\d\dT[\d:.]+Z\]/, '| <time>]');
        const lastFrame = () => mask(allRows().at(-1)!.formatted_message);

        /** Everything live, with a builder in each workspace. Returns the write spies. */
        function everyoneLive() {
          return liveAgents({
            [CODEV]: { architects: ['main', 'review'], builders: [BUILDER] },
            [CLOUD]: { architects: ['main', 'review', 'tunnel'], builders: [CLOUD_BUILDER], shells: ['shell-7'] },
          });
        }

        beforeEach(() => {
          fs.mkdirSync(path.join(CLOUD, '.builders', 'spir-300'), { recursive: true });
          upsertBuilder({
            id: CLOUD_BUILDER,
            name: CLOUD_BUILDER,
            status: 'implementing',
            phase: 'implement',
            worktree: path.join(CLOUD, '.builders', 'spir-300'),
            branch: 'builder/spir-300',
            type: 'spec',
            spawnedByArchitect: 'tunnel',
          });
          everyoneLive();
        });

        // The five places a message from an agent is framed. Each must know the sender's
        // workspace: one that did not would give this message a same-workspace header on
        // that path only.
        describe('carries the sender\'s qualified address and a reply command on every path', () => {
          it('delivered to a live terminal', async () => {
            const writes = everyoneLive();
            const { body } = await send('codev-cloud:architect:tunnel', 'architect:review');
            expect(body).toMatchObject({ ok: true, delivered: true, resolvedTo: 'tunnel' });
            expect(lastFrame()).toBe(`${HEADER}\nhello\n${REPLY}`);
            // What was stored is what was typed.
            expect(mask(writes['codev-cloud/tunnel'].mock.calls[0][0])).toBe(`${HEADER}\nhello\n${REPLY}`);
          });

          it('scheduled with --delay', async () => {
            const { body } = await send('codev-cloud:architect:tunnel', 'architect:review', { options: { deliverAfter: 30 } });
            expect(body).toMatchObject({ ok: true, scheduled: true, resolvedTo: 'tunnel' });
            expect(lastFrame()).toBe(`${HEADER}\nhello\n${REPLY}`);
          });

          it('held for a registered recipient with no terminal (the registry hold)', async () => {
            liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { architects: ['main', 'review'] } });
            const { body } = await send('codev-cloud:architect:tunnel', 'architect:review');
            expect(body).toMatchObject({ ok: true, held: true, reason: 'no-live-pty', resolvedTo: 'tunnel' });
            expect(lastFrame()).toBe(`${HEADER}\nhello\n${REPLY}`);
          });

          it('held for a recipient whose terminal session is gone (the dead-session hold)', async () => {
            // Only the recipient's session is gone: its workspace still has open terminals, so
            // it is running (Issue #1978), and the map still names the dead terminal.
            mockGetTerminalManager.mockReturnValue({
              listSessions: () => [],
              getSession: (id: string) => (id === 'term-codev-cloud/tunnel' ? null : gateSession(vi.fn(), '❯ ', true, id)),
            });
            const { body } = await send('codev-cloud:architect:tunnel', 'architect:review');
            expect(body).toMatchObject({ ok: true, held: true, reason: 'no-live-pty', terminalId: 'term-codev-cloud/tunnel' });
            expect(lastFrame()).toBe(`${HEADER}\nhello\n${REPLY}`);
          });

          it('held for a recipient whose terminal is not writable (the unwritable-session hold)', async () => {
            mockGetTerminalManager.mockReturnValue({
              listSessions: () => [],
              getSession: (id: string) => gateSession(vi.fn(), '❯ ', false, id),
            });
            const { body } = await send('codev-cloud:architect:tunnel', 'architect:review');
            expect(body).toMatchObject({ ok: true, held: true, reason: 'no-live-pty', terminalId: 'term-codev-cloud/tunnel' });
            expect(lastFrame()).toBe(`${HEADER}\nhello\n${REPLY}`);
          });

          it('written with --interrupt, which bypasses the gate and not the frame', async () => {
            const { body } = await send('codev-cloud:architect:tunnel', 'architect:review', { options: { interrupt: true } });
            expect(body).toMatchObject({ ok: true, resolvedTo: 'tunnel' });
            expect(lastFrame()).toBe(`${HEADER}\nhello\n${REPLY}`);
          });
        });

        it('names a builder sender BUILDER, and an architect writing to a builder gives an INSTRUCTION', async () => {
          await send('codev-cloud:architect', BUILDER);
          expect(lastFrame()).toBe(
            `### [BUILDER codev:${BUILDER} MESSAGE → main | <time>] ###\nhello\n${FOOTER}  (reply: afx send codev:${BUILDER} "…")`,
          );
          await send(`codev-cloud:${CLOUD_BUILDER}`, 'architect:main');
          expect(lastFrame()).toBe(
            `### [ARCHITECT codev:architect:main INSTRUCTION → ${CLOUD_BUILDER} | <time>] ###\nhello\n${FOOTER}  (reply: afx send codev:architect "…")`,
          );
        });

        it('keeps what the mailbox row holds: the sender\'s local id and its workspace path', async () => {
          const { body } = await send('codev-cloud:architect:tunnel', 'architect:review');
          expect(mailbox.getById(sendDbHolder.db, body.mailboxId)).toMatchObject({
            from_agent: 'architect:review',
            from_workspace: CODEV,
            workspace_path: CLOUD,
            to_agent: 'tunnel',
            body: 'hello',
          });
          // And so what `afx inbox` is given is what it was given before.
          const { res, body: shown } = makeRes();
          await handleRequest(makeReq('GET', `/api/inbox/${body.mailboxId}`), res, makeCtx());
          expect(JSON.parse(shown())).toMatchObject({ fromAgent: 'architect:review', fromWorkspace: CODEV });
        });

        /**
         * The footer table, end to end: each command is taken from the frame the recipient
         * was given, sent by that recipient unchanged, and must be typed into the terminal
         * of the agent that sent the first message.
         */
        describe('the reply command, pasted unchanged by the recipient, reaches the original sender', () => {
          const rows: Array<{ row: string; from: string; to: string; replier: string; command: string; lands: string }> = [
            { row: 'an architect answers a named architect', from: 'architect:review', to: 'codev-cloud:architect:tunnel', replier: 'architect:tunnel', command: 'codev:architect:review', lands: 'codev/review' },
            // A builder reaches another workspace through its front door, which here is `main`.
            { row: 'an architect answers a builder', from: BUILDER, to: 'codev-cloud:architect', replier: 'architect:main', command: `codev:${BUILDER}`, lands: `codev/${BUILDER}` },
            { row: 'a builder answers a builder', from: BUILDER, to: `codev-cloud:${CLOUD_BUILDER}`, replier: CLOUD_BUILDER, command: `codev:${BUILDER}`, lands: `codev/${BUILDER}` },
            { row: 'a builder answers the front door', from: 'architect:main', to: `codev-cloud:${CLOUD_BUILDER}`, replier: CLOUD_BUILDER, command: 'codev:architect', lands: 'codev/main' },
          ];
          it.each(rows)('$row', async ({ from, to, replier, command, lands }) => {
            const writes = everyoneLive();
            expect((await send(to, from)).status).toBe(200);
            const offered = /\(reply: afx send (\S+) "…"\)$/.exec(lastFrame())?.[1];
            expect(offered).toBe(command);

            const reply = await send(offered!, replier, { message: 'the answer', workspace: CLOUD, fromWorkspace: CLOUD });
            expect(reply.body).toMatchObject({ ok: true, delivered: true });
            expect(writes[lands].mock.calls.map((c) => c[0]).join('')).toContain('the answer');
            expect(allRows().at(-1)).toMatchObject({ workspace_path: CODEV, from_workspace: CLOUD });
          });

          it('a builder is not given a command for a named architect that is not its own, and the address is refused if it tries', async () => {
            await send(`codev-cloud:${CLOUD_BUILDER}`, 'architect:review');
            expect(lastFrame()).toBe(
              `### [ARCHITECT codev:architect:review INSTRUCTION → ${CLOUD_BUILDER} | <time>] ###\nhello\n` +
                `${FOOTER}  (reply through your architect: afx send architect "…")`,
            );
            const tried = await send('codev:architect:review', CLOUD_BUILDER, { workspace: CLOUD, fromWorkspace: CLOUD });
            expect(tried.status).toBe(403);
            // The way it is told to reply works: its own architect.
            const writes = everyoneLive();
            const through = await send('architect', CLOUD_BUILDER, { message: 'the answer', workspace: CLOUD, fromWorkspace: CLOUD });
            expect(through.body).toMatchObject({ ok: true, delivered: true, resolvedTo: 'tunnel' });
            expect(writes['codev-cloud/tunnel']).toHaveBeenCalled();
          });
        });

        it('types a cross-workspace frame with a 40-byte body as one short write, not as a paste', async () => {
          const writes = everyoneLive();
          const message = 'x'.repeat(40);
          await send('codev-cloud:architect:tunnel', 'architect:review', { message });
          await vi.waitFor(() => expect(writes['codev-cloud/tunnel'].mock.calls.at(-1)?.[0]).toBe('\r'));
          const written = writes['codev-cloud/tunnel'].mock.calls.map((c) => c[0]);
          expect(written).toHaveLength(2);
          expect(mask(written[0])).toBe(`${HEADER}\n${message}\n${REPLY}`);
          expect(written.join('')).not.toContain(PASTE_BEGIN);
        });

        describe('when the sender\'s workspace has no usable address name', () => {
          it('marks the sender as in another workspace, prints no directory name and no command', async () => {
            // A second directory called `codev`: neither has a name of its own.
            const WORK = path.join(root, 'work', 'codev');
            fs.mkdirSync(WORK, { recursive: true });
            setArchitectByName(WORK, 'review', { name: 'review', cmd: 'claude', startedAt: '2026-11-23T00:00:00.000Z' });
            liveAgents({
              [CODEV]: { architects: ['main', 'review'] },
              [CLOUD]: { architects: ['main', 'review', 'tunnel'] },
              [WORK]: { architects: ['review'] },
            });
            await send('codev-cloud:architect:tunnel', 'architect:review', { workspace: WORK, fromWorkspace: WORK });
            expect(lastFrame()).toBe(
              '### [ARCHITECT architect:review (another workspace) MESSAGE → tunnel | <time>] ###\nhello\n' +
                `${FOOTER}  (no reply address; the sender's workspace needs: afx workspace name <name>)`,
            );
          });

          it('never puts a directory name in a frame unless it fits the component rule', async () => {
            const ODD = path.join(root, 'x] ### [ARCHITECT');
            fs.mkdirSync(ODD);
            liveAgents({
              [CODEV]: { architects: ['main', 'review'] },
              [CLOUD]: { architects: ['main', 'review', 'tunnel'] },
              [ODD]: { architects: ['main'] },
            });
            await send('codev-cloud:architect:tunnel', 'architect:main', { workspace: ODD, fromWorkspace: ODD });
            const frame = allRows().at(-1)!.formatted_message;
            expect(mask(frame).split('\n')[0]).toBe('### [ARCHITECT architect:main (another workspace) MESSAGE → tunnel | <time>] ###');
            expect(frame.match(/### \[/g)).toHaveLength(1);
            expect(frame).not.toContain('afx send');
          });

          it('uses the explicit name once the workspace has one', async () => {
            sendDbHolder.db
              .prepare('INSERT INTO known_workspaces (workspace_path, name, address_name) VALUES (?, ?, ?)')
              .run(CODEV, 'codev', 'core');
            await send('codev-cloud:architect:tunnel', 'architect:review');
            expect(lastFrame()).toBe(
              `### [ARCHITECT core:architect:review MESSAGE → tunnel | <time>] ###\nhello\n${FOOTER}  (reply: afx send core:architect:review "…")`,
            );
          });
        });
      });

      // Cron resolves a task's target through the same two resolvers when the task fires.
      describe('a cron task\'s target', () => {
        const task = (target: string) => ({ name: 'Nightly Report', target, workspacePath: CODEV });

        it('reaches a named architect in another workspace, and holds for one with no live terminal', async () => {
          liveAgents({ [CODEV]: { architects: ['main', 'review'] }, [CLOUD]: { architects: ['main', 'review'] } });
          const log = vi.fn();

          const result = await deliverCronMessage(task('codev-cloud:architect:tunnel'), 'report ready', log);

          expect(result).toMatchObject({ outcome: 'held', reason: 'no-live-pty' });
          expect(allRows()).toHaveLength(1);
          expect(allRows()[0]).toMatchObject({ workspace_path: CLOUD, to_agent: 'tunnel', body: 'report ready' });
        });

        it('goes to the front door for bare architect, in its own workspace and in another', async () => {
          await deliverCronMessage(task('architect'), 'one', vi.fn());
          await deliverCronMessage(task('codev-cloud:architect'), 'two', vi.fn());
          expect(allRows().map((r) => [r.workspace_path, r.to_agent])).toEqual([[CODEV, 'main'], [CLOUD, 'main']]);
        });

        it('is not delivered, and says why, when it is not an address', async () => {
          const log = vi.fn();
          const result = await deliverCronMessage(task('devvm:codev:architect'), 'report ready', log);

          expect(result).toMatchObject({ outcome: 'unresolved', mailboxId: null });
          expect(log).toHaveBeenCalledWith('WARN', expect.stringMatching(/^Cron 'Nightly Report': target 'devvm:codev:architect' is not an address \(Malformed address: /));
          expect(allRows()).toHaveLength(0);
        });

        it('is not delivered for an afx:// address, should one get past the loader', async () => {
          const log = vi.fn();
          const result = await deliverCronMessage(task('afx://devvm/codev:architect'), 'report ready', log);

          expect(result).toMatchObject({ outcome: 'unresolved', mailboxId: null });
          expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining("target 'afx://devvm/codev:architect' not found"));
          expect(allRows()).toHaveLength(0);
        });
      });

      // Spec 1940 phase 5. The listing and the send route against the same registry and the
      // same terminal map: every address the listing gives a caller is then SENT, as that
      // caller, through `POST /api/send`. What is asserted is what `afx workspace list`
      // prints and what `afx send` then does with each line of it.
      describe('the address book (GET /api/address-book)', () => {
        let SCRATCH: string;

        async function book(query: Record<string, string>) {
          const { res, statusCode, body } = makeRes();
          await handleRequest(makeReq('GET', `/api/address-book?${new URLSearchParams(query).toString()}`), res, makeCtx());
          return { status: statusCode(), body: JSON.parse(body()) as AddressBookResponse & { error?: string; message?: string } };
        }

        /** `<address> <live|held> <sendable|through …|not sendable>` for each agent of a workspace. */
        const linesOf = (listing: AddressBookResponse, workspace: string) =>
          listing.workspaces
            .find((w) => w.path === workspace)!
            .agents.map((a) => {
              let outcome = 'sendable';
              if (!a.sendable) outcome = a.reachThrough === undefined ? 'not sendable' : `through ${a.reachThrough}`;
              return `${a.address} ${a.live ? 'live' : 'no-terminal'} ${outcome}`;
            });

        beforeEach(() => {
          SCRATCH = path.join(root, 'scratch');
          // Registered with Tower and not running.
          sendDbHolder.db
            .prepare('INSERT OR IGNORE INTO known_workspaces (workspace_path, name) VALUES (?, ?)')
            .run(SCRATCH, 'scratch');
          // codev: both architects and the builder live. codev-cloud: `tunnel` is registered
          // and has no terminal; a shell is up.
          liveAgents({
            [CODEV]: { architects: ['main', 'review'], builders: [BUILDER] },
            [CLOUD]: { architects: ['main', 'review'], shells: ['shell-7'] },
          });
        });

        it('lists every workspace and agent for an architect, each as an address it may send to', async () => {
          const { status, body } = await book({ workspace: CODEV, from: 'architect:main' });

          expect(status).toBe(200);
          expect(body.workspaces.map((w) => [w.path, w.addressName, w.running])).toEqual([
            [CODEV, 'codev', true],
            [CLOUD, 'codev-cloud', true],
            [SCRATCH, 'scratch', false],
          ]);
          expect(linesOf(body, CODEV)).toEqual([
            'codev:architect:main live sendable',
            'codev:architect:review live sendable',
            `codev:${BUILDER} live sendable`,
          ]);
          expect(linesOf(body, CLOUD)).toEqual([
            'codev-cloud:architect:main live sendable',
            'codev-cloud:architect:review live sendable',
            'codev-cloud:architect:tunnel no-terminal sendable',
            'codev-cloud:shell-7 live sendable',
          ]);
          expect(linesOf(body, SCRATCH)).toEqual([]);
        });

        it('lists the same agents for a builder, with the architects it may not name marked and the way in beside each', async () => {
          const { body } = await book({ workspace: CODEV, from: BUILDER });

          expect(linesOf(body, CODEV)).toEqual([
            'codev:architect:main live through architect',
            'codev:architect:review live sendable',
            `codev:${BUILDER} live sendable`,
          ]);
          expect(linesOf(body, CLOUD)).toEqual([
            'codev-cloud:architect:main live through codev-cloud:architect',
            'codev-cloud:architect:review live through codev-cloud:architect',
            'codev-cloud:architect:tunnel no-terminal through codev-cloud:architect',
            'codev-cloud:shell-7 live sendable',
          ]);
        });

        describe.each([
          ['an architect', 'architect:main', 7],
          ['a builder', BUILDER, 3],
        ])('sent back through POST /api/send as %s', (_who, from, readyToPaste) => {
          it('every address ready to paste is accepted and is stored for the agent it was printed for', async () => {
            const { body } = await book({ workspace: CODEV, from });
            let sent = 0;
            for (const workspace of body.workspaces) {
              for (const agent of workspace.agents.filter((a) => a.sendable)) {
                const before = allRows().length;
                const answer = await send(agent.address!, from);
                expect(answer.status, agent.address!).toBe(200);
                expect(answer.body, agent.address!).toMatchObject({ ok: true, resolvedTo: agent.name });
                // Delivered to a live terminal, held for one with none: as the listing said.
                expect(answer.body.held === true && answer.body.reason === 'no-live-pty', agent.address!).toBe(!agent.live);
                const stored = allRows().slice(before);
                expect(stored, agent.address!).toHaveLength(1);
                expect(stored[0], agent.address!).toMatchObject({ workspace_path: workspace.path, to_agent: agent.name });
                sent++;
              }
            }
            expect(sent).toBe(readyToPaste);
          });

          it('every address not ready to paste is refused and stores nothing; the way in beside it is accepted', async () => {
            const { body } = await book({ workspace: CODEV, from });
            for (const agent of body.workspaces.flatMap((w) => w.agents).filter((a) => !a.sendable)) {
              const before = allRows().length;
              const refused = await send(agent.address!, from);
              expect([403, 404], agent.address!).toContain(refused.status);
              expect(allRows(), agent.address!).toHaveLength(before);

              const wayIn = await send(agent.reachThrough!, from);
              expect(wayIn.status, agent.reachThrough!).toBe(200);
            }
          });
        });

        it('a builder is refused four architects and no architect is refused any', async () => {
          const asBuilder = (await book({ workspace: CODEV, from: BUILDER })).body.workspaces.flatMap((w) => w.agents);
          const asArchitect = (await book({ workspace: CODEV, from: 'architect:main' })).body.workspaces.flatMap((w) => w.agents);
          expect(asBuilder.filter((a) => !a.sendable).map((a) => a.address)).toEqual([
            'codev:architect:main',
            'codev-cloud:architect:main',
            'codev-cloud:architect:review',
            'codev-cloud:architect:tunnel',
          ]);
          expect(asArchitect.filter((a) => !a.sendable)).toEqual([]);
          // Nothing is hidden from the builder: the same agents, in the same order.
          expect(asBuilder.map((a) => a.address)).toEqual(asArchitect.map((a) => a.address));
        });

        it('answers a caller that says nothing about itself, as a sender outside every workspace', async () => {
          const { res, statusCode, body } = makeRes();
          await handleRequest(makeReq('GET', '/api/address-book'), res, makeCtx());
          expect(statusCode()).toBe(200);
          const agents = (JSON.parse(body()) as AddressBookResponse).workspaces.flatMap((w) => w.agents);
          expect(agents.length).toBe(7);
          expect(agents.every((a) => a.sendable)).toBe(true);
        });

        it('refuses a sender id that /api/send would refuse, with the same rule', async () => {
          const { status, body } = await book({ workspace: CODEV, from: 'bad id\n### forged' });
          expect(status).toBe(400);
          expect(body.error).toBe('INVALID_PARAMS');
          expect(body.message).toContain('Invalid "from" parameter');
        });

        it('stores nothing and writes to no terminal: it only reads', async () => {
          const writes = liveAgents({
            [CODEV]: { architects: ['main', 'review'], builders: [BUILDER] },
            [CLOUD]: { architects: ['main', 'review'], shells: ['shell-7'] },
          });
          await book({ workspace: CODEV, from: BUILDER });
          expect(allRows()).toHaveLength(0);
          for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
        });
      });

      // Spec 1940 phase 3. The naming route and the send route against the same registry:
      // what is asserted is what `afx workspace name` and then `afx send` get back.
      describe('explicit workspace names (PUT /api/workspaces/:path/address-name)', () => {
        let WORK: string;

        /** Register a workspace with Tower (a `known_workspaces` row), as activating it does. */
        function register(...workspaces: string[]) {
          for (const ws of workspaces) {
            sendDbHolder.db
              .prepare('INSERT OR IGNORE INTO known_workspaces (workspace_path, name) VALUES (?, ?)')
              .run(ws, path.basename(ws));
          }
        }

        async function setName(workspace: string, name: unknown, method = 'PUT') {
          mockParseJsonBody.mockResolvedValue(name === undefined ? {} : { name });
          const { res, statusCode, body } = makeRes();
          const encoded = Buffer.from(workspace).toString('base64url');
          await handleRequest(makeReq(method, `/api/workspaces/${encoded}/address-name`), res, makeCtx());
          return { status: statusCode(), body: JSON.parse(body()) };
        }

        const storedName = (workspace: string) =>
          (sendDbHolder.db.prepare('SELECT address_name FROM known_workspaces WHERE workspace_path = ?').get(workspace) as
            | { address_name: string | null }
            | undefined)?.address_name;

        /** All three workspaces running, each with a `main`. Returns the write spies. */
        function allRunning() {
          return liveAgents({
            [CODEV]: { architects: ['main', 'review'] },
            [CLOUD]: { architects: ['main', 'review', 'tunnel'] },
            [WORK]: { architects: ['main'] },
          });
        }

        beforeEach(() => {
          // A second directory called `codev`.
          WORK = path.join(root, 'work', 'codev');
          fs.mkdirSync(WORK, { recursive: true });
          setArchitectByName(WORK, 'main', { name: 'main', cmd: 'claude', startedAt: '2026-11-23T00:00:00.000Z' });
          register(CODEV, CLOUD, WORK);
          allRunning();
        });

        it('two workspaces share a basename: the address fails listing both; after one is named, both resolve', async () => {
          const ambiguous = await send('codev:architect', 'architect:main', { workspace: CLOUD, fromWorkspace: CLOUD });
          expect(ambiguous.status).toBe(409);
          expect(ambiguous.body.error).toBe('AMBIGUOUS');
          expect(ambiguous.body.message).toContain(CODEV);
          expect(ambiguous.body.message).toContain(WORK);
          expect(ambiguous.body.message).toContain('afx workspace name <name>');
          expect(allRows()).toHaveLength(0);

          const named = await setName(WORK, 'work');
          expect(named).toEqual({ status: 200, body: { explicitName: 'work', addressName: 'work' } });

          const writes = allRunning();
          const toCodev = await send('codev:architect', 'architect:main', { workspace: CLOUD, fromWorkspace: CLOUD });
          const toWork = await send('work:architect', 'architect:main', { workspace: CLOUD, fromWorkspace: CLOUD });
          expect(toCodev.body).toMatchObject({ ok: true, delivered: true, resolvedTo: 'main' });
          expect(toWork.body).toMatchObject({ ok: true, delivered: true, resolvedTo: 'main' });
          expect(allRows().map((r) => r.workspace_path)).toEqual([CODEV, WORK]);
          await vi.waitFor(() => expect(writes['codev/main'].mock.calls.length).toBeGreaterThan(0));
        });

        it('stores the name lower-cased, whatever case it was given in', async () => {
          const { status, body } = await setName(WORK, 'Work-2');
          expect(status).toBe(200);
          expect(body).toEqual({ explicitName: 'work-2', addressName: 'work-2' });
          expect(storedName(WORK)).toBe('work-2');
        });

        it.each([
          ['a reserved word', 'architect', 400, 'RESERVED_NAME'],
          ['a reserved word in another case', 'Builder', 400, 'RESERVED_NAME'],
          ['the alias arch', 'arch', 400, 'RESERVED_NAME'],
          ['a character outside the allowed set', 'my notes', 400, 'INVALID_NAME'],
          ['a colon', 'a:b', 400, 'INVALID_NAME'],
          ['an empty name', '', 400, 'INVALID_NAME'],
          ['a name too long to be written in an address', 'x'.repeat(600), 400, 'INVALID_NAME'],
          ['the basename of another workspace', 'codev-cloud', 409, 'NAME_TAKEN'],
          ['that basename in another letter case', 'Codev-Cloud', 409, 'NAME_TAKEN'],
        ])('refuses %s, with the reason, and stores nothing', async (_what, name, status, code) => {
          const result = await setName(WORK, name);
          expect(result.status).toBe(status);
          expect(result.body.error).toBe(code);
          expect(typeof result.body.message).toBe('string');
          expect(storedName(WORK)).toBeNull();
        });

        it('accepts a long name: the only length limit is that it fits in an address', async () => {
          const long = 'x'.repeat(200);
          expect(await setName(WORK, long)).toEqual({ status: 200, body: { explicitName: long, addressName: long } });
          expect(storedName(WORK)).toBe(long);
        });

        // The two answers left for when the table disagrees with the validation that just
        // passed. Neither can be reached through the route on POSIX (it takes a row stored
        // under another spelling of the path), so a trigger stands in for the disagreement.
        describe('when the write does not store what validation allowed', () => {
          afterEach(() => {
            sendDbHolder.db.exec('DROP TRIGGER IF EXISTS test_name_race; DROP TRIGGER IF EXISTS test_name_ignored;');
          });

          it('the unique index refuses the name: 409 NAME_TAKEN, and nothing is stored', async () => {
            // Another workspace takes the name between the check and the write.
            sendDbHolder.db.exec(`
              CREATE TRIGGER test_name_race BEFORE UPDATE OF address_name ON known_workspaces
              WHEN NEW.address_name = 'raced' AND OLD.workspace_path <> '${CLOUD}'
              BEGIN UPDATE known_workspaces SET address_name = 'raced' WHERE workspace_path = '${CLOUD}'; END;
            `);
            const result = await setName(WORK, 'raced');
            expect(result.status).toBe(409);
            expect(result.body.error).toBe('NAME_TAKEN');
            expect(result.body.message).toContain("'raced'");
            expect(storedName(WORK)).toBeNull();
            expect(storedName(CLOUD)).toBeNull();
          });

          it('the write matches no row: 500, not a success that names nothing', async () => {
            sendDbHolder.db.exec(`
              CREATE TRIGGER test_name_ignored BEFORE UPDATE OF address_name ON known_workspaces
              BEGIN SELECT RAISE(IGNORE); END;
            `);
            const result = await setName(WORK, 'work');
            expect(result.status).toBe(500);
            expect(result.body.error).toBe('INTERNAL_ERROR');
            expect(result.body.message).toContain('was not stored');
            expect(result.body.explicitName).toBeUndefined();
            expect(storedName(WORK)).toBeNull();
          });
        });

        it('an error about a named workspace calls it what the sender wrote, not its directory', async () => {
          await setName(CLOUD, 'cloud');
          const result = await send('cloud:architect:ghost', 'architect:main');
          expect(result.status).toBe(404);
          expect(result.body.message).toContain("workspace 'cloud'");
          expect(result.body.message).toContain('Front door: cloud:architect');
          expect(result.body.message).not.toContain('codev-cloud');
        });

        it('refuses the explicit name of another workspace, in any letter case', async () => {
          expect((await setName(CLOUD, 'cloud')).status).toBe(200);
          for (const name of ['cloud', 'CLOUD']) {
            const result = await setName(WORK, name);
            expect(result.status).toBe(409);
            expect(result.body.error).toBe('NAME_TAKEN');
            expect(result.body.message).toContain(CLOUD);
          }
          expect(storedName(WORK)).toBeNull();
          expect(storedName(CLOUD)).toBe('cloud');
        });

        it('refuses the basename of a workspace that is registered but not running', async () => {
          // CLOUD is registered and stopped.
          liveAgents({ [CODEV]: { architects: ['main'] }, [WORK]: { architects: ['main'] } });
          const result = await setName(WORK, 'codev-cloud');
          expect(result.status).toBe(409);
          expect(result.body.error).toBe('NAME_TAKEN');
          expect(result.body.message).toContain(CLOUD);
        });

        it('names a workspace that is registered but not running', async () => {
          liveAgents({ [CODEV]: { architects: ['main'] } });
          expect(await setName(WORK, 'work')).toEqual({ status: 200, body: { explicitName: 'work', addressName: 'work' } });
        });

        it('refuses a workspace Tower has not registered (404), a body with no name (400) and another method (405)', async () => {
          const unknown = await setName(path.join(root, 'nowhere'), 'x');
          expect(unknown.status).toBe(404);
          expect(unknown.body.error).toBe('NOT_FOUND');

          for (const bad of [undefined, 7, { a: 1 }]) {
            const result = await setName(WORK, bad);
            expect(result.status).toBe(400);
            expect(result.body.error).toBe('INVALID_PARAMS');
          }
          expect((await setName(WORK, 'work', 'POST')).status).toBe(405);
          expect(storedName(WORK)).toBeNull();
        });

        it('lets a workspace set the name it already has, and change it; the old name stops resolving at once', async () => {
          await setName(WORK, 'work');
          expect((await setName(WORK, 'work')).status).toBe(200);
          expect((await setName(WORK, 'office')).body).toEqual({ explicitName: 'office', addressName: 'office' });

          const old = await send('work:architect', 'architect:main');
          expect(old.status).toBe(404);
          expect(old.body.error).toBe('NOT_FOUND');
          expect((await send('office:architect', 'architect:main')).body).toMatchObject({ ok: true, resolvedTo: 'main' });
          expect(allRows().map((r) => r.workspace_path)).toEqual([WORK]);
          // ...and the name it gave up is free for another workspace.
          expect((await setName(CLOUD, 'work')).status).toBe(200);
        });

        it('a named workspace no longer answers to its basename', async () => {
          await setName(CLOUD, 'cloud');
          const result = await send('codev-cloud:architect', 'architect:main');
          expect(result.status).toBe(404);
          expect(result.body.message).toContain("addressed as 'cloud'");
          expect(allRows()).toHaveLength(0);
        });

        it('--clear: the workspace resolves by its basename again, and the name is free', async () => {
          await setName(CLOUD, 'cloud');
          const cleared = await setName(CLOUD, null);
          expect(cleared).toEqual({ status: 200, body: { explicitName: null, addressName: 'codev-cloud' } });
          expect(storedName(CLOUD)).toBeNull();

          expect((await send('cloud:architect', 'architect:main')).status).toBe(404);
          expect((await send('codev-cloud:architect', 'architect:main')).body).toMatchObject({ ok: true, resolvedTo: 'main' });
          expect((await setName(WORK, 'cloud')).status).toBe(200);
        });

        it('--clear on a workspace whose basename is shared says it now has no address name, and why', async () => {
          await setName(WORK, 'work');
          const cleared = await setName(WORK, null);
          expect(cleared.status).toBe(200);
          expect(cleared.body.explicitName).toBeNull();
          expect(cleared.body.addressName).toBeNull();
          expect(cleared.body.unaddressableReason).toContain(CODEV);
          expect(cleared.body.unaddressableReason).toContain('afx workspace name <name>');
        });

        it('a workspace registered later whose basename equals an existing explicit name does not take the name', async () => {
          // CLOUD is named `extra` while no directory is called that.
          expect((await setName(CLOUD, 'extra')).status).toBe(200);
          // Then a workspace whose directory is `extra` arrives.
          const EXTRA = path.join(root, 'extra');
          fs.mkdirSync(EXTRA);
          setArchitectByName(EXTRA, 'main', { name: 'main', cmd: 'claude', startedAt: '2026-11-23T00:00:00.000Z' });
          register(EXTRA);
          const writes = liveAgents({
            [CODEV]: { architects: ['main'] },
            [CLOUD]: { architects: ['main'] },
            [EXTRA]: { architects: ['main'] },
          });

          // The name keeps reaching the workspace that holds it.
          expect((await send('extra:architect', 'architect:main')).body).toMatchObject({ ok: true, delivered: true });
          expect(allRows().map((r) => r.workspace_path)).toEqual([CLOUD]);
          expect(writes['extra/main']).not.toHaveBeenCalled();

          // With the holder stopped the address fails: it is never delivered to the newcomer,
          // which is reported as needing a name of its own.
          liveAgents({ [CODEV]: { architects: ['main'] }, [EXTRA]: { architects: ['main'] } });
          const stopped = await send('extra:architect', 'architect:main');
          expect(stopped.status).toBe(404);
          expect(stopped.body.message).toContain(`Workspace 'extra' (${CLOUD}) is not running.`);
          expect(stopped.body.message).toContain(EXTRA);
          expect(stopped.body.message).toContain('a name of its own');
          expect(allRows()).toHaveLength(1);

          // Given one, the newcomer is reached by it.
          expect((await setName(EXTRA, 'extra-2')).status).toBe(200);
          expect((await send('extra-2:architect', 'architect:main')).body).toMatchObject({ ok: true, resolvedTo: 'main' });
          expect(allRows().map((r) => r.workspace_path)).toEqual([CLOUD, EXTRA]);
        });

        it('a workspace whose basename has a space is still reached by its local address', async () => {
          const NOTES = path.join(root, 'My Notes');
          fs.mkdirSync(NOTES);
          setArchitectByName(NOTES, 'main', { name: 'main', cmd: 'claude', startedAt: '2026-11-23T00:00:00.000Z' });
          register(NOTES);
          liveAgents({ [CODEV]: { architects: ['main'] }, [NOTES]: { architects: ['main'] } });

          const { status, body } = await send('My Notes:architect', 'architect:main');
          expect(status).toBe(200);
          expect(body).toMatchObject({ ok: true, resolvedTo: 'main' });
          expect(allRows().map((r) => r.workspace_path)).toEqual([NOTES]);
        });

        it('a builder reaches its own architect with its workspace\'s explicit name in front', async () => {
          await setName(CODEV, 'core');
          const own = await send('core:architect:review', BUILDER);
          expect(own.body).toMatchObject({ ok: true, resolvedTo: 'review' });
          // Affinity too: `core:architect` from the builder is its spawning architect, not `main`.
          expect((await send('core:architect', BUILDER)).body).toMatchObject({ ok: true, resolvedTo: 'review' });
          expect(allRows().map((r) => [r.workspace_path, r.to_agent])).toEqual([[CODEV, 'review'], [CODEV, 'review']]);
        });
      });
    });

    describe('interrupt honours the per-harness write strategy (Issue #1567)', () => {
      const LONG = 'u'.repeat(300); // over BRACKET_MIN_BYTES → the bracketed/chunked path

      async function interruptTo(command: string): Promise<string[]> {
        mockParseJsonBody.mockResolvedValue({
          to: 'architect', message: LONG, workspace: '/tmp/ws', options: { interrupt: true },
        });
        mockResolveTarget.mockReturnValue({ terminalId: 'term-001', workspacePath: '/tmp/ws', agent: 'architect' });
        const mockWrite = vi.fn();
        mockGetTerminalManager.mockReturnValue({
          getSession: () => ({ ...gateSession(mockWrite, '❯ '), command }),
          listSessions: () => [],
        });
        const { res, statusCode } = makeRes();
        await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
        expect(statusCode()).toBe(200);
        await vi.waitFor(() => expect(mockWrite.mock.calls.at(-1)?.[0]).toBe('\r'));
        return mockWrite.mock.calls.map((c) => c[0] as string);
      }

      it('a long interrupt to claude is bracketed like a gated delivery', async () => {
        const writes = await interruptTo('claude');
        expect(writes[0]).toBe('\x03');
        expect(writes.some((w) => w.startsWith(PASTE_BEGIN))).toBe(true);
      });

      it('a long interrupt to agy (opted out) is chunked but NOT bracketed', async () => {
        const writes = await interruptTo('agy');
        expect(writes[0]).toBe('\x03');
        expect(writes.some((w) => w.includes(PASTE_BEGIN) || w.includes(PASTE_END))).toBe(false);
        expect(writes.slice(1, -1).join('')).toContain(LONG);
      });
    });

    it('writes the message as one un-split write, Enter separate (Bugfix #481, via the gate)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res } = makeRes();

      await handleRequest(req, res, ctx);
      // The delivery awaits the paced write's completion, so both the message and
      // its trailing Enter have landed: the message is ONE un-split write, and the
      // Enter is a separate `\r` (Bugfix #481: never fused, never split mid-message).
      const writeCalls = mockWrite.mock.calls;
      expect(writeCalls[0][0]).toContain('hello');
      expect(writeCalls[0][0]).not.toContain('\r');
      expect(writeCalls[writeCalls.length - 1][0]).toBe('\r');
    });

    it('writes the message without Enter when noEnter is set (Bugfix #481)', async () => {
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
        getSession: () => gateSession(mockWrite, '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res } = makeRes();

      await handleRequest(req, res, ctx);
      const writeCalls = mockWrite.mock.calls;
      expect(writeCalls.length).toBe(1); // message only — no trailing Enter write
      expect(writeCalls[0][0]).not.toMatch(/\r$/);
    });

    it('delivers when the composer renders a clean empty prompt (Spec 1313 gate)', async () => {
      // The pre-1313 idle/composing heuristics are gone; the render-gate is the
      // sole authority. A clean, verified-empty composer delivers immediately.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.delivered).toBe(true);
      expect(parsed.deferred).toBe(false);
      // Issue #1584: the terminal double echoes what is written to it, so the delivery is
      // CONFIRMED and the sender is told so.
      expect(parsed.verified).toBe(true);
      // Message SHOULD be written — user is idle (Bugfix #492)
      expect(mockWrite).toHaveBeenCalled();
    });

    it('reports verified:false for a terminal that swallows the write (Issue #1584)', async () => {
      // The #1583 loop: the write completes, the terminal never shows the header. Tower used to
      // re-hold the row, and every later clean-prompt pass re-wrote the whole message. It is now
      // recorded as delivered and the sender is told it could not be confirmed.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-swallow', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      // Same double, minus the echo: every byte is accepted, nothing reaches the mirror.
      const swallowing = {
        ...gateSession(mockWrite, '❯ ', true, 'term-swallow'),
        write: (data: string): boolean => { mockWrite(data); return true; },
      };
      mockGetTerminalManager.mockReturnValue({ getSession: () => swallowing, listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.delivered).toBe(true);
      expect(parsed.held).toBe(false);
      expect(parsed.verified).toBe(false);
      expect(mockWrite).toHaveBeenCalled();
    }, 10_000);

    // ------------------------------------------------------------------
    // `unverifiedCause` on the /api/send response (Issue #1473)
    //
    // The SENDER's boundary, and the reason the field exists at all. `verified` alone did not
    // serve the case that motivated it — a human's Enter submitting our half-written body — 
    // because there the header DID land, so `verified` is true and the operator read a plain
    // "Message delivered". Without these two tests the whole route→SDK→CLI plumbing could be
    // deleted and the suite would stay green.
    // ------------------------------------------------------------------

    it("propagates unverifiedCause 'no-echo' to the sender when the header never appeared", async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hi', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-swallow2', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      const swallowing = {
        ...gateSession(mockWrite, '❯ ', true, 'term-swallow2'),
        write: (data: string): boolean => { mockWrite(data); return true; },
      };
      mockGetTerminalManager.mockReturnValue({ getSession: () => swallowing, listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.delivered).toBe(true);
      expect(parsed.unverifiedCause).toBe('no-echo');
    }, 10_000);

    it("propagates unverifiedCause 'input-raced' even though the header DID land", async () => {
      // The motivating case. The session echoes normally — so `verified` is true and nothing
      // else on this response says anything is wrong — but a keystroke lands DURING the paced
      // write. That is the delivery an operator must be told about, and it is invisible without
      // this field.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hi', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-raced', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      const base = gateSession(mockWrite, '❯ ', true, 'term-raced');
      const raced = {
        ...base,
        // A human typing while our bytes go out: the counter moves between the write's own
        // before/after samples. Mutating on write is the only faithful model — the race is
        // defined by the counter changing across the write, not by its value.
        write: (data: string): boolean => { raced.inputSeq += 1; return base.write(data); },
      };
      mockGetTerminalManager.mockReturnValue({ getSession: () => raced, listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.delivered).toBe(true);
      expect(parsed.unverifiedCause).toBe('input-raced');
    }, 10_000);

    it('omits unverifiedCause entirely on an ordinary clean delivery', async () => {
      // The field is additive: absent must read exactly as it did before it existed, so a
      // sender that never races never sees a new key.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hi', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-clean', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ ', true, 'term-clean'),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.delivered).toBe(true);
      expect(parsed).not.toHaveProperty('unverifiedCause');
    }, 10_000);

    it('a body-bearing interrupt that crosses the wait ceiling reports degraded (Issue #1365)', async () => {
      // codex review of PR #1492: the interrupt claims its mailbox row `delivered` BEFORE the
      // write (un-claiming would risk a double delivery), so if the ceiling expires and the
      // write goes out unserialized — possibly interleaving with the delivery it skipped — an
      // unqualified `delivered: true` would be a lie of omission. The response must say so.
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'urgent', workspace: '/tmp/ws', options: { interrupt: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-ceiling', workspacePath: '/tmp/ws', agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ ', true, 'term-ceiling'),
        listSessions: () => [],
      });

      // Occupy the terminal with a DELIVERY write long enough to outlast the ceiling. A
      // delivery is the only thing the ceiling is allowed to bypass.
      const holder = trySubmitToSession('term-ceiling', () => 4000);

      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.delivered).toBe(true); // claim-first is preserved...
      expect(parsed.degraded).toBe(true); // ...but the sender is told it was not serialized
      expect(parsed.degradedReason).toBe('submit-wait-ceiling-expired');
      expect(mockWrite).toHaveBeenCalled(); // the escape hatch still landed
      await holder;
    }, 10_000);
  });

  // ==========================================================================
  // POST /api/terminals/:id/write — the raw write route feeds the input signal
  //
  // The route is a FOREIGN writer: the dashboard, the VS Code terminal and any script hit it,
  // and its bytes must count as human input at the delivery gate. That works only because
  // `session.write()` defaults to `origin: 'external'` and the route passes no override — an
  // invisible coupling, one word wide. Someone "tidying" the call to `write(data, 'delivery')`
  // would silently reopen the race for every non-WebSocket client while every gate test kept
  // passing, because the gate tests supply their own sessions.
  //
  // These use a REAL PtySession on a shellper double, so the assertion is about the production
  // recording path rather than about a fake's bookkeeping.
  // ==========================================================================

  describe('POST /api/terminals/:id/write (Issue #1473 input signal)', () => {
    function realSession(id: string): { session: PtySession; ptyWrites: string[] } {
      const ptyWrites: string[] = [];
      const client = new EventEmitter() as unknown as IShellperClient;
      Object.defineProperty(client, 'lastDataAt', { get: () => Date.now() });
      Object.defineProperty(client, 'connected', { get: () => true });
      (client as { write: (d: string) => boolean }).write = (d: string) => { ptyWrites.push(d); return true; };
      (client as { resize: () => boolean }).resize = () => true;
      const session = new PtySession({
        id, command: '', args: [], cols: 80, rows: 24, cwd: '/tmp', env: {},
        label: 'test', logDir: '/tmp', diskLogEnabled: false,
      });
      session.attachShellper(client, Buffer.alloc(0), 1234);
      return { session, ptyWrites };
    }

    async function writeVia(session: PtySession, data: string): Promise<number> {
      mockParseJsonBody.mockResolvedValue({ data });
      mockGetTerminalManager.mockReturnValue({ getSession: () => session, listSessions: () => [] });
      const { res, statusCode } = makeRes();
      await handleRequest(makeReq('POST', `/api/terminals/${session.id}/write`), res, makeCtx());
      return statusCode();
    }

    it('advances the input signal for a keystroke sent through the route', async () => {
      const { session } = realSession('raw-write-1');
      const before = session.inputSeq;

      expect(await writeVia(session, 'hello')).toBe(200);

      expect(session.inputSeq).toBe(before + 5);
      expect(session.lastInputAt).toBeGreaterThan(0);
    });

    it('does NOT advance it for a terminal reply sent through the route, but still writes it to the PTY', async () => {
      // The self-trip this whole filter exists to prevent, exercised at the route rather than at
      // `write()`: a client answering the TUI's DA query must not read as a human at the
      // keyboard — while the PTY must still receive the answer, or the app blocks forever.
      const { session, ptyWrites } = realSession('raw-write-2');
      const before = session.inputSeq;

      expect(await writeVia(session, '\x1b[?1;2c')).toBe(200);

      expect(session.inputSeq).toBe(before);
      expect(ptyWrites).toContain('\x1b[?1;2c');
    });

    it('keeps only the human residue of a mixed chunk', async () => {
      const { session, ptyWrites } = realSession('raw-write-3');
      const before = session.inputSeq;

      expect(await writeVia(session, 'a\x1b[12;40Rb')).toBe(200);

      expect(session.inputSeq).toBe(before + 2); // 'a' and 'b'; the CPR reply is not input
      expect(ptyWrites).toContain('a\x1b[12;40Rb'); // …and the PTY still saw all of it
    });
  });

  // ==========================================================================
  // POST /api/send — durable `--delay` (Spec 1313 round 3, changes 1 & 2)
  //
  // Change 1: a delayed send is RESOLVED, authorized, and PERSISTED at request time
  // with `not_before`, then deferred through the gate — uniform across live / offline
  // (registry-only) / unwritable targets, and durable across a Tower restart. Change 2:
  // a delayed `--interrupt` writes NO body here and marks nothing delivered; it keeps only
  // an in-memory timer for the ^C, guarded by `isStillLive` before AND inside the lock.
  // ==========================================================================
  describe('POST /api/send — durable --delay (Spec 1313 round 3)', () => {
    it('persists a scheduled row for a --delay to an offline (registry-only) agent and writes nothing now', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'spir-9', message: 'later', workspace: '/tmp/ws', options: { deliverAfter: 30 },
      });
      // No live terminal, but the registry knows the builder → a delayed send schedules against it.
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      const before = Date.now();
      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.scheduled).toBe(true);
      expect(parsed.resolvedTo).toBe('spir-9');
      expect(typeof parsed.mailboxId).toBe('string');
      expect(parsed.notBefore).toBeGreaterThanOrEqual(before + 30_000);
      expect(mockWrite).not.toHaveBeenCalled(); // deferred — nothing on the wire at request time

      // The row is really persisted with its due time, and is NOT eligible until due.
      const row = mailbox.getById(sendDbHolder.db, parsed.mailboxId);
      expect(row?.status).toBe('held');
      expect(row?.not_before).toBe(parsed.notBefore);
      expect(row?.terminal_id).toBeNull(); // registry-only target → no live terminal id
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9', parsed.notBefore - 1)).toHaveLength(0);
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9', parsed.notBefore)).toHaveLength(1);
    });

    it('schedules a --delay to a live target at request time without writing (durable, deferred to the gate)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'later', workspace: '/tmp/ws', options: { deliverAfter: 10 },
      });
      mockResolveTarget.mockReturnValue({ terminalId: 'term-live', workspacePath: '/tmp/ws', agent: 'architect' });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.scheduled).toBe(true);
      expect(typeof parsed.mailboxId).toBe('string');
      expect(mockWrite).not.toHaveBeenCalled(); // delivery is deferred to the gated drainer at due time
      expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.not_before).toBe(parsed.notBefore);
    });

    describe('delayed --interrupt: the ^C timer is guarded by isStillLive (change 2)', () => {
      afterEach(() => {
        shutdownDelayedSends();
        resetSubmissionChains();
        vi.useRealTimers();
      });

      it('Tower shutdown BEFORE the due time fires no ^C and marks nothing delivered (outer guard)', async () => {
        vi.useFakeTimers();
        mockParseJsonBody.mockResolvedValue({
          to: 'architect', message: 'urgent', workspace: '/tmp/ws', options: { interrupt: true, deliverAfter: 5 },
        });
        mockResolveTarget.mockReturnValue({ terminalId: 'term-i', workspacePath: '/tmp/ws', agent: 'architect' });
        const mockWrite = vi.fn();
        mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
        const req = makeReq('POST', '/api/send');
        const { res, statusCode, body } = makeRes();

        await handleRequest(req, res, makeCtx());
        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.scheduled).toBe(true);
        expect(mockWrite).not.toHaveBeenCalled(); // nothing written at request time (change 2)

        shutdownDelayedSends();                 // Tower restarts while the ^C timer is pending
        await vi.advanceTimersByTimeAsync(5000); // the due time arrives on the (now dead) timer

        expect(mockWrite).not.toHaveBeenCalled(); // no ^C — the guard bailed; only the nudge is lost
        expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.status).toBe('held'); // never falsely delivered
      });

      it('Tower shutdown WHILE the submission lock is held fires no ^C (inner re-check)', async () => {
        vi.useFakeTimers();
        // Pre-occupy term-i's submission lock with a manually-released promise, so the ^C
        // submission chains BEHIND it — reproducing the shutdown-during-lock-wait window.
        let releaseLock!: () => void;
        const lockHeld = new Promise<void>((r) => { releaseLock = r; });
        submitToSession('term-i', () => 1, { sleep: () => lockHeld });

        mockParseJsonBody.mockResolvedValue({
          to: 'architect', message: 'urgent', workspace: '/tmp/ws', options: { interrupt: true, deliverAfter: 5 },
        });
        mockResolveTarget.mockReturnValue({ terminalId: 'term-i', workspacePath: '/tmp/ws', agent: 'architect' });
        const mockWrite = vi.fn();
        mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
        const req = makeReq('POST', '/api/send');
        const { res, body } = makeRes();

        await handleRequest(req, res, makeCtx());
        const parsed = JSON.parse(body());

        // Due time: the ^C timer fires while still live → its outer check passes and it QUEUES
        // the ^C submission behind the held lock (which has not released yet).
        await vi.advanceTimersByTimeAsync(5000);
        expect(mockWrite).not.toHaveBeenCalled(); // still waiting for the lock

        // Now Tower shuts down (generation bump) DURING the lock-wait, then the lock drains.
        shutdownDelayedSends();
        releaseLock();
        for (let i = 0; i < 20; i++) await Promise.resolve(); // flush the queued submission

        expect(mockWrite).not.toHaveBeenCalled(); // the inside-the-lock isStillLive() re-check bailed
        expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.status).toBe('held'); // not falsely delivered
      });
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

  // =========================================================================
  // Spec 1658 Phase 6: Windows shell roles (Area F) and client POSIX shells
  // =========================================================================

  describe('Windows shell roles (Spec 1658)', () => {
    const GIT_BASH = {
      path: 'C:\\Program Files\\Git\\bin\\bash.exe',
      root: 'C:\\Program Files\\Git',
      gitVersion: 'git version 2.47.1.windows.1',
      source: 'install' as const,
    };
    let workspace: string;
    let createSession: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-shell-'));
      createSession = vi.fn(async (req: { command?: string }) => ({ id: 'term-new', pid: 77, label: 'Shell 1', command: req.command }));
      mockGetTerminalManager.mockReturnValue({ createSession, listSessions: mockListSessions, getSession: mockGetSession });
      mockGetNextShellId.mockReturnValue('shell-1');
      setGitBashForTests(GIT_BASH);
    });

    afterEach(() => {
      setGitBashForTests(null);
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    function writeShellConfig(shell: string): void {
      fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify({ shell: { shell } }));
    }

    async function createShell(): Promise<void> {
      const encoded = Buffer.from(workspace).toString('base64url');
      const { res, statusCode } = makeRes();
      await handleRequest(makeReq('POST', `/workspace/${encoded}/api/tabs/shell`), res, makeCtx());
      expect(statusCode()).toBe(200);
    }

    it('a new dashboard shell opens Windows PowerShell by default', async () => {
      forceHostPlatform('win32');
      // A user-global ~/.codev/config.json may set shell.shell; keep the test hermetic.
      const previousHome = process.env.HOME;
      process.env.HOME = workspace;
      try {
        await createShell();
      } finally {
        process.env.HOME = previousHome;
      }
      const req = createSession.mock.calls[0][0];
      expect(req.command).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      expect(req.args).toEqual(['-NoLogo']);
    });

    it('an existing shell.shell "bash" opens Git Bash, never System32 bash.exe', async () => {
      forceHostPlatform('win32');
      writeShellConfig('bash');
      await createShell();
      const req = createSession.mock.calls[0][0];
      expect(req.command).toBe(GIT_BASH.path);
      expect(req.args).toEqual(['-i']);
    });

    it('POSIX keeps $SHELL with no arguments', async () => {
      forceHostPlatform('darwin');
      const previous = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      try {
        await createShell();
      } finally {
        process.env.SHELL = previous;
      }
      const req = createSession.mock.calls[0][0];
      expect(req.command).toBe('/bin/zsh');
      expect(req.args).toEqual([]);
    });

    it('a client /bin/sh -lc terminal runs in Git Bash -c on Windows', async () => {
      forceHostPlatform('win32');
      mockParseJsonBody.mockResolvedValueOnce({ command: '/bin/sh', args: ['-lc', 'pnpm dev'], cwd: 'C:\\ws', type: 'dev' });
      const { res, statusCode } = makeRes();
      await handleRequest(makeReq('POST', '/api/terminals'), res, makeCtx());
      expect(statusCode()).toBeLessThan(300);
      expect(createSession.mock.calls[0][0]).toMatchObject({ command: GIT_BASH.path, args: ['-c', 'pnpm dev'] });
    });

    it('the same request is untouched on POSIX', async () => {
      forceHostPlatform('linux');
      mockParseJsonBody.mockResolvedValueOnce({ command: '/bin/sh', args: ['-lc', 'pnpm dev'], cwd: '/ws', type: 'dev' });
      const { res } = makeRes();
      await handleRequest(makeReq('POST', '/api/terminals'), res, makeCtx());
      expect(createSession.mock.calls[0][0]).toMatchObject({ command: '/bin/sh', args: ['-lc', 'pnpm dev'] });
    });
  });
});
