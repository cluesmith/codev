/**
 * Issue #1901 — `afx workspace start` and `afx workspace stop` must not act on a Tower that is
 * busy rather than down.
 *
 * Both used to treat any failed health probe as "Tower is not running". Start then started one,
 * falling into `towerStart`'s old "zombie" branch that SIGTERMed the live Tower. Stop fell back
 * to a local cleanup ending in `clearRuntime()`, wiping the registry of builders that were still
 * running. That fallback is for a Tower that answered with an error or is not running. A Tower
 * that took the request and never answered may still be running everything, so stop aborts and
 * clears nothing: at the health probe, and again at the deactivation request itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockProbe = vi.fn();
const mockDeactivate = vi.fn();
const mockActivate = vi.fn();
const mockClearRuntime = vi.fn();
const mockTowerStart = vi.fn();

vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  getTowerClient: () => ({
    probeHealth: (...a: unknown[]) => mockProbe(...a),
    deactivateWorkspace: (...a: unknown[]) => mockDeactivate(...a),
    activateWorkspace: (...a: unknown[]) => mockActivate(...a),
    getWorkspaceUrl: () => 'http://localhost:4100/workspace/alpha/',
    killTerminal: vi.fn(),
  }),
}));
vi.mock('../commands/tower.js', () => ({ towerStart: (...a: unknown[]) => mockTowerStart(...a) }));
vi.mock('../state.js', () => ({
  loadState: () => ({ builders: [], utils: [], architects: [] }),
  clearRuntime: (...a: unknown[]) => mockClearRuntime(...a),
  getArchitects: () => [],
}));
vi.mock('../utils/config.js', () => ({ getConfig: () => ({ workspaceRoot: '/work/alpha' }) }));
vi.mock('../utils/index.js', () => ({ getConfig: () => ({ workspaceRoot: '/work/alpha' }) }));
vi.mock('../utils/shell.js', () => ({ openBrowser: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { header: vi.fn(), info: vi.fn(), success: vi.fn(), debug: vi.fn(), blank: vi.fn(), warn: vi.fn(), error: vi.fn(), kv: vi.fn() },
  fatal: (message: string) => {
    throw new Error(`FATAL: ${message}`);
  },
}));

const { start } = await import('../commands/start.js');
const { stop } = await import('../commands/stop.js');

const unresponsive = { state: 'unresponsive', route: '/health/live', error: 'Request timeout' };

beforeEach(() => {
  for (const mock of [mockProbe, mockDeactivate, mockActivate, mockClearRuntime, mockTowerStart]) mock.mockReset();
  mockActivate.mockResolvedValue({ ok: true });
});

describe('afx workspace start against a busy Tower (#1901)', () => {
  it('exits with the reason and never starts (or replaces) a Tower', async () => {
    mockProbe.mockResolvedValue(unresponsive);

    await expect(start({ noBrowser: true })).rejects.toThrow(/FATAL: Tower did not answer \/health\/live \(Request timeout\)/);
    expect(mockTowerStart).not.toHaveBeenCalled();
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('starts Tower when the connection is refused, as before', async () => {
    mockProbe.mockResolvedValue({ state: 'not-running' });

    await start({ noBrowser: true });
    expect(mockTowerStart).toHaveBeenCalledTimes(1);
    expect(mockActivate).toHaveBeenCalledWith('/work/alpha');
  });
});

describe('afx workspace stop against a busy Tower (#1901)', () => {
  it('aborts without clearing anything when the liveness probe is not answered', async () => {
    mockProbe.mockResolvedValue(unresponsive);

    await expect(stop()).rejects.toThrow(/FATAL: Tower did not answer \/health\/live \(Request timeout\)/);
    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(mockClearRuntime).not.toHaveBeenCalled();
  });

  it('aborts without clearing anything when the deactivation request is not answered', async () => {
    mockProbe.mockResolvedValue({ state: 'running' });
    mockDeactivate.mockResolvedValue({ ok: false, status: 0, error: 'Request timeout' });

    await expect(stop()).rejects.toThrow(
      'FATAL: Tower did not answer the deactivation request (Request timeout); nothing was cleared.',
    );
    expect(mockClearRuntime).not.toHaveBeenCalled();
  });

  it('still falls back to local cleanup when Tower answers with an error', async () => {
    mockProbe.mockResolvedValue({ state: 'running' });
    mockDeactivate.mockResolvedValue({ ok: false, status: 404, error: 'Workspace not found' });

    await stop();
    expect(mockClearRuntime).toHaveBeenCalledWith('/work/alpha');
  });
});
