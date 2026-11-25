/**
 * Issue #1901 — `afx status --json` tells a busy Tower from a down one.
 *
 * `tower.running` stays as it was (false for both, so existing scripts read the same). `state`
 * says which (`running`, `not-running`, `unresponsive`), and `error` says why an unresponsive
 * Tower did not answer, null otherwise: the file's nullable-not-optional contract.
 *
 * Mocking harness mirrors status-fleet-observability.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockProbe = vi.fn();

vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceRoot: '/fake/workspace' })),
}));
vi.mock('../state.js', () => ({
  loadState: () => ({ architect: null, architects: [], builders: [], utils: [], annotations: [] }),
}));
vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    probeHealth: (...a: unknown[]) => mockProbe(...a),
    getHealth: async () => ({ status: 'healthy', uptime: 1, activeWorkspaces: 0, memoryUsage: 0 }),
    getWorkspaceStatus: async () => null,
    getOverview: async () => null,
  }),
}));
vi.mock('../../lib/config.js', () => ({ loadConfig: vi.fn(() => ({})) }));
vi.mock('../utils/logger.js', () => ({
  logger: { header: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), kv: vi.fn(), blank: vi.fn(), row: vi.fn() },
  fatal: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
}));

import { status } from '../commands/status.js';

describe('afx status --json: busy apart from down (#1901)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockProbe.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  async function towerField(): Promise<unknown> {
    await status({ json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(String(logSpy.mock.calls[0][0])).tower;
  }

  it('reports an unresponsive Tower with its reason', async () => {
    mockProbe.mockResolvedValue({ state: 'unresponsive', error: 'Request timeout' });
    expect(await towerField()).toEqual({ running: false, state: 'unresponsive', error: 'Request timeout' });
  });

  it('reports a down Tower as not-running, error null (present, not omitted)', async () => {
    mockProbe.mockResolvedValue({ state: 'not-running' });
    const tower = await towerField();
    expect(tower).toEqual({ running: false, state: 'not-running', error: null });
    expect(Object.prototype.hasOwnProperty.call(tower, 'error')).toBe(true);
  });

  it('reports a running Tower as before, with state running', async () => {
    mockProbe.mockResolvedValue({ state: 'running' });
    expect(await towerField()).toEqual({ running: true, state: 'running', error: null });
  });
});
