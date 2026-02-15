/**
 * consult stats - Display consultation metrics summary
 *
 * Queries ~/.codev/metrics.db and displays aggregated statistics
 * or individual invocation history.
 */

import { existsSync } from 'node:fs';
import { MetricsDB, type StatsFilters, type MetricsRow, type StatsSummary } from './metrics.js';

interface StatsOptions {
  days?: string;
  model?: string;
  type?: string;
  protocol?: string;
  project?: string;
  last?: string;
  json?: boolean;
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)} hours`;
  }
  if (seconds >= 60) {
    return `${(seconds / 60).toFixed(1)} min`;
  }
  return `${seconds.toFixed(1)}s`;
}

function formatCost(cost: number | null): string {
  if (cost === null) return 'N/A';
  return `$${cost.toFixed(2)}`;
}

function padRight(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function padLeft(str: string, len: number): string {
  return ' '.repeat(Math.max(0, len - str.length)) + str;
}

function printSummary(summary: StatsSummary, days: number): void {
  const successRate = summary.totalCount > 0
    ? ((summary.successCount / summary.totalCount) * 100).toFixed(1)
    : '0.0';
  const costStr = summary.totalCost !== null
    ? `$${summary.totalCost.toFixed(2)} (${summary.costCount} of ${summary.totalCount} with cost data)`
    : 'N/A';

  console.log(`Consultation Metrics (last ${days} days)`);
  console.log('='.repeat(40));
  console.log('');
  console.log(`Total invocations: ${summary.totalCount}`);
  console.log(`Total duration:    ${formatDuration(summary.totalDuration)}`);
  console.log(`Total cost:        ${costStr}`);
  console.log(`Success rate:      ${successRate}% (${summary.successCount}/${summary.totalCount})`);

  if (summary.byModel.length > 0) {
    console.log('');
    console.log('By Model:');
    for (const m of summary.byModel) {
      const avgDur = `avg ${m.avgDuration.toFixed(0)}s`;
      const cost = formatCost(m.totalCost);
      const success = `${m.successRate.toFixed(0)}% success`;
      console.log(`  ${padRight(m.model, 8)} ${padLeft(String(m.count), 3)} calls   ${padLeft(avgDur, 8)}    ${padLeft(cost, 8)}   ${success}`);
    }
  }

  if (summary.byType.length > 0) {
    console.log('');
    console.log('By Review Type:');
    for (const t of summary.byType) {
      const avgDur = `avg ${t.avgDuration.toFixed(0)}s`;
      const cost = formatCost(t.totalCost);
      console.log(`  ${padRight(t.reviewType, 20)} ${padLeft(String(t.count), 3)} calls   ${padLeft(avgDur, 8)}   ${padLeft(cost, 8)}`);
    }
  }

  if (summary.byProtocol.length > 0) {
    console.log('');
    console.log('By Protocol:');
    for (const p of summary.byProtocol) {
      const cost = formatCost(p.totalCost);
      console.log(`  ${padRight(p.protocol, 8)} ${padLeft(String(p.count), 3)} calls   ${padLeft(cost, 8)}`);
    }
  }
}

function printLastN(rows: MetricsRow[]): void {
  console.log(`Last ${rows.length} consultations:`);
  console.log(`${padRight('TIMESTAMP', 20)} ${padRight('MODEL', 8)} ${padRight('TYPE', 20)} ${padRight('DURATION', 10)} ${padRight('COST', 10)} ${padRight('EXIT', 5)} PROJECT`);

  for (const row of rows) {
    const ts = row.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '').substring(0, 19);
    const model = row.model;
    const type = row.review_type ?? '';
    const duration = `${row.duration_seconds.toFixed(1)}s`;
    const cost = row.cost_usd !== null ? `$${row.cost_usd.toFixed(2)}` : 'N/A';
    const exit = String(row.exit_code);
    const project = row.project_id ?? '';

    console.log(`${padRight(ts, 20)} ${padRight(model, 8)} ${padRight(type, 20)} ${padLeft(duration, 10)} ${padLeft(cost, 10)} ${padLeft(exit, 5)} ${project}`);
  }
}

export async function handleStats(_args: string[], options: StatsOptions): Promise<void> {
  // Cold start: check if database exists
  if (!existsSync(MetricsDB.defaultPath)) {
    console.log('No metrics data found. Run a consultation first.');
    return;
  }

  const filters: StatsFilters = {};

  if (options.days) {
    filters.days = parseInt(options.days, 10);
    if (isNaN(filters.days) || filters.days <= 0) {
      throw new Error(`Invalid --days value: ${options.days}`);
    }
  } else {
    filters.days = 30; // Default to last 30 days
  }

  if (options.model) filters.model = options.model;
  if (options.type) filters.type = options.type;
  if (options.protocol) filters.protocol = options.protocol;
  if (options.project) filters.project = options.project;

  if (options.last) {
    filters.last = parseInt(options.last, 10);
    if (isNaN(filters.last) || filters.last <= 0) {
      throw new Error(`Invalid --last value: ${options.last}`);
    }
  }

  const db = new MetricsDB();
  try {
    if (options.json) {
      if (options.last) {
        const rows = db.query(filters);
        console.log(JSON.stringify(rows, null, 2));
      } else {
        const summary = db.summary(filters);
        console.log(JSON.stringify(summary, null, 2));
      }
    } else if (options.last) {
      const rows = db.query(filters);
      if (rows.length === 0) {
        console.log('No consultations found matching the filters.');
      } else {
        printLastN(rows);
      }
    } else {
      const summary = db.summary(filters);
      if (summary.totalCount === 0) {
        console.log('No consultations found matching the filters.');
      } else {
        printSummary(summary, filters.days!);
      }
    }
  } finally {
    db.close();
  }
}
