/**
 * Issue #1227: `afx status` surfaces fleet RSS + unregistered-shellper count
 * from Tower's /health payload — human mode (`Fleet RSS`/`Unregistered
 * Shellpers` kv lines) and `--json` mode (`fleet` field).
 *
 * Mirrors the mocking harness from status-naming.test.ts / spec-1057-status-owner.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockLoadState = vi.fn();
const mockIsRunning = vi.fn();
const mockGetHealth = vi.fn();
const mockGetWorkspaceStatus = vi.fn();
const mockLoggerKv = vi.fn();

vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceRoot: '/fake/workspace' })),
}));

vi.mock('../state.js', () => ({
  loadState: (...args: any[]) => mockLoadState(...args),
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    isRunning: (...a: any[]) => mockIsRunning(...a),
    getHealth: (...a: any[]) => mockGetHealth(...a),
    getWorkspaceStatus: (...a: any[]) => mockGetWorkspaceStatus(...a),
  }),
}));

vi.mock('../../lib/config.js', () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    kv: (...args: any[]) => mockLoggerKv(...args),
    blank: vi.fn(),
    row: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { status } from '../commands/status.js';

describe('afx status — fleet observability (Issue #1227)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadState.mockReturnValue({ architect: null, architects: [], builders: [], utils: [], annotations: [] });
  });

  describe('human mode', () => {
    beforeEach(() => {
      mockIsRunning.mockResolvedValue(true);
      mockGetWorkspaceStatus.mockResolvedValue(null);
    });

    it('shows Fleet RSS and Unregistered Shellpers when Tower reports them', async () => {
      mockGetHealth.mockResolvedValue({
        uptime: 100, activeWorkspaces: 1, memoryUsage: 50 * 1024 * 1024,
        fleetRssKb: 2_048_000, unregisteredShellperCount: 3,
      });

      await status();

      const kvCalls = mockLoggerKv.mock.calls;
      expect(kvCalls).toContainEqual(['  Fleet RSS', '2000MB']);
      const unregisteredCall = kvCalls.find((c: any[]) => c[0] === '  Unregistered Shellpers');
      expect(unregisteredCall).toBeDefined();
      expect(String(unregisteredCall![1])).toContain('3');
    });

    it('omits the fleet lines when the running Tower predates these fields', async () => {
      mockGetHealth.mockResolvedValue({ uptime: 100, activeWorkspaces: 1, memoryUsage: 50 * 1024 * 1024 });

      await status();

      const kvKeys = mockLoggerKv.mock.calls.map((c: any[]) => c[0]);
      expect(kvKeys).not.toContain('  Fleet RSS');
      expect(kvKeys).not.toContain('  Unregistered Shellpers');
    });
  });

  describe('--json mode', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    function parsePayload() {
      expect(logSpy).toHaveBeenCalledTimes(1);
      return JSON.parse(String(logSpy.mock.calls[0][0]));
    }

    it('carries fleet rssKb/unregisteredShellperCount from health when Tower is running', async () => {
      mockIsRunning.mockResolvedValue(true);
      mockGetWorkspaceStatus.mockResolvedValue(null);
      mockGetHealth.mockResolvedValue({
        uptime: 100, activeWorkspaces: 1, memoryUsage: 1024,
        fleetRssKb: 512_000, unregisteredShellperCount: 2,
      });

      await status({ json: true });

      const payload = parsePayload();
      expect(payload.fleet).toEqual({ rssKb: 512_000, unregisteredShellperCount: 2 });
    });

    it('emits explicit nulls (not omitted keys) when Tower is not running', async () => {
      mockIsRunning.mockResolvedValue(false);

      await status({ json: true });

      const payload = parsePayload();
      expect(Object.prototype.hasOwnProperty.call(payload.fleet, 'rssKb')).toBe(true);
      expect(payload.fleet).toEqual({ rssKb: null, unregisteredShellperCount: null });
    });
  });
});
