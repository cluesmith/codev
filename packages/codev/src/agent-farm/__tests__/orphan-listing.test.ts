/**
 * #1915: the read-only orphan listing in `afx status` and `codev doctor`
 * (Windows). Nothing ends an orphan but the end of its session.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SessionOrphans } from '../lib/session-orphans-api.js';
import { forceHostPlatform } from '../../__tests__/helpers/host-platform.js';
import { resetHostPlatformForTests } from '../../lib/platform.js';

vi.mock('../utils/logger.js', () => ({
  logger: { header: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), kv: vi.fn(), blank: vi.fn(), row: vi.fn() },
}));

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

async function logger() {
  return (await import('../utils/logger.js')).logger as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

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

  it('prints name, pid, age and CPU (never a command line) only when a session has orphans or no job', async () => {
    const { renderOrphanSection } = await import('../commands/status.js');
    const log = await logger();
    vi.clearAllMocks();
    renderOrphanSection({ sessions: [architect] }, NOW);
    expect(log.info).not.toHaveBeenCalled();
    renderOrphanSection({ sessions: [builder, { ...architect, job: false }] }, NOW);
    const rows = log.row.mock.calls.map((c) => c[0] as string[]);
    expect(rows).toContainEqual(['pir-1', '110', 'find.exe', '1m', '1m1s']);
    expect(rows).toContainEqual(['', '111', '  └ grep.exe', '1m', '10ms']);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('They end when their session does'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('main: no job'));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('afx orphans'));
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
    expect(warn.recommendation).toContain('afx cleanup');
  });
});
