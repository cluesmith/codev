/**
 * Tests for Spec 0100: Enhanced af status gate output
 *
 * Mocks TowerClient.getWorkspaceStatus to verify gate display
 * includes wait time and approval command.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing status
vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceRoot: '/fake/workspace' })),
}));

vi.mock('../state.js', () => ({
  loadState: vi.fn(() => ({
    architect: null,
    builders: [],
    utils: [],
    annotations: [],
  })),
}));

const mockIsRunning = vi.fn();
const mockGetHealth = vi.fn();
const mockGetWorkspaceStatus = vi.fn();

vi.mock('../lib/tower-client.js', () => {
  return {
    TowerClient: class MockTowerClient {
      isRunning = mockIsRunning;
      getHealth = mockGetHealth;
      getWorkspaceStatus = mockGetWorkspaceStatus;
    },
  };
});

import { status } from '../commands/status.js';

describe('af status gate display (Spec 0100)', () => {
  let logOutput: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logOutput = [];

    // Capture all console.log/error output
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map(String).join(' '));
    });

    // Default: tower running with health
    mockIsRunning.mockResolvedValue(true);
    mockGetHealth.mockResolvedValue({
      status: 'healthy',
      uptime: 300,
      activeWorkspaces: 1,
      totalWorkspaces: 1,
      memoryUsage: 50 * 1024 * 1024,
    });
  });

  it('shows wait time and approval command for blocked builder with requestedAt', async () => {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60_000).toISOString();

    mockGetWorkspaceStatus.mockResolvedValue({
      path: '/fake/workspace',
      name: 'test-workspace',
      active: true,
      terminals: [],
      gateStatus: {
        hasGate: true,
        gateName: 'spec-approval',
        builderId: '0100',
        requestedAt: threeMinutesAgo,
      },
    });

    await status();

    const combined = logOutput.join('\n');
    expect(combined).toContain('Builder 0100');
    expect(combined).toContain('blocked');
    expect(combined).toContain('spec-approval');
    expect(combined).toContain('waiting 3m');
    expect(combined).toContain('porch approve 0100 spec-approval');
  });

  it('shows gate name and command but no wait time when requestedAt is missing', async () => {
    mockGetWorkspaceStatus.mockResolvedValue({
      path: '/fake/workspace',
      name: 'test-workspace',
      active: true,
      terminals: [],
      gateStatus: {
        hasGate: true,
        gateName: 'plan-approval',
        builderId: '0077',
      },
    });

    await status();

    const combined = logOutput.join('\n');
    expect(combined).toContain('Builder 0077');
    expect(combined).toContain('blocked');
    expect(combined).toContain('plan-approval');
    expect(combined).toContain('porch approve 0077 plan-approval');
    expect(combined).not.toContain('waiting');
  });

  it('shows no gate warning when no gate is pending', async () => {
    mockGetWorkspaceStatus.mockResolvedValue({
      path: '/fake/workspace',
      name: 'test-workspace',
      active: true,
      terminals: [],
      gateStatus: {
        hasGate: false,
      },
    });

    await status();

    const combined = logOutput.join('\n');
    expect(combined).not.toContain('blocked');
    expect(combined).not.toContain('porch approve');
  });

  it('shows "<1m" for very recent gates', async () => {
    const justNow = new Date(Date.now() - 15_000).toISOString(); // 15 seconds ago

    mockGetWorkspaceStatus.mockResolvedValue({
      path: '/fake/workspace',
      name: 'test-workspace',
      active: true,
      terminals: [],
      gateStatus: {
        hasGate: true,
        gateName: 'spec-approval',
        builderId: '0100',
        requestedAt: justNow,
      },
    });

    await status();

    const combined = logOutput.join('\n');
    expect(combined).toContain('waiting <1m');
  });
});
