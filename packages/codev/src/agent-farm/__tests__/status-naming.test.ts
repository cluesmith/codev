/**
 * Tests for afx status display with new agent naming convention.
 * Spec 0110: Messaging Infrastructure — Phase 4
 *
 * Verifies that the legacy (no Tower) status display correctly shows
 * new-format builder IDs (e.g., 'builder-spir-109') with adequate
 * column width (20 chars, up from 12).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockLoadState = vi.fn();
const mockIsRunning = vi.fn();
const mockGetHealth = vi.fn();
const mockGetWorkspaceStatus = vi.fn();
const mockLoggerRow = vi.fn();

vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceRoot: '/fake/workspace' })),
}));

vi.mock('../state.js', () => ({
  loadState: (...args: any[]) => mockLoadState(...args),
}));

vi.mock('../lib/tower-client.js', () => ({
  TowerClient: vi.fn().mockImplementation(function (this: any) {
    this.isRunning = (...a: any[]) => mockIsRunning(...a);
    this.getHealth = (...a: any[]) => mockGetHealth(...a);
    this.getWorkspaceStatus = (...a: any[]) => mockGetWorkspaceStatus(...a);
  }),
  getTowerClient: () => ({
    isRunning: (...a: any[]) => mockIsRunning(...a),
    getHealth: (...a: any[]) => mockGetHealth(...a),
    getWorkspaceStatus: (...a: any[]) => mockGetWorkspaceStatus(...a),
    // Spec 1313 round 3: status reads the overview for held-mail awareness; null → "no held info".
    getOverview: async () => null,
  }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
    row: (...args: any[]) => mockLoggerRow(...args),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { status } from '../commands/status.js';

// ============================================================================
// Tests
// ============================================================================

describe('afx status naming display (Phase 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Tower not running → forces legacy display
    mockIsRunning.mockResolvedValue(false);
  });

  it('displays new-format builder IDs in legacy mode with wide columns', async () => {
    mockLoadState.mockReturnValue({
      architect: null,
      builders: [
        { id: 'builder-spir-109', name: '109-messaging', type: 'spec', worktree: '/project/.builders/spir-109', terminalId: 'term-1', status: 'implementing', phase: 'impl' },
        { id: 'builder-bugfix-42', name: '42-fix-auth', type: 'issue', worktree: '/project/.builders/bugfix-42', terminalId: 'term-2', status: 'pr', phase: 'review' },
      ],
      utils: [],
      annotations: [],
    });

    await status();

    // Find the row calls that contain builder IDs (skip header/separator rows)
    const builderRows = mockLoggerRow.mock.calls.filter(
      (call: any[]) => Array.isArray(call[0]) && call[0][0] !== 'ID' && call[0][0] !== '──'
    );

    // Verify builder IDs are the new format
    expect(builderRows.length).toBe(2);
    expect(builderRows[0][0][0]).toBe('builder-spir-109');
    expect(builderRows[1][0][0]).toBe('builder-bugfix-42');

    // Verify column widths accommodate new naming (ID column = 20)
    const headerRow = mockLoggerRow.mock.calls.find(
      (call: any[]) => Array.isArray(call[0]) && call[0][0] === 'ID'
    );
    expect(headerRow).toBeDefined();
    expect(headerRow![1][0]).toBe(20); // ID column width
  });

  it('displays empty builders message when no builders exist', async () => {
    mockLoadState.mockReturnValue({
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
    });

    await status();

    // No builder rows should exist
    const builderRows = mockLoggerRow.mock.calls.filter(
      (call: any[]) => Array.isArray(call[0]) && call[0][0] !== 'ID' && call[0][0] !== '──'
    );
    expect(builderRows.length).toBe(0);
  });
});

// ============================================================================
// Spec 786 Phase 5 — Architect enumeration in `afx status`
// ============================================================================
//
// The Spec 755 v1 display showed a single "Architect" line. Spec 786 Phase 5
// surfaces ALL registered architects. In Tower-running mode, names/PIDs come
// from the `TowerWorkspaceStatus.terminals[]` entries (with the new
// architectName/pid/port/terminalId fields). In Tower-down mode, names/cmds
// come from `state.architects` (loadState now populates the collection).

describe('afx status — Spec 786 Phase 5 architect enumeration', () => {
  const mockLoggerInfo = vi.fn();
  const mockLoggerKv = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoggerInfo.mockReset();
    mockLoggerKv.mockReset();
  });

  describe('Tower-running mode', () => {
    beforeEach(async () => {
      mockIsRunning.mockResolvedValue(true);
      mockGetHealth.mockResolvedValue({ uptime: 100, activeWorkspaces: 1, memoryUsage: 1024 * 1024 });
    });

    it('lists all registered architects with name + PID + terminal id', async () => {
      mockGetWorkspaceStatus.mockResolvedValue({
        name: 'project',
        active: true,
        terminals: [
          { type: 'architect', id: 'architect', label: 'main', url: '', active: true,
            architectName: 'main', pid: 1234, terminalId: 'sess-main-uuid' },
          { type: 'architect', id: 'architect:ob-refine', label: 'ob-refine', url: '', active: true,
            architectName: 'ob-refine', pid: 5678, terminalId: 'sess-ob-uuid' },
          { type: 'builder', id: 'b1', label: 'b1', url: '', active: true },
        ],
      });

      // Re-import logger mock with .info capture for this test block.
      const { logger } = await import('../utils/logger.js');
      (logger as any).info = mockLoggerInfo;

      await status();

      const lines = mockLoggerInfo.mock.calls.map(c => String(c[0]));
      // Architects section header.
      expect(lines.some(l => l === 'Architects:')).toBe(true);
      // Both architects listed by name with PID and terminal id (the
      // session id, not the tab id).
      const mainLine = lines.find(l => l.includes('main') && l.includes('pid=1234'));
      expect(mainLine).toBeDefined();
      expect(mainLine).toContain('terminal=sess-main-uuid');
      const obLine = lines.find(l => l.includes('ob-refine') && l.includes('pid=5678'));
      expect(obLine).toBeDefined();
      expect(obLine).toContain('terminal=sess-ob-uuid');
    });

    it('falls back to tab id when terminalId is absent (older Tower)', async () => {
      mockGetWorkspaceStatus.mockResolvedValue({
        name: 'project',
        active: true,
        terminals: [
          { type: 'architect', id: 'architect', label: 'main', url: '', active: true,
            architectName: 'main', pid: 1234 /* no terminalId */ },
        ],
      });

      const { logger } = await import('../utils/logger.js');
      (logger as any).info = mockLoggerInfo;

      await status();

      const lines = mockLoggerInfo.mock.calls.map(c => String(c[0]));
      // Falls back to `term.id` for terminal=… when terminalId is undefined.
      expect(lines.some(l => l.includes('terminal=architect'))).toBe(true);
    });
  });

  describe('Tower-down fallback mode', () => {
    beforeEach(() => {
      mockIsRunning.mockResolvedValue(false);
    });

    it('lists all architects from state.db with name + cmd; notes "Tower not running"', async () => {
      mockLoadState.mockReturnValue({
        architect: { name: 'main', cmd: 'claude', startedAt: '2026-05-22T10:00:00Z', terminalId: 'term-1' },
        architects: [
          { name: 'main', cmd: 'claude', startedAt: '2026-05-22T10:00:00Z', terminalId: 'term-1' },
          { name: 'ob-refine', cmd: 'claude --resume', startedAt: '2026-05-22T11:00:00Z', terminalId: 'term-2' },
        ],
        builders: [],
        utils: [],
        annotations: [],
      });

      const { logger } = await import('../utils/logger.js');
      (logger as any).info = mockLoggerInfo;
      (logger as any).kv = mockLoggerKv;

      await status();

      // The "Architects" kv row reports the count.
      const archKv = mockLoggerKv.mock.calls.find(c => c[0] === 'Architects');
      expect(archKv).toBeDefined();
      // The "Tower not running" note is emitted.
      const lines = mockLoggerInfo.mock.calls.map(c => String(c[0]));
      expect(lines.some(l => l.includes('Tower not running'))).toBe(true);
      // Both architects listed with cmd.
      const mainLine = lines.find(l => l.includes('main') && l.includes('claude'));
      expect(mainLine).toBeDefined();
      const obLine = lines.find(l => l.includes('ob-refine') && l.includes('claude --resume'));
      expect(obLine).toBeDefined();
    });

    it('shows "none registered" when state.architects is empty', async () => {
      mockLoadState.mockReturnValue({
        architect: null,
        architects: [],
        builders: [],
        utils: [],
        annotations: [],
      });

      const { logger } = await import('../utils/logger.js');
      (logger as any).kv = mockLoggerKv;

      await status();

      const archKv = mockLoggerKv.mock.calls.find(c => c[0] === 'Architects');
      expect(archKv).toBeDefined();
      // Value (second arg) contains "none registered".
      expect(String(archKv![1])).toMatch(/none registered/);
    });
  });
});
