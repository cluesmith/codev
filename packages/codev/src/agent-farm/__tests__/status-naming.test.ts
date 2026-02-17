/**
 * Tests for af status display with new agent naming convention.
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

describe('af status naming display (Phase 4)', () => {
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
