/**
 * Unit tests for the analytics service (Spec 456, Phase 1).
 *
 * Tests computeAnalytics() with mocked GitHub CLI and MetricsDB.
 * Tests fetchMergedPRs/fetchClosedIssues via child_process mock.
 *
 * costByProject integration tests live in consult/__tests__/metrics.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before all imports
// ---------------------------------------------------------------------------

const execFileMock = vi.hoisted(() => vi.fn());
const mockSummary = vi.hoisted(() => vi.fn());
const mockCostByProject = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());

// Mock child_process + util (for GitHub CLI calls in github.ts)
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));
vi.mock('node:util', () => ({
  promisify: () => execFileMock,
}));

// Mock MetricsDB (for consultation metrics in analytics.ts)
vi.mock('../../commands/consult/metrics.js', () => ({
  MetricsDB: class MockMetricsDB {
    summary = mockSummary;
    costByProject = mockCostByProject;
    close = mockClose;
  },
}));

// ---------------------------------------------------------------------------
// Static imports (resolved after mocks are hoisted)
// ---------------------------------------------------------------------------

import { fetchMergedPRs, fetchClosedIssues } from '../../lib/github.js';
import { computeAnalytics, clearAnalyticsCache } from '../servers/analytics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGhOutput(responses: Record<string, string>) {
  execFileMock.mockImplementation((_cmd: string, args: string[]) => {
    const argsStr = args.join(' ');

    if (argsStr.includes('pr') && argsStr.includes('list') && argsStr.includes('merged')) {
      return Promise.resolve({ stdout: responses.mergedPRs ?? '[]' });
    }
    if (argsStr.includes('issue') && argsStr.includes('list') && argsStr.includes('closed')) {
      return Promise.resolve({ stdout: responses.closedIssues ?? '[]' });
    }
    if (argsStr.includes('issue') && argsStr.includes('list') && !argsStr.includes('closed')) {
      return Promise.resolve({ stdout: responses.openIssues ?? '[]' });
    }

    return Promise.resolve({ stdout: '[]' });
  });
}

function defaultSummary() {
  return {
    totalCount: 5,
    totalDuration: 500,
    totalCost: 15.00,
    costCount: 5,
    successCount: 4,
    byModel: [
      { model: 'gemini', count: 2, avgDuration: 80, totalCost: 5.00, costCount: 2, successRate: 100, successCount: 2 },
      { model: 'codex', count: 2, avgDuration: 90, totalCost: 6.00, costCount: 2, successRate: 100, successCount: 2 },
      { model: 'claude', count: 1, avgDuration: 180, totalCost: 4.00, costCount: 1, successRate: 0, successCount: 0 },
    ],
    byType: [
      { reviewType: 'spec', count: 2, avgDuration: 70, totalCost: 3.00, costCount: 2 },
      { reviewType: 'pr', count: 3, avgDuration: 120, totalCost: 12.00, costCount: 3 },
    ],
    byProtocol: [
      { protocol: 'spir', count: 3, totalCost: 10.00, costCount: 3 },
      { protocol: 'tick', count: 2, totalCost: 5.00, costCount: 2 },
    ],
  };
}

function defaultCostByProject() {
  return [
    { projectId: '42', totalCost: 8.50 },
    { projectId: '73', totalCost: 6.50 },
  ];
}

// ---------------------------------------------------------------------------
// fetchMergedPRs
// ---------------------------------------------------------------------------

describe('fetchMergedPRs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed merged PRs from gh CLI', async () => {
    const prs = [
      { number: 1, title: 'PR 1', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42' },
    ];
    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify(prs) });

    const result = await fetchMergedPRs('2026-02-10', '/tmp');
    expect(result).toEqual(prs);
  });

  it('includes --search merged:>=DATE when since is provided', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '[]' });

    await fetchMergedPRs('2026-02-14', '/tmp');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--search', 'merged:>=2026-02-14']),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('omits --search when since is null', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '[]' });

    await fetchMergedPRs(null, '/tmp');

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--search');
  });

  it('returns null on failure', async () => {
    execFileMock.mockRejectedValueOnce(new Error('gh not found'));

    const result = await fetchMergedPRs('2026-02-14', '/tmp');
    expect(result).toBeNull();
  });

  it('passes --limit 1000', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '[]' });

    await fetchMergedPRs('2026-02-14', '/tmp');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--limit', '1000']),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchClosedIssues
// ---------------------------------------------------------------------------

describe('fetchClosedIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed closed issues from gh CLI', async () => {
    const issues = [
      { number: 42, title: 'Bug', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-11T00:00:00Z', labels: [{ name: 'bug' }] },
    ];
    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify(issues) });

    const result = await fetchClosedIssues('2026-02-10', '/tmp');
    expect(result).toEqual(issues);
  });

  it('includes --search closed:>=DATE when since is provided', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '[]' });

    await fetchClosedIssues('2026-02-14', '/tmp');

    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--search', 'closed:>=2026-02-14']),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('returns null on failure', async () => {
    execFileMock.mockRejectedValueOnce(new Error('gh not found'));

    const result = await fetchClosedIssues('2026-02-14', '/tmp');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeAnalytics
// ---------------------------------------------------------------------------

describe('computeAnalytics', () => {
  beforeEach(() => {
    clearAnalyticsCache();
    vi.clearAllMocks();
    mockSummary.mockReturnValue(defaultSummary());
    mockCostByProject.mockReturnValue(defaultCostByProject());
  });

  it('assembles full statistics from all data sources', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: '[Spec 42] Feature', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T12:00:00Z', body: 'Closes #42' },
        { number: 2, title: '[Spec 73] Other', createdAt: '2026-02-12T00:00:00Z', mergedAt: '2026-02-13T00:00:00Z', body: '' },
      ]),
      closedIssues: JSON.stringify([
        { number: 42, title: 'Bug fix', createdAt: '2026-02-08T00:00:00Z', closedAt: '2026-02-11T12:00:00Z', labels: [{ name: 'bug' }] },
        { number: 50, title: 'Feature', createdAt: '2026-02-09T00:00:00Z', closedAt: '2026-02-12T00:00:00Z', labels: [] },
      ]),
      openIssues: JSON.stringify([
        { number: 100, title: 'Open bug', url: '', labels: [{ name: 'bug' }], createdAt: '2026-02-01T00:00:00Z' },
        { number: 101, title: 'Open feature', url: '', labels: [], createdAt: '2026-02-02T00:00:00Z' },
        { number: 102, title: 'Another feature', url: '', labels: [], createdAt: '2026-02-03T00:00:00Z' },
      ]),
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 3);

    expect(result.timeRange).toBe('7d');
    expect(result.github.prsMerged).toBe(2);
    expect(result.github.avgTimeToMergeHours).toBeCloseTo(30); // (36+24)/2
    expect(result.github.bugBacklog).toBe(1);
    expect(result.github.nonBugBacklog).toBe(2);
    expect(result.github.issuesClosed).toBe(2);
    expect(result.github.avgTimeToCloseBugsHours).toBeCloseTo(84); // 3.5 days for bug only

    expect(result.builders.projectsCompleted).toBe(2); // #42 (body) + #73 (title)
    expect(result.builders.activeBuilders).toBe(3);

    expect(result.consultation.totalCount).toBe(5);
    expect(result.consultation.totalCostUsd).toBe(15.00);
    expect(result.consultation.costByModel).toEqual({ gemini: 5.00, codex: 6.00, claude: 4.00 });
    expect(result.consultation.avgLatencySeconds).toBeCloseTo(100);
    expect(result.consultation.successRate).toBeCloseTo(80);
    expect(result.consultation.byModel).toHaveLength(3);
    expect(result.consultation.byReviewType).toEqual({ spec: 2, pr: 3 });
    expect(result.consultation.byProtocol).toEqual({ spir: 3, tick: 2 });
    expect(result.consultation.costByProject).toEqual(defaultCostByProject());

    expect(result.errors).toBeUndefined();
  });

  it('returns 24h label for range "1"', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '1', 0);
    expect(result.timeRange).toBe('24h');
  });

  it('returns 30d label for range "30"', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '30', 0);
    expect(result.timeRange).toBe('30d');
  });

  it('returns all label for range "all"', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', 'all', 0);
    expect(result.timeRange).toBe('all');
  });

  it('passes null since date for "all" range', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    await computeAnalytics('/tmp/workspace', 'all', 0);

    const prCall = execFileMock.mock.calls.find(
      (c: unknown[]) => (c[1] as string[]).includes('merged'),
    );
    expect(prCall).toBeDefined();
    expect((prCall![1] as string[])).not.toContain('--search');
  });

  it('passes a date string for "7" range', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    await computeAnalytics('/tmp/workspace', '7', 0);

    const prCall = execFileMock.mock.calls.find(
      (c: unknown[]) => (c[1] as string[]).includes('merged'),
    );
    expect(prCall).toBeDefined();
    const args = prCall![1] as string[];
    const searchIdx = args.indexOf('--search');
    expect(searchIdx).toBeGreaterThan(-1);
    expect(args[searchIdx + 1]).toMatch(/^merged:>=\d{4}-\d{2}-\d{2}$/);
  });

  // --- Partial failure: GitHub unavailable ---

  it('returns GitHub defaults and error when all GitHub calls fail', async () => {
    execFileMock.mockRejectedValue(new Error('gh not found'));

    const result = await computeAnalytics('/tmp/workspace', '7', 2);

    expect(result.errors?.github).toBeDefined();
    expect(result.github.prsMerged).toBe(0);
    expect(result.github.avgTimeToMergeHours).toBeNull();
    expect(result.github.bugBacklog).toBe(0);
    expect(result.github.nonBugBacklog).toBe(0);
    expect(result.github.issuesClosed).toBe(0);
    expect(result.github.avgTimeToCloseBugsHours).toBeNull();
    expect(result.builders.projectsCompleted).toBe(0);
    expect(result.builders.throughputPerWeek).toBe(0);
    expect(result.builders.activeBuilders).toBe(2);
    // Consultation still works
    expect(result.consultation.totalCount).toBe(5);
    expect(result.errors?.consultation).toBeUndefined();
  });

  // --- Partial failure: MetricsDB unavailable ---

  it('returns consultation defaults and error when MetricsDB fails', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    mockSummary.mockImplementation(() => { throw new Error('DB file not found'); });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);

    expect(result.errors?.consultation).toBe('DB file not found');
    expect(result.consultation.totalCount).toBe(0);
    expect(result.consultation.totalCostUsd).toBeNull();
    expect(result.consultation.costByModel).toEqual({});
    expect(result.consultation.avgLatencySeconds).toBeNull();
    expect(result.consultation.successRate).toBeNull();
    expect(result.consultation.byModel).toEqual([]);
    expect(result.consultation.byReviewType).toEqual({});
    expect(result.consultation.byProtocol).toEqual({});
    expect(result.consultation.costByProject).toEqual([]);
    expect(result.errors?.github).toBeUndefined();
  });

  // --- Null averages ---

  it('returns null averages when no data exists', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    mockSummary.mockReturnValue({
      totalCount: 0, totalDuration: 0, totalCost: null, costCount: 0,
      successCount: 0, byModel: [], byType: [], byProtocol: [],
    });
    mockCostByProject.mockReturnValue([]);

    const result = await computeAnalytics('/tmp/workspace', '7', 0);

    expect(result.github.avgTimeToMergeHours).toBeNull();
    expect(result.github.avgTimeToCloseBugsHours).toBeNull();
    expect(result.consultation.avgLatencySeconds).toBeNull();
    expect(result.consultation.successRate).toBeNull();
  });

  // --- Projects completed ---

  it('excludes PRs without linked issues from projectsCompleted', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'No link', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'No issue ref' },
        { number: 2, title: '[Spec 42] Feature', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: '' },
      ]),
      closedIssues: '[]',
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.builders.projectsCompleted).toBe(1);
  });

  it('counts all linked issues from a single PR with multiple references', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'Big PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42 and Fixes #73' },
      ]),
      closedIssues: '[]',
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.builders.projectsCompleted).toBe(2); // Both #42 and #73
  });

  it('counts distinct issues when multiple PRs link to same issue', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: '[Spec 42] Part 1', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42' },
        { number: 2, title: '[Spec 42] Part 2', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Closes #42' },
      ]),
      closedIssues: '[]',
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.builders.projectsCompleted).toBe(1);
  });

  it('counts multiple issues linked from a single PR', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'Big cleanup', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42, Closes #73, Resolves #99' },
      ]),
      closedIssues: '[]',
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.builders.projectsCompleted).toBe(3);
  });

  // --- Bug-only avg time to close ---

  it('only counts bug-labeled issues for avgTimeToCloseBugsHours', async () => {
    mockGhOutput({
      mergedPRs: '[]',
      closedIssues: JSON.stringify([
        { number: 1, title: 'Bug', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-11T00:00:00Z', labels: [{ name: 'bug' }] },
        { number: 2, title: 'Feature', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-15T00:00:00Z', labels: [{ name: 'enhancement' }] },
      ]),
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.github.avgTimeToCloseBugsHours).toBeCloseTo(24);
  });

  // --- costByModel derivation ---

  it('derives costByModel correctly, excluding null costs', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });
    mockSummary.mockReturnValue({
      ...defaultSummary(),
      byModel: [
        { model: 'gemini', count: 1, avgDuration: 60, totalCost: null, costCount: 0, successRate: 100, successCount: 1 },
        { model: 'codex', count: 1, avgDuration: 80, totalCost: 3.50, costCount: 1, successRate: 100, successCount: 1 },
      ],
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.consultation.costByModel).toEqual({ codex: 3.50 });
  });

  // --- Caching ---

  it('returns cached result on second call within TTL', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });

    const result1 = await computeAnalytics('/tmp/workspace', '7', 3);
    const result2 = await computeAnalytics('/tmp/workspace', '7', 3);

    expect(result1).toBe(result2);
    expect(mockSummary).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when refresh=true', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });

    await computeAnalytics('/tmp/workspace', '7', 3);
    await computeAnalytics('/tmp/workspace', '7', 3, true);

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  it('does not share cache between different ranges', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]', openIssues: '[]' });

    await computeAnalytics('/tmp/workspace', '7', 3);
    await computeAnalytics('/tmp/workspace', '30', 3);

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  // --- Throughput ---

  it('computes throughput for 30d range', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-02T00:00:00Z', body: 'Fixes #10' },
        { number: 2, title: 'PR', createdAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-02T00:00:00Z', body: 'Fixes #20' },
        { number: 3, title: 'PR', createdAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-02T00:00:00Z', body: 'Fixes #30' },
        { number: 4, title: 'PR', createdAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-02T00:00:00Z', body: 'Fixes #40' },
      ]),
      closedIssues: '[]',
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '30', 0);
    const expected = Math.round((4 / (30 / 7)) * 10) / 10;
    expect(result.builders.throughputPerWeek).toBeCloseTo(expected, 1);
  });

  it('computes throughput for 7d range (equals projectsCompleted)', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-02T00:00:00Z', body: 'Fixes #10' },
        { number: 2, title: 'PR', createdAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-02T00:00:00Z', body: 'Fixes #20' },
      ]),
      closedIssues: '[]',
      openIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result.builders.throughputPerWeek).toBe(2);
  });
});
