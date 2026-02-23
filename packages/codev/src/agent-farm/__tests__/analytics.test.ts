/**
 * Unit tests for the analytics service (Spec 456, Bugfix #529).
 *
 * Tests computeAnalytics() with mocked project artifacts and MetricsDB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockSummary = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

// Mock MetricsDB
vi.mock('../../commands/consult/metrics.js', () => ({
  MetricsDB: class MockMetricsDB {
    summary = mockSummary;
    close = mockClose;
  },
}));

// Mock node:fs for project scanning
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
      readdirSync: mockReaddirSync,
      readFileSync: mockReadFileSync,
    },
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
  };
});

// ---------------------------------------------------------------------------
// Static imports
// ---------------------------------------------------------------------------

import { computeAnalytics, clearAnalyticsCache } from '../servers/analytics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeDirent(name: string) {
  return { name, isDirectory: () => true, isFile: () => false };
}

function setupProjectMocks(projects: Array<{ dirName: string; yaml: string }>) {
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue(projects.map(p => makeDirent(p.dirName)));
  mockReadFileSync.mockImplementation((filePath: unknown) => {
    const p = String(filePath);
    for (const proj of projects) {
      if (p.includes(proj.dirName)) return proj.yaml;
    }
    return '';
  });
}

// ---------------------------------------------------------------------------
// computeAnalytics
// ---------------------------------------------------------------------------

describe('computeAnalytics', () => {
  beforeEach(() => {
    clearAnalyticsCache();
    vi.clearAllMocks();
    mockSummary.mockReturnValue(defaultSummary());

    setupProjectMocks([
      {
        dirName: '0087-feature-a',
        yaml: `protocol: spir\nphase: complete\nstarted_at: '2026-02-10T00:00:00Z'\nupdated_at: '2026-02-11T12:00:00Z'\n`,
      },
      {
        dirName: '0088-feature-b',
        yaml: `protocol: aspir\nphase: complete\nstarted_at: '2026-02-12T00:00:00Z'\nupdated_at: '2026-02-13T00:00:00Z'\n`,
      },
      {
        dirName: 'bugfix-327-fix-thing',
        yaml: `protocol: bugfix\nphase: complete\nstarted_at: '2026-02-14T00:00:00Z'\nupdated_at: '2026-02-14T02:00:00Z'\n`,
      },
    ]);
  });

  it('assembles full statistics from all data sources', async () => {
    const result = await computeAnalytics('/tmp/workspace', 'all', 3);

    expect(result.timeRange).toBe('all');

    // Activity metrics from project artifacts
    expect(result.activity.projectsCompleted).toBe(2); // spir + aspir (not bugfix)
    expect(result.activity.bugsFixed).toBe(1); // bugfix-327
    expect(result.activity.projectsByProtocol).toEqual({ spir: 1, aspir: 1 });
    expect(result.activity.activeBuilders).toBe(3);
    expect(result.activity.avgTimeToMergeHours).toBeCloseTo(
      (36 + 24 + 2) / 3, // avg of 36h, 24h, 2h
    );

    // Consultation metrics unchanged
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

  it('returns correct time range labels', async () => {
    const result1 = await computeAnalytics('/tmp/workspace', '1', 0);
    expect(result1.timeRange).toBe('24h');

    clearAnalyticsCache();
    const result7 = await computeAnalytics('/tmp/workspace', '7', 0);
    expect(result7.timeRange).toBe('7d');

    clearAnalyticsCache();
    const result30 = await computeAnalytics('/tmp/workspace', '30', 0);
    expect(result30.timeRange).toBe('30d');

    clearAnalyticsCache();
    const resultAll = await computeAnalytics('/tmp/workspace', 'all', 0);
    expect(resultAll.timeRange).toBe('all');
  });

  it('returns consultation defaults and error when MetricsDB fails', async () => {
    mockSummary.mockImplementation(() => { throw new Error('DB file not found'); });

    const result = await computeAnalytics('/tmp/workspace', 'all', 0);

    expect(result.errors?.consultation).toBe('DB file not found');
    expect(result.consultation.totalCount).toBe(0);
    expect(result.consultation.totalCostUsd).toBeNull();
    expect(result.consultation.costByModel).toEqual({});
    expect(result.consultation.avgLatencySeconds).toBeNull();
    expect(result.consultation.successRate).toBeNull();
    expect(result.consultation.byModel).toEqual([]);
    expect(result.consultation.byReviewType).toEqual({});
    expect(result.consultation.byProtocol).toEqual({});
    expect(result.errors?.activity).toBeUndefined();
  });

  it('returns null averages when no complete projects exist', async () => {
    setupProjectMocks([]);
    mockSummary.mockReturnValue({
      totalCount: 0, totalDuration: 0, totalCost: null, costCount: 0,
      successCount: 0, byModel: [], byType: [], byProtocol: [],
    });

    const result = await computeAnalytics('/tmp/workspace', 'all', 0);

    expect(result.activity.avgTimeToMergeHours).toBeNull();
    expect(result.activity.projectsCompleted).toBe(0);
    expect(result.activity.bugsFixed).toBe(0);
    expect(result.consultation.avgLatencySeconds).toBeNull();
    expect(result.consultation.successRate).toBeNull();
  });

  it('only counts complete projects (not in-progress)', async () => {
    setupProjectMocks([
      {
        dirName: '0087-feature-a',
        yaml: `protocol: spir\nphase: complete\nstarted_at: '2026-02-10T00:00:00Z'\nupdated_at: '2026-02-11T00:00:00Z'\n`,
      },
      {
        dirName: '0088-feature-b',
        yaml: `protocol: spir\nphase: implement\nstarted_at: '2026-02-12T00:00:00Z'\nupdated_at: '2026-02-13T00:00:00Z'\n`,
      },
    ]);

    const result = await computeAnalytics('/tmp/workspace', 'all', 0);
    expect(result.activity.projectsCompleted).toBe(1);
  });

  it('normalizes spider protocol to spir', async () => {
    setupProjectMocks([
      {
        dirName: '0087-old-project',
        yaml: `protocol: spider\nphase: complete\nstarted_at: '2026-02-10T00:00:00Z'\nupdated_at: '2026-02-11T00:00:00Z'\n`,
      },
    ]);

    const result = await computeAnalytics('/tmp/workspace', 'all', 0);
    expect(result.activity.projectsByProtocol).toEqual({ spir: 1 });
  });

  it('does not include costByProject in consultation', async () => {
    const result = await computeAnalytics('/tmp/workspace', 'all', 0);
    expect((result.consultation as Record<string, unknown>).costByProject).toBeUndefined();
  });

  it('does not include github or builders top-level keys', async () => {
    const result = await computeAnalytics('/tmp/workspace', 'all', 0);
    expect((result as Record<string, unknown>).github).toBeUndefined();
    expect((result as Record<string, unknown>).builders).toBeUndefined();
  });

  // --- Caching ---

  it('returns cached result on second call within TTL', async () => {
    const result1 = await computeAnalytics('/tmp/workspace', '7', 3);
    const result2 = await computeAnalytics('/tmp/workspace', '7', 3);

    expect(result1).toBe(result2);
    expect(mockSummary).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when refresh=true', async () => {
    await computeAnalytics('/tmp/workspace', '7', 3);
    await computeAnalytics('/tmp/workspace', '7', 3, true);

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  it('does not share cache between different ranges', async () => {
    await computeAnalytics('/tmp/workspace', '7', 3);
    await computeAnalytics('/tmp/workspace', '30', 3);

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  // --- Throughput ---

  it('computes throughput including both projects and bugs', async () => {
    // 3 total complete projects (2 non-bug + 1 bug), over 30/7 weeks
    const result = await computeAnalytics('/tmp/workspace', '30', 0);
    const expected = Math.round((3 / (30 / 7)) * 10) / 10;
    expect(result.activity.throughputPerWeek).toBeCloseTo(expected, 1);
  });

  it('computes throughput for 7d range', async () => {
    // Use recent dates so they fall within 7-day window
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    setupProjectMocks([
      { dirName: 'a', yaml: `protocol: spir\nphase: complete\nstarted_at: '${twoDaysAgo}'\nupdated_at: '${oneDayAgo}'\n` },
      { dirName: 'b', yaml: `protocol: bugfix\nphase: complete\nstarted_at: '${twoDaysAgo}'\nupdated_at: '${oneDayAgo}'\n` },
    ]);

    const result = await computeAnalytics('/tmp/workspace', '7', 0);
    // 2 total complete projects / 1 week = 2
    expect(result.activity.throughputPerWeek).toBe(2);
  });

  // --- costByModel derivation ---

  it('derives costByModel correctly, excluding null costs', async () => {
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

  // --- Activity error handling ---

  it('returns activity defaults and error when project scan fails', async () => {
    mockExistsSync.mockImplementation(() => { throw new Error('Permission denied'); });

    const result = await computeAnalytics('/tmp/workspace', 'all', 2);

    expect(result.errors?.activity).toBe('Permission denied');
    expect(result.activity.projectsCompleted).toBe(0);
    expect(result.activity.bugsFixed).toBe(0);
    expect(result.activity.avgTimeToMergeHours).toBeNull();
    expect(result.activity.projectsByProtocol).toEqual({});
    expect(result.activity.activeBuilders).toBe(2);
    // Consultation still works
    expect(result.consultation.totalCount).toBe(5);
    expect(result.errors?.consultation).toBeUndefined();
  });
});
