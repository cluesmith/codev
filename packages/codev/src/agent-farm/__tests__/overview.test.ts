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
} from '../servers/overview.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockFetchPRList, mockFetchIssueList } = vi.hoisted(() => ({
  mockFetchPRList: vi.fn(),
  mockFetchIssueList: vi.fn(),
}));

vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  return {
    ...actual,
    fetchPRList: mockFetchPRList,
    fetchIssueList: mockFetchIssueList,
  };
});

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
): string {
  const builderDir = path.join(root, '.builders', builderName);
  if (statusYaml) {
    const projectDir = path.join(builderDir, 'codev', 'projects', `test-project`);
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
  });

  // ==========================================================================
  // discoverBuilders
  // ==========================================================================

  describe('discoverBuilders', () => {
    it('returns empty array when .builders/ does not exist', () => {
      expect(discoverBuilders(tmpDir)).toEqual([]);
    });

    it('discovers strict mode builder with status.yaml', () => {
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
      ].join('\n'));

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('0126');
      expect(builders[0].issueNumber).toBe(126);
      expect(builders[0].phase).toBe('tower_endpoint');
      expect(builders[0].mode).toBe('strict');
      expect(builders[0].gates['pr-ready']).toBe('pending');
    });

    it('discovers soft mode builder without status.yaml', () => {
      createBuilderWorktree(tmpDir, 'soft-builder-42');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].id).toBe('soft-builder-42');
      expect(builders[0].mode).toBe('soft');
      expect(builders[0].phase).toBe('');
    });

    it('discovers multiple builders', () => {
      createBuilderWorktree(tmpDir, 'spir-100-feature', [
        "id: '100'",
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: phase_1',
        'gates:',
      ].join('\n'));

      createBuilderWorktree(tmpDir, 'bugfix-200-fix');

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(2);

      const strict = builders.find(b => b.mode === 'strict');
      const soft = builders.find(b => b.mode === 'soft');
      expect(strict?.issueNumber).toBe(100);
      expect(soft?.id).toBe('bugfix-200-fix');
    });

    it('treats builder with codev/projects but no status.yaml as soft', () => {
      const builderDir = path.join(tmpDir, '.builders', 'no-status');
      fs.mkdirSync(path.join(builderDir, 'codev', 'projects', 'test'), { recursive: true });
      // No status.yaml

      const builders = discoverBuilders(tmpDir);
      expect(builders).toHaveLength(1);
      expect(builders[0].mode).toBe('soft');
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
        "id: '42'",
        'protocol: spir',
        'phase: implement',
        'current_plan_phase: coding',
        'gates:',
      ].join('\n'));

      mockFetchPRList.mockResolvedValue([
        { number: 10, title: '[Spec 42] Add feature', reviewDecision: 'APPROVED', body: '' },
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
        "id: '1'",
        'protocol: spir',
        'phase: specify',
        'current_plan_phase: draft',
        'gates:',
      ].join('\n'));

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
        { number: 1, title: 'Test', reviewDecision: '', body: '' },
      ]);

      const data2 = await cache.getOverview(tmpDir);
      expect(data2.errors?.prs).toBeUndefined();
      expect(data2.pendingPRs).toHaveLength(1);
    });

    it('filters backlog issues that are linked to PRs', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 10, title: 'Fix', reviewDecision: '', body: 'Fixes #42' },
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

    it('parses PR review statuses', async () => {
      mockFetchPRList.mockResolvedValue([
        { number: 1, title: 'Approved', reviewDecision: 'APPROVED', body: '' },
        { number: 2, title: 'Changes', reviewDecision: 'CHANGES_REQUESTED', body: '' },
        { number: 3, title: 'Pending', reviewDecision: '', body: '' },
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
