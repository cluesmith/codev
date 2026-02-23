/**
 * Analytics aggregation service for the dashboard Analytics tab.
 *
 * Aggregates data from three sources:
 * - GitHub CLI (merged PRs, closed issues)
 * - Consultation metrics DB (~/.codev/metrics.db)
 * - Local project artifacts (codev/projects/ status.yaml for protocol breakdown)
 * - Active builder count (passed in from tower context)
 *
 * Each data source fails independently — partial results are returned
 * with error messages in the `errors` field.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  fetchMergedPRs,
  fetchClosedIssues,
  parseAllLinkedIssues,
} from '../../lib/github.js';
import { MetricsDB } from '../../commands/consult/metrics.js';

// =============================================================================
// Types
// =============================================================================

export interface AnalyticsResponse {
  timeRange: '24h' | '7d' | '30d' | 'all';
  activity: {
    prsMerged: number;
    avgTimeToMergeHours: number | null;
    issuesClosed: number;
    avgTimeToCloseBugsHours: number | null;
    projectsCompleted: number;
    bugsFixed: number;
    throughputPerWeek: number;
    activeBuilders: number;
    projectsByProtocol: Record<string, number>;
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
  data: AnalyticsResponse;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const cache = new Map<string, CacheEntry>();

export function clearAnalyticsCache(): void {
  cache.clear();
}

// =============================================================================
// Range helpers
// =============================================================================

type RangeParam = '1' | '7' | '30' | 'all';
type TimeRangeLabel = '24h' | '7d' | '30d' | 'all';

function rangeToLabel(range: RangeParam): TimeRangeLabel {
  if (range === '1') return '24h';
  if (range === '7') return '7d';
  if (range === '30') return '30d';
  return 'all';
}

function rangeToDays(range: RangeParam): number | undefined {
  if (range === '1') return 1;
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
  if (range === '1') return 1 / 7;
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
  issuesClosed: number;
  avgTimeToCloseBugsHours: number | null;
  projectsCompleted: number;
  bugsFixed: number;
}

async function computeGitHubMetrics(
  since: string | null,
  cwd: string,
): Promise<GitHubMetrics> {
  // Fetch merged PRs and closed issues in parallel
  const [mergedPRs, closedIssues] = await Promise.all([
    fetchMergedPRs(since, cwd),
    fetchClosedIssues(since, cwd),
  ]);

  if (mergedPRs === null && closedIssues === null) {
    throw new Error('GitHub CLI unavailable');
  }

  // PRs merged
  const prs = mergedPRs ?? [];
  const prsMerged = prs.length;

  // Average time to merge
  const avgTimeToMergeHours = computeAvgHours(
    prs.filter(pr => pr.mergedAt).map(pr => ({ start: pr.createdAt, end: pr.mergedAt })),
  );

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

  // Bugs fixed (closed issues with bug label)
  const bugsFixed = closedBugs.length;

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
    issuesClosed,
    avgTimeToCloseBugsHours,
    projectsCompleted,
    bugsFixed,
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
}

function computeConsultationMetrics(days: number | undefined): ConsultationMetrics {
  const db = new MetricsDB();
  try {
    const filters = days ? { days } : {};
    const summary = db.summary(filters);

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
    };
  } finally {
    db.close();
  }
}

// =============================================================================
// Project protocol breakdown (from status.yaml)
// =============================================================================

function normalizeProtocol(protocol: string): string {
  // Legacy "spider" → "spir"
  if (protocol === 'spider') return 'spir';
  return protocol;
}

function computeProjectsByProtocol(workspaceRoot: string): Record<string, number> {
  const projectsDir = path.join(workspaceRoot, 'codev', 'projects');
  const result: Record<string, number> = {};

  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return result; // No projects directory — return empty
  }

  for (const entry of entries) {
    const statusPath = path.join(projectsDir, entry, 'status.yaml');
    try {
      const content = fs.readFileSync(statusPath, 'utf-8');
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      if (parsed && typeof parsed.protocol === 'string') {
        const proto = normalizeProtocol(parsed.protocol);
        result[proto] = (result[proto] ?? 0) + 1;
      }
    } catch {
      // Skip unreadable entries
    }
  }

  return result;
}

// =============================================================================
// Main computation
// =============================================================================

/**
 * Compute analytics for the dashboard Analytics tab.
 *
 * @param workspaceRoot - Path to the workspace root (used as cwd for gh CLI)
 * @param range - Time range: '1', '7', '30', or 'all'
 * @param activeBuilders - Current active builder count (from tower context)
 * @param refresh - If true, bypass the cache
 */
export async function computeAnalytics(
  workspaceRoot: string,
  range: RangeParam,
  activeBuilders: number,
  refresh = false,
): Promise<AnalyticsResponse> {
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
      issuesClosed: 0,
      avgTimeToCloseBugsHours: null,
      projectsCompleted: 0,
      bugsFixed: 0,
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
    };
  }

  // Protocol breakdown from local status.yaml files (supplementary source)
  const projectsByProtocol = computeProjectsByProtocol(workspaceRoot);

  const result: AnalyticsResponse = {
    timeRange: rangeToLabel(range),
    activity: {
      prsMerged: githubMetrics.prsMerged,
      avgTimeToMergeHours: githubMetrics.avgTimeToMergeHours,
      issuesClosed: githubMetrics.issuesClosed,
      avgTimeToCloseBugsHours: githubMetrics.avgTimeToCloseBugsHours,
      projectsCompleted: githubMetrics.projectsCompleted,
      bugsFixed: githubMetrics.bugsFixed,
      throughputPerWeek: weeks > 0
        ? Math.round((githubMetrics.projectsCompleted / weeks) * 10) / 10
        : 0,
      activeBuilders,
      projectsByProtocol,
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
