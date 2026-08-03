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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MetricsDB, type MetricsRecord } from '../metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run the concurrency child processes against the TypeScript SOURCE, via tsx.
 *
 * Found by codex: pointing the children at `dist/` made this test depend on a prior `pnpm build`.
 * The unit-test CI job (`.github/workflows/test.yml`) runs `copy-skeleton` and then vitest, and
 * never builds `packages/codev` — so on a clean checkout there is no `dist/` and every child dies
 * with ERR_MODULE_NOT_FOUND.
 *
 * The staleness case is the worse half and the reason source beats "just build first": when `dist/`
 * DOES exist but predates the fix, the children exercise the old migration and the test goes green
 * while the source is broken. A concurrency regression test that can pass against code it isn't
 * running is worse than no test at all.
 */
const require_ = createRequire(import.meta.url);
const TSX_CLI = require_.resolve('tsx/cli');
const METRICS_SRC = path.resolve(__dirname, '../metrics.ts');

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

/**
 * Build a DB on the pre-1286 schema, with a row, so the migration has real data to preserve.
 *
 * Seeded ALREADY IN WAL, which matters for the parallel test: the journal-mode switch takes a brief
 * exclusive lock, so leaving the fixture in delete mode makes the first opener a serialization
 * point and the others no longer reach the migration together. Measured — with a reverted migration
 * fix, a delete-mode fixture caught the regression only 2 runs in 5. Starting in WAL sends every
 * opener down `enableWal`'s fast path, so the contention lands on the migration, which is the thing
 * this fixture exists to stress. (A real `~/.codev/metrics.db` is in WAL for the same reason.)
 */
function seedOldSchemaDb(): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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

  // The deterministic half of the concurrency story. The multi-process test below reproduces the
  // real race but, being a race, catches a regression only about half the time — once the first
  // opener flips the journal to WAL, every later `journal_mode = WAL` is a cheap no-op, so the
  // window is genuinely tiny. This test removes the timing entirely: hold the write lock outright,
  // which is the state a concurrent opener transiently sees, and assert the constructor survives it.
  //
  // Seeded on the CURRENT schema on purpose, so the migration takes its fast path and does not
  // contend. What is under test here is only the journal-mode switch.
  it('opens while another connection holds the write lock, instead of throwing SQLITE_BUSY', () => {
    const seed = new Database(dbPath);
    seed.exec(OLD_SCHEMA);
    seed.exec('ALTER TABLE consultation_metrics ADD COLUMN model_id TEXT');
    seed.close();

    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE'); // take the write lock and keep it
    try {
      expect(() => new MetricsDB(dbPath).close()).not.toThrow();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  // Found by codex: a CMAP opens three MetricsDB connections in PARALLEL, so on the first
  // consultation after upgrading, all three can see the column as absent. A plain check-then-ALTER
  // lets one win and the others fail with "duplicate column name" — and recordMetrics swallows
  // errors, so those lanes' rows disappear without a trace.
  //
  // Uses real child processes: better-sqlite3 is synchronous, so nothing in-process can reproduce
  // two connections interleaving.
  it('survives concurrent first-open by several processes, losing no rows', () => {
    seedOldSchemaDb();

    // The children rendezvous on a real readiness BARRIER before touching the database.
    //
    // Spawning alone does not make them collide: tsx transpiles on startup, and that jitter dwarfs
    // the lock window, so they arrive staggered and the race mostly does not happen. Measured
    // against a reverted fix: no barrier caught it 2 runs in 5.
    //
    // A shared wall-clock deadline was the obvious next try and it is not enough either — it
    // assumes every child is warm before the deadline, and under the load of N concurrent tsx
    // starts the stragglers miss it. Raising N made detection WORSE (2 in 6 at ten racers vs 4 in 5
    // at six), because more processes means more startup contention, and a child that arrives late
    // finds the work already done and never contends at all.
    //
    // So: each child announces itself and then spins on a `go` file the parent creates only once
    // every child has announced. Contention no longer depends on how long tsx takes.
    const runner = path.join(dir, 'open.mts');
    const goFile = path.join(dir, 'go');
    fs.writeFileSync(runner, `
      import * as fs from 'node:fs';
      import { MetricsDB } from ${JSON.stringify(METRICS_SRC)};
      fs.writeFileSync(process.argv[4] + '.' + process.argv[3], 'ready');
      while (!fs.existsSync(process.argv[4])) { /* spin — sub-ms release, unlike setTimeout */ }
      const db = new MetricsDB(process.argv[2]);
      db.record({
        timestamp: new Date(0).toISOString(), model: 'codex', modelId: process.argv[3],
        reviewType: null, subcommand: 'general', protocol: 'aspir', projectId: null,
        durationSeconds: 1, inputTokens: null, cachedInputTokens: null, outputTokens: null,
        costUsd: null, exitCode: 0, workspacePath: '/tmp/ws', errorMessage: null,
      });
      db.close();
    `);

    // Six rather than the three a real CMAP uses — more contenders, wider window. With the barrier
    // the count no longer trades off against startup skew, but six keeps the test quick.
    const racers = ['a', 'b', 'c', 'd', 'e', 'f'];
    const procs = racers.map((tag) =>
      spawn(process.execPath, [TSX_CLI, runner, dbPath, tag, goFile], { stdio: 'pipe' }));
    const results = procs.map((p) => {
      const chunks: Buffer[] = [];
      p.stderr.on('data', (b: Buffer) => chunks.push(b));
      return new Promise<{ code: number | null; err: string }>((resolve) =>
        p.on('close', (code) => resolve({ code, err: Buffer.concat(chunks).toString() })));
    });

    // Release only once every child has announced itself, so they all hit the database together.
    const allReady = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const poll = setInterval(() => {
        if (racers.every((t) => fs.existsSync(`${goFile}.${t}`))) {
          clearInterval(poll);
          fs.writeFileSync(goFile, 'go');
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          // Never silently proceed: without the barrier the test still "passes", but it would be
          // measuring startup order rather than lock contention.
          reject(new Error('children did not reach the barrier within 20s'));
        }
      }, 5);
    });

    return allReady.then(() => Promise.all(results)).then((outcomes) => {
      for (const o of outcomes) {
        expect(o.err).not.toMatch(/duplicate column name/i);
        // Carry stderr into the failure message: a child that dies for an unrelated reason
        // (a missing loader, a bad import) otherwise shows up as a bare "expected 1 to be 0".
        expect(o.code, o.err).toBe(0);
      }
      // The point of the fix: every racer's row survives. Losing one is the silent failure.
      const raw = new Database(dbPath);
      const tags = (raw.prepare('SELECT model_id FROM consultation_metrics WHERE model_id IS NOT NULL')
        .all() as { model_id: string }[]).map((r) => r.model_id).sort();
      raw.close();
      expect(tags).toEqual(racers);
    });
  }, 30_000);
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
