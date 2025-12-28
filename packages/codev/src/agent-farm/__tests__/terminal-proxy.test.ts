/**
 * Tests for terminal proxy functionality (Spec 0062 - Secure Remote Access)
 *
 * Tests the getPortForTerminal helper function that maps terminal IDs to ports.
 * Imports the production code from utils/terminal-ports.ts for accurate testing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DashboardState } from '../types.js';
import { getPortForTerminal } from '../utils/terminal-ports.js';

describe('getPortForTerminal', () => {
  const mockState: DashboardState = {
    architect: {
      pid: 1234,
      port: 4201,
      cmd: 'claude',
      startedAt: new Date().toISOString(),
    },
    builders: [
      {
        id: '0055',
        name: 'Builder 0055',
        port: 4210,
        pid: 2345,
        status: 'implementing',
        phase: 'implement',
        worktree: '/tmp/worktree',
        branch: 'builder/0055-feature',
        type: 'spec',
      },
      {
        id: '0056',
        name: 'Builder 0056',
        port: 4211,
        pid: 3456,
        status: 'blocked',
        phase: 'defend',
        worktree: '/tmp/worktree2',
        branch: 'builder/0056-feature',
        type: 'spec',
      },
    ],
    utils: [
      {
        id: 'U12345',
        name: 'Shell 1',
        port: 4230,
        pid: 4567,
      },
      {
        id: 'U67890',
        name: 'Shell 2',
        port: 4231,
        pid: 5678,
      },
    ],
    annotations: [],
  };

  describe('architect terminal', () => {
    it('should return architect port for "architect" ID', () => {
      const port = getPortForTerminal('architect', mockState);
      expect(port).toBe(4201);
    });

    it('should return null when architect is not running', () => {
      const stateNoArchitect = { ...mockState, architect: null };
      const port = getPortForTerminal('architect', stateNoArchitect);
      expect(port).toBeNull();
    });
  });

  describe('builder terminals', () => {
    it('should return builder port for valid builder ID', () => {
      const port = getPortForTerminal('builder-0055', mockState);
      expect(port).toBe(4210);
    });

    it('should return correct port for different builders', () => {
      const port = getPortForTerminal('builder-0056', mockState);
      expect(port).toBe(4211);
    });

    it('should return null for non-existent builder', () => {
      const port = getPortForTerminal('builder-9999', mockState);
      expect(port).toBeNull();
    });

    it('should handle builder IDs with different formats', () => {
      // Add a builder with a non-numeric ID
      const stateWithCustomBuilder = {
        ...mockState,
        builders: [
          ...mockState.builders,
          {
            id: 'custom-task-abc',
            name: 'Custom Task',
            port: 4215,
            pid: 9999,
            status: 'implementing' as const,
            phase: 'init',
            worktree: '/tmp/worktree3',
            branch: 'builder/custom-task',
            type: 'task' as const,
          },
        ],
      };
      const port = getPortForTerminal('builder-custom-task-abc', stateWithCustomBuilder);
      expect(port).toBe(4215);
    });
  });

  describe('utility terminals', () => {
    it('should return util port for valid util ID', () => {
      const port = getPortForTerminal('util-U12345', mockState);
      expect(port).toBe(4230);
    });

    it('should return correct port for different utils', () => {
      const port = getPortForTerminal('util-U67890', mockState);
      expect(port).toBe(4231);
    });

    it('should return null for non-existent util', () => {
      const port = getPortForTerminal('util-UNKNOWN', mockState);
      expect(port).toBeNull();
    });
  });

  describe('invalid terminal IDs', () => {
    it('should return null for empty string', () => {
      const port = getPortForTerminal('', mockState);
      expect(port).toBeNull();
    });

    it('should return null for unknown prefix', () => {
      const port = getPortForTerminal('unknown-123', mockState);
      expect(port).toBeNull();
    });

    it('should return null for partial prefix match', () => {
      const port = getPortForTerminal('build-0055', mockState); // missing 'er'
      expect(port).toBeNull();
    });

    it('should return null for case mismatch', () => {
      const port = getPortForTerminal('Architect', mockState);
      expect(port).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle empty state', () => {
      const emptyState: DashboardState = {
        architect: null,
        builders: [],
        utils: [],
        annotations: [],
      };

      expect(getPortForTerminal('architect', emptyState)).toBeNull();
      expect(getPortForTerminal('builder-0055', emptyState)).toBeNull();
      expect(getPortForTerminal('util-U12345', emptyState)).toBeNull();
    });

    it('should handle builder ID that contains "builder-" in the ID itself', () => {
      // Edge case: what if someone names their builder "builder-test"
      // The ID would be "builder-builder-test"
      const stateWithEdgeCaseBuilder = {
        ...mockState,
        builders: [
          ...mockState.builders,
          {
            id: 'builder-test',
            name: 'Edge Case',
            port: 4220,
            pid: 8888,
            status: 'implementing' as const,
            phase: 'init',
            worktree: '/tmp/worktree4',
            branch: 'builder/builder-test',
            type: 'task' as const,
          },
        ],
      };
      const port = getPortForTerminal('builder-builder-test', stateWithEdgeCaseBuilder);
      expect(port).toBe(4220);
    });
  });
});
