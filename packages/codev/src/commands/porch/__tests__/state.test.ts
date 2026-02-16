/**
 * Tests for porch state management
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
  detectProjectId,
  detectProjectIdFromCwd,
  resolveProjectId,
  getProjectDir,
  getStatusPath,
  PROJECTS_DIR,
} from '../state.js';
import type { ProjectState, Protocol } from '../types.js';

describe('porch state management', () => {
  const testDir = path.join(tmpdir(), `porch-state-test-${Date.now()}`);
  const projectsDir = path.join(testDir, PROJECTS_DIR);

  // Sample protocol for testing
  const sampleProtocol: Protocol = {
    name: 'spir',
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
      protocol: 'spir',
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
      expect(read.protocol).toBe('spir');
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
      expect(state.protocol).toBe('spir');
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
      fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "0074"\nprotocol: spir\nphase: specify\n');

      const result = findStatusPath(testDir, '0074');

      expect(result).not.toBeNull();
      expect(result).toContain('0074-test-feature');
    });

    it('should find bugfix project by bugfix ID prefix', () => {
      const projectDir = path.join(projectsDir, 'bugfix-237-fix-spawn');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "bugfix-237"\nprotocol: bugfix\nphase: investigate\n');

      const result = findStatusPath(testDir, 'bugfix-237');

      expect(result).not.toBeNull();
      expect(result).toContain('bugfix-237-fix-spawn');
    });

    it('should return null if projects directory does not exist', () => {
      const emptyDir = path.join(testDir, 'empty');
      fs.mkdirSync(emptyDir);

      const result = findStatusPath(emptyDir, '0074');
      expect(result).toBeNull();
    });
  });

  describe('detectProjectId (filesystem scan)', () => {
    it('should detect a single bugfix project', () => {
      const projectDir = path.join(projectsDir, 'bugfix-42-login-bug');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "bugfix-42"\n');

      expect(detectProjectId(testDir)).toBe('bugfix-42');
    });

    it('should return null when multiple projects exist (bugfix + spec)', () => {
      const bugfixDir = path.join(projectsDir, 'bugfix-42-login-bug');
      fs.mkdirSync(bugfixDir, { recursive: true });
      fs.writeFileSync(path.join(bugfixDir, 'status.yaml'), 'id: "bugfix-42"\n');

      const specDir = path.join(projectsDir, '0001-feature');
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, 'status.yaml'), 'id: "0001"\n');

      expect(detectProjectId(testDir)).toBeNull();
    });
  });

  describe('detectProjectIdFromCwd', () => {
    it('should detect project ID from spec worktree root', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/0073')).toBe('0073');
    });

    it('should detect project ID from spec worktree subdirectory', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/0073/src/commands/')).toBe('0073');
    });

    it('should return full bugfix ID from bugfix worktree', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/bugfix-228')).toBe('bugfix-228');
    });

    it('should detect bugfix ID from subdirectory', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/bugfix-228/src/deep/path')).toBe('bugfix-228');
    });

    it('should return full bugfix ID for single-digit issue numbers', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/bugfix-5')).toBe('bugfix-5');
    });

    it('should handle bugfix IDs > 9999', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/bugfix-12345')).toBe('bugfix-12345');
    });

    it('should detect bugfix ID from worktree with slug suffix', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/bugfix-332-fix-login-bug')).toBe('bugfix-332');
    });

    it('should detect bugfix ID from slug-suffixed worktree subdirectory', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/bugfix-332-fix-login-bug/src/commands/')).toBe('bugfix-332');
    });

    it('should return null for task worktrees', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/task-aB2C')).toBeNull();
    });

    it('should return null for maintain worktrees', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/maintain-xY9z')).toBeNull();
    });

    it('should return null for protocol worktrees', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/spir-aB2C')).toBeNull();
    });

    it('should return null for non-worktree paths', () => {
      expect(detectProjectIdFromCwd('/regular/path/no/builders')).toBeNull();
    });

    it('should return null for worktree names with extra text after ID', () => {
      expect(detectProjectIdFromCwd('/repo/.builders/0073-extra-text/')).toBeNull();
    });

    it('should not match partial .builders in unrelated paths', () => {
      expect(detectProjectIdFromCwd('/repo/not.builders/0073')).toBeNull();
    });
  });

  describe('resolveProjectId (priority chain)', () => {
    let singleProjectRoot: string;
    let emptyProjectRoot: string;

    beforeEach(() => {
      // Create a temp dir with exactly one project for filesystem scan tests
      singleProjectRoot = fs.mkdtempSync(path.join(tmpdir(), 'resolve-single-'));
      const projectDir = path.join(singleProjectRoot, PROJECTS_DIR, '0099-test-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "0099"\n');

      // Create a temp dir with no projects for error path tests
      emptyProjectRoot = fs.mkdtempSync(path.join(tmpdir(), 'resolve-empty-'));
      fs.mkdirSync(path.join(emptyProjectRoot, PROJECTS_DIR), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(singleProjectRoot, { recursive: true, force: true });
      fs.rmSync(emptyProjectRoot, { recursive: true, force: true });
    });

    it('step 1: explicit arg takes highest priority over CWD and filesystem scan', () => {
      // Even when CWD is a worktree and filesystem has a project, explicit arg wins
      const result = resolveProjectId('0042', '/repo/.builders/0073', singleProjectRoot);
      expect(result).toEqual({ id: '0042', source: 'explicit' });
    });

    it('step 2: CWD worktree detection takes precedence over filesystem scan', () => {
      // No explicit arg, CWD is a worktree -> CWD detection wins over filesystem scan
      const result = resolveProjectId(undefined, '/repo/.builders/0073', singleProjectRoot);
      expect(result).toEqual({ id: '0073', source: 'cwd' });
    });

    it('step 2: CWD bugfix worktree resolves to full bugfix ID', () => {
      const result = resolveProjectId(undefined, '/repo/.builders/bugfix-42', singleProjectRoot);
      expect(result).toEqual({ id: 'bugfix-42', source: 'cwd' });
    });

    it('step 2: CWD bugfix worktree with slug suffix resolves to bugfix ID', () => {
      const result = resolveProjectId(undefined, '/repo/.builders/bugfix-42-fix-login-bug', singleProjectRoot);
      expect(result).toEqual({ id: 'bugfix-42', source: 'cwd' });
    });

    it('step 3: falls back to filesystem scan when CWD is not a worktree', () => {
      // No explicit arg, CWD is NOT a worktree -> filesystem scan finds the project
      const result = resolveProjectId(undefined, '/regular/path', singleProjectRoot);
      expect(result).toEqual({ id: '0099', source: 'filesystem' });
    });

    it('step 4: throws when no detection method succeeds', () => {
      // No explicit arg, CWD is NOT a worktree, no projects on filesystem
      expect(() => resolveProjectId(undefined, '/regular/path', emptyProjectRoot))
        .toThrow('Cannot determine project ID');
    });

    it('step 4: task/protocol worktrees fall through to error when no filesystem match', () => {
      // Task worktrees return null from CWD detection, and empty root has no projects
      expect(() => resolveProjectId(undefined, '/repo/.builders/task-aB2C', emptyProjectRoot))
        .toThrow('Cannot determine project ID');
    });
  });
});
