/**
 * Issue #1977 — the liveness route every CLI command probes before it talks to Tower.
 *
 * `/health` builds the instance list, runs a process census and reads global.db on every call,
 * and since #1901 every command probes Tower first, up to twice when the machine is busy: the
 * probe added load to the Tower it was asking about. `/health/live` must do none of that work.
 *
 * Real Tower request handler behind a real HTTP server, real auth gate, real SDK client with no
 * key; the heavy functions are spies, and `/health` on the same Tower shows they are wired.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TOWER_LIVENESS_ROUTE } from '@cluesmith/codev-types';
import { TowerClient, TOWER_LIVENESS_ROUTE as SDK_TOWER_LIVENESS_ROUTE } from '@cluesmith/codev-sdk/tower-client';
import type { RouteContext } from '../servers/tower-routes.js';

const heavy = vi.hoisted(() => ({
  getInstances: vi.fn(async () => [{ running: true, workspacePath: '/a' }]),
  listProcessCensus: vi.fn(async () => []),
  getGlobalDb: vi.fn(() => ({})),
  computeRegisteredShellperPids: vi.fn(async () => new Set<number>()),
  isStartupReconcileSettled: vi.fn(() => true),
}));

vi.mock('../servers/tower-instances.js', () => ({
  getInstances: heavy.getInstances,
  getKnownWorkspacePaths: vi.fn(() => []),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(),
  killTerminalWithShellper: vi.fn(),
  stopInstance: vi.fn(),
  addArchitect: vi.fn(),
}));
vi.mock('../servers/process-census.js', () => ({ listProcessCensus: heavy.listProcessCensus }));
vi.mock('../db/index.js', async (importActual) => ({
  ...(await importActual<typeof import('../db/index.js')>()),
  getGlobalDb: heavy.getGlobalDb,
}));
vi.mock('../servers/shellper-husk-sweep.js', async (importActual) => ({
  ...(await importActual<typeof import('../servers/shellper-husk-sweep.js')>()),
  computeRegisteredShellperPids: heavy.computeRegisteredShellperPids,
}));
vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: vi.fn(),
  getWorkspaceTerminalsEntry: vi.fn(),
  getNextShellId: vi.fn(),
  saveTerminalSession: vi.fn(),
  isSessionPersistent: vi.fn(),
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  deleteFileTab: vi.fn(),
  getTerminalsForWorkspace: vi.fn(),
  getRehydratedTerminalsEntry: vi.fn(),
  isStartupReconcileSettled: heavy.isStartupReconcileSettled,
}));
vi.mock('../servers/tower-tunnel.js', () => ({ handleTunnelEndpoint: vi.fn() }));
vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = vi.fn();
    invalidate = vi.fn();
  },
}));

const { handleRequest } = await import('../servers/tower-routes.js');
const { GLOBAL_CURRENT_VERSION } = await import('../db/index.js');

const ctx: RouteContext = {
  log: vi.fn(),
  port: 4100,
  version: '9.8.7',
  startedAt: '2026-11-26T00:00:00.000Z',
  templatePath: null,
  reactDashboardPath: '/tmp/dashboard/dist',
  hasReactDashboard: false,
  // A live shellper manager, so `/health` takes its full path (census and DB read included).
  getShellperManager: () => ({ socketDir: '/tmp/air-1977-sockets' }) as unknown as ReturnType<RouteContext['getShellperManager']>,
  broadcastNotification: vi.fn(),
  addSseClient: vi.fn(() => true),
  removeSseClient: vi.fn(),
};

describe('GET /health/live (#1977)', () => {
  let server: http.Server;
  let port: number;
  /** A client with no key: the route is public, like `/health`. */
  const client = () => new TowerClient({ host: '127.0.0.1', port, getAuthKey: () => null });

  beforeAll(async () => {
    server = http.createServer((req, res) => void handleRequest(req, res, ctx));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is the route the SDK probes', () => {
    expect(SDK_TOWER_LIVENESS_ROUTE).toBe(TOWER_LIVENESS_ROUTE);
  });

  it("answers with Tower's version and schema version, keyless", async () => {
    const response = await fetch(`http://127.0.0.1:${port}${TOWER_LIVENESS_ROUTE}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'healthy',
      version: '9.8.7',
      startedAt: '2026-11-26T00:00:00.000Z',
      schemaVersion: GLOBAL_CURRENT_VERSION,
    });
  });

  it('builds no instance list, runs no process census and reads no database', async () => {
    expect((await client().probeHealth()).state).toBe('running');

    expect(heavy.getInstances).not.toHaveBeenCalled();
    expect(heavy.listProcessCensus).not.toHaveBeenCalled();
    expect(heavy.getGlobalDb).not.toHaveBeenCalled();
    expect(heavy.computeRegisteredShellperPids).not.toHaveBeenCalled();
    expect(heavy.isStartupReconcileSettled).not.toHaveBeenCalled();
  });

  it('while /health on the same Tower still does all of that, for status and the dashboard', async () => {
    const health = await client().getHealth();
    expect(health).toMatchObject({ status: 'healthy', activeWorkspaces: 1, totalWorkspaces: 1 });

    expect(heavy.getInstances).toHaveBeenCalled();
    expect(heavy.listProcessCensus).toHaveBeenCalled();
    expect(heavy.getGlobalDb).toHaveBeenCalled();
    expect(heavy.computeRegisteredShellperPids).toHaveBeenCalled();
    expect(heavy.isStartupReconcileSettled).toHaveBeenCalled();
  });

  it("gives the probe the Tower's version", async () => {
    expect(await client().probeHealth()).toEqual({
      state: 'running',
      liveness: { status: 'healthy', version: '9.8.7', startedAt: '2026-11-26T00:00:00.000Z', schemaVersion: GLOBAL_CURRENT_VERSION },
    });
  });
});
