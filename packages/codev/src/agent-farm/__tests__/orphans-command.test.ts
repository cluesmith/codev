/**
 * #1915: `afx orphans` — read-only by default; `--apply` needs an agent or
 * `--all`, lists, asks (unless -y), then ends exactly the listed processes.
 * Windows only. Also the `afx status` section and the `codev doctor` check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionOrphans } from '../lib/session-orphans-api.js';
import { forceHostPlatform } from '../../__tests__/helpers/host-platform.js';
import { resetHostPlatformForTests } from '../../lib/platform.js';

const mockIsRunning = vi.fn();
const mockListOrphans = vi.fn();
const mockEndOrphans = vi.fn();

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({ isRunning: mockIsRunning, listOrphans: mockListOrphans, endOrphans: mockEndOrphans }),
}));

const mockConfirm = vi.fn();
vi.mock('../../lib/cli-prompts.js', () => ({ confirm: mockConfirm }));

vi.mock('../utils/config.js', () => ({ getConfig: () => ({ workspaceRoot: 'C:\\repo' }) }));

vi.mock('../utils/logger.js', () => ({
  logger: { header: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), kv: vi.fn(), blank: vi.fn(), row: vi.fn() },
}));

async function load() {
  const mod = await import('../commands/orphans.js');
  const { logger } = await import('../utils/logger.js');
  return { ...mod, logger: logger as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

const NOW = Date.now();
const builder: SessionOrphans = {
  workspacePath: 'C:\\repo',
  terminalId: 't-b',
  agent: 'pir-1',
  kind: 'builder',
  job: true,
  orphans: [{ pid: 110, name: 'find.exe', createdAt: NOW - 90_000, cpuMs: 61_000, descendants: [{ pid: 111, name: 'grep.exe', createdAt: NOW - 80_000, cpuMs: 10 }] }],
};
const architect: SessionOrphans = { workspacePath: 'C:\\repo', terminalId: 't-a', agent: 'main', kind: 'architect', job: true, orphans: [] };

describe('afx orphans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceHostPlatform('win32');
    process.exitCode = undefined;
    mockIsRunning.mockResolvedValue(true);
    mockListOrphans.mockResolvedValue({ ok: true, listing: { supported: true, sessions: [builder, architect] } });
    mockEndOrphans.mockResolvedValue({ ok: true, response: { supported: true, results: [{ terminalId: 't-b', pid: 110, createdAt: 1, outcome: 'ended' }, { terminalId: 't-b', pid: 111, createdAt: 1, outcome: 'ended' }] } });
  });
  afterEach(() => {
    resetHostPlatformForTests();
    process.exitCode = undefined;
  });

  it('on macOS and Linux says it is Windows only and asks Tower nothing', async () => {
    forceHostPlatform('linux');
    const { orphans, logger, ORPHANS_NOT_WINDOWS } = await load();
    await orphans({ all: true, apply: true, yes: true });
    expect(logger.info).toHaveBeenCalledWith(ORPHANS_NOT_WINDOWS);
    expect(mockIsRunning).not.toHaveBeenCalled();
    expect(mockEndOrphans).not.toHaveBeenCalled();
  });

  it('lists without ending by default, with no command lines', async () => {
    const { orphans, logger } = await load();
    await orphans({});
    expect(mockListOrphans).toHaveBeenCalledWith('C:\\repo');
    expect(mockEndOrphans).not.toHaveBeenCalled();
    const rows = logger.row.mock.calls.map((c) => c[0] as string[]);
    expect(rows).toContainEqual(['pir-1', '110', 'find.exe', '1m', '1m1s']);
    expect(rows).toContainEqual(['', '111', '  └ grep.exe', '1m', '10ms']);
  });

  it('refuses --apply without an agent or --all, before asking Tower anything', async () => {
    const { orphans, logger } = await load();
    await orphans({ apply: true, yes: true });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('--apply needs an agent name'));
    expect(process.exitCode).toBe(1);
    expect(mockListOrphans).not.toHaveBeenCalled();
  });

  it('asks before ending; a declined prompt ends nothing', async () => {
    mockConfirm.mockResolvedValue(false);
    const { orphans } = await load();
    await orphans({ agent: 'pir-1', apply: true });
    expect(mockConfirm).toHaveBeenCalledWith('End these 2 process(es)?', false);
    expect(mockEndOrphans).not.toHaveBeenCalled();
  });

  it('ends exactly the listed processes of the named agent, with their creation times', async () => {
    mockConfirm.mockResolvedValue(true);
    const { orphans, logger } = await load();
    await orphans({ agent: 'PIR-1', apply: true });
    expect(mockEndOrphans).toHaveBeenCalledWith('C:\\repo', [
      { terminalId: 't-b', pid: 110, createdAt: builder.orphans[0].createdAt },
      { terminalId: 't-b', pid: 111, createdAt: builder.orphans[0].descendants[0].createdAt },
    ]);
    expect(logger.kv).toHaveBeenCalledWith('Ended', '2');
  });

  it('-y skips the prompt; --all covers every session', async () => {
    const { orphans } = await load();
    await orphans({ all: true, apply: true, yes: true });
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockEndOrphans).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown agent, and Tower being down', async () => {
    const { orphans, logger } = await load();
    await orphans({ agent: 'nobody' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No running session named "nobody"'));
    mockIsRunning.mockResolvedValue(false);
    await orphans({});
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Tower is not running'));
  });

  it('says so when there is nothing to end', async () => {
    mockListOrphans.mockResolvedValue({ ok: true, listing: { supported: true, sessions: [architect] } });
    const { orphans, logger } = await load();
    await orphans({ all: true, apply: true, yes: true });
    expect(logger.info).toHaveBeenCalledWith('No orphaned processes.');
    expect(mockEndOrphans).not.toHaveBeenCalled();
  });
});

describe('afx status orphan section', () => {
  afterEach(() => resetHostPlatformForTests());

  it('is absent off Windows, and reports a slow or failed listing without failing', async () => {
    const { fetchOrphanSection } = await import('../commands/status.js');
    const client = { listOrphans: vi.fn(() => new Promise(() => {})) } as never;
    forceHostPlatform('linux');
    expect(await fetchOrphanSection(client, 'C:\\repo', 10)).toBeNull();
    forceHostPlatform('win32');
    expect(await fetchOrphanSection(client, 'C:\\repo', 10)).toEqual({ error: 'no answer within 0s' });
    const failing = { listOrphans: vi.fn(async () => ({ ok: false, error: 'boom' })) } as never;
    expect(await fetchOrphanSection(failing, 'C:\\repo', 1000)).toEqual({ error: 'boom' });
    const older = {} as never; // a client without the method (older build) must not throw
    expect(await fetchOrphanSection(older, 'C:\\repo', 1000)).toMatchObject({ error: expect.any(String) });
  });

  it('prints the table only when a session has orphans or no job', async () => {
    const { renderOrphanSection } = await import('../commands/status.js');
    const { logger } = await load();
    vi.clearAllMocks();
    renderOrphanSection({ sessions: [architect] });
    expect(logger.info).not.toHaveBeenCalled();
    renderOrphanSection({ sessions: [builder, { ...architect, job: false }] });
    expect(logger.row).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('afx orphans <agent> --apply'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('main: no job'));
  });
});

describe('codev doctor orphan check', () => {
  it('skips without Tower, warns per session with orphans, else ok', async () => {
    const { checkOrphans } = await import('../../commands/doctor.js');
    expect(checkOrphans(null, 'Tower not running')).toMatchObject({ status: 'skipped', summary: 'Orphaned processes: skipped (Tower not running)' });
    expect(checkOrphans({ supported: true, sessions: [architect] }).status).toBe('ok');
    const warn = checkOrphans({ supported: true, sessions: [builder, architect] });
    expect(warn.status).toBe('warn');
    expect(warn.summary).toBe('1 orphaned process(es) in 1 Codev session(s), still running after their parent exited');
    expect(warn.details).toEqual(['pir-1 (C:\\repo): find.exe pid 110']);
    expect(warn.recommendation).toContain('afx orphans <agent> --apply');
  });
});
