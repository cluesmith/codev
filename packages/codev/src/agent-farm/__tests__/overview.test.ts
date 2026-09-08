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
import Database from 'better-sqlite3';
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
  detectBlockedSince,
  computeIdleMs,
  derivePrReady,
  countQueuedFeedback,
  readFeedbackMode,
} from '../servers/overview.js';
import { negativeTtlMs, projectHourlyForgeCalls } from '../servers/overview-budget.js';
import {
  noteRateLimited,
  resetForgeRateLimit,
  isForgeSuspended,
  getForgeRateLimit,
} from '../../lib/forge-rate-limit.js';
import { resolveConceptBackend } from '../../lib/forge.js';

/**
 * The backend the overview's list concepts resolve to in these tests — the
 * github scripts, so `gh`. Rate-limit state is keyed by backend (#1645), not by
 * the workspace's configured provider.
 */
const OVERVIEW_BACKEND = resolveConceptBackend('issue-list', null);
import { projectHourlyGraphqlPoints, GRAPHQL_POINTS_PER_CALL } from '../servers/overview-budget.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockFetchPRList, mockFetchIssueList, mockFetchRecentlyClosed, mockFetchMergedPRs, mockLoadProtocol, mockFetchCurrentUser, dbState } = vi.hoisted(() => ({
  mockFetchPRList: vi.fn(),
  mockFetchIssueList: vi.fn(),
  mockFetchRecentlyClosed: vi.fn(),
  mockFetchMergedPRs: vi.fn(),
  mockLoadProtocol: vi.fn(),
  mockFetchCurrentUser: vi.fn(),
  // Issue #1118: overview reads builders from getGlobalDbPath(); point it at a
  // per-test path under tmpDir so each test is isolated.
  dbState: { globalDbPath: '' },
}));

vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  return {
    ...actual,
    fetchPRList: mockFetchPRList,
    fetchIssueList: mockFetchIssueList,
    fetchRecentlyClosed: mockFetchRecentlyClosed,
    fetchRecentMergedPRs: mockFetchMergedPRs,
    fetchCurrentUser: mockFetchCurrentUser,
  };
});

vi.mock('../../commands/porch/protocol.js', () => ({
  loadProtocol: mockLoadProtocol,
}));

// Issue #1118: builders now live in global.db; redirect getGlobalDbPath to a
// per-test file (set in beforeEach) so the enrichment read is isolated.
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { normalizeWorkspacePath } from '../servers/tower-utils.js';

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

function createPlanFile(root: string, issueNumber: number, name: string): void {
  const plansDir = path.join(root, 'codev', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${issueNumber}-${name}.md`), `# ${name}`);
}

function createReviewFile(root: string, issueNumber: number, name: string): void {
  const reviewsDir = path.join(root, 'codev', 'reviews');
  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.writeFileSync(path.join(reviewsDir, `${issueNumber}-${name}.md`), `# ${name}`);
}

function issueItem(number: number, title: string, labels: Array<{ name: string }> = []): { number: number; title: string; url: string; labels: Array<{ name: string }>; createdAt: string } {
  return { number, title, url: `https://github.com/org/repo/issues/${number}`, labels, createdAt: '2026-01-01T00:00:00Z' };
}

/**
 * Create a state.db in the workspace's .agent-farm/ with builder rows.
 * Spec 823 extended the schema with `spawned_by_architect` (nullable) so tests
 * can exercise the enrichment path for both issue_number and spawnedByArchitect.
 */
function createStateDb(
  root: string,
  rows: Array<{ worktree: string; issue_number?: number | string | null; spawned_by_architect?: string | null }>,
): void {
  // Issue #1118: builders live in global.db, keyed by (workspace_path, id) and
  // read scoped by workspace_path. Write to the per-test global path with rows
  // tagged for this workspace.
  fs.mkdirSync(path.dirname(dbState.globalDbPath), { recursive: true });
  const db = new Database(dbState.globalDbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS builders (
    workspace_path TEXT NOT NULL,
    id TEXT NOT NULL,
    worktree TEXT,
    issue_number TEXT,
    spawned_by_architect TEXT,
    PRIMARY KEY (workspace_path, id)
  )`);
  const ws = normalizeWorkspacePath(root);
  const insert = db.prepare(
    'INSERT INTO builders (workspace_path, id, worktree, issue_number, spawned_by_architect) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(
      ws,
      row.worktree, // id: unique per workspace
      row.worktree,
      row.issue_number == null ? null : String(row.issue_number),
      row.spawned_by_architect ?? null,
    );
  }
  db.close();
}

// ============================================================================
// Tests
// ============================================================================

describe('overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #1645: the forge rate-limit suspension is module-level process state.
    resetForgeRateLimit();
    tmpDir = makeTmpDir();
    // Issue #1118: per-test global.db path (file created lazily by createStateDb).
    dbState.globalDbPath = path.join(tmpDir, '.agent-farm', 'global.db');
    mockFetchPRList.mockResolvedValue([]);
    mockFetchIssueList.mockResolvedValue([]);
    mockFetchRecentlyClosed.mockResolvedValue([]);
    mockFetchMergedPRs.mockResolvedValue([]);
    mockFetchCurrentUser.mockResolvedValue('octocat');
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

    it('parses started_at field (Bugfix #388)', () => {
      const yaml = [
        'id: bugfix-388',
        'protocol: bugfix',
        'phase: fix',
        "started_at: '2026-02-17T08:54:32.623Z'",
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.startedAt).toBe('2026-02-17T08:54:32.623Z');
    });

    it('returns empty startedAt when not present', () => {
      const result = parseStatusYaml('id: test\nphase: fix');
      expect(result.startedAt).toBe('');
    });

    it('parses gates section', () => {
      const yaml = [
        "id: '0126'",
        'gates:',
        '  spec-approval:',
        '    status: approved',
        '  plan-approval:',
        '    status: approved',
        '  pr:',
        '    status: pending',
        'iteration: 1',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gates).toEqual({
        'spec-approval': 'approved',
        'plan-approval': 'approved',
        'pr': 'pending',
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
        '  pr:',
        '    status: pending',
        'iteration: 1',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateRequestedAt['spec-approval']).toBe('2026-02-16T03:47:00.754Z');
      expect(result.gateRequestedAt['plan-approval']).toBe('2026-02-16T04:24:06.254Z');
      expect(result.gateRequestedAt['pr']).toBeUndefined();
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

    it('parses gate approved_at fields (Bugfix #405)', () => {
      const yaml = [
        "id: '0124'",
        'gates:',
        '  spec-approval:',
        '    status: approved',
        "    requested_at: '2026-02-16T03:47:00.754Z'",
        "    approved_at: '2026-02-16T04:17:44.002Z'",
        '  plan-approval:',
        '    status: approved',
        "    approved_at: '2026-02-16T04:30:17.176Z'",
        '  pr:',
        '    status: pending',
        "    requested_at: '2026-02-16T05:00:00.000Z'",
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateApprovedAt['spec-approval']).toBe('2026-02-16T04:17:44.002Z');
      expect(result.gateApprovedAt['plan-approval']).toBe('2026-02-16T04:30:17.176Z');
      expect(result.gateApprovedAt['pr']).toBeUndefined();
    });

    it('ignores approved_at: null and approved_at: ~', () => {
      const yaml = [
        'gates:',
        '  spec-approval:',
        '    status: approved',
        '    approved_at: null',
        '  plan-approval:',
        '    status: approved',
        '    approved_at: ~',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateApprovedAt).toEqual({});
    });

    it('returns empty gateApprovedAt when no approved_at present', () => {
      const yaml = [
        'gates:',
        '  spec-approval:',
        '    status: pending',
        "    requested_at: '2026-02-16T03:47:00.754Z'",
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.gateApprovedAt).toEqual({});
    });

    it('defaults merged to false when pr_history is absent (#966)', () => {
      const result = parseStatusYaml("id: '0100'\nphase: review");
      expect(result.merged).toBe(false);
    });

    it('parses merged: true from the pr_history entry (#966)', () => {
      const yaml = [
        "id: '2019'",
        'protocol: bugfix',
        'phase: review',
        'gates:',
        '  pr:',
        '    status: pending',
        "    requested_at: '2026-06-02T15:14:59.000Z'",
        'pr_history:',
        '  - phase: review',
        '    pr_number: 2030',
        '    branch: builder/spir-2019',
        "    created_at: '2026-06-02T15:10:00.000Z'",
        '    merged: true',
        "    merged_at: '2026-06-02T15:14:34.000Z'",
        'pr_ready_for_human: true',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.merged).toBe(true);
      // sanity: the surrounding fields still parse correctly around the new section
      expect(result.gates['pr']).toBe('pending');
      expect(result.gateRequestedAt['pr']).toBe('2026-06-02T15:14:59.000Z');
    });

    it('parses merged: false (open PR) in pr_history (#966)', () => {
      const yaml = [
        "id: '0100'",
        'phase: review',
        'pr_history:',
        '  - phase: review',
        '    pr_number: 50',
        '    branch: builder/bugfix-100',
        "    created_at: '2026-06-02T15:10:00.000Z'",
        '    merged: false',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.merged).toBe(false);
    });

    it('reflects the LAST pr_history entry — earlier merged PR + later open PR (#966)', () => {
      // SPIR/PIR checkpoint workflow: an earlier checkpoint PR merged, but a later
      // PR is still open and awaiting review. The current pr gate is for the LATEST
      // PR (not merged), so the builder is genuinely PR-ready.
      const yaml = [
        "id: '0100'",
        'protocol: spir',
        'phase: review',
        'pr_history:',
        '  - phase: implement',
        '    pr_number: 40',
        '    branch: builder/spir-100',
        "    created_at: '2026-06-01T00:00:00.000Z'",
        '    merged: true',
        "    merged_at: '2026-06-01T01:00:00.000Z'",
        '  - phase: review',
        '    pr_number: 41',
        '    branch: builder/spir-100',
        "    created_at: '2026-06-02T00:00:00.000Z'",
        '    merged: false',
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.merged).toBe(false);
    });

    it('reflects the LAST pr_history entry when the later entry has no merged key (#966)', () => {
      // The later (open) PR has no `merged` key at all — must still read as not-merged.
      const yaml = [
        "id: '0100'",
        'protocol: spir',
        'phase: review',
        'pr_history:',
        '  - phase: implement',
        '    pr_number: 40',
        '    branch: builder/spir-100',
        "    created_at: '2026-06-01T00:00:00.000Z'",
        '    merged: true',
        "    merged_at: '2026-06-01T01:00:00.000Z'",
        '  - phase: review',
        '    pr_number: 41',
        '    branch: builder/spir-100',
        "    created_at: '2026-06-02T00:00:00.000Z'",
      ].join('\n');

      const result = parseStatusYaml(yaml);
      expect(result.merged).toBe(false);
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
        gateApprovedAt: {},
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
        gates: { 'pr': 'pending' },
        gateRequestedAt: { 'pr': '2026-01-01T00:00:00Z' },
      }))).toBe(95);
    });

    it('returns 100 for verified phase', () => {
      expect(calculateProgress(makeParsed({ phase: 'verified' }))).toBe(100);
    });

    it('returns 100 for legacy complete phase (backward compat)', () => {
      expect(calculateProgress(makeParsed({ phase: 'complete' }))).toBe(100);
    });

    it('works for spider protocol (legacy alias for spir)', () => {
      expect(calculateProgress(makeParsed({ protocol: 'spider', phase: 'implement' }))).toBe(70);
    });

    // ASPIR uses the same phase structure as SPIR (Bugfix #454)
    it('uses SPIR progress for ASPIR protocol', () => {
      expect(calculateProgress(makeParsed({ protocol: 'aspir', phase: 'specify' }))).toBe(10);
      expect(calculateProgress(makeParsed({ protocol: 'aspir', phase: 'plan' }))).toBe(35);
      expect(calculateProgress(makeParsed({ protocol: 'aspir', phase: 'implement' }))).toBe(70);
      expect(calculateProgress(makeParsed({ protocol: 'aspir', phase: 'review' }))).toBe(92);
      expect(calculateProgress(makeParsed({ protocol: 'aspir', phase: 'verified' }))).toBe(100);
    });

    it('tracks ASPIR implement plan phases like SPIR (Bugfix #454)', () => {
      expect(calculateProgress(makeParsed({
        protocol: 'aspir',
        phase: 'implement',
        planPhases: [
          { id: 'p1', title: 'A', status: 'complete' },
          { id: 'p2', title: 'B', status: 'complete' },
          { id: 'p3', title: 'C', status: 'in_progress' },
          { id: 'p4', title: 'D', status: 'pending' },
        ],
      }))).toBe(70); // 50 + round((2/4) * 40) = 50 + 20 = 70
    });

    it('shows ASPIR review gate requested progress (Bugfix #454)', () => {
      expect(calculateProgress(makeParsed({
        protocol: 'aspir',
        phase: 'review',
        gates: { 'pr': 'pending' },
        gateRequestedAt: { 'pr': '2026-01-01T00:00:00Z' },
      }))).toBe(95);
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
      expect(calculateProgress(makeParsed({ protocol: 'bugfix', phase: 'verified' }), tmpDir)).toBe(100);
    });

    // TICK protocol removed (spec 653) — tick progress test deleted

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

    it('returns 100 for verified phase', () => {
      expect(calculateEvenProgress('verified', ['a', 'b'])).toBe(100);
    });

    it('returns 100 for legacy complete phase (backward compat)', () => {
      expect(calculateEvenProgress('complete', ['a', 'b'])).toBe(100);
    });

    it('returns 0 for unknown phase', () => {
      expect(calculateEvenProgress('unknown', ['a', 'b'])).toBe(0);
    });

    it('handles single-phase protocol', () => {
      expect(calculateEvenProgress('only', ['only'])).toBe(50);
      expect(calculateEvenProgress('verified', ['only'])).toBe(100);
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
        gateApprovedAt: {},
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

    it('returns "PR review" when pr is pending and requested', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'pr': 'pending' },
        gateRequestedAt: { 'pr': '2026-01-01T00:00:00Z' },
      }))).toBe('PR review');
    });

    it('returns "verify review" when verify-approval is pending and requested (#927)', () => {
      expect(detectBlocked(makeParsed({
        gates: { 'verify-approval': 'pending' },
        gateRequestedAt: { 'verify-approval': '2026-05-29T12:00:00Z' },
      }))).toBe('verify review');
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
  // detectBlockedSince (Bugfix #409)
  // ==========================================================================

  describe('detectBlockedSince', () => {
    function makeParsed(overrides: Partial<ReturnType<typeof parseStatusYaml>> = {}) {
      return {
        id: '0100',
        title: 'test',
        protocol: 'spir',
        phase: 'specify',
        currentPlanPhase: '',
        gates: {},
        gateRequestedAt: {},
        gateApprovedAt: {},
        planPhases: [],
        startedAt: '2026-02-17T00:00:00.000Z',
        ...overrides,
      };
    }

    it('returns null when no gates are pending', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'spec-approval': 'approved' },
      }))).toBeNull();
    });

    it('returns null when gate is pending but not requested', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'spec-approval': 'pending' },
      }))).toBeNull();
    });

    it('returns requested_at timestamp for pending spec-approval', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'spec-approval': 'pending' },
        gateRequestedAt: { 'spec-approval': '2026-02-15T10:30:00Z' },
      }))).toBe('2026-02-15T10:30:00Z');
    });

    it('returns requested_at timestamp for pending plan-approval', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'spec-approval': 'approved', 'plan-approval': 'pending' },
        gateRequestedAt: { 'plan-approval': '2026-02-16T08:00:00Z' },
      }))).toBe('2026-02-16T08:00:00Z');
    });

    it('returns requested_at timestamp for pending PR gate', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'pr': 'pending' },
        gateRequestedAt: { 'pr': '2026-02-17T12:00:00Z' },
      }))).toBe('2026-02-17T12:00:00Z');
    });

    it('returns requested_at timestamp for pending verify-approval gate (#927)', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'verify-approval': 'pending' },
        gateRequestedAt: { 'verify-approval': '2026-05-29T12:00:00Z' },
      }))).toBe('2026-05-29T12:00:00Z');
    });

    it('returns first blocked gate timestamp when multiple are pending', () => {
      expect(detectBlockedSince(makeParsed({
        gates: { 'spec-approval': 'pending', 'plan-approval': 'pending' },
        gateRequestedAt: {
          'spec-approval': '2026-02-15T10:00:00Z',
          'plan-approval': '2026-02-16T10:00:00Z',
        },
      }))).toBe('2026-02-15T10:00:00Z');
    });
  });

  // ==========================================================================
  // computeIdleMs (Bugfix #405)
  // ==========================================================================

  // ==========================================================================
  // derivePrReady (#927) — gate-authoritative "PR ready for human" signal
  // ==========================================================================

  describe('derivePrReady', () => {
    function makeParsed(overrides: Partial<ReturnType<typeof parseStatusYaml>> = {}) {
      return {
        id: '0100',
        title: 'test',
        protocol: 'spir',
        phase: 'specify',
        currentPlanPhase: '',
        gates: {},
        gateRequestedAt: {},
        gateApprovedAt: {},
        planPhases: [],
        startedAt: '2026-05-26T00:00:00.000Z',
        prReadyForHuman: null,
        merged: false,
        ...overrides,
      };
    }

    it('returns true when the pr gate is pending and requested — uniform across protocols', () => {
      // The signal is the gate shape, not the protocol name. #887 gave BUGFIX a
      // pr gate, so all five PR-producing protocols use the identical predicate.
      for (const protocol of ['bugfix', 'air', 'spir', 'aspir', 'pir']) {
        expect(derivePrReady(makeParsed({
          protocol,
          gates: { pr: 'pending' },
          gateRequestedAt: { pr: '2026-05-26T12:00:00Z' },
        }))).toBe(true);
      }
    });

    it('returns false when the pr gate is pending but has NO requested_at (freshly-initialized project)', () => {
      // Porch initializes every gate to status: pending with no requested_at;
      // the requested_at conjunct prevents mis-flagging brand-new projects.
      expect(derivePrReady(makeParsed({
        gates: { pr: 'pending', 'spec-approval': 'pending', 'verify-approval': 'pending' },
        gateRequestedAt: {},
      }))).toBe(false);
    });

    it('returns false once the pr gate has been approved', () => {
      expect(derivePrReady(makeParsed({
        gates: { pr: 'approved' },
        gateRequestedAt: { pr: '2026-05-26T12:00:00Z' },
        gateApprovedAt: { pr: '2026-05-26T13:00:00Z' },
      }))).toBe(false);
    });

    it('returns false when the PR has merged but the pr gate is still pending (#966)', () => {
      // Repro: porch left the `pr` gate pending after an out-of-band merge. The
      // merged PR is in recentlyClosed (never pendingPRs), so a stale prReady:true
      // would suppress the builder row without emitting a PR row → vanishes.
      expect(derivePrReady(makeParsed({
        protocol: 'bugfix',
        phase: 'review',
        gates: { pr: 'pending' },
        gateRequestedAt: { pr: '2026-06-02T15:14:59Z' },
        merged: true,
      }))).toBe(false);
    });

    it('still returns true when the pr gate is pending, requested, and NOT merged (#966)', () => {
      // The companion to the merged case: an open PR genuinely awaiting review.
      expect(derivePrReady(makeParsed({
        gates: { pr: 'pending' },
        gateRequestedAt: { pr: '2026-05-26T12:00:00Z' },
        merged: false,
      }))).toBe(true);
    });

    it('reads the pr gate directly and ignores pr_ready_for_human (#927)', () => {
      // Field true but gate not pending → not ready (kills the sticky-field hazard #919).
      expect(derivePrReady(makeParsed({
        prReadyForHuman: true,
        gates: {},
        gateRequestedAt: {},
      }))).toBe(false);
      // Field false but gate genuinely pending → ready (the gate is authoritative).
      expect(derivePrReady(makeParsed({
        prReadyForHuman: false,
        gates: { pr: 'pending' },
        gateRequestedAt: { pr: '2026-05-26T12:00:00Z' },
      }))).toBe(true);
    });

    it('does NOT fall back to bugfix phase=verified (removed gateless crutch)', () => {
      // A gateless bugfix variant no longer surfaces a PR row — by design (#927).
      expect(derivePrReady(makeParsed({
        protocol: 'bugfix',
        phase: 'verified',
        gates: {},
        gateRequestedAt: {},
      }))).toBe(false);
    });

    it('returns false when no pr-gate signal is present', () => {
      expect(derivePrReady(makeParsed({ protocol: 'spir', phase: 'implement' }))).toBe(false);
    });

    it('repro #966: merged-but-gate-pending builder surfaces via the gate row, not as PR-ready', () => {
      // Full chain on the real #966 repro shape: porch recorded
      // merged: true but left the pr gate pending. The builder must NOT
      // read as PR-ready (else NeedsAttentionList suppresses its row while no PR
      // row exists — it vanishes). It must instead surface as a blocked "PR review"
      // gate row, since the pr gate is genuinely still pending. This is why fixing
      // derivePrReady alone is sufficient (no NeedsAttentionList change needed).
      const yaml = [
        "id: '2019'",
        'protocol: bugfix',
        'phase: review',
        'gates:',
        '  pr:',
        '    status: pending',
        "    requested_at: '2026-06-02T15:14:59.000Z'",
        'pr_history:',
        '  - phase: review',
        '    pr_number: 2030',
        '    branch: builder/spir-2019',
        "    created_at: '2026-06-02T15:10:00.000Z'",
        '    merged: true',
        "    merged_at: '2026-06-02T15:14:34.000Z'",
        'pr_ready_for_human: true',
      ].join('\n');

      const parsed = parseStatusYaml(yaml);
      // No longer suppressed as a (now-merged) PR-ready builder...
      expect(derivePrReady(parsed)).toBe(false);
      // ...and surfaces via the gate-row path instead (pr gate still pending).
      expect(detectBlocked(parsed)).toBe('PR review');
      expect(detectBlockedSince(parsed)).toBe('2026-06-02T15:14:59.000Z');
    });
  });

  describe('computeIdleMs', () => {
    function makeParsed(overrides: Partial<ReturnType<typeof parseStatusYaml>> = {}) {
      return {
        id: '0100',
        title: 'test',
        protocol: 'spir',
        phase: 'specify',
        currentPlanPhase: '',
        gates: {},
        gateRequestedAt: {},
        gateApprovedAt: {},
        planPhases: [],
        startedAt: '2026-02-17T00:00:00.000Z',
        ...overrides,
      };
    }

    it('returns 0 when no gates have requested_at', () => {
      expect(computeIdleMs(makeParsed())).toBe(0);
    });

    it('returns 0 when gates have approved_at but no requested_at (pre-approved)', () => {
      expect(computeIdleMs(makeParsed({
        gateApprovedAt: { 'spec-approval': '2026-02-17T01:00:00.000Z' },
      }))).toBe(0);
    });

    it('computes idle time from completed gate interval', () => {
      // 30 minutes of waiting at spec-approval
      const idle = computeIdleMs(makeParsed({
        gateRequestedAt: { 'spec-approval': '2026-02-17T01:00:00.000Z' },
        gateApprovedAt: { 'spec-approval': '2026-02-17T01:30:00.000Z' },
      }));
      expect(idle).toBe(30 * 60 * 1000); // 30 minutes in ms
    });

    it('sums idle time from multiple completed gates', () => {
      // 30 min at spec-approval + 15 min at plan-approval = 45 min
      const idle = computeIdleMs(makeParsed({
        gateRequestedAt: {
          'spec-approval': '2026-02-17T01:00:00.000Z',
          'plan-approval': '2026-02-17T02:00:00.000Z',
        },
        gateApprovedAt: {
          'spec-approval': '2026-02-17T01:30:00.000Z',
          'plan-approval': '2026-02-17T02:15:00.000Z',
        },
      }));
      expect(idle).toBe(45 * 60 * 1000); // 45 minutes in ms
    });

    it('includes current pending gate in idle time', () => {
      // spec-approval is completed (30 min), plan-approval is currently pending
      const now = Date.now();
      const pendingRequestedAt = new Date(now - 10 * 60 * 1000).toISOString(); // 10 min ago

      const idle = computeIdleMs(makeParsed({
        gateRequestedAt: {
          'spec-approval': '2026-02-17T01:00:00.000Z',
          'plan-approval': pendingRequestedAt,
        },
        gateApprovedAt: {
          'spec-approval': '2026-02-17T01:30:00.000Z',
          // plan-approval has no approved_at → currently pending
        },
      }));

      // Should be ~30 min (completed) + ~10 min (pending)
      // Allow 2 second tolerance for test execution time
      const expected = 40 * 60 * 1000;
      expect(idle).toBeGreaterThanOrEqual(expected - 2000);
      expect(idle).toBeLessThanOrEqual(expected + 2000);
    });
  });

  // ==========================================================================
  // extractProjectIdFromWorktreeName
  // ==========================================================================

  describe('extractProjectIdFromWorktreeName', () => {
    it('extracts unpadded ID from SPIR worktree', () => {
      expect(extractProjectIdFromWorktreeName('spir-126-slug')).toBe('126');
    });

    it('returns unpadded short SPIR numbers', () => {
      expect(extractProjectIdFromWorktreeName('spir-1-feature')).toBe('1');
    });

    it('preserves 4+ digit SPIR numbers', () => {
      expect(extractProjectIdFromWorktreeName('spir-9999-big')).toBe('9999');
    });

    it('extracts unpadded ID from TICK worktree', () => {
      expect(extractProjectIdFromWorktreeName('tick-130-slug')).toBe('130');
    });

    it('extracts bugfix-N from bugfix worktree', () => {
      expect(extractProjectIdFromWorktreeName('bugfix-296-slug')).toBe('bugfix-296');
    });

    it('extracts bare numeric ID from PIR worktree (aligns with SPIR convention)', () => {
      expect(extractProjectIdFromWorktreeName('pir-1298-fix-foo')).toBe('1298');
    });

    it('extracts bare numeric ID from PIR worktree with no slug', () => {
      expect(extractProjectIdFromWorktreeName('pir-1298')).toBe('1298');
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
        '  pr:',
        '    status: pending',
      ].join('\n'), '0126-project-management-rework');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('0126');
      expect(builders[0].issueId).toBe('126');
      expect(builders[0].phase).toBe('tower_endpoint');
      expect(builders[0].mode).toBe('strict');
      expect(builders[0].gates['pr']).toBe('pending');
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
      expect(builders[0].issueId).toBeNull();
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
      expect(strict?.issueId).toBe('100');
      expect(soft?.id).toBe('bugfix-200-fix');
      expect(soft?.issueId).toBe('200');
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
      expect(builders[0].issueId).toBe('126');
      expect(builders[0].mode).toBe('strict');
    });

    it('discovers bugfix builder matching bugfix-N project dir', () => {
      // Bugfix worktree with matching project dir (current porch naming)
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

      // The bugfix's own project dir (created by porch init via afx spawn)
      const bugfixDir = path.join(projectsBase, 'bugfix-326-fix-discover');
      fs.mkdirSync(bugfixDir, { recursive: true });
      fs.writeFileSync(path.join(bugfixDir, 'status.yaml'), [
        'id: bugfix-326',
        'title: fix-discover',
        'protocol: bugfix',
        'phase: investigate',
      ].join('\n'));

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('bugfix-326');
      expect(builders[0].issueId).toBe('326');
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
      expect(builders[0].issueId).toBe('300');
      expect(builders[0].id).toBe('bugfix-300-some-fix');
    });

    it('includes idleMs computed from gate timestamps (Bugfix #405)', () => {
      createBuilderWorktree(tmpDir, 'spir-60-feature', [
        "id: '0060'",
        'title: test-idle',
        'protocol: spir',
        'phase: implement',
        'gates:',
        '  spec-approval:',
        '    status: approved',
        "    requested_at: '2026-02-17T01:00:00.000Z'",
        "    approved_at: '2026-02-17T01:30:00.000Z'",
        '  plan-approval:',
        '    status: approved',
        "    requested_at: '2026-02-17T02:00:00.000Z'",
        "    approved_at: '2026-02-17T02:15:00.000Z'",
        "started_at: '2026-02-17T00:00:00.000Z'",
      ].join('\n'), '0060-test-idle');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      // 30 min + 15 min = 45 min idle
      expect(builders[0].idleMs).toBe(45 * 60 * 1000);
    });

    it('returns idleMs 0 for soft-mode builders (Bugfix #405)', () => {
      createBuilderWorktree(tmpDir, 'task-XyZw');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].idleMs).toBe(0);
    });

    it('includes startedAt from status.yaml (Bugfix #388)', () => {
      createBuilderWorktree(tmpDir, 'bugfix-501-test', [
        'id: bugfix-501',
        'title: test-elapsed',
        'protocol: bugfix',
        'phase: fix',
        "started_at: '2026-02-17T08:54:32.623Z'",
      ].join('\n'), 'bugfix-501-test-elapsed');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].startedAt).toBe('2026-02-17T08:54:32.623Z');
    });

    it('uses protocol phase when currentPlanPhase is "null" string (Bugfix #388)', () => {
      createBuilderWorktree(tmpDir, 'bugfix-500-test', [
        'id: bugfix-500',
        'title: test-null-phase',
        'protocol: bugfix',
        'phase: fix',
        'current_plan_phase: null',
      ].join('\n'), 'bugfix-500-test-null-phase');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      // Should use 'fix' (protocol phase), not 'null' (string from YAML)
      expect(builders[0].phase).toBe('fix');
    });

    it('treats builder with codev/projects but no matching status.yaml as soft', () => {
      const builderDir = path.join(tmpDir, '.builders', 'spir-999-no-match');
      fs.mkdirSync(path.join(builderDir, 'codev', 'projects', 'unrelated'), { recursive: true });
      // No status.yaml at all

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].mode).toBe('soft');
      expect(builders[0].issueId).toBe('999');
    });

    it('handles multiple worktrees each matching their own project (not all #87)', () => {
      // This is the core regression test for issue #326
      const worktrees = [
        { name: 'spir-87-timeout', projDir: '0087-porch-timeout', id: '0087', issue: '87' },
        { name: 'spir-126-rework', projDir: '0126-project-rework', id: '0126', issue: '126' },
        { name: 'tick-130-amend', projDir: '0130-codex-integration', id: '0130', issue: '130' },
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
        const builder = builders.find(b => b.issueId === wt.issue);
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

      const issues = [issueItem(42, 'My Feature'), issueItem(43, 'No Spec')];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog).toHaveLength(2);

      const issue42 = backlog.find(b => b.id === '42')!;
      expect(issue42.hasSpec).toBe(true);
      expect(issue42.specPath).toBe('codev/specs/42-my-feature.md');

      const issue43 = backlog.find(b => b.id === '43')!;
      expect(issue43.hasSpec).toBe(false);
      expect(issue43.specPath).toBeUndefined();
    });

    it('matches zero-padded spec filenames to unpadded issue IDs', () => {
      // Real spec files use zero-padded names like 0042-my-feature.md
      const specsDir = path.join(tmpDir, 'codev', 'specs');
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, '0042-my-feature.md'), '# my-feature');

      const issues = [issueItem(42, 'My Feature')];
      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());

      const issue42 = backlog.find(b => b.id === '42')!;
      expect(issue42.hasSpec).toBe(true);
      expect(issue42.specPath).toBe('codev/specs/0042-my-feature.md');
    });

    it('includes url from issue', () => {
      const issues = [issueItem(42, 'Test')];
      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].url).toBe('https://github.com/org/repo/issues/42');
    });

    it('detects plan and review files', () => {
      createSpecFile(tmpDir, 42, 'my-feature');
      createPlanFile(tmpDir, 42, 'my-feature');
      createReviewFile(tmpDir, 42, 'my-feature');

      const issues = [issueItem(42, 'My Feature')];
      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].hasSpec).toBe(true);
      expect(backlog[0].hasPlan).toBe(true);
      expect(backlog[0].hasReview).toBe(true);
      expect(backlog[0].specPath).toBe('codev/specs/42-my-feature.md');
      expect(backlog[0].planPath).toBe('codev/plans/42-my-feature.md');
      expect(backlog[0].reviewPath).toBe('codev/reviews/42-my-feature.md');
    });

    it('marks issues with active builders', () => {
      const issues = [issueItem(100, 'Active'), issueItem(200, 'Idle')];

      const backlog = deriveBacklog(issues, tmpDir, new Set(['100']), new Set());
      const active = backlog.find(b => b.id === '100')!;
      const idle = backlog.find(b => b.id === '200')!;

      expect(active.hasBuilder).toBe(true);
      expect(idle.hasBuilder).toBe(false);
    });

    it('filters out issues that have linked PRs', () => {
      const issues = [issueItem(50, 'Has PR'), issueItem(60, 'No PR')];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set(['50']));
      expect(backlog).toHaveLength(1);
      expect(backlog[0].id).toBe('60');
    });

    it('parses type and priority from labels', () => {
      const issues = [issueItem(70, 'Bug', [{ name: 'type:bug' }, { name: 'priority:high' }])];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].type).toBe('bug');
      expect(backlog[0].priority).toBe('high');
    });

    it('defaults to project/medium when labels are missing and title has no bug keywords', () => {
      const issues = [issueItem(80, 'No labels')];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].type).toBe('project');
      expect(backlog[0].priority).toBe('medium');
    });

    it('handles missing codev/specs directory', () => {
      const issues = [issueItem(90, 'Test')];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog).toHaveLength(1);
      expect(backlog[0].hasSpec).toBe(false);
      expect(backlog[0].hasPlan).toBe(false);
      expect(backlog[0].hasReview).toBe(false);
    });

    it('maps author login when present', () => {
      const issues = [{ ...issueItem(42, 'Test'), author: { login: 'timeleft--' } }];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].author).toBe('timeleft--');
    });

    it('sets author to undefined when author is missing', () => {
      const issues = [issueItem(42, 'Test')];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].author).toBeUndefined();
    });

    it('sets author to undefined when author is null', () => {
      const issues = [{ ...issueItem(42, 'Test'), author: null as unknown as { login: string } }];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].author).toBeUndefined();
    });

    it('maps a single assignee login', () => {
      const issues = [{ ...issueItem(42, 'Test'), assignees: [{ login: 'amr' }] }];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].assignees).toEqual(['amr']);
    });

    it('maps multiple assignee logins', () => {
      const issues = [
        { ...issueItem(42, 'Test'), assignees: [{ login: 'amr' }, { login: 'bob' }] },
      ];

      const backlog = deriveBacklog(issues, tmpDir, new Set(), new Set());
      expect(backlog[0].assignees).toEqual(['amr', 'bob']);
    });

    it('omits assignees when array is empty or missing', () => {
      const empty = [{ ...issueItem(42, 'Test'), assignees: [] }];
      const missing = [issueItem(43, 'Test')];

      const backlogEmpty = deriveBacklog(empty, tmpDir, new Set(), new Set());
      const backlogMissing = deriveBacklog(missing, tmpDir, new Set(), new Set());

      expect(backlogEmpty[0].assignees).toBeUndefined();
      expect(backlogMissing[0].assignees).toBeUndefined();
    });
  });

  // ==========================================================================
  // OverviewCache
  // ==========================================================================

  describe('OverviewCache', () => {
    it('returns builders, PRs, backlog, and recentlyClosed', async () => {
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
      mockFetchIssueList.mockResolvedValue([issueItem(99, 'Backlog item')]);
      mockFetchRecentlyClosed.mockResolvedValue([
        { number: 88, title: 'Fixed bug', url: 'https://github.com/org/repo/issues/88', labels: [{ name: 'bug' }], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date().toISOString() },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      expect(data.builders[0].issueId).toBe('42');

      expect(data.pendingPRs).toHaveLength(1);
      expect(data.pendingPRs[0].linkedIssue).toBe('42');

      expect(data.backlog).toHaveLength(1);
      expect(data.backlog[0].id).toBe('99');
      expect(data.backlog[0].url).toContain('/issues/99');

      expect(data.recentlyClosed).toHaveLength(1);
      expect(data.recentlyClosed[0].id).toBe('88');
      expect(data.recentlyClosed[0].type).toBe('bug');

      expect(data.errors).toBeUndefined();
    });

    it('maps PR author login to pendingPRs', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 10, title: 'Add feature', url: 'https://github.com/org/repo/pull/10', reviewDecision: 'APPROVED', body: '', createdAt: '2026-01-10T00:00:00Z', author: { login: 'contributor' } },
      ]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs[0].author).toBe('contributor');
    });

    it('maps backlog author login from issues', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([
        { ...issueItem(42, 'Test'), author: { login: 'external-dev' } },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.backlog[0].author).toBe('external-dev');
    });

    it('handles PR without author field', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 10, title: 'Add feature', url: 'https://github.com/org/repo/pull/10', reviewDecision: 'APPROVED', body: '', createdAt: '2026-01-10T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs[0].author).toBeUndefined();
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

    it('resolves currentUser from the user-identity concept', async () => {
      mockFetchCurrentUser.mockResolvedValue('octocat');

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.currentUser).toBe('octocat');
      expect(mockFetchCurrentUser).toHaveBeenCalledWith(tmpDir);
    });

    it('omits currentUser when user-identity resolution fails', async () => {
      mockFetchCurrentUser.mockResolvedValue(null);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.currentUser).toBeUndefined();
      expect(data.backlog).toEqual([]);
    });

    it('doubles the negative-cache window per failure, capped at 15 minutes (#1645)', () => {
      expect(negativeTtlMs(1)).toBe(60_000);
      expect(negativeTtlMs(2)).toBe(120_000);
      expect(negativeTtlMs(3)).toBe(240_000);
      expect(negativeTtlMs(10)).toBe(900_000);
    });

    it('projects the hourly forge spend from the TTLs (#1645)', () => {
      // 2 list calls per 180s window (40/h) + 2 search calls per 600s window (12/h).
      expect(projectHourlyForgeCalls(1)).toBe(52);
      expect(projectHourlyForgeCalls(13)).toBe(676);
      expect(projectHourlyForgeCalls(0)).toBe(0);
    });

    it('caches currentUser across getOverview calls', async () => {
      mockFetchCurrentUser.mockResolvedValue('octocat');

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      await cache.getOverview(tmpDir);

      expect(mockFetchCurrentUser).toHaveBeenCalledTimes(1);
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

    it('re-fetches after the positive TTL expires (Bugfix #388)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);
      mockFetchRecentlyClosed.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).toHaveBeenCalledTimes(1);

      // Advance time past the 180s positive TTL (raised from 30s in #1645)
      vi.useFakeTimers();
      vi.advanceTimersByTime(181_000);

      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('holds the positive TTL for 180s, not 30s (#1645)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      vi.useFakeTimers();
      vi.advanceTimersByTime(150_000);
      await cache.getOverview(tmpDir);
      vi.useRealTimers();

      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
    });

    it('keeps the 24h search windows cached for 10 minutes (#1645)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);
      mockFetchRecentlyClosed.mockResolvedValue([]);
      mockFetchMergedPRs.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      vi.useFakeTimers();
      // Past the 180s list TTL, well inside the 600s search TTL.
      vi.advanceTimersByTime(300_000);
      await cache.getOverview(tmpDir);
      vi.useRealTimers();

      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
      expect(mockFetchRecentlyClosed).toHaveBeenCalledTimes(1);
      expect(mockFetchMergedPRs).toHaveBeenCalledTimes(1);
    });

    // ======================================================================
    // Issue #1645 — negative caching, backoff, and rate-limit suspension
    // ======================================================================

    it('caches a FAILED fetch instead of re-spawning it on the next request (#1645)', async () => {
      // The bug: `if (data !== null) cache.set(...)` never stored a failure, so
      // every 2.5s dashboard poll re-spawned all four gh commands. Measured at
      // 180 gh processes in 60s once GitHub started refusing them.
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue(null);
      mockFetchRecentlyClosed.mockResolvedValue(null);
      mockFetchMergedPRs.mockResolvedValue(null);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      await cache.getOverview(tmpDir);
      await cache.getOverview(tmpDir);

      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
      expect(mockFetchIssueList).toHaveBeenCalledTimes(1);
      expect(mockFetchRecentlyClosed).toHaveBeenCalledTimes(1);
      expect(mockFetchMergedPRs).toHaveBeenCalledTimes(1);
    });

    it('retries a failed fetch once the negative window expires (#1645)', async () => {
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000); // past the 60s first negative window
      await cache.getOverview(tmpDir);
      vi.useRealTimers();

      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
    });

    it('backs off further on each consecutive failure (#1645)', async () => {
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);
      await cache.getOverview(tmpDir); // 2nd failure -> window doubles to 120s
      expect(mockFetchPRList).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(61_000); // inside the doubled window
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(61_000); // past it
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('clears the backoff after a success (#1645)', async () => {
      mockFetchPRList.mockResolvedValueOnce(null).mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);
      await cache.getOverview(tmpDir); // succeeds
      vi.advanceTimersByTime(181_000);
      await cache.getOverview(tmpDir); // normal positive TTL, not a backoff
      vi.useRealTimers();

      expect(mockFetchPRList).toHaveBeenCalledTimes(3);
    });

    it('spawns nothing at all while a forge rate limit is in force (#1645)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);
      mockFetchRecentlyClosed.mockResolvedValue([]);
      mockFetchMergedPRs.mockResolvedValue([]);
      mockFetchCurrentUser.mockResolvedValue('octocat');

      noteRateLimited(OVERVIEW_BACKEND, Date.now() + 10 * 60 * 1000);
      expect(isForgeSuspended(OVERVIEW_BACKEND)).toBe(true);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      await cache.getOverview(tmpDir);

      expect(mockFetchPRList).not.toHaveBeenCalled();
      expect(mockFetchIssueList).not.toHaveBeenCalled();
      expect(mockFetchRecentlyClosed).not.toHaveBeenCalled();
      expect(mockFetchMergedPRs).not.toHaveBeenCalled();
      expect(mockFetchCurrentUser).not.toHaveBeenCalled();
    });

    it('reports forgeStatus rate-limited with a reset instant (#1645)', async () => {
      const resetAt = Date.now() + 10 * 60 * 1000;
      noteRateLimited(OVERVIEW_BACKEND, resetAt);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.forgeStatus).toBe('rate-limited');
      expect(data.forgeResetAt).toBe(new Date(resetAt).toISOString());
    });

    it('reports forgeStatus ok when the forge answers, unavailable when it fails (#1645)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      const okData = await new OverviewCache().getOverview(tmpDir);
      expect(okData.forgeStatus).toBe('ok');
      expect(okData.forgeResetAt).toBeUndefined();

      mockFetchIssueList.mockResolvedValue(null);
      const badData = await new OverviewCache().getOverview(tmpDir);
      expect(badData.forgeStatus).toBe('unavailable');
    });

    it('says the forge is rate-limited, not that gh is missing (#1645)', async () => {
      // The dashboard renders errors.prs/errors.issues verbatim (WorkView's
      // `work-unavailable`), so "GitHub CLI unavailable" during a rate limit
      // sent people looking for a broken gh install.
      noteRateLimited(OVERVIEW_BACKEND, Date.now() + 10 * 60 * 1000);

      const data = await new OverviewCache().getOverview(tmpDir);

      expect(data.errors?.prs).toContain('rate limit exhausted');
      expect(data.errors?.issues).toContain('rate limit exhausted');
      expect(data.errors?.prs).not.toContain('GitHub CLI unavailable');
    });

    it('keeps the suspension when the REST identity call still succeeds (#1645)', async () => {
      // `user-identity` is REST (`gh api user`), charged to a different budget,
      // so it keeps succeeding while its GraphQL siblings are refused. A
      // refresh that hits the limit must stay suspended afterwards.
      //
      // Two things hold this, and both matter: `countsAsRecovery` (the identity
      // call's success is never evidence the GraphQL budget recovered) and the
      // dispatch-time guard in `noteForgeSuccess` (a command dispatched at or
      // before the suspension proves nothing). In this test the batch shares a
      // millisecond, so the timestamp guard is what fires. Deliberately NOT asserted here: that the
      // identity call goes undispatched. An earlier revision did assert that,
      // relying on `fetchCached` re-checking the suspension synchronously
      // before a sibling's fetcher had returned — an artifact of mocks
      // resolving in the same tick, which real subprocesses never do.
      mockFetchPRList.mockImplementation(async () => {
        noteRateLimited(OVERVIEW_BACKEND, Date.now() + 10 * 60 * 1000);
        return null;
      });
      mockFetchIssueList.mockResolvedValue(null);
      mockFetchRecentlyClosed.mockResolvedValue(null);
      mockFetchMergedPRs.mockResolvedValue(null);
      mockFetchCurrentUser.mockResolvedValue('octocat');

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(isForgeSuspended(OVERVIEW_BACKEND)).toBe(true);
      expect(data.forgeStatus).toBe('rate-limited');
    });

    it('coalesces concurrent requests into one forge call (#1645)', async () => {
      // A cache entry is only written once its fetch resolves. With the
      // dashboard polling every 2.5s and `gh` hanging for tens of seconds
      // during an incident, every poll and every extra client would otherwise
      // start another duplicate batch.
      let release: (v: unknown) => void = () => {};
      const gate = new Promise(r => { release = r; });
      mockFetchPRList.mockImplementation(async () => { await gate; return []; });
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const all = Promise.all([
        cache.getOverview(tmpDir),
        cache.getOverview(tmpDir),
        cache.getOverview(tmpDir),
      ]);
      release(null);
      await all;

      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
    });

    it('does not let the REST identity call reset the escalating backoff (#1645)', async () => {
      // `user-identity` is `gh api user` — REST, a budget separate from the
      // GraphQL one the lists spend, but resolving to the same `gh` backend
      // key. Its success must not clear the suspension, or every window that
      // expires after its 1h TTL also expires would reset the doubling backoff
      // to its first step and it would never escalate.
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue(null);
      mockFetchRecentlyClosed.mockResolvedValue(null);
      mockFetchMergedPRs.mockResolvedValue(null);
      mockFetchCurrentUser.mockResolvedValue('octocat');

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);           // identity fetched, nothing suspended yet
      noteRateLimited(OVERVIEW_BACKEND, null);   // first hit -> 60s window

      vi.useFakeTimers();
      // Past both the suspension window and the identity call's 1h TTL, so the
      // identity call actually re-runs and succeeds.
      vi.advanceTimersByTime(61 * 60_000);
      await cache.getOverview(tmpDir);
      expect(mockFetchCurrentUser).toHaveBeenCalledTimes(2); // it really did re-run

      noteRateLimited(OVERVIEW_BACKEND, null);   // second hit
      const windowMs = new Date(getForgeRateLimit(OVERVIEW_BACKEND).resetAt!).getTime() - Date.now();
      vi.useRealTimers();

      // Escalated to the second step. Without the guard the identity success
      // would have reset the counter and this would still be the first.
      expect(windowMs).toBeGreaterThan(60_000);
    });

    it('keeps coalescing after an invalidate (#1645)', async () => {
      // invalidate() clears the join table, so a newer flight is registered
      // while an older one is still settling. The older one's cleanup must not
      // delete the newer entry — a caller arriving after that would start yet
      // another fetch, the fan-out single-flight exists to prevent.
      let releaseA: (v: unknown) => void = () => {};
      let releaseB: (v: unknown) => void = () => {};
      const gateA = new Promise(r => { releaseA = r; });
      const gateB = new Promise(r => { releaseB = r; });
      mockFetchPRList
        .mockImplementationOnce(async () => { await gateA; return []; })
        .mockImplementation(async () => { await gateB; return []; });
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const first = cache.getOverview(tmpDir);   // flight A
      cache.invalidate();                        // clears the join table
      const second = cache.getOverview(tmpDir);  // flight B registers

      // Let A settle and its cleanup run, while B is still in flight.
      releaseA(null);
      await first;
      await new Promise(r => setTimeout(r, 0));

      const third = cache.getOverview(tmpDir);   // must JOIN B, not start C
      releaseB(null);
      await Promise.all([second, third]);

      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
    });

    it('does not orphan a rejection when a fetcher throws (#1645)', async () => {
      // `executeForgeCommand` resolves forge config OUTSIDE its own try, and
      // `loadConfig` fails fast, so a fetcher really can reject. A chained
      // `.finally()` would leave that rejection on a derived promise nobody
      // awaits — and Tower's `unhandledRejection` handler calls
      // `process.exit(1)`. The whole cache going down beats a stale PR list,
      // so this must stay caught.
      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown): void => { unhandled.push(r); };
      process.on('unhandledRejection', onUnhandled);
      try {
        mockFetchPRList.mockRejectedValue(new Error('malformed .codev/config.json'));
        mockFetchIssueList.mockResolvedValue([]);

        const cache = new OverviewCache();
        await expect(cache.getOverview(tmpDir)).rejects.toThrow('malformed');
        // Let any orphaned derived promise surface.
        await new Promise(r => setTimeout(r, 10));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('keeps the failure record across a cache refresh (#1645)', async () => {
      // A refresh means "my data may be stale", never "the forge has
      // recovered" — and porch fires one after every mutating command. If it
      // cleared failures too, a plainly broken forge (`gh` missing, not
      // authenticated) would be re-spawned as fast as invalidations arrive.
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).toHaveBeenCalledTimes(1);

      cache.invalidate();
      await cache.getOverview(tmpDir);

      // Still inside the 60s negative window: the refresh did not buy a retry.
      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
    });

    it('escalates the backoff even when a failure is written by a queued flight (#1645)', async () => {
      // The failure count used to be read at dispatch and written minutes
      // later, so consecutive failures never escalated past the first step.
      mockFetchPRList.mockResolvedValue(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);       // past window 1 (60s)
      await cache.getOverview(tmpDir);      // 2nd failure -> window 2 (120s)
      vi.advanceTimersByTime(61_000);       // inside window 2
      await cache.getOverview(tmpDir);
      vi.useRealTimers();

      // Two fetches, not three: the second failure escalated the window.
      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
    });

    it('re-checks the suspension after waiting on a queued fetch (#1645)', async () => {
      // The suspension is checked when a fetch is dispatched. A queued fetch
      // can wait 30s behind the one ahead of it, and the forge may start
      // refusing us in that window — spawning anyway would be the one command
      // the suspension exists to prevent.
      let release: (v: unknown) => void = () => {};
      const gate = new Promise(r => { release = r; });
      mockFetchPRList.mockImplementationOnce(async () => {
        await gate;
        return [];
      });
      mockFetchIssueList.mockResolvedValue([]);

      const tick = (): Promise<unknown> => new Promise(r => setTimeout(r, 0));

      const cache = new OverviewCache();
      const first = cache.getOverview(tmpDir);
      await tick();          // let the first fetch actually start
      cache.invalidate();
      const queued = cache.getOverview(tmpDir);
      await tick();          // let the queued one reach its wait

      // The forge starts refusing us while the queued fetch is still waiting.
      noteRateLimited(OVERVIEW_BACKEND, Date.now() + 10 * 60 * 1000);
      release(null);
      await Promise.all([first, queued]);

      // Only the first command ran; the queued one saw the suspension.
      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
    });

    it('bounds concurrency across repeated invalidations (#1645)', async () => {
      // porch fires invalidate() after every mutating command, so in a busy
      // workspace they arrive constantly. Each one must not be licence to start
      // another parallel forge command: at most one runs, at most one waits.
      let inFlight = 0;
      let maxConcurrent = 0;
      let release: (v: unknown) => void = () => {};
      const gate = new Promise(r => { release = r; });
      mockFetchPRList.mockImplementation(async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await gate;
        inFlight--;
        return [];
      });
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const calls: Promise<unknown>[] = [];
      for (let i = 0; i < 6; i++) {
        calls.push(cache.getOverview(tmpDir));
        cache.invalidate();
      }
      release(null);
      await Promise.all(calls);

      expect(maxConcurrent).toBe(1);
      // And — the part that matters for the API budget — six invalidations do
      // not buy six commands. One runs, one is queued behind it, and every
      // later caller joins that queued one. Asserting only `maxConcurrent` hid
      // six serial executions costing exactly what the fan-out would have.
      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
    });

    it('does not hand a post-refresh caller a result fetched before it (#1645)', async () => {
      // A fetch already in flight was made under the previous config. Callers
      // already awaiting it still get it, but someone who asked *after* the
      // Refresh must trigger a fresh fetch rather than join the stale one.
      let release: (v: unknown) => void = () => {};
      const gate = new Promise(r => { release = r; });
      mockFetchPRList.mockImplementationOnce(async () => { await gate; return []; });
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const before = cache.getOverview(tmpDir);
      cache.invalidate();
      const after = cache.getOverview(tmpDir);
      release(null);
      await Promise.all([before, after]);

      expect(mockFetchPRList).toHaveBeenCalledTimes(2);
    });

    it('does NOT let a cache refresh lift a rate-limit suspension (#1645)', async () => {
      // `POST /api/overview/refresh` is not a human signal: porch fires it after
      // every mutating command, VSCode on every review-queue mutation, and
      // cleanup too. With a dozen builders that is constant, and clearing the
      // suspension here would reset the escalating backoff over and over in
      // exactly the busy workspace this fix exists for.
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      noteRateLimited(OVERVIEW_BACKEND, Date.now() + 10 * 60 * 1000);
      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).not.toHaveBeenCalled();

      cache.invalidate();

      expect(isForgeSuspended(OVERVIEW_BACKEND)).toBe(true);
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).not.toHaveBeenCalled();
    });

    it('projects spend in GraphQL points, not calls (#1645)', () => {
      // Points, not calls: reporting 676 calls against a 5,000-*point* budget
      // reads as 14% when the real figure is 41%, which would suppress the
      // warning the doctor check exists to raise.
      expect(projectHourlyGraphqlPoints(13)).toBe(676 * GRAPHQL_POINTS_PER_CALL);
      expect(projectHourlyGraphqlPoints(13)).toBeGreaterThan(projectHourlyForgeCalls(13));
      // And the shipped TTLs must keep 13 watched workspaces under half the budget.
      expect(projectHourlyGraphqlPoints(13)).toBeLessThan(0.5 * 5000);
    });

    it('resumes fetching once the suspension lifts (#1645)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);

      noteRateLimited(OVERVIEW_BACKEND, Date.now() + 60_000);
      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);
      expect(mockFetchPRList).not.toHaveBeenCalled();

      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);
      await cache.getOverview(tmpDir);
      vi.useRealTimers();

      expect(mockFetchPRList).toHaveBeenCalledTimes(1);
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

    it('recovers from a failed fetch once its negative window expires', async () => {
      // #1645 changed *when* the retry happens — a failure is now cached for a
      // backoff window instead of being retried on the very next request — but a
      // transient failure must still self-heal.
      mockFetchPRList.mockResolvedValueOnce(null);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data1 = await cache.getOverview(tmpDir);
      expect(data1.errors?.prs).toBeDefined();

      // Second call: gh succeeds
      mockFetchPRList.mockResolvedValueOnce([
        { number: 1, title: 'Test', url: 'https://github.com/org/repo/pull/1', reviewDecision: '', body: '', createdAt: '2026-01-01T00:00:00Z' },
      ]);

      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);
      const data2 = await cache.getOverview(tmpDir);
      vi.useRealTimers();

      expect(data2.errors?.prs).toBeUndefined();
      expect(data2.pendingPRs).toHaveLength(1);
    });

    it('filters backlog issues that are linked to PRs', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 10, title: 'Fix', url: 'https://github.com/org/repo/pull/10', reviewDecision: '', body: 'Fixes #42', createdAt: '2026-01-10T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([
        issueItem(42, 'Bug 42'),
        issueItem(43, 'Bug 43'),
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      // Issue 42 is linked to a PR, so it should not appear in backlog
      expect(data.backlog).toHaveLength(1);
      expect(data.backlog[0].id).toBe('43');

      // PR linkage should be parsed
      expect(data.pendingPRs[0].linkedIssue).toBe('42');
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

    it('flows reviewRequests and isDraft through to pendingPRs', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 1, title: 'Draft PR', url: 'https://github.com/org/repo/pull/1', reviewDecision: '', body: '', createdAt: '2026-01-01T00:00:00Z', reviewRequests: ['alice', 'bob'], isDraft: true },
      ]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs[0].reviewRequests).toEqual(['alice', 'bob']);
      expect(data.pendingPRs[0].isDraft).toBe(true);
    });

    it('defaults reviewRequests to [] and isDraft to false when the forge omits them', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 1, title: 'Bare PR', url: 'https://github.com/org/repo/pull/1', reviewDecision: '', body: '', createdAt: '2026-01-01T00:00:00Z' },
      ]);
      mockFetchIssueList.mockResolvedValue([]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.pendingPRs[0].reviewRequests).toEqual([]);
      expect(data.pendingPRs[0].isDraft).toBe(false);
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
      expect(filtered.builders[0].issueId).toBe('42');
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

    it('enriches builder issueTitle from GitHub issue titles', async () => {
      // status.yaml has a slug title, not the human-readable issue title
      createBuilderWorktree(tmpDir, 'bugfix-381-work-view-fix', [
        'id: bugfix-381',
        'title: work-view-fix',
        'protocol: bugfix',
        'phase: investigate',
      ].join('\n'), 'builder-bugfix-381-work-view-fix');

      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([
        { number: 381, title: 'Work view: builder rows show internal names', labels: [{ name: 'bug' }], createdAt: '2026-02-16T00:00:00Z' },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      // The title should be enriched from the GitHub issue, not the slug
      expect(data.builders[0].issueTitle).toBe('Work view: builder rows show internal names');
    });

    it('preserves slug title when GitHub issues are unavailable', async () => {
      createBuilderWorktree(tmpDir, 'bugfix-400-some-fix', [
        'id: bugfix-400',
        'title: some-fix',
        'protocol: bugfix',
        'phase: fix',
      ].join('\n'), 'bugfix-400-some-fix');

      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue(null);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      // Falls back to slug from status.yaml
      expect(data.builders[0].issueTitle).toBe('some-fix');
    });

    // ------------------------------------------------------------------
    // Resolved-area enrichment cache (PIR #907)
    //
    // Regression coverage for the transient UNCATEGORIZED flash during
    // cleanup. `area` is resolved from the *open*-issues list; when a
    // builder's issue is absent from that list (closed on PR merge, torn
    // down mid-cleanup, or a failed fetch) the record used to fall back to
    // the UNCATEGORIZED_AREA default while the builder was still present,
    // making it jump groups in the Builders tree. The cache now replays the
    // resolved area instead.
    // ------------------------------------------------------------------

    it('keeps the resolved area when the issue leaves the open list (PIR #907)', async () => {
      createBuilderWorktree(tmpDir, 'pir-907-area-fix', [
        "id: '0907'",
        'protocol: pir',
        'phase: implement',
        'gates:',
      ].join('\n'), '0907-area-fix');

      const cache = new OverviewCache();

      // First refresh: issue is open and labeled area/vscode.
      mockFetchIssueList.mockResolvedValue([
        issueItem(907, 'Builder flash bug', [{ name: 'area/vscode' }]),
      ]);
      const first = await cache.getOverview(tmpDir);
      expect(first.builders).toHaveLength(1);
      expect(first.builders[0].area).toBe('vscode');

      // Issue closes (e.g. PR merged) → drops out of the open-issues list.
      cache.invalidate();
      mockFetchIssueList.mockResolvedValue([]);
      const second = await cache.getOverview(tmpDir);
      expect(second.builders).toHaveLength(1);
      // Must NOT regress to 'Uncategorized' — stays in its real group until
      // it disappears entirely.
      expect(second.builders[0].area).toBe('vscode');
    });

    it('keeps the resolved area when the issue fetch fails (PIR #907)', async () => {
      createBuilderWorktree(tmpDir, 'pir-907-area-fetchfail', [
        "id: '0907'",
        'protocol: pir',
        'phase: implement',
        'gates:',
      ].join('\n'), '0907-area-fetchfail');

      const cache = new OverviewCache();

      mockFetchIssueList.mockResolvedValue([
        issueItem(907, 'Builder flash bug', [{ name: 'area/vscode' }]),
      ]);
      const first = await cache.getOverview(tmpDir);
      expect(first.builders[0].area).toBe('vscode');

      cache.invalidate();
      mockFetchIssueList.mockResolvedValue(null);
      const second = await cache.getOverview(tmpDir);
      expect(second.builders[0].area).toBe('vscode');
    });

    it('still classifies a genuinely unlabeled builder as Uncategorized (PIR #907)', async () => {
      createBuilderWorktree(tmpDir, 'pir-908-no-area', [
        "id: '0908'",
        'protocol: pir',
        'phase: implement',
        'gates:',
      ].join('\n'), '0908-no-area');

      const cache = new OverviewCache();

      // Issue is present across two refreshes but carries no area/* label.
      mockFetchIssueList.mockResolvedValue([
        issueItem(908, 'No area label', [{ name: 'bug' }]),
      ]);
      const first = await cache.getOverview(tmpDir);
      expect(first.builders[0].area).toBe('Uncategorized');

      cache.invalidate();
      const second = await cache.getOverview(tmpDir);
      expect(second.builders[0].area).toBe('Uncategorized');
    });

    it('classifies as Uncategorized when never previously resolved (PIR #907)', async () => {
      createBuilderWorktree(tmpDir, 'pir-909-absent', [
        "id: '0909'",
        'protocol: pir',
        'phase: implement',
        'gates:',
      ].join('\n'), '0909-absent');

      const cache = new OverviewCache();

      // Issue never appears in the open list → no resolved area to replay.
      mockFetchIssueList.mockResolvedValue([]);
      const data = await cache.getOverview(tmpDir);
      expect(data.builders[0].area).toBe('Uncategorized');
    });

    it('uses separate cache per workspace (Bugfix #333)', async () => {
      mockFetchPRList.mockResolvedValue([]);
      mockFetchIssueList.mockResolvedValue([]);
      mockFetchRecentlyClosed.mockResolvedValue([]);

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

        // Original workspace cache is still valid (not invalidated)
        await cache.getOverview(tmpDir);
        expect(mockFetchPRList).toHaveBeenCalledTimes(2); // no extra fetch
      } finally {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });

    it('fetches PRs, issues, recently closed, and merged PRs in parallel (Bugfix #400)', async () => {
      // Track the order of mock call starts and completions to verify concurrency.
      // If calls are sequential, each starts after the previous completes.
      // If parallel, all start before any completes.
      const callLog: string[] = [];

      mockFetchPRList.mockImplementation(() => {
        callLog.push('pr-start');
        return new Promise(resolve => {
          setTimeout(() => { callLog.push('pr-end'); resolve([]); }, 50);
        });
      });
      mockFetchIssueList.mockImplementation(() => {
        callLog.push('issue-start');
        return new Promise(resolve => {
          setTimeout(() => { callLog.push('issue-end'); resolve([]); }, 50);
        });
      });
      mockFetchRecentlyClosed.mockImplementation(() => {
        callLog.push('closed-start');
        return new Promise(resolve => {
          setTimeout(() => { callLog.push('closed-end'); resolve([]); }, 50);
        });
      });
      mockFetchMergedPRs.mockImplementation(() => {
        callLog.push('merged-start');
        return new Promise(resolve => {
          setTimeout(() => { callLog.push('merged-end'); resolve([]); }, 50);
        });
      });

      const cache = new OverviewCache();
      await cache.getOverview(tmpDir);

      // All four starts should come before any ends (parallel execution)
      const starts = callLog.filter(e => e.endsWith('-start'));
      const firstEnd = callLog.findIndex(e => e.endsWith('-end'));
      expect(starts).toHaveLength(4);
      expect(firstEnd).toBeGreaterThanOrEqual(4); // all 4 starts before first end
    });

    it('enriches recently closed items with PR URLs from merged PRs (Bugfix #465)', async () => {
      mockFetchRecentlyClosed.mockResolvedValue([
        { number: 100, title: 'Bug fix', url: 'https://github.com/org/repo/issues/100', labels: [{ name: 'bug' }], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date().toISOString() },
        { number: 200, title: 'Feature', url: 'https://github.com/org/repo/issues/200', labels: [], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date().toISOString() },
      ]);
      mockFetchMergedPRs.mockResolvedValue([
        { number: 150, title: '[Bugfix #100] Fix the bug', url: 'https://github.com/org/repo/pull/150', body: 'Fixes #100', createdAt: '2026-01-02T00:00:00Z', mergedAt: new Date().toISOString() },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      // Issue #100 should have a PR link; issue #200 should not
      const item100 = data.recentlyClosed.find(i => i.id === '100')!;
      expect(item100.prUrl).toBe('https://github.com/org/repo/pull/150');

      const item200 = data.recentlyClosed.find(i => i.id === '200')!;
      expect(item200.prUrl).toBeUndefined();
    });

    it('sorts recently closed items by closedAt descending (#1191)', async () => {
      // Forge search APIs return relevance order, not closure order. Feed the
      // items deliberately out of order and assert they come back most-recent-first.
      const now = Date.now();
      const hour = 60 * 60 * 1000;
      mockFetchRecentlyClosed.mockResolvedValue([
        { number: 1, title: 'Closed yesterday', url: 'https://github.com/org/repo/issues/1', labels: [], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date(now - 20 * hour).toISOString() },
        { number: 2, title: 'Closed this morning', url: 'https://github.com/org/repo/issues/2', labels: [], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date(now - 1 * hour).toISOString() },
        { number: 3, title: 'Closed midday', url: 'https://github.com/org/repo/issues/3', labels: [], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date(now - 8 * hour).toISOString() },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.recentlyClosed.map(i => i.id)).toEqual(['2', '3', '1']);
    });

    it('enriches recently closed items with spec/plan/review paths (Bugfix #465)', async () => {
      createSpecFile(tmpDir, 42, 'my-feature');
      createPlanFile(tmpDir, 42, 'my-feature');
      createReviewFile(tmpDir, 42, 'my-feature');

      mockFetchRecentlyClosed.mockResolvedValue([
        { number: 42, title: 'My Feature', url: 'https://github.com/org/repo/issues/42', labels: [], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date().toISOString() },
        { number: 99, title: 'No artifacts', url: 'https://github.com/org/repo/issues/99', labels: [{ name: 'bug' }], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date().toISOString() },
      ]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      const item42 = data.recentlyClosed.find(i => i.id === '42')!;
      expect(item42.specPath).toBe('codev/specs/42-my-feature.md');
      expect(item42.planPath).toBe('codev/plans/42-my-feature.md');
      expect(item42.reviewPath).toBe('codev/reviews/42-my-feature.md');

      const item99 = data.recentlyClosed.find(i => i.id === '99')!;
      expect(item99.specPath).toBeUndefined();
      expect(item99.planPath).toBeUndefined();
      expect(item99.reviewPath).toBeUndefined();
    });

    it('handles null merged PRs gracefully (Bugfix #465)', async () => {
      mockFetchRecentlyClosed.mockResolvedValue([
        { number: 50, title: 'Bug', url: 'https://github.com/org/repo/issues/50', labels: [{ name: 'bug' }], createdAt: '2026-01-01T00:00:00Z', closedAt: new Date().toISOString() },
      ]);
      mockFetchMergedPRs.mockResolvedValue(null);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.recentlyClosed).toHaveLength(1);
      expect(data.recentlyClosed[0].prUrl).toBeUndefined();
    });

    it('enriches issueId from DB issue_number for unknown protocols (#664)', async () => {
      // research-533 doesn't match any protocol regex → soft mode, issueId null
      const worktreePath = createBuilderWorktree(tmpDir, 'research-533-context-window');

      // Create a real DB with issue_number for this worktree
      createStateDb(tmpDir, [{ worktree: worktreePath, issue_number: 533 }]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      expect(data.builders[0].issueId).toBe('533');
    });

    it('DB issue_number overrides regex-parsed issueId (#664)', async () => {
      // spir-42 matches the regex → issueId '42' from regex
      // DB also has issue_number 42 → should still be '42'
      const worktreePath = createBuilderWorktree(tmpDir, 'spir-42-feature', [
        "id: '0042'",
        'title: feature',
        'protocol: spir',
        'phase: implement',
        'gates:',
      ].join('\n'), '0042-feature');

      createStateDb(tmpDir, [{ worktree: worktreePath, issue_number: 42 }]);

      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      expect(data.builders[0].issueId).toBe('42');
    });

    it('falls back to regex-parsed issueId when DB has no issue_number (#664)', async () => {
      createBuilderWorktree(tmpDir, 'spir-42-feature', [
        "id: '0042'",
        'title: feature',
        'protocol: spir',
        'phase: implement',
        'gates:',
      ].join('\n'), '0042-feature');

      // No state.db → regex-parsed issueId preserved
      const cache = new OverviewCache();
      const data = await cache.getOverview(tmpDir);

      expect(data.builders).toHaveLength(1);
      expect(data.builders[0].issueId).toBe('42');
    });

    // Spec 823: spawnedByArchitect enrichment from state.db.builders.
    describe('Spec 823 — spawnedByArchitect enrichment', () => {
      it('populates spawnedByArchitect from state.db for strict-mode builders', async () => {
        const worktreePath = createBuilderWorktree(tmpDir, 'spir-823-attribution', [
          "id: '0823'",
          'title: attribution',
          'protocol: spir',
          'phase: implement',
          'gates:',
        ].join('\n'), '0823-attribution');

        createStateDb(tmpDir, [
          { worktree: worktreePath, issue_number: 823, spawned_by_architect: 'ob-refine' },
        ]);

        const cache = new OverviewCache();
        const data = await cache.getOverview(tmpDir);

        expect(data.builders).toHaveLength(1);
        expect(data.builders[0].spawnedByArchitect).toBe('ob-refine');
        expect(data.builders[0].issueId).toBe('823');
      });

      it('populates spawnedByArchitect for soft-mode builders with issue_number=NULL (iter-1 Gemini)', async () => {
        // Soft-mode / task-mode builders have issue_number=null in state.db.
        // Before Spec 823, the SQL enrichment had `WHERE issue_number IS NOT NULL`
        // which excluded these rows entirely. After Spec 823, the WHERE is
        // dropped and conditional assignment ensures spawnedByArchitect populates
        // even when issue_number is null.
        const worktreePath = createBuilderWorktree(tmpDir, 'task-experiment-foo');

        createStateDb(tmpDir, [
          { worktree: worktreePath, issue_number: null, spawned_by_architect: 'ob-refine' },
        ]);

        const cache = new OverviewCache();
        const data = await cache.getOverview(tmpDir);

        expect(data.builders).toHaveLength(1);
        expect(data.builders[0].spawnedByArchitect).toBe('ob-refine');
        // issueId stays null since neither the regex nor the DB supplied one.
        expect(data.builders[0].issueId).toBeNull();
      });

      it('leaves spawnedByArchitect null when state.db has NULL for the column (legacy pre-#755)', async () => {
        const worktreePath = createBuilderWorktree(tmpDir, 'spir-50-legacy', [
          "id: '0050'",
          'title: legacy',
          'protocol: spir',
          'phase: implement',
          'gates:',
        ].join('\n'), '0050-legacy');

        createStateDb(tmpDir, [
          { worktree: worktreePath, issue_number: 50, spawned_by_architect: null },
        ]);

        const cache = new OverviewCache();
        const data = await cache.getOverview(tmpDir);

        expect(data.builders).toHaveLength(1);
        expect(data.builders[0].spawnedByArchitect).toBeNull();
        // Existing issueId enrichment still works (regression check).
        expect(data.builders[0].issueId).toBe('50');
      });

      it('leaves spawnedByArchitect null when state.db does not exist', async () => {
        createBuilderWorktree(tmpDir, 'spir-99-no-db', [
          "id: '0099'",
          'title: nodb',
          'protocol: spir',
          'phase: implement',
          'gates:',
        ].join('\n'), '0099-no-db');

        // No createStateDb call → no state.db file at all.
        const cache = new OverviewCache();
        const data = await cache.getOverview(tmpDir);

        expect(data.builders).toHaveLength(1);
        expect(data.builders[0].spawnedByArchitect).toBeNull();
      });
    });
  });
});

// ============================================================================
// #1410: per-builder queued-feedback count + workspace feedback mode
// ============================================================================

describe('countQueuedFeedback (#1410)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeQueue(content: string): void {
    fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codev', 'pending-comments.json'), content);
  }

  it('counts the comments in a builder’s queue file', () => {
    writeQueue(JSON.stringify({ version: 1, builderId: 'pir-1', comments: [
      { id: 'a', createdAt: 't', file: 'f', lineRange: null, body: 'x' },
      { id: 'b', createdAt: 't', file: 'g', lineRange: null, body: 'y' },
    ] }));
    expect(countQueuedFeedback(dir)).toBe(2);
  });

  it('is 0 for a missing, empty, or corrupt file', () => {
    expect(countQueuedFeedback(dir)).toBe(0); // no file
    writeQueue('not json at all');
    expect(countQueuedFeedback(dir)).toBe(0);
    writeQueue(JSON.stringify({ version: 1, builderId: 'x', comments: 'nope' }));
    expect(countQueuedFeedback(dir)).toBe(0); // comments not an array
  });
});

describe('readFeedbackMode (#1410)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeSettings(content: string): void {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), content);
  }

  it('maps the codev.diffCodelensMode setting to the wire value', () => {
    writeSettings(JSON.stringify({ 'codev.diffCodelensMode': 'comment' }));
    expect(readFeedbackMode(dir)).toBe('queue');
    writeSettings(JSON.stringify({ 'codev.diffCodelensMode': 'forward' }));
    expect(readFeedbackMode(dir)).toBe('forward');
  });

  it('defaults to forward when the file / key is absent or unreadable', () => {
    expect(readFeedbackMode(dir)).toBe('forward'); // no file
    writeSettings(JSON.stringify({ 'editor.tabSize': 2 }));
    expect(readFeedbackMode(dir)).toBe('forward'); // key absent
  });

  it('tolerates JSONC comments / trailing commas around the setting', () => {
    writeSettings('{\n  // my settings\n  "codev.diffCodelensMode": "comment",\n}');
    expect(readFeedbackMode(dir)).toBe('queue');
  });
});
