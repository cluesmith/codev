/**
 * Analytics aggregation service for the dashboard Analytics tab.
 *
 * Aggregates data from two sources:
 * - GitHub CLI (merged PRs, closed issues, protocol breakdown from branch names)
 * - Consultation metrics DB (~/.codev/metrics.db)
 *
 * Each data source fails independently — partial results are returned
 * with error messages in the `errors` field.
 */

import {
  fetchMergedPRs,
  fetchClosedIssues,
  parseAllLinkedIssues,
  fetchOnItTimestamps,
} from '../../lib/github.js';
import type { MergedPR } from '../../lib/github.js';
import { MetricsDB } from '../../commands/consult/metrics.js';

// =============================================================================
// Types
// =============================================================================

export interface ProtocolStats {
  count: number;
  avgWallClockHours: number | null;
}

export interface AnalyticsResponse {
  timeRange: '24h' | '7d' | '30d' | 'all';
  activity: {
    prsMerged: number;
    medianTimeToMergeHours: number | null;
    issuesClosed: number;
    medianTimeToCloseBugsHours: number | null;
    projectsByProtocol: Record<string, ProtocolStats>;
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

// =============================================================================
// GitHub metrics computation
// =============================================================================

function computeMedianHours(items: Array<{ start: string; end: string }>): number | null {
  if (items.length === 0) return null;
  const hours = items
    .map(item => (new Date(item.end).getTime() - new Date(item.start).getTime()) / (1000 * 60 * 60))
    .sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  return hours.length % 2 === 0
    ? (hours[mid - 1] + hours[mid]) / 2
    : hours[mid];
}

interface GitHubMetrics {
  prsMerged: number;
  medianTimeToMergeHours: number | null;
  issuesClosed: number;
  medianTimeToCloseBugsHours: number | null;
  mergedPRList: MergedPR[];
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

  // Median time to merge
  const medianTimeToMergeHours = computeMedianHours(
    prs.filter(pr => pr.mergedAt).map(pr => ({ start: pr.createdAt, end: pr.mergedAt })),
  );

  // Closed issues
  const closed = closedIssues ?? [];
  const issuesClosed = closed.length;

  // Median time to close bugs
  const closedBugs = closed.filter(i =>
    i.labels.some(l => l.name === 'bug') && i.closedAt,
  );
  const medianTimeToCloseBugsHours = computeMedianHours(
    closedBugs.map(i => ({ start: i.createdAt, end: i.closedAt })),
  );

  return {
    prsMerged,
    medianTimeToMergeHours,
    issuesClosed,
    medianTimeToCloseBugsHours,
    mergedPRList: prs,
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

function computeConsultationMetrics(days: number | undefined, workspacePath: string): ConsultationMetrics {
  const db = new MetricsDB();
  try {
    const filters: { days?: number; workspace: string } = { workspace: workspacePath };
    if (days) filters.days = days;
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
// Project protocol breakdown (from PR branch names)
// =============================================================================

/**
 * Known branch-name prefixes that map to protocols.
 * Checked in order; first match wins.
 */
const BRANCH_PROTOCOL_PATTERNS: Array<{ pattern: RegExp; protocol: string }> = [
  { pattern: /^builder\/bugfix-/,  protocol: 'bugfix' },
  { pattern: /^builder\/spir-/,    protocol: 'spir' },
  { pattern: /^spir\//,            protocol: 'spir' },
  { pattern: /^builder\/aspir-/,   protocol: 'aspir' },
  { pattern: /^builder\/air-/,     protocol: 'air' },
  { pattern: /^builder\/tick-/,    protocol: 'tick' },
];

export function protocolFromBranch(branch: string): string | null {
  for (const { pattern, protocol } of BRANCH_PROTOCOL_PATTERNS) {
    if (pattern.test(branch)) return protocol;
  }
  return null;
}

async function computeProjectsByProtocol(
  mergedPRs: MergedPR[],
  cwd: string,
): Promise<Record<string, ProtocolStats>> {
  // Group PRs by protocol and collect linked issue numbers
  const byProtocol = new Map<string, MergedPR[]>();
  const issueToProtocolPRs = new Map<number, MergedPR[]>();

  for (const pr of mergedPRs) {
    const protocol = protocolFromBranch(pr.headRefName ?? '');
    if (!protocol) continue;

    if (!byProtocol.has(protocol)) byProtocol.set(protocol, []);
    byProtocol.get(protocol)!.push(pr);

    // Track linked issues for "on it" timestamp lookup
    for (const issueNum of parseAllLinkedIssues(pr.body ?? '', pr.title)) {
      if (!issueToProtocolPRs.has(issueNum)) issueToProtocolPRs.set(issueNum, []);
      issueToProtocolPRs.get(issueNum)!.push(pr);
    }
  }

  // Fetch "on it" timestamps for all linked issues
  const onItTimestamps = await fetchOnItTimestamps(
    [...issueToProtocolPRs.keys()],
    cwd,
  );

  // Build a map from PR number → start time (on-it or fallback to PR createdAt)
  const prStartTime = new Map<number, string>();
  for (const [issueNum, prs] of issueToProtocolPRs) {
    const onIt = onItTimestamps.get(issueNum);
    if (onIt) {
      for (const pr of prs) {
        // Only set if not already set (first linked issue wins)
        if (!prStartTime.has(pr.number)) {
          prStartTime.set(pr.number, onIt);
        }
      }
    }
  }

  // Compute per-protocol stats
  const result: Record<string, ProtocolStats> = {};
  for (const [protocol, prs] of byProtocol) {
    const wallClockHours: number[] = [];
    for (const pr of prs) {
      if (!pr.mergedAt) continue;
      const start = prStartTime.get(pr.number) ?? pr.createdAt;
      const ms = new Date(pr.mergedAt).getTime() - new Date(start).getTime();
      wallClockHours.push(ms / (1000 * 60 * 60));
    }

    result[protocol] = {
      count: prs.length,
      avgWallClockHours: wallClockHours.length > 0
        ? wallClockHours.reduce((a, b) => a + b, 0) / wallClockHours.length
        : null,
    };
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
 * @param refresh - If true, bypass the cache
 */
export async function computeAnalytics(
  workspaceRoot: string,
  range: RangeParam,
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
      medianTimeToMergeHours: null,
      issuesClosed: 0,
      medianTimeToCloseBugsHours: null,
      mergedPRList: [],
    };
  }

  // Consultation metrics
  let consultMetrics: ConsultationMetrics;
  try {
    consultMetrics = computeConsultationMetrics(days, workspaceRoot);
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

  // Protocol breakdown with avg wall clock times (from PR branch names + "on it" timestamps)
  const projectsByProtocol = await computeProjectsByProtocol(
    githubMetrics.mergedPRList,
    workspaceRoot,
  );

  const result: AnalyticsResponse = {
    timeRange: rangeToLabel(range),
    activity: {
      prsMerged: githubMetrics.prsMerged,
      medianTimeToMergeHours: githubMetrics.medianTimeToMergeHours,
      issuesClosed: githubMetrics.issuesClosed,
      medianTimeToCloseBugsHours: githubMetrics.medianTimeToCloseBugsHours,
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
