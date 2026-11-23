/**
 * Issue #1950 — `afx spawn --max-load <n> [--wait <seconds>]`.
 *
 * Over the limit, spawn exits 75 before anything is created. The gate is exercised with an
 * injected clock and load reader; the CLI case proves the spawn command is never reached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forceHostPlatform } from '../../__tests__/helpers/host-platform.js';

const mockSpawn = vi.fn();
vi.mock('../commands/spawn.js', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a) }));

const loadavgMock = vi.fn(() => [0.5, 0.5, 0.5]);
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, loadavg: () => loadavgMock(), default: { ...actual, loadavg: () => loadavgMock() } };
});

vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  const silent = Object.fromEntries(Object.keys(actual.logger).map((k) => [k, vi.fn()]));
  return { ...actual, logger: silent };
});

import { checkLoad, LOAD_REFUSED_EXIT, LOAD_RECHECK_MS, type LoadGateDeps } from '../utils/load-gate.js';
import { runAgentFarm } from '../cli.js';
import { logger } from '../utils/logger.js';

/** A fake clock: each sleep advances it; the load reader replays `loads`, then repeats the last. */
function fake(loads: number[]): LoadGateDeps & { sleeps: number[] } {
  let t = 0;
  let i = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    oneMinuteLoad: () => loads[Math.min(i++, loads.length - 1)],
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
  };
}

describe('afx spawn --max-load (#1950)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes under the limit', async () => {
    expect(await checkLoad('8', undefined, fake([3.2]))).toEqual({ ok: true });
  });

  it('refuses at or above the limit with exit 75, giving the load and the limit', async () => {
    const deps = fake([8]);
    const verdict = await checkLoad('8', undefined, deps);
    expect(verdict).toEqual({
      ok: false,
      exitCode: LOAD_REFUSED_EXIT,
      message: 'One-minute load average is 8.00, at or above --max-load 8. Nothing was created.',
    });
    expect(LOAD_REFUSED_EXIT).toBe(75);
    expect(deps.sleeps).toEqual([]);
  });

  it('--wait re-reads every 15s and spawns once the load drops', async () => {
    const deps = fake([12, 11, 4]);
    expect(await checkLoad('8', '60', deps)).toEqual({ ok: true });
    expect(deps.sleeps).toEqual([LOAD_RECHECK_MS, LOAD_RECHECK_MS]);
  });

  it('--wait gives up after the window, with a last read at the deadline', async () => {
    const deps = fake([12]);
    const verdict = await checkLoad('8', '40', deps);
    expect(verdict).toMatchObject({ ok: false, exitCode: 75 });
    expect((verdict as { message: string }).message).toContain('after waiting 40s');
    expect(deps.sleeps).toEqual([15_000, 15_000, 10_000]);
  });

  it('fails loudly as unsupported on Windows, which reports no load average', async () => {
    forceHostPlatform('win32');
    const verdict = await checkLoad('8', undefined, fake([0]));
    expect(verdict).toMatchObject({ ok: false, exitCode: 1 });
    expect((verdict as { message: string }).message).toContain('not supported on Windows');
  });

  it.each([
    ['0', undefined, '--max-load'],
    ['abc', undefined, '--max-load'],
    ['8', '-5', '--wait'],
    [undefined, '30', '--wait requires --max-load'],
  ])('rejects --max-load %s --wait %s', async (max, wait, text) => {
    const verdict = await checkLoad(max, wait, fake([1]));
    expect(verdict).toMatchObject({ ok: false, exitCode: 1 });
    expect((verdict as { message: string }).message).toContain(text);
  });

  describe('through the CLI', () => {
    it.skipIf(process.platform === 'win32')('over the limit: exits 75 and never reaches spawn', async () => {
      loadavgMock.mockReturnValue([20, 10, 5]);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('__exit__'); }) as never);
      await expect(runAgentFarm(['spawn', '1950', '--protocol', 'air', '--max-load', '18'])).rejects.toThrow('__exit__');
      expect(exit).toHaveBeenCalledWith(75);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error).mock.calls[0][0]).toContain('load average is 20.00, at or above --max-load 18');
      exit.mockRestore();
    });

    it.skipIf(process.platform === 'win32')('under the limit: spawns', async () => {
      loadavgMock.mockReturnValue([2, 2, 2]);
      await runAgentFarm(['spawn', '1950', '--protocol', 'air', '--max-load', '18']);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });
});
