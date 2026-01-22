/**
 * Tests for porch2 state management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  readState,
  writeState,
  createInitialState,
  findStatusPath,
  getProjectDir,
  getStatusPath,
  PROJECTS_DIR,
} from '../state.js';
import type { ProjectState, Protocol } from '../types.js';

describe('porch2 state management', () => {
  const testDir = path.join(tmpdir(), `porch2-state-test-${Date.now()}`);
  const projectsDir = path.join(testDir, PROJECTS_DIR);

  // Sample protocol for testing
  const sampleProtocol: Protocol = {
    name: 'spider',
    version: '1.0.0',
    phases: [
      { id: 'specify', name: 'Specification', gate: 'spec_approval', next: 'plan' },
      { id: 'plan', name: 'Planning', gate: 'plan_approval', next: 'implement' },
      { id: 'implement', name: 'Implementation', checks: ['build', 'test'], next: 'review' },
      { id: 'review', name: 'Review', gate: 'review_approval', next: null },
    ],
    checks: {
      build: 'npm run build',
      test: 'npm test',
    },
  };

  // Sample state for testing
  function createSampleState(overrides: Partial<ProjectState> = {}): ProjectState {
    return {
      id: '0074',
      title: 'test-feature',
      protocol: 'spider',
      phase: 'specify',
      plan_phases: [],
      current_plan_phase: null,
      gates: {
        spec_approval: { status: 'pending' },
        plan_approval: { status: 'pending' },
      },
      started_at: '2026-01-21T10:00:00Z',
      updated_at: '2026-01-21T10:00:00Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('path utilities', () => {
    it('should return correct project directory', () => {
      const dir = getProjectDir('/root', '0074', 'test-feature');
      expect(dir).toBe('/root/codev/projects/0074-test-feature');
    });

    it('should return correct status path', () => {
      const statusPath = getStatusPath('/root', '0074', 'test-feature');
      expect(statusPath).toBe('/root/codev/projects/0074-test-feature/status.yaml');
    });
  });

  describe('readState', () => {
    it('should throw error for non-existent file', () => {
      expect(() => {
        readState('/nonexistent/path/status.yaml');
      }).toThrow('Project not found');
    });

    it('should throw error for invalid YAML', () => {
      const statusFile = path.join(projectsDir, '0074-test', 'status.yaml');
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, '{ invalid yaml :::');

      expect(() => {
        readState(statusFile);
      }).toThrow('YAML parse error');
    });

    it('should throw error for missing required fields', () => {
      const statusFile = path.join(projectsDir, '0074-test', 'status.yaml');
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, 'title: test\n');

      expect(() => {
        readState(statusFile);
      }).toThrow('missing required fields');
    });

    it('should read valid state file', () => {
      const state = createSampleState();
      const statusFile = path.join(projectsDir, '0074-test', 'status.yaml');
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });

      // Write using js-yaml format
      const yaml = `id: "${state.id}"
title: "${state.title}"
protocol: "${state.protocol}"
phase: "${state.phase}"
plan_phases: []
current_plan_phase: null
gates:
  spec_approval:
    status: pending
started_at: "${state.started_at}"
updated_at: "${state.updated_at}"
`;
      fs.writeFileSync(statusFile, yaml);

      const read = readState(statusFile);
      expect(read.id).toBe('0074');
      expect(read.title).toBe('test-feature');
      expect(read.protocol).toBe('spider');
      expect(read.phase).toBe('specify');
    });
  });

  describe('writeState', () => {
    it('should write state atomically', () => {
      const state = createSampleState();
      const statusFile = path.join(projectsDir, '0074-test', 'status.yaml');

      writeState(statusFile, state);

      expect(fs.existsSync(statusFile)).toBe(true);
      expect(fs.existsSync(`${statusFile}.tmp`)).toBe(false); // tmp should be removed
    });

    it('should update timestamp on write', () => {
      const state = createSampleState({
        updated_at: '2026-01-01T00:00:00Z',
      });
      const statusFile = path.join(projectsDir, '0074-test', 'status.yaml');

      writeState(statusFile, state);
      const read = readState(statusFile);

      // updated_at should be newer than the original
      expect(new Date(read.updated_at).getTime()).toBeGreaterThan(
        new Date('2026-01-01T00:00:00Z').getTime()
      );
    });

    it('should round-trip state correctly', () => {
      const state = createSampleState({
        phase: 'implement',
        plan_phases: [
          { id: 'phase_1', title: 'Core types', status: 'complete' },
          { id: 'phase_2', title: 'State mgmt', status: 'in_progress' },
        ],
        current_plan_phase: 'phase_2',
        gates: {
          spec_approval: { status: 'approved', approved_at: '2026-01-20T10:00:00Z' },
          plan_approval: { status: 'approved', approved_at: '2026-01-20T11:00:00Z' },
        },
      });
      const statusFile = path.join(projectsDir, '0074-test', 'status.yaml');

      writeState(statusFile, state);
      const read = readState(statusFile);

      expect(read.id).toBe('0074');
      expect(read.phase).toBe('implement');
      expect(read.plan_phases).toHaveLength(2);
      expect(read.plan_phases[0].status).toBe('complete');
      expect(read.current_plan_phase).toBe('phase_2');
      expect(read.gates.spec_approval.status).toBe('approved');
    });
  });

  describe('createInitialState', () => {
    it('should create state with first phase', () => {
      const state = createInitialState(sampleProtocol, '0075', 'new-feature');

      expect(state.id).toBe('0075');
      expect(state.title).toBe('new-feature');
      expect(state.protocol).toBe('spider');
      expect(state.phase).toBe('specify');
    });

    it('should initialize gates from protocol', () => {
      const state = createInitialState(sampleProtocol, '0075', 'new-feature');

      expect(state.gates.spec_approval).toEqual({ status: 'pending' });
      expect(state.gates.plan_approval).toEqual({ status: 'pending' });
      expect(state.gates.review_approval).toEqual({ status: 'pending' });
    });

    it('should set timestamps', () => {
      const before = new Date().toISOString();
      const state = createInitialState(sampleProtocol, '0075', 'new-feature');
      const after = new Date().toISOString();

      expect(state.started_at >= before).toBe(true);
      expect(state.started_at <= after).toBe(true);
      expect(state.updated_at).toBe(state.started_at);
    });
  });

  describe('findStatusPath', () => {
    it('should return null for non-existent project', () => {
      const result = findStatusPath(testDir, '9999');
      expect(result).toBeNull();
    });

    it('should find project by ID prefix', () => {
      // Create a project
      const projectDir = path.join(projectsDir, '0074-test-feature');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "0074"\nprotocol: spider\nphase: specify\n');

      const result = findStatusPath(testDir, '0074');

      expect(result).not.toBeNull();
      expect(result).toContain('0074-test-feature');
    });

    it('should return null if projects directory does not exist', () => {
      const emptyDir = path.join(testDir, 'empty');
      fs.mkdirSync(emptyDir);

      const result = findStatusPath(emptyDir, '0074');
      expect(result).toBeNull();
    });
  });
});
