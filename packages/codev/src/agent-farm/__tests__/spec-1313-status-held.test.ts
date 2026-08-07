/**
 * `afx status` held-mail awareness (Spec 1313 round 3, change 3a).
 *
 * `afx status` is the reachable surface for mailbox starvation: an autonomous builder whose
 * composer never classifies as a ready prompt holds ALL its mail (cron nudges included), and
 * escalation was previously SSE/log-only. These tests drive the real `status()` command with a
 * mocked Tower client whose overview payload carries the held counts + escalation bit (the
 * command REUSES that payload — no re-derivation), and assert the human table's `Held` column,
 * the workspace summary + remedy hint, and the `--json` contract.
 *
 * Mock structure mirrors spec-1057-status-owner.test.ts so the two suites coexist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockLoadState = vi.fn();
const mockIsRunning = vi.fn();
const mockGetHealth = vi.fn();
const mockGetWorkspaceStatus = vi.fn();
const mockGetOverview = vi.fn();
const mockLoggerRow = vi.fn();
const mockLoggerInfo = vi.fn();
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
    getOverview: (...a: any[]) => mockGetOverview(...a),
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
    info: (...args: any[]) => mockLoggerInfo(...args),
    kv: (...args: any[]) => mockLoggerKv(...args),
    blank: vi.fn(),
    row: (...args: any[]) => mockLoggerRow(...args),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { status } from '../commands/status.js';

// Strip the FULL SGR sequence incl. the ESC (\x1b) — omitting it leaves a stray ESC
// under FORCE_COLOR/TTY (expected '2' vs received '\x1b2\x1b'), making the test
// color-dependent (non-hermetic). Matches spec-1057-status-owner's correct helper.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function builder(id: string, owner: string | undefined, extra: Record<string, any> = {}) {
  return {
    id,
    name: id.replace(/^builder-/, ''),
    type: 'spec',
    status: 'implementing',
    phase: 'impl',
    worktree: `/project/.builders/${id}`,
    branch: `builder/${id}`,
    terminalId: `term-${id}`,
    spawnedByArchitect: owner,
    ...extra,
  };
}

/** A minimal overview payload carrying just the fields `status` reuses (Spec 1313). */
function overview(builders: Array<[string, number]>, heldCount: number, escalated: boolean) {
  return {
    builders: builders.map(([roleId, heldCount]) => ({ roleId, heldCount })),
    heldCount,
    mailboxEscalated: escalated,
    pendingPRs: [],
    backlog: [],
  } as any;
}

/** Data rows (cols arrays) of the builder table, ANSI-stripped. */
function builderDataRows() {
  return mockLoggerRow.mock.calls
    .map((call: any[]) => call[0] as string[])
    .filter((cols) => Array.isArray(cols) && cols[0] !== 'ID' && cols[0] !== '──')
    .map((cols) => cols.map((c) => stripAnsi(String(c))));
}

function builderHeader(): string[] | undefined {
  return mockLoggerRow.mock.calls
    .map((c: any[]) => c[0] as string[])
    .find((cols) => Array.isArray(cols) && cols[0] === 'ID');
}

/** The 'Held mail' summary value the workspace summary printed (ANSI-stripped), if any. */
function heldMailSummary(): string | undefined {
  const call = mockLoggerKv.mock.calls.find((c) => stripAnsi(String(c[0])) === 'Held mail');
  return call ? stripAnsi(String(call[1])) : undefined;
}

describe('afx status — held-mail awareness (Spec 1313 round 3, human path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockGetHealth.mockResolvedValue({ uptime: 100, activeWorkspaces: 1, memoryUsage: 1024 * 1024 });
    mockGetWorkspaceStatus.mockResolvedValue({
      path: '/fake/workspace',
      name: 'project',
      active: true,
      terminals: [
        { type: 'architect', id: 'architect', label: 'main', url: '', active: true, architectName: 'main', pid: 1, terminalId: 's1' },
      ],
    });
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [],
      builders: [builder('spir-1', 'main'), builder('spir-2', 'main')],
      utils: [],
      annotations: [],
    });
  });

  it('adds a Held column with per-builder counts when the workspace has held mail', async () => {
    mockGetOverview.mockResolvedValue(overview([['spir-1', 2], ['spir-2', 0]], 2, true));
    await status();

    const header = builderHeader();
    expect(header).toBeDefined();
    expect(header![header!.length - 1]).toBe('Held'); // trailing Held column

    const rows = builderDataRows();
    const byId = Object.fromEntries(rows.map((r) => [r[0], r]));
    expect(byId['spir-1'][byId['spir-1'].length - 1]).toBe('2'); // its held count
    expect(byId['spir-2'][byId['spir-2'].length - 1]).toBe('0'); // no held mail → 0
  });

  it('omits the Held column entirely when the workspace has no held mail (no per-row noise)', async () => {
    mockGetOverview.mockResolvedValue(overview([['spir-1', 0], ['spir-2', 0]], 0, false));
    await status();

    const header = builderHeader();
    expect(header).toBeDefined();
    expect(header).not.toContain('Held'); // column suppressed at zero
    // The summary still prints, saying there is nothing held.
    expect(heldMailSummary()).toBe('none');
  });

  it('prints the workspace held summary + remedy hint when escalated', async () => {
    mockGetOverview.mockResolvedValue(overview([['spir-1', 3]], 3, true));
    await status();

    expect(heldMailSummary()).toContain('3');
    expect(heldMailSummary()).toContain('escalated');
    const info = mockLoggerInfo.mock.calls.map((c) => stripAnsi(String(c[0])));
    // The remedy names the two operator actions the alarm exists to prompt.
    expect(info.some((l) => l.includes('afx inbox'))).toBe(true);
    expect(info.some((l) => l.includes('afx interrupt'))).toBe(true);
  });

  it('shows the count without the remedy hint when held but not escalated', async () => {
    mockGetOverview.mockResolvedValue(overview([['spir-1', 1]], 1, false));
    await status();

    expect(heldMailSummary()).toBe('1'); // count, no "(escalated)" suffix
    const info = mockLoggerInfo.mock.calls.map((c) => stripAnsi(String(c[0])));
    expect(info.some((l) => l.includes('afx interrupt'))).toBe(false); // remedy only on escalation
  });

  it('degrades to "no held info" when the overview is unavailable (older/again-starting Tower)', async () => {
    mockGetOverview.mockResolvedValue(null);
    await status();
    expect(heldMailSummary()).toBe('none');
    expect(builderHeader()).not.toContain('Held');
  });
});

describe('afx status --json — held-mail contract (Spec 1313 round 3)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockGetHealth.mockResolvedValue({ uptime: 100, activeWorkspaces: 1, memoryUsage: 1024 });
    mockGetWorkspaceStatus.mockResolvedValue({ path: '/fake/workspace', name: 'project', active: true, terminals: [] });
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [],
      builders: [builder('spir-1', 'main'), builder('spir-2', 'main')],
      utils: [],
      annotations: [],
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => logSpy.mockRestore());

  function parsePayload() {
    expect(logSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(String(logSpy.mock.calls[0][0]));
  }

  it('carries the workspace mailbox summary and per-builder heldCount', async () => {
    mockGetOverview.mockResolvedValue(overview([['spir-1', 2], ['spir-2', 0]], 2, true));
    await status({ json: true });

    const payload = parsePayload();
    expect(payload.mailbox).toEqual({ heldCount: 2, escalated: true });
    const byId = Object.fromEntries(payload.builders.map((b: any) => [b.id, b]));
    expect(byId['spir-1'].heldCount).toBe(2);
    expect(byId['spir-2'].heldCount).toBe(0);
  });

  it('reports zeroed mailbox info when the overview is unavailable', async () => {
    mockGetOverview.mockResolvedValue(null);
    await status({ json: true });

    const payload = parsePayload();
    expect(payload.mailbox).toEqual({ heldCount: 0, escalated: false });
    expect(payload.builders.every((b: any) => b.heldCount === 0)).toBe(true);
  });
});
