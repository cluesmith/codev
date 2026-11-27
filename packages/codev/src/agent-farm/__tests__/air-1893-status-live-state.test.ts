/**
 * `afx status` shows each builder's live state (#1893): the porch phase and
 * pending gate from the builder's OWN worktree status.yaml (not the spawn-time
 * state.db 'implementing' / 'init', nor the workspace root's stale copy —
 * #1229, #1703), the age of its last terminal output from Tower, and, behind
 * `--activity`, its session/process activity with "unknown" where unreadable.
 *
 * Drives the real `status()` against a temp workspace with real worktree
 * status.yaml files; Tower, state.db and the activity gatherer are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockGetConfig = vi.fn();
const mockLoadState = vi.fn();
const mockIsRunning = vi.fn();
const mockGetHealth = vi.fn();
const mockGetWorkspaceStatus = vi.fn();
const mockGetOverview = vi.fn();
const mockGather = vi.fn();
const mockLoggerRow = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock('../utils/config.js', () => ({ getConfig: () => mockGetConfig() }));
vi.mock('../state.js', () => ({ loadState: (...a: any[]) => mockLoadState(...a) }));
vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    isRunning: (...a: any[]) => mockIsRunning(...a),
    probeHealth: async () => ((await mockIsRunning()) ? { state: 'running' } : { state: 'not-running' }),
    getHealth: (...a: any[]) => mockGetHealth(...a),
    getWorkspaceStatus: (...a: any[]) => mockGetWorkspaceStatus(...a),
    getOverview: (...a: any[]) => mockGetOverview(...a),
    // Spec 1967: the remote-messaging line; this suite's Tower predates it.
    getPeerStatus: async () => ({ ok: false, status: 404, error: 'Not found', unknownRoute: true }),
  }),
}));
vi.mock('../lib/builder-activity.js', () => ({
  gatherBuilderActivity: (...a: any[]) => mockGather(...a),
}));
vi.mock('../../lib/config.js', () => ({ loadConfig: vi.fn(() => ({})) }));
vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: (...a: any[]) => mockLoggerInfo(...a),
    kv: vi.fn(),
    blank: vi.fn(),
    row: (...a: any[]) => mockLoggerRow(...a),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { status } from '../commands/status.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const HOUR = 3_600_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

let workspace: string;

function writeStatus(dir: string, id: string, yaml: string): void {
  const projectDir = path.join(dir, 'codev', 'projects', `${id}-feature`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'status.yaml'), yaml);
}

/** A state.db builder row frozen at spawn ('implementing' / 'init'), as `afx spawn` writes it. */
function builderRow(id: string, worktreeName: string) {
  return {
    id,
    name: worktreeName,
    type: 'protocol',
    status: 'implementing',
    phase: 'init',
    worktree: path.join(workspace, '.builders', worktreeName),
    branch: `builder/${worktreeName}`,
    terminalId: `term-${id}`,
    spawnedByArchitect: 'main',
    protocolName: 'spir',
  };
}

function rows(): string[][] {
  return mockLoggerRow.mock.calls
    .map((c: any[]) => c[0] as string[])
    .filter((cols) => cols[0] !== 'ID' && cols[0] !== '──')
    .map((cols) => cols.map((c) => stripAnsi(String(c))));
}

function header(): string[] {
  return mockLoggerRow.mock.calls.map((c: any[]) => c[0] as string[]).find((cols) => cols[0] === 'ID')!;
}

function infoLines(): string[] {
  return mockLoggerInfo.mock.calls.map((c: any[]) => stripAnsi(String(c[0])));
}

async function runJson(extra: Record<string, unknown> = {}): Promise<any> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await status({ json: true, ...extra });
    return JSON.parse(log.mock.calls[0][0]);
  } finally {
    log.mockRestore();
  }
}

describe('afx status — live builder state (#1893)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'air-1893-ws-'));
    mockGetConfig.mockReturnValue({ workspaceRoot: workspace });

    // Waiting at spec-approval for 2h, per its worktree. The workspace ROOT holds a stale
    // copy saying `plan` with no gate requested — it must not be read.
    writeStatus(path.join(workspace, '.builders', 'spir-42'), '42', [
      "id: '42'", 'protocol: spir', 'phase: specify', 'gates:', '  spec-approval:', '    status: pending',
      `    requested_at: '${isoAgo(2 * HOUR + 60_000)}'`, '',
    ].join('\n'));
    writeStatus(workspace, '42', ["id: '42'", 'protocol: spir', 'phase: plan', ''].join('\n'));
    // Protocol complete, no gate pending.
    writeStatus(path.join(workspace, '.builders', 'spir-43'), '43', [
      "id: '43'", 'protocol: spir', 'phase: complete', 'gates:', '  pr:', '    status: approved', '',
    ].join('\n'));
    // A worktree with no porch project.
    fs.mkdirSync(path.join(workspace, '.builders', 'task-AbCd'), { recursive: true });

    mockLoadState.mockReturnValue({
      architects: [],
      builders: [builderRow('builder-spir-42', 'spir-42'), builderRow('builder-spir-43', 'spir-43'), builderRow('builder-task-AbCd', 'task-AbCd')],
      utils: [],
      annotations: [],
    });
    mockIsRunning.mockResolvedValue(true);
    mockGetHealth.mockResolvedValue({ uptime: 1, activeWorkspaces: 1, memoryUsage: 0 });
    mockGetWorkspaceStatus.mockResolvedValue({ name: 'ws', active: true, terminals: [] });
    // spir-42 and the task builder have live sessions; spir-43's terminal is gone.
    mockGetOverview.mockResolvedValue({
      builders: [
        { roleId: 'builder-spir-42', lastDataAt: isoAgo(5 * 60_000 + 1000) },
        { roleId: 'builder-task-abcd', lastDataAt: isoAgo(10_000) },
      ],
      heldCount: 0,
      mailboxEscalated: false,
    });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('shows the worktree phase, pending gate with its age, and last terminal activity', async () => {
    await status({});
    expect(header()).toEqual(['ID', 'Owner', 'Type', 'Phase', 'Gate', 'Last active']);
    const byId = Object.fromEntries(rows().map((r) => [r[0], r]));
    expect(byId['builder-spir-42'].slice(3)).toEqual(['specify', 'spec-approval (2h)', '5m ago']);
    expect(byId['builder-spir-43'].slice(3)).toEqual(['complete', '—', 'stopped']);
    expect(byId['builder-task-AbCd'].slice(3)).toEqual(['—', '—', 'just now']);
    expect(mockGather).not.toHaveBeenCalled();
  });

  it('still reads phase and gate from the worktree when Tower is down; activity is unknown', async () => {
    mockIsRunning.mockResolvedValue(false);
    await status({});
    const byId = Object.fromEntries(rows().map((r) => [r[0], r]));
    expect(byId['builder-spir-42'].slice(3)).toEqual(['specify', 'spec-approval (2h)', 'unknown']);
    expect(byId['builder-spir-43'].slice(3)).toEqual(['complete', '—', 'unknown']);
  });

  it('a live session with no output time reads unknown, not stopped', async () => {
    mockGetOverview.mockResolvedValue({ builders: [{ roleId: 'builder-spir-43', lastDataAt: null }], heldCount: 0 });
    await status({});
    const byId = Object.fromEntries(rows().map((r) => [r[0], r]));
    expect(byId['builder-spir-43'][5]).toBe('unknown');
    const payload = await runJson();
    const b43 = payload.builders.find((b: any) => b.id === 'builder-spir-43');
    expect(b43).toMatchObject({ terminalLive: true, lastActivityAt: null });
  });

  it('--json keeps every existing field and adds the live ones', async () => {
    const payload = await runJson();
    const b42 = payload.builders.find((b: any) => b.id === 'builder-spir-42');
    expect(b42).toMatchObject({
      status: 'implementing', phase: 'init', running: true, heldCount: 0, spawnedByArchitect: 'main',
      porchPhase: 'specify',
      gate: { name: 'spec-approval' },
      terminalLive: true,
      activity: null,
    });
    expect(Date.parse(b42.lastActivityAt)).toBeGreaterThan(Date.now() - 6 * 60_000);
    const b43 = payload.builders.find((b: any) => b.id === 'builder-spir-43');
    expect(b43).toMatchObject({ porchPhase: 'complete', gate: null, lastActivityAt: null, terminalLive: false });
    const task = payload.builders.find((b: any) => b.id === 'builder-task-AbCd');
    expect(task).toMatchObject({ porchPhase: null, gate: null });
  });

  describe('--activity', () => {
    const known = {
      sessionWrittenAt: isoAgo(2 * 60_000 + 1000),
      lastTurns: ['assistant: Running the suite', 'tool: Bash(pnpm test)'],
      apiError: true,
      processes: [{ pid: 4242, kind: 'test', command: 'pnpm test' }],
    };
    // A codex / agy builder: no Claude transcript, so every transcript field is unknown.
    const unknown = { sessionWrittenAt: null, lastTurns: null, apiError: null, processes: null };

    beforeEach(() => {
      mockGather.mockResolvedValue(new Map<string, unknown>([
        ['builder-spir-42', known],
        ['builder-spir-43', unknown],
        ['builder-task-AbCd', { ...unknown, lastTurns: [], processes: [] }],
      ]));
    });

    it('renders each builder, with "unknown" for fields it could not read', async () => {
      await status({ activity: true });
      expect(mockGather).toHaveBeenCalledWith(workspace, expect.any(Array));
      const lines = infoLines();
      const at = (id: string) => lines.findIndex((l) => l.trimStart().startsWith(id));

      const i42 = at('builder-spir-42');
      expect(lines[i42]).toBe('  builder-spir-42  session write: 2m ago  ·  API error: yes');
      expect(lines.slice(i42 + 1, i42 + 4)).toEqual([
        '    > assistant: Running the suite',
        '    > tool: Bash(pnpm test)',
        '    running: test pnpm test (pid 4242)',
      ]);

      const i43 = at('builder-spir-43');
      expect(lines.slice(i43, i43 + 3)).toEqual([
        '  builder-spir-43  session write: unknown  ·  API error: unknown',
        '    turns: unknown',
        '    running: unknown',
      ]);
      const iTask = at('builder-task-AbCd');
      expect(lines.slice(iTask + 1, iTask + 3)).toEqual(['    turns: none', '    running: none']);
    });

    it('carries the activity, nulls included, in --json', async () => {
      const payload = await runJson({ activity: true });
      const activity = (id: string) => payload.builders.find((b: any) => b.id === id).activity;
      expect(activity('builder-spir-42')).toEqual(known);
      expect(activity('builder-spir-43')).toEqual(unknown);
    });
  });
});
