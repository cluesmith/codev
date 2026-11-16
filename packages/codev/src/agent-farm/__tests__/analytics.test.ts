/**
 * Unit tests for the analytics service.
 *
 * Tests computeAnalytics() with mocked GitHub CLI and MetricsDB.
 * Tests fetchMergedPRs/fetchClosedIssues via child_process mock.
 * Tests protocolFromBranch for branch-name-based protocol derivation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before all imports
// ---------------------------------------------------------------------------

const execFileMock = vi.hoisted(() => vi.fn());
const executeForgeCommandMock = vi.hoisted(() => vi.fn());
const mockSummary = vi.hoisted(() => vi.fn());
const mockAgentTimeByProtocol = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());

// Mock child_process + util (for direct gh calls like fetchOnItTimestamps)
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  exec: vi.fn(),
  execSync: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: () => execFileMock,
}));

// Mock the forge module so functions routed through executeForgeCommand work
vi.mock('../../lib/forge.js', () => ({
  executeForgeCommand: executeForgeCommandMock,
  executeForgeCommandSync: vi.fn(),
  getForgeCommand: vi.fn(),
  isConceptDisabled: vi.fn(),
  loadForgeConfig: vi.fn(),
  getKnownConcepts: vi.fn(),
  getDefaultCommand: vi.fn(),
  validateForgeConfig: vi.fn(),
}));

// Mock MetricsDB (for consultation metrics in analytics.ts)
vi.mock('../../commands/consult/metrics.js', () => ({
  MetricsDB: class MockMetricsDB {
    summary = mockSummary;
    agentTimeByProtocol = mockAgentTimeByProtocol;
    close = mockClose;
  },
}));

// ---------------------------------------------------------------------------
// Static imports (resolved after mocks are hoisted)
// ---------------------------------------------------------------------------

import { fetchMergedPRs, fetchClosedIssues, fetchOnItTimestamps } from '../../lib/github.js';
import { computeAnalytics, clearAnalyticsCache, protocolFromBranch } from '../servers/analytics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGhOutput(responses: Record<string, string>, onItTimestamps?: Record<number, string>) {
  // Mock forge concept commands for fetchMergedPRs, fetchClosedIssues, and fetchOnItTimestamps
  executeForgeCommandMock.mockImplementation((concept: string) => {
    if (concept === 'recently-merged') {
      return Promise.resolve(JSON.parse(responses.mergedPRs ?? '[]'));
    }
    if (concept === 'recently-closed') {
      return Promise.resolve(JSON.parse(responses.closedIssues ?? '[]'));
    }
    if (concept === 'on-it-timestamps') {
      // Return GraphQL-style response matching the default gh command output
      const repository: Record<string, unknown> = {};
      if (onItTimestamps) {
        for (const [num, ts] of Object.entries(onItTimestamps)) {
          repository[`issue${num}`] = {
            comments: { nodes: [{ body: 'On it! Working on a fix now.', createdAt: ts }] },
          };
        }
      }
      return Promise.resolve({ data: { repository } });
    }
    return Promise.resolve(null);
  });

  // Mock direct execFile for git remote get-url (used by getRepoInfo for GraphQL repo context)
  execFileMock.mockImplementation((_cmd: string, args: string[]) => {
    const argsStr = args.join(' ');

    // git remote get-url origin (for repo owner/name)
    if (argsStr.includes('remote') && argsStr.includes('get-url')) {
      return Promise.resolve({ stdout: 'https://github.com/test/repo.git\n' });
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

// ---------------------------------------------------------------------------
// fetchMergedPRs
// ---------------------------------------------------------------------------

describe('fetchMergedPRs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed merged PRs via forge concept command', async () => {
    const prs = [
      { number: 1, title: 'PR 1', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42' },
    ];
    executeForgeCommandMock.mockResolvedValueOnce(prs);

    const result = await fetchMergedPRs('2026-02-10', '/tmp');
    expect(result).toEqual(prs);
  });

  it('passes CODEV_SINCE_DATE when since is provided', async () => {
    executeForgeCommandMock.mockResolvedValueOnce([]);

    await fetchMergedPRs('2026-02-14', '/tmp');

    expect(executeForgeCommandMock).toHaveBeenCalledWith(
      'recently-merged',
      expect.objectContaining({ CODEV_SINCE_DATE: '2026-02-14' }),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('omits CODEV_SINCE_DATE when since is null', async () => {
    executeForgeCommandMock.mockResolvedValueOnce([]);

    await fetchMergedPRs(null, '/tmp');

    const envArg = executeForgeCommandMock.mock.calls[0][1] as Record<string, string>;
    expect(envArg).not.toHaveProperty('CODEV_SINCE_DATE');
  });

  it('returns null on failure', async () => {
    executeForgeCommandMock.mockResolvedValueOnce(null);

    const result = await fetchMergedPRs('2026-02-14', '/tmp');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchClosedIssues
// ---------------------------------------------------------------------------

describe('fetchClosedIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed closed issues via forge concept command', async () => {
    const issues = [
      { number: 42, title: 'Bug', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-11T00:00:00Z', labels: [{ name: 'bug' }] },
    ];
    executeForgeCommandMock.mockResolvedValueOnce(issues);

    const result = await fetchClosedIssues('2026-02-10', '/tmp');
    expect(result).toEqual(issues);
  });

  it('passes CODEV_SINCE_DATE when since is provided', async () => {
    executeForgeCommandMock.mockResolvedValueOnce([]);

    await fetchClosedIssues('2026-02-14', '/tmp');

    expect(executeForgeCommandMock).toHaveBeenCalledWith(
      'recently-closed',
      expect.objectContaining({ CODEV_SINCE_DATE: '2026-02-14' }),
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('returns null on failure', async () => {
    executeForgeCommandMock.mockResolvedValueOnce(null);

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
    mockAgentTimeByProtocol.mockReturnValue([]);
  });

  it('assembles full statistics from all data sources', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: '[Spec 42] Feature', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T12:00:00Z', body: 'Closes #42', headRefName: 'builder/spir-42-feature' },
        { number: 2, title: '[Spec 73] Other', createdAt: '2026-02-12T00:00:00Z', mergedAt: '2026-02-13T00:00:00Z', body: '', headRefName: 'builder/aspir-73-other' },
      ]),
      closedIssues: JSON.stringify([
        { number: 42, title: 'Bug fix', createdAt: '2026-02-08T00:00:00Z', closedAt: '2026-02-11T12:00:00Z', labels: [{ name: 'bug' }] },
        { number: 50, title: 'Feature', createdAt: '2026-02-09T00:00:00Z', closedAt: '2026-02-12T00:00:00Z', labels: [] },
      ]),
    });

    const result = await computeAnalytics('/tmp/workspace', '7');

    expect(result.timeRange).toBe('7d');
    expect(result.activity.prsMerged).toBe(2);
    expect(result.activity.medianTimeToMergeHours).toBeCloseTo(30); // median of [24, 36] = 30
    expect(result.activity.issuesClosed).toBe(2);
    expect(result.activity.medianTimeToCloseBugsHours).toBeCloseTo(84); // 3.5 days for bug only (single item)
    expect(result.activity).not.toHaveProperty('activeBuilders');
    // Protocol breakdown now includes count + avgWallClockHours + avgAgentTimeHours
    expect(result.activity.projectsByProtocol.spir).toEqual({ count: 1, avgWallClockHours: expect.closeTo(36), avgAgentTimeHours: null });
    expect(result.activity.projectsByProtocol.aspir).toEqual({ count: 1, avgWallClockHours: expect.closeTo(24), avgAgentTimeHours: null });
    // Removed fields
    expect(result.activity).not.toHaveProperty('projectsCompleted');
    expect(result.activity).not.toHaveProperty('bugsFixed');
    expect(result.activity).not.toHaveProperty('throughputPerWeek');

    expect(result.consultation.totalCount).toBe(5);
    expect(result.consultation.totalCostUsd).toBe(15.00);
    expect(result.consultation.costByModel).toEqual({ gemini: 5.00, codex: 6.00, claude: 4.00 });
    expect(result.consultation.avgLatencySeconds).toBeCloseTo(100);
    expect(result.consultation.successRate).toBeCloseTo(80);
    expect(result.consultation.byModel).toHaveLength(3);
    expect(result.consultation.byReviewType).toEqual({ spec: 2, pr: 3 });
    expect(result.consultation.byProtocol).toEqual({ spir: 3, tick: 2 });

    expect(result.errors).toBeUndefined();
  });

  it('does not have github or builders top-level keys', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result).not.toHaveProperty('github');
    expect(result).not.toHaveProperty('builders');
    expect(result).toHaveProperty('activity');
  });

  it('does not have costByProject in consultation', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.consultation).not.toHaveProperty('costByProject');
  });

  it('returns 24h label for range "1"', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '1');
    expect(result.timeRange).toBe('24h');
  });

  it('returns 30d label for range "30"', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '30');
    expect(result.timeRange).toBe('30d');
  });

  it('returns all label for range "all"', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', 'all');
    expect(result.timeRange).toBe('all');
  });

  it('passes no CODEV_SINCE_DATE for "all" range', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    await computeAnalytics('/tmp/workspace', 'all');

    // fetchMergedPRs(null, ...) should pass empty env (no CODEV_SINCE_DATE)
    const mergedCall = executeForgeCommandMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'recently-merged',
    );
    expect(mergedCall).toBeDefined();
    const env = mergedCall![1] as Record<string, string>;
    expect(env).not.toHaveProperty('CODEV_SINCE_DATE');
  });

  it('passes CODEV_SINCE_DATE for "7" range', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    await computeAnalytics('/tmp/workspace', '7');

    const mergedCall = executeForgeCommandMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'recently-merged',
    );
    expect(mergedCall).toBeDefined();
    const env = mergedCall![1] as Record<string, string>;
    expect(env.CODEV_SINCE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // --- Partial failure: GitHub unavailable ---

  it('returns GitHub defaults and error when all GitHub calls fail', async () => {
    executeForgeCommandMock.mockResolvedValue(null);
    execFileMock.mockRejectedValue(new Error('gh not found'));

    const result = await computeAnalytics('/tmp/workspace', '7');

    expect(result.errors?.github).toBeDefined();
    expect(result.activity.prsMerged).toBe(0);
    expect(result.activity.medianTimeToMergeHours).toBeNull();
    expect(result.activity.issuesClosed).toBe(0);
    expect(result.activity.medianTimeToCloseBugsHours).toBeNull();
    expect(result.activity).not.toHaveProperty('activeBuilders');
    expect(result.activity.projectsByProtocol).toEqual({});
    // Consultation still works
    expect(result.consultation.totalCount).toBe(5);
    expect(result.errors?.consultation).toBeUndefined();
  });

  // --- Partial failure: MetricsDB unavailable ---

  it('returns consultation defaults and error when MetricsDB fails', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    mockSummary.mockImplementation(() => { throw new Error('DB file not found'); });

    const result = await computeAnalytics('/tmp/workspace', '7');

    expect(result.errors?.consultation).toBe('DB file not found');
    expect(result.consultation.totalCount).toBe(0);
    expect(result.consultation.totalCostUsd).toBeNull();
    expect(result.consultation.costByModel).toEqual({});
    expect(result.consultation.avgLatencySeconds).toBeNull();
    expect(result.consultation.successRate).toBeNull();
    expect(result.consultation.byModel).toEqual([]);
    expect(result.consultation.byReviewType).toEqual({});
    expect(result.consultation.byProtocol).toEqual({});
    expect(result.errors?.github).toBeUndefined();
  });

  // --- Null averages ---

  it('returns null averages when no data exists', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    mockSummary.mockReturnValue({
      totalCount: 0, totalDuration: 0, totalCost: null, costCount: 0,
      successCount: 0, byModel: [], byType: [], byProtocol: [],
    });

    const result = await computeAnalytics('/tmp/workspace', '7');

    expect(result.activity.medianTimeToMergeHours).toBeNull();
    expect(result.activity.medianTimeToCloseBugsHours).toBeNull();
    expect(result.consultation.avgLatencySeconds).toBeNull();
    expect(result.consultation.successRate).toBeNull();
  });

  // --- Bug-only avg time to close ---

  it('only counts bug-labeled issues for medianTimeToCloseBugsHours', async () => {
    mockGhOutput({
      mergedPRs: '[]',
      closedIssues: JSON.stringify([
        { number: 1, title: 'Bug', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-11T00:00:00Z', labels: [{ name: 'bug' }] },
        { number: 2, title: 'Feature', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-15T00:00:00Z', labels: [{ name: 'enhancement' }] },
      ]),
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity.medianTimeToCloseBugsHours).toBeCloseTo(24);
  });

  // --- costByModel derivation ---

  it('derives costByModel correctly, excluding null costs', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    mockSummary.mockReturnValue({
      ...defaultSummary(),
      byModel: [
        { model: 'gemini', count: 1, avgDuration: 60, totalCost: null, costCount: 0, successRate: 100, successCount: 1 },
        { model: 'codex', count: 1, avgDuration: 80, totalCost: 3.50, costCount: 1, successRate: 100, successCount: 1 },
      ],
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.consultation.costByModel).toEqual({ codex: 3.50 });
  });

  // --- Protocol breakdown from PR branch names (#538) ---

  it('derives protocol counts and wall clock times from PR branch names', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42', headRefName: 'builder/spir-42-feature' },
        { number: 2, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #43', headRefName: 'builder/spir-43-other' },
        { number: 3, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #80', headRefName: 'builder/air-80-small-feature' },
        { number: 4, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #100', headRefName: 'builder/bugfix-100-broken-thing' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity.projectsByProtocol.spir?.count).toBe(2);
    expect(result.activity.projectsByProtocol.spir?.avgWallClockHours).toBeCloseTo(24);
    expect(result.activity.projectsByProtocol.air?.count).toBe(1);
    expect(result.activity.projectsByProtocol.bugfix?.count).toBe(1);
  });

  it('uses "on it" comment timestamp when available', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T12:00:00Z', mergedAt: '2026-02-11T12:00:00Z', body: 'Fixes #42', headRefName: 'builder/bugfix-42-fix' },
      ]),
      closedIssues: '[]',
    }, {
      // "On it" comment posted 6 hours before PR was created
      42: '2026-02-10T06:00:00Z',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    // Wall clock should be mergedAt - onIt = 30 hours (not 24 from PR createdAt)
    expect(result.activity.projectsByProtocol.bugfix?.avgWallClockHours).toBeCloseTo(30);
  });

  it('falls back to PR createdAt when no "on it" comment found', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42', headRefName: 'builder/bugfix-42-fix' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    // No "on it" → uses PR createdAt → mergedAt = 24 hours
    expect(result.activity.projectsByProtocol.bugfix?.avgWallClockHours).toBeCloseTo(24);
  });

  it('ignores PRs with unrecognized branch names', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #10', headRefName: 'builder/bugfix-10-fix' },
        { number: 2, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #20', headRefName: 'feature/random-branch' },
        { number: 3, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #30', headRefName: 'main' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(Object.keys(result.activity.projectsByProtocol)).toEqual(['bugfix']);
    expect(result.activity.projectsByProtocol.bugfix?.count).toBe(1);
  });

  it('returns empty projectsByProtocol when no PRs have protocol branches', async () => {
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: '', headRefName: 'feature/unrelated' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity.projectsByProtocol).toEqual({});
  });

  it('returns empty projectsByProtocol when GitHub fails', async () => {
    execFileMock.mockRejectedValue(new Error('gh not found'));

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity.projectsByProtocol).toEqual({});
  });

  // --- Agent time per protocol (#541) ---

  it('includes avgAgentTimeHours from MetricsDB consultation durations', async () => {
    mockAgentTimeByProtocol.mockReturnValue([
      { protocol: 'spir', avgAgentTimeSeconds: 2700, projectCount: 5 },   // 45 min
      { protocol: 'bugfix', avgAgentTimeSeconds: 720, projectCount: 10 }, // 12 min
    ]);
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42', headRefName: 'builder/spir-42-feature' },
        { number: 2, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T12:00:00Z', body: 'Fixes #100', headRefName: 'builder/bugfix-100-fix' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity.projectsByProtocol.spir?.avgAgentTimeHours).toBeCloseTo(0.75);  // 2700/3600
    expect(result.activity.projectsByProtocol.bugfix?.avgAgentTimeHours).toBeCloseTo(0.2);  // 720/3600
  });

  it('returns null avgAgentTimeHours when no consultation data for that protocol', async () => {
    mockAgentTimeByProtocol.mockReturnValue([
      { protocol: 'spir', avgAgentTimeSeconds: 1800, projectCount: 3 },
    ]);
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42', headRefName: 'builder/spir-42-feature' },
        { number: 2, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T12:00:00Z', body: 'Fixes #100', headRefName: 'builder/bugfix-100-fix' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity.projectsByProtocol.spir?.avgAgentTimeHours).toBeCloseTo(0.5);  // 1800/3600
    expect(result.activity.projectsByProtocol.bugfix?.avgAgentTimeHours).toBeNull();
  });

  it('handles agentTimeByProtocol failure gracefully', async () => {
    mockAgentTimeByProtocol.mockImplementation(() => { throw new Error('DB locked'); });
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-11T00:00:00Z', body: 'Fixes #42', headRefName: 'builder/spir-42-feature' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    // Should still return protocol stats, just with null agent time
    expect(result.activity.projectsByProtocol.spir?.count).toBe(1);
    expect(result.activity.projectsByProtocol.spir?.avgAgentTimeHours).toBeNull();
  });

  // --- Caching ---

  it('returns cached result on second call within TTL', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });

    const result1 = await computeAnalytics('/tmp/workspace', '7');
    const result2 = await computeAnalytics('/tmp/workspace', '7');

    expect(result1).toBe(result2);
    expect(mockSummary).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when refresh=true', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });

    await computeAnalytics('/tmp/workspace', '7');
    await computeAnalytics('/tmp/workspace', '7', true);

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  it('does not share cache between different ranges', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });

    await computeAnalytics('/tmp/workspace', '7');
    await computeAnalytics('/tmp/workspace', '30');

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  // --- Workspace scoping (#545) ---

  it('passes workspace filter to MetricsDB.summary()', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });

    await computeAnalytics('/tmp/my-workspace', '7');

    expect(mockSummary).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/tmp/my-workspace' }),
    );
  });

  it('passes workspace filter for all time ranges', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });

    await computeAnalytics('/tmp/workspace-a', 'all');

    expect(mockSummary).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/tmp/workspace-a' }),
    );
  });

  it('different workspaces get different cache entries', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });

    await computeAnalytics('/tmp/workspace-a', '7');
    await computeAnalytics('/tmp/workspace-b', '7');

    expect(mockSummary).toHaveBeenCalledTimes(2);
    expect(mockSummary).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/tmp/workspace-a' }),
    );
    expect(mockSummary).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/tmp/workspace-b' }),
    );
  });

  // --- Regression: median instead of average (#548) ---

  it('uses median (not average) for time-to-merge with outliers', async () => {
    // 3 PRs: 2h, 3h, 100h — average=35h, median=3h
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T02:00:00Z', body: '', headRefName: 'main' },
        { number: 2, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T03:00:00Z', body: '', headRefName: 'main' },
        { number: 3, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-14T04:00:00Z', body: '', headRefName: 'main' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    // Median of [2, 3, 100] = 3 (middle value)
    expect(result.activity.medianTimeToMergeHours).toBeCloseTo(3);
  });

  it('uses median (not average) for bug close time with outliers', async () => {
    // 3 bugs: 1h, 2h, 200h — average=67.67h, median=2h
    mockGhOutput({
      mergedPRs: '[]',
      closedIssues: JSON.stringify([
        { number: 1, title: 'Bug 1', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-10T01:00:00Z', labels: [{ name: 'bug' }] },
        { number: 2, title: 'Bug 2', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-10T02:00:00Z', labels: [{ name: 'bug' }] },
        { number: 3, title: 'Bug 3', createdAt: '2026-02-10T00:00:00Z', closedAt: '2026-02-18T08:00:00Z', labels: [{ name: 'bug' }] },
      ]),
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    // Median of [1, 2, 200] = 2 (middle value)
    expect(result.activity.medianTimeToCloseBugsHours).toBeCloseTo(2);
  });

  it('computes median correctly for even number of items', async () => {
    // 4 PRs: 1h, 2h, 10h, 20h — median = (2+10)/2 = 6
    mockGhOutput({
      mergedPRs: JSON.stringify([
        { number: 1, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T01:00:00Z', body: '', headRefName: 'main' },
        { number: 2, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T02:00:00Z', body: '', headRefName: 'main' },
        { number: 3, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T10:00:00Z', body: '', headRefName: 'main' },
        { number: 4, title: 'PR', createdAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-10T20:00:00Z', body: '', headRefName: 'main' },
      ]),
      closedIssues: '[]',
    });

    const result = await computeAnalytics('/tmp/workspace', '7');
    // Median of [1, 2, 10, 20] = (2+10)/2 = 6
    expect(result.activity.medianTimeToMergeHours).toBeCloseTo(6);
  });

  // --- Regression: activeBuilders removed (#548) ---

  it('does not include activeBuilders in response', async () => {
    mockGhOutput({ mergedPRs: '[]', closedIssues: '[]' });
    const result = await computeAnalytics('/tmp/workspace', '7');
    expect(result.activity).not.toHaveProperty('activeBuilders');
  });

});

// ---------------------------------------------------------------------------
// protocolFromBranch (unit tests for branch → protocol mapping)
// ---------------------------------------------------------------------------

describe('protocolFromBranch', () => {
  it.each([
    ['builder/bugfix-538-analytics-fix', 'bugfix'],
    ['builder/spir-42-feature-name', 'spir'],
    ['spir/42-feature-name/phase', 'spir'],
    ['builder/aspir-73-other', 'aspir'],
    ['builder/air-80-small-feature', 'air'],
    ['builder/tick-90-amendment', 'tick'],
  ])('maps "%s" to "%s"', (branch, expected) => {
    expect(protocolFromBranch(branch)).toBe(expected);
  });

  it.each([
    'feature/random-branch',
    'main',
    'develop',
    'bugfix-without-builder-prefix',
    '',
  ])('returns null for unrecognized branch "%s"', (branch) => {
    expect(protocolFromBranch(branch)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchOnItTimestamps — regression test for #543 (GraphQL batch query)
// ---------------------------------------------------------------------------

describe('fetchOnItTimestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes through on-it-timestamps concept command', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('remote') && argsStr.includes('get-url')) {
        return Promise.resolve({ stdout: 'https://github.com/test/repo.git\n' });
      }
      return Promise.resolve({ stdout: '[]' });
    });

    executeForgeCommandMock.mockResolvedValueOnce({
      data: {
        repository: {
          issue42: { comments: { nodes: [{ body: 'On it! Working on it.', createdAt: '2026-02-10T06:00:00Z' }] } },
          issue73: { comments: { nodes: [{ body: 'Just a comment', createdAt: '2026-02-10T07:00:00Z' }] } },
        },
      },
    });

    const result = await fetchOnItTimestamps(['42', '73'], '/tmp');

    expect(result.get('42')).toBe('2026-02-10T06:00:00Z');
    expect(result.has('73')).toBe(false); // No "On it!" comment
    // Verify it used the on-it-timestamps concept
    expect(executeForgeCommandMock).toHaveBeenCalledWith(
      'on-it-timestamps',
      expect.objectContaining({
        CODEV_ISSUE_NUMBERS: '42,73',
        CODEV_GRAPHQL_QUERY: expect.any(String),
        CODEV_REPO_OWNER: 'test',
        CODEV_REPO_NAME: 'repo',
      }),
      expect.any(Object),
    );
  });

  it('returns empty map for empty input', async () => {
    const result = await fetchOnItTimestamps([]);
    expect(result.size).toBe(0);
    expect(executeForgeCommandMock).not.toHaveBeenCalled();
  });

  it('deduplicates issue numbers', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('remote') && argsStr.includes('get-url')) {
        return Promise.resolve({ stdout: 'https://github.com/test/repo.git\n' });
      }
      return Promise.resolve({ stdout: '[]' });
    });
    executeForgeCommandMock.mockResolvedValueOnce({ data: { repository: {} } });

    await fetchOnItTimestamps(['42', '42', '42'], '/tmp');

    // Verify CODEV_ISSUE_NUMBERS has only one 42
    expect(executeForgeCommandMock).toHaveBeenCalledWith(
      'on-it-timestamps',
      expect.objectContaining({ CODEV_ISSUE_NUMBERS: '42' }),
      expect.any(Object),
    );
  });

  it('returns empty map when repo lookup fails', async () => {
    execFileMock.mockRejectedValue(new Error('gh not found'));

    const result = await fetchOnItTimestamps(['42'], '/tmp');
    expect(result.size).toBe(0);
  });

  it('handles concept command failure gracefully', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('remote') && argsStr.includes('get-url')) {
        return Promise.resolve({ stdout: 'https://github.com/test/repo.git\n' });
      }
      return Promise.resolve({ stdout: '[]' });
    });
    executeForgeCommandMock.mockRejectedValueOnce(new Error('concept failed'));

    const result = await fetchOnItTimestamps(['42', '73'], '/tmp');
    expect(result.size).toBe(0);
  });

  it('supports custom forge config with simple JSON map response', async () => {
    const forgeConfig = { 'on-it-timestamps': 'custom-cmd' };
    executeForgeCommandMock.mockResolvedValueOnce({
      '42': '2026-02-10T06:00:00Z',
      '73': '2026-02-10T07:00:00Z',
    });

    const result = await fetchOnItTimestamps(['42', '73'], '/tmp', forgeConfig);

    expect(result.get('42')).toBe('2026-02-10T06:00:00Z');
    expect(result.get('73')).toBe('2026-02-10T07:00:00Z');
    // Should not call execFile for repo view (custom path)
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns empty map when custom concept is disabled (null)', async () => {
    const forgeConfig = { 'on-it-timestamps': null };

    const result = await fetchOnItTimestamps(['42'], '/tmp', forgeConfig as any);

    expect(result.size).toBe(0);
    expect(executeForgeCommandMock).not.toHaveBeenCalled();
  });
});
