/**
 * Issue #1227: afx tower sweep-husks — dry-run by default, --apply to reap,
 * -y/--yes to skip the confirm() prompt, mirroring `afx workspace recover`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsRunning = vi.fn();
const mockFindHuskCandidates = vi.fn();
const mockSweepHusks = vi.fn();

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    isRunning: mockIsRunning,
    findHuskCandidates: mockFindHuskCandidates,
    sweepHusks: mockSweepHusks,
  }),
}));

const mockConfirm = vi.fn();
vi.mock('../../lib/cli-prompts.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
    row: vi.fn(),
  },
}));

async function loadModule() {
  const mod = await import('../commands/tower-sweep-husks.js');
  const { logger } = await import('../utils/logger.js');
  return { towerSweepHusks: mod.towerSweepHusks, logger: logger as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

const HUSK = { pid: 100, rssKb: 34816, ageMs: 7_200_000 };

describe('towerSweepHusks (Issue #1227)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
  });

  it('errors without calling anything else when Tower is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    const { towerSweepHusks, logger } = await loadModule();

    await towerSweepHusks({});

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Tower is not running'));
    expect(mockFindHuskCandidates).not.toHaveBeenCalled();
  });

  it('no flags: previews candidates and never calls sweepHusks', async () => {
    mockFindHuskCandidates.mockResolvedValue({ candidates: [HUSK], graceMs: 3_600_000 });
    const { towerSweepHusks, logger } = await loadModule();

    await towerSweepHusks({});

    expect(logger.row).toHaveBeenCalled();
    expect(mockSweepHusks).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('no flags, zero candidates: reports nothing found and never calls sweepHusks', async () => {
    mockFindHuskCandidates.mockResolvedValue({ candidates: [], graceMs: 3_600_000 });
    const { towerSweepHusks, logger } = await loadModule();

    await towerSweepHusks({});

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('No husk shellpers found'));
    expect(mockSweepHusks).not.toHaveBeenCalled();
  });

  it('--apply --yes: reaps without prompting', async () => {
    mockFindHuskCandidates.mockResolvedValue({ candidates: [HUSK], graceMs: 3_600_000 });
    mockSweepHusks.mockResolvedValue({ swept: 1, pids: [100] });
    const { towerSweepHusks } = await loadModule();

    await towerSweepHusks({ apply: true, yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSweepHusks).toHaveBeenCalledTimes(1);
  });

  it('--apply alone: prompts, and declining aborts with nothing killed', async () => {
    mockFindHuskCandidates.mockResolvedValue({ candidates: [HUSK], graceMs: 3_600_000 });
    mockConfirm.mockResolvedValue(false);
    const { towerSweepHusks, logger } = await loadModule();

    await towerSweepHusks({ apply: true });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSweepHusks).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Aborted'));
  });

  it('--apply alone: confirming proceeds to reap', async () => {
    mockFindHuskCandidates.mockResolvedValue({ candidates: [HUSK], graceMs: 3_600_000 });
    mockConfirm.mockResolvedValue(true);
    mockSweepHusks.mockResolvedValue({ swept: 1, pids: [100] });
    const { towerSweepHusks } = await loadModule();

    await towerSweepHusks({ apply: true });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSweepHusks).toHaveBeenCalledTimes(1);
  });
});
