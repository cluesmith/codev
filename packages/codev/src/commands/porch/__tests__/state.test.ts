/**
 * Tests for porch state management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  readState,
  serializeState,
  parseState,
  updateState,
  approveGate,
  requestGateApproval,
  updatePhaseStatus,
  setPlanPhases,
  findProjects,
  getConsultationAttempts,
  incrementConsultationAttempts,
  resetConsultationAttempts,
  PROJECTS_DIR,
} from '../state.js';
import type { ProjectState } from '../types.js';

describe('state management', () => {
  const testDir = path.join(tmpdir(), `porch-state-test-${Date.now()}`);
  const projectsDir = path.join(testDir, PROJECTS_DIR);

  // Create a sample state for testing
  function createSampleState(overrides: Partial<ProjectState> = {}): ProjectState {
    return {
      id: '0073',
      title: 'test-feature',
      protocol: 'spider',
      current_state: 'specify:draft',
      gates: {},
      phases: {},
      iteration: 0,
      started_at: '2026-01-19T10:00:00Z',
      last_updated: '2026-01-19T10:00:00Z',
      log: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    fs.mkdirSync(projectsDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('serializeState / parseState', () => {
    it('should serialize and parse state correctly', () => {
      const state = createSampleState();
      const serialized = serializeState(state);
      const parsed = parseState(serialized);

      expect(parsed.id).toBe('0073');
      expect(parsed.title).toBe('test-feature');
      expect(parsed.protocol).toBe('spider');
      expect(parsed.current_state).toBe('specify:draft');
    });

    it('should handle gates in serialization', () => {
      const state = createSampleState({
        gates: {
          // Use underscore format as that's what the YAML parser expects
          'spec_approval': {
            status: 'pending',
            requested_at: '2026-01-19T10:00:00Z',
          },
        },
      });
      const serialized = serializeState(state);
      const parsed = parseState(serialized);

      expect(parsed.gates['spec_approval'].status).toBe('pending');
      expect(parsed.gates['spec_approval'].requested_at).toBe('2026-01-19T10:00:00Z');
    });

    it('should handle phases in serialization', () => {
      const state = createSampleState({
        phases: {
          'phase_1': { status: 'complete', title: 'Setup' },
          'phase_2': { status: 'in_progress', title: 'Build' },
        },
      });
      const serialized = serializeState(state);
      const parsed = parseState(serialized);

      expect(parsed.phases['phase_1'].status).toBe('complete');
      expect(parsed.phases['phase_2'].status).toBe('in_progress');
    });

    it('should handle worktree path', () => {
      const state = createSampleState({
        worktree: '/path/to/worktree',
      });
      const serialized = serializeState(state);
      const parsed = parseState(serialized);

      expect(parsed.worktree).toBe('/path/to/worktree');
    });
  });

  describe('readState', () => {
    it('should return null for non-existent file', () => {
      const result = readState('/nonexistent/path/status.yaml');
      expect(result).toBeNull();
    });

    it('should read existing state file', () => {
      const state = createSampleState();
      const statusFile = path.join(projectsDir, '0073-test', 'status.yaml');
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, serializeState(state));

      const read = readState(statusFile);
      expect(read).not.toBeNull();
      expect(read!.id).toBe('0073');
    });
  });

  describe('updateState', () => {
    it('should update current state', () => {
      const state = createSampleState();
      const updated = updateState(state, 'plan:draft');

      expect(updated.current_state).toBe('plan:draft');
      expect(updated.iteration).toBe(1);
    });

    it('should add log entry', () => {
      const state = createSampleState();
      const updated = updateState(state, 'plan:draft', { signal: 'SPEC_READY' });

      expect(updated.log.length).toBe(1);
      const entry = updated.log[0] as { from: string; to: string; signal: string };
      expect(entry.from).toBe('specify:draft');
      expect(entry.to).toBe('plan:draft');
      expect(entry.signal).toBe('SPEC_READY');
    });
  });

  describe('approveGate', () => {
    it('should mark gate as passed', () => {
      const state = createSampleState({
        gates: {
          'spec-approval': { status: 'pending', requested_at: '2026-01-19T10:00:00Z' },
        },
      });

      const updated = approveGate(state, 'spec-approval');

      expect(updated.gates['spec-approval'].status).toBe('passed');
      expect(updated.gates['spec-approval'].approved_at).toBeDefined();
    });
  });

  describe('requestGateApproval', () => {
    it('should mark gate as pending with timestamp', () => {
      const state = createSampleState();
      const updated = requestGateApproval(state, 'spec-approval');

      expect(updated.gates['spec-approval'].status).toBe('pending');
      expect(updated.gates['spec-approval'].requested_at).toBeDefined();
    });
  });

  describe('updatePhaseStatus', () => {
    it('should update phase status', () => {
      const state = createSampleState({
        phases: {
          'phase_1': { status: 'pending', title: 'Setup' },
        },
      });

      const updated = updatePhaseStatus(state, 'phase_1', 'complete');

      expect(updated.phases['phase_1'].status).toBe('complete');
    });
  });

  describe('setPlanPhases', () => {
    it('should set plan phases and initialize phase status', () => {
      const state = createSampleState();
      const phases = [
        { id: 'phase_1', title: 'Setup' },
        { id: 'phase_2', title: 'Build' },
      ];

      const updated = setPlanPhases(state, phases);

      expect(updated.plan_phases).toHaveLength(2);
      expect(updated.phases['phase_1'].status).toBe('pending');
      expect(updated.phases['phase_2'].status).toBe('pending');
    });
  });

  describe('findProjects', () => {
    it('should find projects in directory', () => {
      // Create a project
      const projectDir = path.join(projectsDir, '0073-feature');
      fs.mkdirSync(projectDir, { recursive: true });
      const state = createSampleState();
      fs.writeFileSync(path.join(projectDir, 'status.yaml'), serializeState(state));

      const projects = findProjects(testDir);

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('0073');
    });

    it('should return empty array for non-existent directory', () => {
      const projects = findProjects('/nonexistent/path');
      expect(projects).toEqual([]);
    });
  });

  describe('consultation attempt tracking', () => {
    it('should return 0 for state with no consultation attempts', () => {
      const state = createSampleState();
      expect(getConsultationAttempts(state, 'specify:consult')).toBe(0);
    });

    it('should increment consultation attempts', () => {
      const state = createSampleState();
      const updated = incrementConsultationAttempts(state, 'specify:consult');

      expect(updated.consultation_attempts).toBeDefined();
      expect(updated.consultation_attempts!['specify:consult']).toBe(1);
      expect(getConsultationAttempts(updated, 'specify:consult')).toBe(1);
    });

    it('should increment multiple times', () => {
      let state = createSampleState();
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'specify:consult');

      expect(getConsultationAttempts(state, 'specify:consult')).toBe(3);
    });

    it('should track different states independently', () => {
      let state = createSampleState();
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'plan:consult');

      expect(getConsultationAttempts(state, 'specify:consult')).toBe(2);
      expect(getConsultationAttempts(state, 'plan:consult')).toBe(1);
    });

    it('should reset consultation attempts', () => {
      let state = createSampleState();
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'specify:consult');

      expect(getConsultationAttempts(state, 'specify:consult')).toBe(2);

      state = resetConsultationAttempts(state, 'specify:consult');
      expect(getConsultationAttempts(state, 'specify:consult')).toBe(0);
    });

    it('should log consultation attempts', () => {
      const state = createSampleState();
      const updated = incrementConsultationAttempts(state, 'specify:consult');

      const logEntry = updated.log[updated.log.length - 1] as { event: string; phase: string; count: number };
      expect(logEntry.event).toBe('consultation_attempt');
      expect(logEntry.phase).toBe('specify:consult');
      expect(logEntry.count).toBe(1);
    });

    it('should serialize and parse consultation attempts', () => {
      let state = createSampleState();
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'specify:consult');
      state = incrementConsultationAttempts(state, 'plan:consult');

      const yaml = serializeState(state);
      const parsed = parseState(yaml);

      expect(parsed.consultation_attempts).toBeDefined();
      expect(parsed.consultation_attempts!['specify:consult']).toBe(2);
      expect(parsed.consultation_attempts!['plan:consult']).toBe(1);
    });
  });
});
