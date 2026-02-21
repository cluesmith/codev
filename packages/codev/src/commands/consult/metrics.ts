/**
 * Consultation metrics database
 *
 * Stores per-invocation metrics (duration, tokens, cost) in a global
 * SQLite database at ~/.codev/metrics.db. Uses WAL mode and busy_timeout
 * for safe concurrent writes from 3-way parallel consultations.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CODEV_DIR = join(homedir(), '.codev');
const DB_PATH = join(CODEV_DIR, 'metrics.db');

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS consultation_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  model TEXT NOT NULL,
  review_type TEXT,
  subcommand TEXT NOT NULL,
  protocol TEXT,
  project_id TEXT,
  duration_seconds REAL NOT NULL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  exit_code INTEGER NOT NULL,
  workspace_path TEXT NOT NULL,
  error_message TEXT
)`;

const INSERT_ROW = `
INSERT INTO consultation_metrics (
  timestamp, model, review_type, subcommand, protocol, project_id,
  duration_seconds, input_tokens, cached_input_tokens, output_tokens,
  cost_usd, exit_code, workspace_path, error_message
) VALUES (
  @timestamp, @model, @reviewType, @subcommand, @protocol, @projectId,
  @durationSeconds, @inputTokens, @cachedInputTokens, @outputTokens,
  @costUsd, @exitCode, @workspacePath, @errorMessage
)`;

export interface MetricsRecord {
  timestamp: string;
  model: string;
  reviewType: string | null;
  subcommand: string;
  protocol: string;
  projectId: string | null;
  durationSeconds: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  exitCode: number;
  workspacePath: string;
  errorMessage: string | null;
}

export interface StatsFilters {
  days?: number;
  model?: string;
  type?: string;
  protocol?: string;
  project?: string;
  last?: number;
}

export interface MetricsRow {
  id: number;
  timestamp: string;
  model: string;
  review_type: string | null;
  subcommand: string;
  protocol: string | null;
  project_id: string | null;
  duration_seconds: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  exit_code: number;
  workspace_path: string;
  error_message: string | null;
}

export interface ModelStats {
  model: string;
  count: number;
  avgDuration: number;
  totalCost: number | null;
  costCount: number;
  successRate: number;
  successCount: number;
}

export interface TypeStats {
  reviewType: string;
  count: number;
  avgDuration: number;
  totalCost: number | null;
  costCount: number;
}

export interface ProtocolStats {
  protocol: string;
  count: number;
  totalCost: number | null;
  costCount: number;
}

export interface StatsSummary {
  totalCount: number;
  totalDuration: number;
  totalCost: number | null;
  costCount: number;
  successCount: number;
  byModel: ModelStats[];
  byType: TypeStats[];
  byProtocol: ProtocolStats[];
}

function buildWhereClause(filters: StatsFilters): { where: string; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.days) {
    conditions.push("datetime(timestamp) >= datetime('now', @daysOffset)");
    params.daysOffset = `-${filters.days} days`;
  }
  if (filters.model) {
    conditions.push('model = @filterModel');
    params.filterModel = filters.model;
  }
  if (filters.type) {
    conditions.push('review_type = @filterType');
    params.filterType = filters.type;
  }
  if (filters.protocol) {
    conditions.push('protocol = @filterProtocol');
    params.filterProtocol = filters.protocol;
  }
  if (filters.project) {
    conditions.push('project_id = @filterProject');
    params.filterProject = filters.project;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export class MetricsDB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.db = new Database(path);

    const journalMode = this.db.pragma('journal_mode = WAL', { simple: true });
    if (journalMode !== 'wal') {
      console.error('[warn] WAL mode unavailable for metrics database');
    }
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(CREATE_TABLE);
  }

  record(entry: MetricsRecord): void {
    try {
      this.db.prepare(INSERT_ROW).run({
        timestamp: entry.timestamp,
        model: entry.model,
        reviewType: entry.reviewType,
        subcommand: entry.subcommand,
        protocol: entry.protocol,
        projectId: entry.projectId,
        durationSeconds: entry.durationSeconds,
        inputTokens: entry.inputTokens,
        cachedInputTokens: entry.cachedInputTokens,
        outputTokens: entry.outputTokens,
        costUsd: entry.costUsd,
        exitCode: entry.exitCode,
        workspacePath: entry.workspacePath,
        errorMessage: entry.errorMessage,
      });
    } catch (err) {
      console.error(`[warn] Failed to write metrics: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  query(filters: StatsFilters): MetricsRow[] {
    const { where, params } = buildWhereClause(filters);
    let sql = `SELECT * FROM consultation_metrics ${where} ORDER BY timestamp DESC`;
    if (filters.last) {
      sql += ' LIMIT @limit';
      params.limit = filters.last;
    }
    return this.db.prepare(sql).all(params) as MetricsRow[];
  }

  summary(filters: StatsFilters): StatsSummary {
    const { where, params } = buildWhereClause(filters);

    // Overall totals
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(duration_seconds), 0) as total_duration,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as total_cost,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) as cost_count,
        SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) as success_count
      FROM consultation_metrics ${where}
    `).get(params) as {
      total_count: number;
      total_duration: number;
      total_cost: number;
      cost_count: number;
      success_count: number;
    };

    // By model
    const byModel = this.db.prepare(`
      SELECT
        model,
        COUNT(*) as count,
        AVG(duration_seconds) as avg_duration,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as total_cost,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) as cost_count,
        SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) as success_count
      FROM consultation_metrics ${where}
      GROUP BY model
      ORDER BY count DESC
    `).all(params) as Array<{
      model: string;
      count: number;
      avg_duration: number;
      total_cost: number;
      cost_count: number;
      success_count: number;
    }>;

    // By review type
    const byType = this.db.prepare(`
      SELECT
        review_type,
        COUNT(*) as count,
        AVG(duration_seconds) as avg_duration,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as total_cost,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) as cost_count
      FROM consultation_metrics ${where} AND review_type IS NOT NULL
      GROUP BY review_type
      ORDER BY count DESC
    `.replace('AND review_type IS NOT NULL', where ? 'AND review_type IS NOT NULL' : 'WHERE review_type IS NOT NULL'))
      .all(params) as Array<{
        review_type: string;
        count: number;
        avg_duration: number;
        total_cost: number;
        cost_count: number;
      }>;

    // By protocol
    const byProtocol = this.db.prepare(`
      SELECT
        protocol,
        COUNT(*) as count,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as total_cost,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) as cost_count
      FROM consultation_metrics ${where} AND protocol IS NOT NULL
      GROUP BY protocol
      ORDER BY count DESC
    `.replace('AND protocol IS NOT NULL', where ? 'AND protocol IS NOT NULL' : 'WHERE protocol IS NOT NULL'))
      .all(params) as Array<{
        protocol: string;
        count: number;
        total_cost: number;
        cost_count: number;
      }>;

    return {
      totalCount: totals.total_count,
      totalDuration: totals.total_duration,
      totalCost: totals.cost_count > 0 ? totals.total_cost : null,
      costCount: totals.cost_count,
      successCount: totals.success_count,
      byModel: byModel.map(r => ({
        model: r.model,
        count: r.count,
        avgDuration: r.avg_duration,
        totalCost: r.cost_count > 0 ? r.total_cost : null,
        costCount: r.cost_count,
        successRate: r.count > 0 ? (r.success_count / r.count) * 100 : 0,
        successCount: r.success_count,
      })),
      byType: byType.map(r => ({
        reviewType: r.review_type,
        count: r.count,
        avgDuration: r.avg_duration,
        totalCost: r.cost_count > 0 ? r.total_cost : null,
        costCount: r.cost_count,
      })),
      byProtocol: byProtocol.map(r => ({
        protocol: r.protocol,
        count: r.count,
        totalCost: r.cost_count > 0 ? r.total_cost : null,
        costCount: r.cost_count,
      })),
    };
  }

  costByProject(filters: StatsFilters): Array<{ projectId: string; totalCost: number }> {
    const { where, params } = buildWhereClause(filters);
    const extraCondition = where
      ? 'AND project_id IS NOT NULL AND cost_usd IS NOT NULL'
      : 'WHERE project_id IS NOT NULL AND cost_usd IS NOT NULL';

    const rows = this.db.prepare(`
      SELECT
        project_id,
        SUM(cost_usd) as total_cost
      FROM consultation_metrics ${where} ${extraCondition}
      GROUP BY project_id
      ORDER BY total_cost DESC
      LIMIT 10
    `).all(params) as Array<{ project_id: string; total_cost: number }>;

    return rows.map(r => ({ projectId: r.project_id, totalCost: r.total_cost }));
  }

  close(): void {
    this.db.close();
  }

  static get defaultPath(): string {
    return DB_PATH;
  }
}
