/**
 * Statistics aggregation service for the dashboard Statistics tab.
 *
 * Aggregates data from three sources:
 * - GitHub CLI (merged PRs, closed issues, open issue backlogs)
 * - Consultation metrics DB (~/.codev/metrics.db)
 * - Active builder count (passed in from tower context)
 *
 * Each data source fails independently — partial results are returned
 * with error messages in the `errors` field.
 */

import {
  fetchMergedPRs,
  fetchClosedIssues,
  fetchIssueList,
  parseAllLinkedIssues,
  type MergedPR,
  type ClosedIssue,
} from '../../lib/github.js';
import { MetricsDB } from '../../commands/consult/metrics.js';

// =============================================================================
// Types
// =============================================================================

export interface StatisticsResponse {
  timeRange: '7d' | '30d' | 'all';
  github: {
    prsMerged: number;
    avgTimeToMergeHours: number | null;
    bugBacklog: number;
    nonBugBacklog: number;
    issuesClosed: number;
    avgTimeToCloseBugsHours: number | null;
  };
  builders: {
    projectsCompleted: number;
    throughputPerWeek: number;
    activeBuilders: number;
  };
  consultation: {
    totalCount: number;
    totalCostUsd: number | null;
    costByModel: Record<string, number>;
    avgLatencySeconds: number | null;
    successRate: number | null;
    byModel: Array<{
      model: string;
      count: number;
      avgLatency: number;
      totalCost: number | null;
      successRate: number;
    }>;
    byReviewType: Record<string, number>;
    byProtocol: Record<string, number>;
    costByProject: Array<{
      projectId: string;
      totalCost: number;
    }>;
  };
  errors?: {
    github?: string;
    consultation?: string;
  };
}

// =============================================================================
// Cache
// =============================================================================

interface CacheEntry {
  data: StatisticsResponse;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const cache = new Map<string, CacheEntry>();

export function clearStatisticsCache(): void {
  cache.clear();
}

// =============================================================================
// Range helpers
// =============================================================================

type RangeParam = '7' | '30' | 'all';
type TimeRangeLabel = '7d' | '30d' | 'all';

function rangeToLabel(range: RangeParam): TimeRangeLabel {
  if (range === '7') return '7d';
  if (range === '30') return '30d';
  return 'all';
}

function rangeToDays(range: RangeParam): number | undefined {
  if (range === '7') return 7;
  if (range === '30') return 30;
  return undefined;
}

function rangeToSinceDate(range: RangeParam): string | null {
  const days = rangeToDays(range);
  if (!days) return null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return since.toISOString().split('T')[0]; // YYYY-MM-DD
}

function rangeToWeeks(range: RangeParam): number {
  if (range === '7') return 1;
  if (range === '30') return 30 / 7;
  // For "all", we can't know the true range without data, so return 1
  // (throughput = projectsCompleted / 1 = total projects)
  return 1;
}

// =============================================================================
// GitHub metrics computation
// =============================================================================

function computeAvgHours(items: Array<{ start: string; end: string }>): number | null {
  if (items.length === 0) return null;
  const totalMs = items.reduce((sum, item) => {
    return sum + (new Date(item.end).getTime() - new Date(item.start).getTime());
  }, 0);
  return totalMs / items.length / (1000 * 60 * 60);
}

interface GitHubMetrics {
  prsMerged: number;
  avgTimeToMergeHours: number | null;
  bugBacklog: number;
  nonBugBacklog: number;
  issuesClosed: number;
  avgTimeToCloseBugsHours: number | null;
  projectsCompleted: number;
}

async function computeGitHubMetrics(
  since: string | null,
  cwd: string,
): Promise<GitHubMetrics> {
  // Fetch merged PRs and closed issues in parallel
  const [mergedPRs, closedIssues, openIssues] = await Promise.all([
    fetchMergedPRs(since, cwd),
    fetchClosedIssues(since, cwd),
    fetchIssueList(cwd),
  ]);

  if (mergedPRs === null && closedIssues === null && openIssues === null) {
    throw new Error('GitHub CLI unavailable');
  }

  // PRs merged
  const prs = mergedPRs ?? [];
  const prsMerged = prs.length;

  // Average time to merge
  const avgTimeToMergeHours = computeAvgHours(
    prs.filter(pr => pr.mergedAt).map(pr => ({ start: pr.createdAt, end: pr.mergedAt })),
  );

  // Backlogs (from open issues)
  const issues = openIssues ?? [];
  const bugBacklog = issues.filter(i =>
    i.labels.some(l => l.name === 'bug'),
  ).length;
  const nonBugBacklog = issues.length - bugBacklog;

  // Closed issues
  const closed = closedIssues ?? [];
  const issuesClosed = closed.length;

  // Average time to close bugs
  const closedBugs = closed.filter(i =>
    i.labels.some(l => l.name === 'bug') && i.closedAt,
  );
  const avgTimeToCloseBugsHours = computeAvgHours(
    closedBugs.map(i => ({ start: i.createdAt, end: i.closedAt })),
  );

  // Projects completed (distinct issue numbers from merged PRs via parseAllLinkedIssues)
  const linkedIssues = new Set<number>();
  for (const pr of prs) {
    for (const issueNum of parseAllLinkedIssues(pr.body ?? '', pr.title)) {
      linkedIssues.add(issueNum);
    }
  }
  const projectsCompleted = linkedIssues.size;

  return {
    prsMerged,
    avgTimeToMergeHours,
    bugBacklog,
    nonBugBacklog,
    issuesClosed,
    avgTimeToCloseBugsHours,
    projectsCompleted,
  };
}

// =============================================================================
// Consultation metrics computation
// =============================================================================

interface ConsultationMetrics {
  totalCount: number;
  totalCostUsd: number | null;
  costByModel: Record<string, number>;
  avgLatencySeconds: number | null;
  successRate: number | null;
  byModel: Array<{
    model: string;
    count: number;
    avgLatency: number;
    totalCost: number | null;
    successRate: number;
  }>;
  byReviewType: Record<string, number>;
  byProtocol: Record<string, number>;
  costByProject: Array<{
    projectId: string;
    totalCost: number;
  }>;
}

function computeConsultationMetrics(days: number | undefined): ConsultationMetrics {
  const db = new MetricsDB();
  try {
    const filters = days ? { days } : {};
    const summary = db.summary(filters);
    const projectCosts = db.costByProject(filters);

    // Derive costByModel from summary.byModel
    const costByModel: Record<string, number> = {};
    for (const m of summary.byModel) {
      if (m.totalCost !== null) {
        costByModel[m.model] = m.totalCost;
      }
    }

    // Derive byReviewType from summary.byType
    const byReviewType: Record<string, number> = {};
    for (const t of summary.byType) {
      byReviewType[t.reviewType] = t.count;
    }

    // Derive byProtocol from summary.byProtocol
    const byProtocol: Record<string, number> = {};
    for (const p of summary.byProtocol) {
      byProtocol[p.protocol] = p.count;
    }

    return {
      totalCount: summary.totalCount,
      totalCostUsd: summary.totalCost,
      costByModel,
      avgLatencySeconds: summary.totalCount > 0
        ? summary.totalDuration / summary.totalCount
        : null,
      successRate: summary.totalCount > 0
        ? (summary.successCount / summary.totalCount) * 100
        : null,
      byModel: summary.byModel.map(m => ({
        model: m.model,
        count: m.count,
        avgLatency: m.avgDuration,
        totalCost: m.totalCost,
        successRate: m.successRate,
      })),
      byReviewType,
      byProtocol,
      costByProject: projectCosts,
    };
  } finally {
    db.close();
  }
}

// =============================================================================
// Main computation
// =============================================================================

/**
 * Compute statistics for the dashboard Statistics tab.
 *
 * @param workspaceRoot - Path to the workspace root (used as cwd for gh CLI)
 * @param range - Time range: '7', '30', or 'all'
 * @param activeBuilders - Current active builder count (from tower context)
 * @param refresh - If true, bypass the cache
 */
export async function computeStatistics(
  workspaceRoot: string,
  range: RangeParam,
  activeBuilders: number,
  refresh = false,
): Promise<StatisticsResponse> {
  const cacheKey = `${workspaceRoot}:${range}`;

  // Check cache
  if (!refresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const since = rangeToSinceDate(range);
  const days = rangeToDays(range);
  const weeks = rangeToWeeks(range);
  const errors: { github?: string; consultation?: string } = {};

  // GitHub metrics
  let githubMetrics: GitHubMetrics;
  try {
    githubMetrics = await computeGitHubMetrics(since, workspaceRoot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.github = msg;
    githubMetrics = {
      prsMerged: 0,
      avgTimeToMergeHours: null,
      bugBacklog: 0,
      nonBugBacklog: 0,
      issuesClosed: 0,
      avgTimeToCloseBugsHours: null,
      projectsCompleted: 0,
    };
  }

  // Consultation metrics
  let consultMetrics: ConsultationMetrics;
  try {
    consultMetrics = computeConsultationMetrics(days);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.consultation = msg;
    consultMetrics = {
      totalCount: 0,
      totalCostUsd: null,
      costByModel: {},
      avgLatencySeconds: null,
      successRate: null,
      byModel: [],
      byReviewType: {},
      byProtocol: {},
      costByProject: [],
    };
  }

  const result: StatisticsResponse = {
    timeRange: rangeToLabel(range),
    github: {
      prsMerged: githubMetrics.prsMerged,
      avgTimeToMergeHours: githubMetrics.avgTimeToMergeHours,
      bugBacklog: githubMetrics.bugBacklog,
      nonBugBacklog: githubMetrics.nonBugBacklog,
      issuesClosed: githubMetrics.issuesClosed,
      avgTimeToCloseBugsHours: githubMetrics.avgTimeToCloseBugsHours,
    },
    builders: {
      projectsCompleted: githubMetrics.projectsCompleted,
      throughputPerWeek: weeks > 0
        ? Math.round((githubMetrics.projectsCompleted / weeks) * 10) / 10
        : 0,
      activeBuilders,
    },
    consultation: consultMetrics,
  };

  if (Object.keys(errors).length > 0) {
    result.errors = errors;
  }

  // Store in cache
  cache.set(cacheKey, { data: result, timestamp: Date.now() });

  return result;
}
