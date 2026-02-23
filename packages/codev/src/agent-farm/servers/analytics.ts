/**
 * Analytics aggregation service for the dashboard Analytics tab.
 *
 * Aggregates data from two sources:
 * - Project artifacts (codev/projects/<name>/status.yaml) for activity metrics
 * - Consultation metrics DB (~/.codev/metrics.db)
 *
 * Each data source fails independently — partial results are returned
 * with error messages in the `errors` field.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { MetricsDB } from '../../commands/consult/metrics.js';

// =============================================================================
// Types
// =============================================================================

export interface AnalyticsResponse {
  timeRange: '24h' | '7d' | '30d' | 'all';
  activity: {
    projectsCompleted: number;
    projectsByProtocol: Record<string, number>;
    bugsFixed: number;
    avgTimeToMergeHours: number | null;
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
  };
  errors?: {
    activity?: string;
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

function rangeToWeeks(range: RangeParam): number {
  if (range === '1') return 1 / 7;
  if (range === '7') return 1;
  if (range === '30') return 30 / 7;
  // For "all", we can't know the true range without data, so return 1
  return 1;
}

// =============================================================================
// Project artifact scanning
// =============================================================================

interface ProjectStatus {
  protocol: string;
  phase: string;
  startedAt: string | null;
  updatedAt: string | null;
}

/**
 * Scan codev/projects/<name>/status.yaml for project statuses.
 * Exported for testing.
 */
export function scanProjectStatuses(workspaceRoot: string): ProjectStatus[] {
  const projectsDir = path.join(workspaceRoot, 'codev', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const statuses: ProjectStatus[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusFile = path.join(projectsDir, entry.name, 'status.yaml');
    if (!fs.existsSync(statusFile)) continue;
    try {
      const content = fs.readFileSync(statusFile, 'utf-8');
      const parsed = yaml.load(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') continue;
      statuses.push({
        protocol: String(parsed.protocol ?? ''),
        phase: String(parsed.phase ?? ''),
        startedAt: parsed.started_at ? String(parsed.started_at) : null,
        updatedAt: parsed.updated_at ? String(parsed.updated_at) : null,
      });
    } catch {
      // Skip unparseable files
    }
  }

  return statuses;
}

// Normalize protocol names (spider → spir)
function normalizeProtocol(protocol: string): string {
  if (protocol === 'spider') return 'spir';
  return protocol;
}

interface ActivityMetrics {
  projectsCompleted: number;
  projectsByProtocol: Record<string, number>;
  bugsFixed: number;
  avgTimeToMergeHours: number | null;
}

function computeActivityMetrics(
  workspaceRoot: string,
  range: RangeParam,
): ActivityMetrics {
  const allStatuses = scanProjectStatuses(workspaceRoot);
  const days = rangeToDays(range);
  const sinceMs = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  // Filter to complete projects, optionally within time range
  const completeProjects = allStatuses.filter(p => {
    if (p.phase !== 'complete') return false;
    if (sinceMs && p.updatedAt) {
      return new Date(p.updatedAt).getTime() >= sinceMs;
    }
    // If no time filter or no updatedAt, include for 'all' range only
    return !sinceMs;
  });

  // Split bugs vs non-bug projects
  const bugProjects = completeProjects.filter(p => normalizeProtocol(p.protocol) === 'bugfix');
  const nonBugProjects = completeProjects.filter(p => normalizeProtocol(p.protocol) !== 'bugfix');

  // Group non-bug projects by protocol
  const projectsByProtocol: Record<string, number> = {};
  for (const p of nonBugProjects) {
    const proto = normalizeProtocol(p.protocol);
    projectsByProtocol[proto] = (projectsByProtocol[proto] ?? 0) + 1;
  }

  // Avg time to complete (started_at → updated_at) for all complete projects
  const durations: number[] = [];
  for (const p of completeProjects) {
    if (p.startedAt && p.updatedAt) {
      const ms = new Date(p.updatedAt).getTime() - new Date(p.startedAt).getTime();
      if (ms > 0) durations.push(ms);
    }
  }
  const avgTimeToMergeHours = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length / (1000 * 60 * 60)
    : null;

  return {
    projectsCompleted: nonBugProjects.length,
    projectsByProtocol,
    bugsFixed: bugProjects.length,
    avgTimeToMergeHours,
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
// Main computation
// =============================================================================

/**
 * Compute analytics for the dashboard Analytics tab.
 *
 * @param workspaceRoot - Path to the workspace root (used for project scanning and as cwd for gh CLI)
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

  const days = rangeToDays(range);
  const weeks = rangeToWeeks(range);
  const errors: { activity?: string; consultation?: string } = {};

  // Activity metrics (from project artifacts)
  let activityMetrics: ActivityMetrics;
  try {
    activityMetrics = computeActivityMetrics(workspaceRoot, range);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.activity = msg;
    activityMetrics = {
      projectsCompleted: 0,
      projectsByProtocol: {},
      bugsFixed: 0,
      avgTimeToMergeHours: null,
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

  const totalCompleted = activityMetrics.projectsCompleted + activityMetrics.bugsFixed;

  const result: AnalyticsResponse = {
    timeRange: rangeToLabel(range),
    activity: {
      projectsCompleted: activityMetrics.projectsCompleted,
      projectsByProtocol: activityMetrics.projectsByProtocol,
      bugsFixed: activityMetrics.bugsFixed,
      avgTimeToMergeHours: activityMetrics.avgTimeToMergeHours,
      throughputPerWeek: weeks > 0
        ? Math.round((totalCompleted / weeks) * 10) / 10
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
