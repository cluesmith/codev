/**
 * Metrics `model_id` column and codex cost accounting (spec 1286, Phase 4).
 *
 * Covers spec scenarios 13 and 14 plus migration idempotency.
 *
 * The migration is the risky part: `consultation_metrics` is created with
 * `CREATE TABLE IF NOT EXISTS` and there is no migration framework, so an existing
 * `~/.codev/metrics.db` never gains the column from the DDL. These tests build a fixture on the
 * OLD schema — not a fresh DB — because a fresh DB gets the column from `CREATE TABLE` and would
 * pass without the migration ever running.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MetricsDB, type MetricsRecord } from '../metrics.js';

/** The schema exactly as it stood before spec 1286 — no `model_id`. */
const OLD_SCHEMA = `
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

let dir: string;
let dbPath: string;

function baseRecord(over: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    timestamp: new Date(0).toISOString(),
    model: 'codex',
    modelId: 'gpt-5.4',
    reviewType: 'impl',
    subcommand: 'protocol',
    protocol: 'aspir',
    projectId: '1286',
    durationSeconds: 1,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    costUsd: 0.001,
    exitCode: 0,
    workspacePath: '/tmp/ws',
    errorMessage: null,
    ...over,
  };
}

/** Build a DB on the pre-1286 schema, with a row, so the migration has real data to preserve. */
function seedOldSchemaDb(): void {
  const db = new Database(dbPath);
  db.exec(OLD_SCHEMA);
  db.prepare(`
    INSERT INTO consultation_metrics
      (timestamp, model, review_type, subcommand, protocol, project_id, duration_seconds,
       input_tokens, cached_input_tokens, output_tokens, cost_usd, exit_code, workspace_path, error_message)
    VALUES ('2026-01-01T00:00:00Z','codex','impl','protocol','spir','999',2.5,100,0,50,0.01,0,'/tmp/old',NULL)
  `).run();
  db.close();
}

function columnNames(): string[] {
  const db = new Database(dbPath);
  const cols = (db.pragma('table_info(consultation_metrics)') as { name: string }[]).map((c) => c.name);
  db.close();
  return cols;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-model-id-'));
  dbPath = path.join(dir, 'metrics.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('model_id migration against a pre-1286 database', () => {
  it('adds the column to an existing database that lacks it', () => {
    seedOldSchemaDb();
    expect(columnNames()).not.toContain('model_id');

    new MetricsDB(dbPath).close();

    expect(columnNames()).toContain('model_id');
  });

  it('preserves existing rows and their values', () => {
    seedOldSchemaDb();
    new MetricsDB(dbPath).close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM consultation_metrics').all() as Record<string, unknown>[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('999');
    expect(rows[0].cost_usd).toBe(0.01);
    // Pre-existing rows get NULL — "no model id was recorded", not a fabricated value.
    expect(rows[0].model_id).toBeNull();
  });

  it('is re-runnable: opening the database twice does not error or duplicate the column', () => {
    seedOldSchemaDb();
    new MetricsDB(dbPath).close();
    expect(() => new MetricsDB(dbPath).close()).not.toThrow();

    const cols = columnNames();
    expect(cols.filter((c) => c === 'model_id')).toHaveLength(1);
  });

  it('leaves a fresh database correct without needing the migration', () => {
    new MetricsDB(dbPath).close();
    expect(columnNames()).toContain('model_id');
  });
});

describe('recording the resolved model id (scenario 13)', () => {
  it('stores the model id while `model` keeps holding the lane name', () => {
    const db = new MetricsDB(dbPath);
    db.record(baseRecord({ model: 'codex', modelId: 'gpt-5.6-sol' }));
    db.close();

    const raw = new Database(dbPath);
    const row = raw.prepare('SELECT model, model_id FROM consultation_metrics').get() as Record<string, unknown>;
    raw.close();

    // The distinction the plan insists on: `consult stats` groups on `model`, so it must stay the
    // lane name. Overloading it would silently change every existing report.
    expect(row.model).toBe('codex');
    expect(row.model_id).toBe('gpt-5.6-sol');
  });

  it('stores null when no model was chosen', () => {
    const db = new MetricsDB(dbPath);
    db.record(baseRecord({ model: 'gemini', modelId: null }));
    db.close();

    const raw = new Database(dbPath);
    const row = raw.prepare('SELECT model_id FROM consultation_metrics').get() as Record<string, unknown>;
    raw.close();

    expect(row.model_id).toBeNull();
  });

  it('does not disturb stats aggregation, which groups on the lane', () => {
    const db = new MetricsDB(dbPath);
    db.record(baseRecord({ model: 'codex', modelId: 'gpt-5.4' }));
    db.record(baseRecord({ model: 'codex', modelId: 'gpt-5.6-sol' }));
    const stats = db.summary({});
    db.close();

    // Two different model ids, one lane — stats must still report a single `codex` group.
    const codex = stats.byModel.filter((m) => m.model === 'codex');
    expect(codex).toHaveLength(1);
    expect(codex[0].count).toBe(2);
  });
});
