/**
 * Unit tests for overview.ts (Spec 0126 Phase 4)
 *
 * Tests: OverviewCache TTL, degraded mode, builder discovery,
 * backlog derivation, PR linkage, and status.yaml parsing.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  OverviewCache,
  parseStatusYaml,
  discoverBuilders,
  deriveBacklog,
  extractProjectIdFromWorktreeName,
  worktreeNameToRoleId,
  calculateProgress,
  calculateEvenProgress,
  detectBlocked,
} from '../servers/overview.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockFetchPRList, mockFetchIssueList, mockLoadProtocol } = vi.hoisted(() => ({
  mockFetchPRList: vi.fn(),
  mockFetchIssueList: vi.fn(),
  mockLoadProtocol: vi.fn(),
}));

vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  return {
    ...actual,
    fetchPRList: mockFetchPRList,
    fetchIssueList: mockFetchIssueList,
  };
});

vi.mock('../../commands/porch/protocol.js', () => ({
  loadProtocol: mockLoadProtocol,
}));

// ============================================================================
// Temp directory helper
// ============================================================================

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
}

function createBuilderWorktree(
  root: string,
  builderName: string,
  statusYaml?: string,
  projectDirName?: string,
): string {
  const builderDir = path.join(root, '.builders', builderName);
  if (statusYaml) {
    const dirName = projectDirName || 'test-project';
    const projectDir = path.join(builderDir, 'codev', 'projects', dirName);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), statusYaml);
  } else {
    fs.mkdirSync(builderDir, { recursive: true });
  }
  return builderDir;
}

function createSpecFile(root: string, issueNumber: number, name: string): void {
  const specsDir = path.join(root, 'codev', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${issueNumber}-${name}.md`), `# ${name}`);
}

// ============================================================================
// Tests
// ============================================================================

describe('overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTmpDir();
    mockFetchPRList.mockResolvedValue([]);
    mockFetchIssueList.mockResolvedValue([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // parseStatusYaml
  // ==========================================================================

  describe('parseStatusYaml', () => {
    it('parses all top-level fields', () => {
      const yaml = [
        "id: '0126'",
        'title: project-management-rework',
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: tower_endpoint',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.id).toBe('0126');
      expect(result.title).toBe('project-management-rework');
      expect(result.protocol).toBe('spir');
      expect(result.phase).toBe('implement');
      expect(result.currentPlanPhase).toBe('tower_endpoint');
    });

    it('parses gates section', () => {
      const yaml = [
        "id: '0126'",
        'gates:',
        '  spec-approval:',
        '    status: approved',
        '  plan-approval:',
        '    status: approved',
        '  pr-ready:',
        '    status: pending',
        'iteration: 1',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gates).toEqual({
        'spec-approval': 'approved',
        'plan-approval': 'approved',
        'pr-ready': 'pending',
      });
    });

    it('handles missing fields gracefully', () => {
      const result = parseStatusYaml('');
      expect(result.id).toBe('');
      expect(result.phase).toBe('');
      expect(result.gates).toEqual({});
    });

    it('handles id without quotes', () => {
      const yaml = 'id: 42\ntitle: test';
      const result = parseStatusYaml(yaml);
      expect(result.id).toBe('42');
    });

    it('parses plan_phases section', () => {
      const yaml = [
        "id: '0124'",
        'protocol: spir',
        'phase: implement',
        'plan_phases:',
        '  - id: phase_1',
        '    title: Remove obsolete files',
        '    status: complete',
        '  - id: phase_2',
        '    title: Consolidate tests',
        '    status: in_progress',
        '  - id: phase_3',
        '    title: Final verification',
        '    status: pending',
        'current_plan_phase: phase_2',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.planPhases).toHaveLength(3);
      expect(result.planPhases[0]).toEqual({ id: 'phase_1', title: 'Remove obsolete files', status: 'complete' });
      expect(result.planPhases[1]).toEqual({ id: 'phase_2', title: 'Consolidate tests', status: 'in_progress' });
      expect(result.planPhases[2]).toEqual({ id: 'phase_3', title: 'Final verification', status: 'pending' });
    });

    it('parses gate requested_at fields', () => {
      const yaml = [
        "id: '0124'",
        'gates:',
        '  spec-approval:',
        '    status: approved',
        "    requested_at: '2026-02-16T03:47:00.754Z'",
        '  plan-approval:',
        '    status: pending',
        "    requested_at: '2026-02-16T04:24:06.254Z'",
        '  pr-ready:',
        '    status: pending',
        'iteration: 1',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateRequestedAt['spec-approval']).toBe('2026-02-16T03:47:00.754Z');
      expect(result.gateRequestedAt['plan-approval']).toBe('2026-02-16T04:24:06.254Z');
      expect(result.gateRequestedAt['pr-ready']).toBeUndefined();
    });

    it('returns empty planPhases when section is absent', () => {
      const yaml = "id: '0100'\nprotocol: spir\nphase: specify";
      const result = parseStatusYaml(yaml);
      expect(result.planPhases).toEqual([]);
    });

    it('returns empty gateRequestedAt when no requested_at present', () => {
      const yaml = [
        'gates:',
        '  spec-approval:',
        '    status: pending',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateRequestedAt).toEqual({});
    });

    it('ignores requested_at: null and requested_at: ~', () => {
      const yaml = [
        'gates:',
        '  spec-approval:',
        '    status: pending',
        '    requested_at: null',
        '  plan-approval:',
        '    status: pending',
        '    requested_at: ~',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateRequestedAt).toEqual({});
    });
  });

  // ==========================================================================
  // calculateProgress
  // ==========================================================================

  describe('calculateProgress', () => {
    function makeParsed(overrides: Partial<ReturnType<typeof parseStatusYaml>> = {}) {
      return {
        id: '0100',
        title: 'test',
        protocol: 'spir',
        phase: 'specify',
        currentPlanPhase: '',
        gates: {},
        gateRequestedAt: {},
        planPhases: [],
        ...overrides,
      };
    }

    it('returns 10 for specify phase (in progress)', () => {
      expect(calculateProgress(makeParsed({ phase: 'specify' }))).toBe(10);
    });

    it('returns 20 for specify phase (gate requested)', () => {
      expect(calculateProgress(makeParsed({
        phase: 'specify',
        gates: { 'spec-approval': 'pending' },
        gateRequestedAt: { 'spec-approval': '2026-01-01T00:00:00Z' },
      }))).toBe(20);
    });

    it('returns 35 for plan phase (in progress)', () => {
      expect(calculateProgress(makeParsed({ phase: 'plan' }))).toBe(35);
    });

    it('returns 45 for plan phase (gate requested)', () => {
      expect(calculateProgress(makeParsed({
        phase: 'plan',
        gates: { 'plan-approval': 'pending' },
        gateRequestedAt: { 'plan-approval': '2026-01-01T00:00:00Z' },
      }))).toBe(45);
    });

    it('returns 70 for implement phase with no plan phases', () => {
      expect(calculateProgress(makeParsed({ phase: 'implement' }))).toBe(70);
    });

    it('returns 50 for implement phase with 0 of 5 complete', () => {
      expect(calculateProgress(makeParsed({
        phase: 'implement',
        planPhases: [
          { id: 'p1', title: 'A', status: 'pending' },
          { id: 'p2', title: 'B', status: 'pending' },
          { id: 'p3', title: 'C', status: 'pending' },
          { id: 'p4', title: 'D', status: 'pending' },
          { id: 'p5', title: 'E', status: 'pending' },
        ],
      }))).toBe(50);
    });

    it('returns 74 for implement phase with 3 of 5 complete', () => {
      expect(calculateProgress(makeParsed({
        phase: 'implement',
        planPhases: [
          { id: 'p1', title: 'A', status: 'complete' },
          { id: 'p2', title: 'B', status: 'complete' },
          { id: 'p3', title: 'C', status: 'complete' },
          { id: 'p4', title: 'D', status: 'in_progress' },
          { id: 'p5', title: 'E', status: 'pending' },
        ],
      }))).toBe(74);
    });

    it('returns 66 for implement phase with 2 of 5 complete', () => {
      expect(calculateProgress(makeParsed({
        phase: 'implement',
        planPhases: [
          { id: 'p1', title: 'A', status: 'complete' },
          { id: 'p2', title: 'B', status: 'complete' },
          { id: 'p3', title: 'C', status: 'in_progress' },
          { id: 'p4', title: 'D', status: 'pending' },
          { id: 'p5', title: 'E', status: 'pending' },
        ],
      }))).toBe(66);
    });

    it('returns 90 for implement phase with all complete', () => {
      expect(calculateProgress(makeParsed({
        phase: 'implement',
        planPhases: [
          { id: 'p1', title: 'A', status: 'complete' },
          { id: 'p2', title: 'B', status: 'complete' },
        ],
      }))).toBe(90);
    });

    it('returns 92 for review phase (in progress)', () => {
      expect(calculateProgress(makeParsed({ phase: 'review' }))).toBe(92);
    });

    it('returns 95 for review phase (gate requested)', () => {
      expect(calculateProgress(makeParsed({
        phase: 'review',
        gates: { 'pr-ready': 'pending' },
        gateRequestedAt: { 'pr-ready': '2026-01-01T00:00:00Z' },
      }))).toBe(95);
    });

    it('returns 100 for complete phase', () => {
      expect(calculateProgress(makeParsed({ phase: 'complete' }))).toBe(100);
    });

    it('works for spider protocol (legacy alias for spir)', () => {
      expect(calculateProgress(makeParsed({ protocol: 'spider', phase: 'implement' }))).toBe(70);
    });

    // Dynamic protocol loading (bugfix, tick, etc.)
    it('loads bugfix phases from protocol.json and calculates progress', () => {
      mockLoadProtocol.mockReturnValue({
        name: 'bugfix',
        phases: [
          { id: 'investigate' },
          { id: 'fix' },
          { id: 'pr' },
        ],
      });

      expect(calculateProgress(makeParsed({ protocol: 'bugfix', phase: 'investigate' }), tmpDir)).toBe(25);
      expect(calculateProgress(makeParsed({ protocol: 'bugfix', phase: 'fix' }), tmpDir)).toBe(50);
      expect(calculateProgress(makeParsed({ protocol: 'bugfix', phase: 'pr' }), tmpDir)).toBe(75);
      expect(calculateProgress(makeParsed({ protocol: 'bugfix', phase: 'complete' }), tmpDir)).toBe(100);
    });

    it('loads tick phases from protocol.json and calculates progress', () => {
      mockLoadProtocol.mockReturnValue({
        name: 'tick',
        phases: [
          { id: 'identify' },
          { id: 'amend_spec' },
          { id: 'amend_plan' },
          { id: 'implement' },
          { id: 'defend' },
          { id: 'evaluate' },
          { id: 'review' },
        ],
      });

      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'identify' }), tmpDir)).toBe(13);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'amend_spec' }), tmpDir)).toBe(25);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'amend_plan' }), tmpDir)).toBe(38);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'implement' }), tmpDir)).toBe(50);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'defend' }), tmpDir)).toBe(63);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'evaluate' }), tmpDir)).toBe(75);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'review' }), tmpDir)).toBe(88);
      expect(calculateProgress(makeParsed({ protocol: 'tick', phase: 'complete' }), tmpDir)).toBe(100);
    });

    it('returns 0 when loadProtocol throws (protocol not found)', () => {
      mockLoadProtocol.mockImplementation(() => { throw new Error('not found'); });
      expect(calculateProgress(makeParsed({ protocol: 'nonexistent', phase: 'foo' }), tmpDir)).toBe(0);
    });

    it('returns 0 when no workspaceRoot provided for non-SPIR protocol', () => {
      expect(calculateProgress(makeParsed({ protocol: 'bugfix', phase: 'fix' }))).toBe(0);
    });

    it('returns 0 for unknown phase', () => {
      expect(calculateProgress(makeParsed({ phase: 'unknown' }))).toBe(0);
    });
  });

  // ==========================================================================
  // calculateEvenProgress
  // ==========================================================================

  describe('calculateEvenProgress', () => {
    it('distributes progress evenly across phases', () => {
      const phases = ['a', 'b', 'c'];
      expect(calculateEvenProgress('a', phases)).toBe(25);
      expect(calculateEvenProgress('b', phases)).toBe(50);
      expect(calculateEvenProgress('c', phases)).toBe(75);
    });

    it('returns 100 for complete phase', () => {
      expect(calculateEvenProgress('complete', ['a', 'b'])).toBe(100);
    });

    it('returns 0 for unknown phase', () => {
      expect(calculateEvenProgress('unknown', ['a', 'b'])).toBe(0);
    });

    it('handles single-phase protocol', () => {
      expect(calculateEvenProgress('only', ['only'])).toBe(50);
      expect(calculateEvenProgress('complete', ['only'])).toBe(100);
    });
  });

  // ==========================================================================
  // detectBlocked
  // ==========================================================================

  describe('detectBlocked', () => {
    function makeParsed(overrides: Partial<ReturnType<typeof parseStatusYaml>> = {}) {
      return {
        id: '0100',
        title: 'test',
        protocol: 'spir',
        phase: 'specify',
        currentPlanPhase: '',
        gates: {},
        gateRequestedAt: {},
        planPhases: [],
        ...overrides,
      };
    }

    it('returns null when no gates are pending', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'spec-approval': 'approved', 'plan-approval': 'approved' },
      }))).toBeNull();
    });

    it('returns null when gate is pending but not requested', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'spec-approval': 'pending' },
      }))).toBeNull();
    });

    it('returns "spec review" when spec-approval is pending and requested', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'spec-approval': 'pending' },
        gateRequestedAt: { 'spec-approval': '2026-01-01T00:00:00Z' },
      }))).toBe('spec review');
    });

    it('returns "plan review" when plan-approval is pending and requested', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'spec-approval': 'approved', 'plan-approval': 'pending' },
        gateRequestedAt: { 'plan-approval': '2026-01-01T00:00:00Z' },
      }))).toBe('plan review');
    });

    it('returns "PR review" when pr-ready is pending and requested', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'pr-ready': 'pending' },
        gateRequestedAt: { 'pr-ready': '2026-01-01T00:00:00Z' },
      }))).toBe('PR review');
    });

    it('returns first blocked gate when multiple are pending', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'spec-approval': 'pending', 'plan-approval': 'pending' },
        gateRequestedAt: {
          'spec-approval': '2026-01-01T00:00:00Z',
          'plan-approval': '2026-01-02T00:00:00Z',
        },
      }))).toBe('spec review');
    });
  });

  // ==========================================================================
  // extractProjectIdFromWorktreeName
  // ==========================================================================

  describe('extractProjectIdFromWorktreeName', () => {
    it('extracts zero-padded ID from SPIR worktree', () => {
      expect(extractProjectIdFromWorktreeName('spir-126-slug')).toBe('0126');
    });

    it('zero-pads short SPIR numbers', () => {
      expect(extractProjectIdFromWorktreeName('spir-1-feature')).toBe('0001');
    });

    it('preserves 4+ digit SPIR numbers', () => {
      expect(extractProjectIdFromWorktreeName('spir-9999-big')).toBe('9999');
    });

    it('extracts zero-padded ID from TICK worktree', () => {
      expect(extractProjectIdFromWorktreeName('tick-130-slug')).toBe('0130');
    });

    it('extracts builder-bugfix-N from bugfix worktree', () => {
      expect(extractProjectIdFromWorktreeName('bugfix-296-slug')).toBe('builder-bugfix-296');
    });

    it('extracts legacy numeric ID', () => {
      expect(extractProjectIdFromWorktreeName('0110')).toBe('0110');
    });

    it('extracts legacy numeric ID with slug', () => {
      expect(extractProjectIdFromWorktreeName('0110-legacy-name')).toBe('0110');
    });

    it('returns null for task worktrees', () => {
      expect(extractProjectIdFromWorktreeName('task-NAvW')).toBeNull();
    });

    it('returns null for worktree worktrees', () => {
      expect(extractProjectIdFromWorktreeName('worktree-foIg')).toBeNull();
    });

    it('returns null for unknown prefixes', () => {
      expect(extractProjectIdFromWorktreeName('unknown-123-slug')).toBeNull();
    });
  });

  // ==========================================================================
  // worktreeNameToRoleId
  // ==========================================================================

  describe('worktreeNameToRoleId', () => {
    it('maps SPIR worktree to builder-spir-N', () => {
      expect(worktreeNameToRoleId('spir-126-project-mgmt')).toBe('builder-spir-126');
    });

    it('strips leading zeros from SPIR numbers', () => {
      expect(worktreeNameToRoleId('spir-0001-feature')).toBe('builder-spir-1');
    });

    it('maps TICK worktree to builder-tick-N', () => {
      expect(worktreeNameToRoleId('tick-130-codex-integration')).toBe('builder-tick-130');
    });

    it('maps bugfix worktree to builder-bugfix-N', () => {
      expect(worktreeNameToRoleId('bugfix-296-some-fix')).toBe('builder-bugfix-296');
    });

    it('maps task worktree to builder-task-shortid (lowercased)', () => {
      expect(worktreeNameToRoleId('task-NAvW')).toBe('builder-task-navw');
    });

    it('maps worktree to worktree-shortid (lowercased, no builder- prefix)', () => {
      expect(worktreeNameToRoleId('worktree-foIg')).toBe('worktree-foig');
    });

    it('maps legacy numeric to builder-spir-N', () => {
      expect(worktreeNameToRoleId('0110-legacy-name')).toBe('builder-spir-110');
    });

    it('maps bare legacy numeric', () => {
      expect(worktreeNameToRoleId('0110')).toBe('builder-spir-110');
    });

    it('maps generic protocol worktree to builder-protocol-shortid', () => {
      expect(worktreeNameToRoleId('experiment-AbCd')).toBe('builder-experiment-abcd');
    });

    it('returns null for empty string', () => {
      expect(worktreeNameToRoleId('')).toBeNull();
    });
  });

  // ==========================================================================
  // discoverBuilders
  // ==========================================================================

  describe('discoverBuilders', () => {
    it('returns empty array when .builders/ does not exist', () => {
      expect(discoverBuilders(tmpDir)).toEqual([]);
    });

    it('discovers strict mode builder with matching project dir', () => {
      createBuilderWorktree(tmpDir, 'spir-126-project-mgmt', [
        "id: '0126'",
        'title: project-management-rework',
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: tower_endpoint',
        'gates:',
        '  spec-approval:',
        '    status: approved',
        '  pr-ready:',
        '    status: pending',
      ].join('\n'), '0126-project-management-rework');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('0126');
      expect(builders[0].issueNumber).toBe(126);
      expect(builders[0].phase).toBe('tower_endpoint');
      expect(builders[0].mode).toBe('strict');
      expect(builders[0].gates['pr-ready']).toBe('pending');
      expect(builders[0].protocol).toBe('spir');
      expect(builders[0].progress).toBe(70);
      expect(builders[0].blocked).toBeNull();
    });

    it('discovers soft mode builder for task/worktree types', () => {
      createBuilderWorktree(tmpDir, 'task-AbCd');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('task-AbCd');
      expect(builders[0].mode).toBe('soft');
      expect(builders[0].issueNumber).toBeNull();
      expect(builders[0].phase).toBe('');
      expect(builders[0].protocol).toBe('');
      expect(builders[0].planPhases).toEqual([]);
      expect(builders[0].progress).toBe(0);
      expect(builders[0].blocked).toBeNull();
    });

    it('populates progress and blocked from status.yaml', () => {
      createBuilderWorktree(tmpDir, 'spir-50-feature', [
        "id: '0050'",
        'title: test-feature',
        'protocol: spir',
        'phase: plan',
        'plan_phases:',
        '  - id: phase_1',
        '    title: Setup',
        '    status: pending',
        'gates:',
        '  spec-approval:',
        '    status: approved',
        '  plan-approval:',
        '    status: pending',
        "    requested_at: '2026-02-16T04:00:00Z'",
      ].join('\n'), '0050-test-feature');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].protocol).toBe('spir');
      expect(builders[0].planPhases).toEqual([
        { id: 'phase_1', title: 'Setup', status: 'pending' },
      ]);
      expect(builders[0].progress).toBe(45);
      expect(builders[0].blocked).toBe('plan review');
    });

    it('discovers multiple builders with correct matching', () => {
      createBuilderWorktree(tmpDir, 'spir-100-feature', [
        "id: '0100'",
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: phase_1',
        'gates:',
      ].join('\n'), '0100-feature');

      createBuilderWorktree(tmpDir, 'bugfix-200-fix');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(2);

      const strict = builders.find(b => b.mode === 'strict');
      const soft = builders.find(b => b.mode === 'soft');
      expect(strict?.issueNumber).toBe(100);
      expect(soft?.id).toBe('bugfix-200-fix');
      expect(soft?.issueNumber).toBe(200);
    });

    it('does not pick up wrong project dir (regression: #326)', () => {
      // Simulate the bug scenario: worktree has multiple inherited project dirs
      // The worktree is spir-126 but codev/projects/ also has 0087 (from main)
      const builderDir = path.join(tmpDir, '.builders', 'spir-126-feature');
      const projectsBase = path.join(builderDir, 'codev', 'projects');

      // Create "inherited" project dir (from git, first alphabetically)
      const wrongDir = path.join(projectsBase, '0087-porch-timeout');
      fs.mkdirSync(wrongDir, { recursive: true });
      fs.writeFileSync(path.join(wrongDir, 'status.yaml'), [
        "id: '0087'",
        'title: porch-timeout-termination-retries',
        'protocol: spider',
        'phase: complete',
      ].join('\n'));

      // Create the correct project dir for this worktree
      const rightDir = path.join(projectsBase, '0126-feature');
      fs.mkdirSync(rightDir, { recursive: true });
      fs.writeFileSync(path.join(rightDir, 'status.yaml'), [
        "id: '0126'",
        'title: project-management-rework',
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: tower_endpoint',
      ].join('\n'));

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      // Must match 0126, NOT 0087
      expect(builders[0].id).toBe('0126');
      expect(builders[0].issueNumber).toBe(126);
      expect(builders[0].mode).toBe('strict');
    });

    it('discovers bugfix builder matching builder-bugfix-N project dir', () => {
      // Bugfix worktree with matching project dir (as created by af spawn)
      const builderDir = path.join(tmpDir, '.builders', 'bugfix-326-fix-discover');
      const projectsBase = path.join(builderDir, 'codev', 'projects');

      // Inherited from main
      const inheritedDir = path.join(projectsBase, '0087-porch-timeout');
      fs.mkdirSync(inheritedDir, { recursive: true });
      fs.writeFileSync(path.join(inheritedDir, 'status.yaml'), [
        "id: '0087'",
        'protocol: spider',
        'phase: complete',
      ].join('\n'));

      // The bugfix's own project dir (created by porch init via af spawn)
      const bugfixDir = path.join(projectsBase, 'builder-bugfix-326-fix-discover');
      fs.mkdirSync(bugfixDir, { recursive: true });
      fs.writeFileSync(path.join(bugfixDir, 'status.yaml'), [
        'id: builder-bugfix-326',
        'title: fix-discover',
        'protocol: bugfix',
        'phase: investigate',
      ].join('\n'));

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('builder-bugfix-326');
      expect(builders[0].issueNumber).toBe(326);
      expect(builders[0].mode).toBe('strict');
    });

    it('falls back to soft mode with issue number when no project dir matches', () => {
      // Bugfix worktree with no matching project dir (only inherited ones)
      const builderDir = path.join(tmpDir, '.builders', 'bugfix-300-some-fix');
      const projectsBase = path.join(builderDir, 'codev', 'projects');

      // Only inherited project dir from main
      const wrongDir = path.join(projectsBase, '0087-porch-timeout');
      fs.mkdirSync(wrongDir, { recursive: true });
      fs.writeFileSync(path.join(wrongDir, 'status.yaml'), [
        "id: '0087'",
        'protocol: spider',
        'phase: complete',
      ].join('\n'));

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].mode).toBe('soft');
      expect(builders[0].issueNumber).toBe(300);
      expect(builders[0].id).toBe('bugfix-300-some-fix');
    });

    it('treats builder with codev/projects but no matching status.yaml as soft', () => {
      const builderDir = path.join(tmpDir, '.builders', 'spir-999-no-match');
      fs.mkdirSync(path.join(builderDir, 'codev', 'projects', 'unrelated'), { recursive: true });
      // No status.yaml at all

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].mode).toBe('soft');
      expect(builders[0].issueNumber).toBe(999);
    });

    it('handles multiple worktrees each matching their own project (not all #87)', () => {
      // This is the core regression test for issue #326
      const worktrees = [
        { name: 'spir-87-timeout', projDir: '0087-porch-timeout', id: '0087', issue: 87 },
        { name: 'spir-126-rework', projDir: '0126-project-rework', id: '0126', issue: 126 },
        { name: 'tick-130-amend', projDir: '0130-codex-integration', id: '0130', issue: 130 },
      ];

      for (const wt of worktrees) {
        const builderDir = path.join(tmpDir, '.builders', wt.name);
        const projectsBase = path.join(builderDir, 'codev', 'projects');

        // Each worktree has ALL project dirs (simulating git inheritance)
        for (const other of worktrees) {
          const dir = path.join(projectsBase, other.projDir);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'status.yaml'), [
            `id: '${other.id}'`,
            `title: ${other.projDir.replace(/^\d+-/, '')}`,
            'protocol: spir',
            'phase: implement',
          ].join('\n'));
        }
      }

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(3);

      // Each builder should match its OWN project, not all showing #87
      for (const wt of worktrees) {
        const builder = builders.find(b => b.issueNumber === wt.issue);
        expect(builder).toBeDefined();
        expect(builder!.id).toBe(wt.id);
        expect(builder!.mode).toBe('strict');
      }
    });
  });

  // ==========================================================================
  // deriveBacklog
  // ==========================================================================

  describe('deriveBacklog', () => {
    it('marks issues with matching spec files', () => {
      createSpecFile(tmpDir, 42, 'my-feature');

      const issues = [
        { number: 42, title: 'My Feature', labels: [], createdAt: '2026-01-01T00:00:00Z' },
        { number: 43, title: 'No Spec', labels: [], createdAt: '2026-01-02T00:00:00Z' },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog).toHaveLength(2);

      const issue42 = backlog.find(b => b.number === 42)!;
      expect(issue42.hasSpec).toBe(true);

      const issue43 = backlog.find(b => b.number === 43)!;
      expect(issue43.hasSpec).toBe(false);
    });

    it('marks issues with active builders', () => {
      const issues = [
        { number: 100, title: 'Active', labels: [], createdAt: '2026-01-01T00:00:00Z' },
        { number: 200, title: 'Idle', labels: [], createdAt: '2026-01-02T00:00:00Z' },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set([100]), new Set());
      const active = backlog.find(b => b.number === 100)!;
      const idle = backlog.find(b => b.number === 200)!;

      expect(active.hasBuilder).toBe(true);
      expect(idle.hasBuilder).toBe(false);
    });

    it('filters out issues that have linked PRs', () => {
      const issues = [
        { number: 50, title: 'Has PR', labels: [], createdAt: '2026-01-01T00:00:00Z' },
        { number: 60, title: 'No PR', labels: [], createdAt: '2026-01-02T00:00:00Z' },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set([50]));
      expect(backlog).toHaveLength(1);
      expect(backlog[0].number).toBe(60);
    });

    it('parses type and priority from labels', () => {
      const issues = [
        {
          number: 70,
          title: 'Bug',
          labels: [{ name: 'type:bug' }, { name: 'priority:high' }],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].type).toBe('bug');
      expect(backlog[0].priority).toBe('high');
    });

    it('defaults to feature/medium when labels are missing', () => {
      const issues = [
        { number: 80, title: 'No labels', labels: [], createdAt: '2026-01-01T00:00:00Z' },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].type).toBe('feature');
      expect(backlog[0].priority).toBe('medium');
    });

    it('handles missing codev/specs directory', () => {
      const issues = [
        { number: 90, title: 'Test', labels: [], createdAt: '2026-01-01T00:00:00Z' },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog).toHaveLength(1);
      expect(backlog[0].hasSpec).toBe(false);
    });
  });

  // ==========================================================================
  // OverviewCache
  // ==========================================================================

  describe('OverviewCache', () => {
    it('returns builders, PRs, and backlog', async () => {
      createBuilderWorktree(tmpDir, 'spir-42-test', [
        "id: '0042'",
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: coding',
        'gates:',
      ].join('\n'), '0042-test');

      mockFetchPRList.mockResolvedValue([
        { number: 10, title: '[Spec 42] Add feature', url: 'https://github.com/org/repo/pull/10', reviewDecision: 'APPROVED', body: '', createdAt: '2026-01-10T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([
        { number: 99, title: 'Backlog item', labels: [], createdAt: '2026-01-01T00:00:00Z' },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      expect(data.builders[0].issueNumber).toBe(42);

      expect(data.pendingPRs).toHaveLength(1);
      expect(data.pendingPRs[0].linkedIssue).toBe(42);

      expect(data.backlog).toHaveLength(1);
      expect(data.backlog[0].number).toBe(99);

      expect(data.errors).toBeUndefined();
    });

    it('caches PR data within TTL', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      await cache.getOverview(tmpDir);

      // fetchPRList should only be called once (second call is cached)
      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
    });

    it('invalidates cache on refresh', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      cache.invalidate();
      await cache.getOverview(tmpDir);

      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
    });

    it('returns degraded data when gh fails for PRs', async () => {
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs).toEqual([]);
      expect(data.errors?.prs).toContain('unavailable');
    });

    it('returns degraded data when gh fails for issues', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue(null);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.backlog).toEqual([]);
      expect(data.errors?.issues).toContain('unavailable');
    });

    it('returns degraded data when both gh calls fail', async () => {
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue(null);

      createBuilderWorktree(tmpDir, 'spir-1-test', [
        "id: '0001'",
        'protocol: spir',
        'phase: specify',
        'current_plan_phase: draft',
        'gates:',
      ].join('\n'), '0001-test');

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      // Builders still returned even when gh fails
      expect(data.builders).toHaveLength(1);
      expect(data.pendingPRs).toEqual([]);
      expect(data.backlog).toEqual([]);
      expect(data.errors?.prs).toBeDefined();
      expect(data.errors?.issues).toBeDefined();
    });

    it('does not cache failed fetch results', async () => {
      // First call: gh fails
      mockFetchPRList.mockResolvedValueOnce(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data1 = await cache.getOverview(tmpDir);
      expect(data1.errors?.prs).toBeDefined();

      // Second call: gh succeeds
      mockFetchPRList.mockResolvedValueOnce([
        { number: 1, title: 'Test', url: 'https://github.com/org/repo/pull/1', reviewDecision: '', body: '', createdAt: '2026-01-01T00:00:00Z' },
      ]);

      const data2 = await cache.getOverview(tmpDir);
      expect(data2.errors?.prs).toBeUndefined();
      expect(data2.pendingPRs).toHaveLength(1);
    });

    it('filters backlog issues that are linked to PRs', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 10, title: 'Fix', url: 'https://github.com/org/repo/pull/10', reviewDecision: '', body: 'Fixes #42', createdAt: '2026-01-10T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([
        { number: 42, title: 'Bug 42', labels: [], createdAt: '2026-01-01T00:00:00Z' },
        { number: 43, title: 'Bug 43', labels: [], createdAt: '2026-01-02T00:00:00Z' },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      // Issue 42 is linked to a PR, so it should not appear in backlog
      expect(data.backlog).toHaveLength(1);
      expect(data.backlog[0].number).toBe(43);

      // PR linkage should be parsed
      expect(data.pendingPRs[0].linkedIssue).toBe(42);
    });

    it('passes through PR url field', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 5, title: 'Test PR', url: 'https://github.com/org/repo/pull/5', reviewDecision: 'APPROVED', body: '', createdAt: '2026-01-05T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs[0].url).toBe('https://github.com/org/repo/pull/5');
    });

    it('parses PR review statuses', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 1, title: 'Approved', url: 'https://github.com/org/repo/pull/1', reviewDecision: 'APPROVED', body: '', createdAt: '2026-01-01T00:00:00Z' },
        { number: 2, title: 'Changes', url: 'https://github.com/org/repo/pull/2', reviewDecision: 'CHANGES_REQUESTED', body: '', createdAt: '2026-01-02T00:00:00Z' },
        { number: 3, title: 'Pending', url: 'https://github.com/org/repo/pull/3', reviewDecision: '', body: '', createdAt: '2026-01-03T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs[0].reviewStatus).toBe('APPROVED');
      expect(data.pendingPRs[1].reviewStatus).toBe('CHANGES_REQUESTED');
      expect(data.pendingPRs[2].reviewStatus).toBe('REVIEW_REQUIRED');
    });

    it('passes workspace root as cwd to gh CLI calls', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      expect(mockFetchPRList).toHaveBeenCalledWith(tmpDir);
      expect(mockFetchIssueList).toHaveBeenCalledWith(tmpDir);
    });

    it('filters builders to only those with active terminal sessions', async () => {
      // Create 3 worktrees: spir-42, bugfix-99, task-AbCd
      createBuilderWorktree(tmpDir, 'spir-42-feature', [
        "id: '0042'",
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: coding',
        'gates:',
      ].join('\n'), '0042-feature');

      createBuilderWorktree(tmpDir, 'bugfix-99-fix', [
        'id: builder-bugfix-99',
        'title: fix-something',
        'protocol: bugfix',
        'phase: investigate',
      ].join('\n'), 'builder-bugfix-99-fix-something');

      createBuilderWorktree(tmpDir, 'task-AbCd');

      // Without filter: all 3 worktrees discovered
      const cache = new OverviewCache();
      const unfiltered = await cache.getOverview(tmpDir);
      expect(unfiltered.builders).toHaveLength(3);

      // With filter: only spir-42 has an active session
      cache.invalidate();
      const activeSet = new Set(['builder-spir-42']);
      const filtered = await cache.getOverview(tmpDir, activeSet);
      expect(filtered.builders).toHaveLength(1);
      expect(filtered.builders[0].issueNumber).toBe(42);
    });

    it('returns no builders when activeBuilderRoleIds is empty', async () => {
      createBuilderWorktree(tmpDir, 'spir-42-feature', [
        "id: '0042'",
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: coding',
        'gates:',
      ].join('\n'), '0042-feature');

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir, new Set());
      expect(data.builders).toHaveLength(0);
    });

    it('invalidates cache when workspace root changes', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      // Create a second tmp dir to simulate workspace switch
      const tmpDir2 = makeTmpDir();
      try {
        await cache.getOverview(tmpDir2);

        // Both fetches should be called twice (once per workspace)
        expect(mockFetchPRList).toHaveBeenCalledTimes(2);
        expect(mockFetchIssueList).toHaveBeenCalledTimes(2);
        expect(mockFetchPRList).toHaveBeenLastCalledWith(tmpDir2);
        expect(mockFetchIssueList).toHaveBeenLastCalledWith(tmpDir2);
      } finally {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });
});
