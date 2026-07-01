/**
 * Issue #1118 — `afx db consolidate <path>` command behavior.
 *
 * Covers the two properties codex flagged: repeat-run idempotency (friendly
 * no-op instead of hard error / double-rename) and a side-effect-free dry-run
 * (must not create or migrate the target global.db before `--apply`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';

// Redirect global.db to a per-test path and track whether the read-WRITE
// getGlobalDb() connection was opened (dry-run must NOT open it).
const h = vi.hoisted(() => ({ globalDbPath: '', getGlobalDbCalled: false }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return {
    ...actual,
    getGlobalDbPath: () => h.globalDbPath,
    getGlobalDb: () => { h.getGlobalDbCalled = true; return actual.getGlobalDb(); },
  };
});

const { dbConsolidate } = await import('../commands/db.js');

const dir = resolve(process.cwd(), '.test-db-consolidate-cmd');

function makeSource(name: string): string {
  const p = resolve(dir, name);
  const db = new Database(p);
  db.exec(GLOBAL_SCHEMA);
  db.prepare(
    "INSERT INTO architect (workspace_path, id, pid, port, cmd, started_at) VALUES ('/ws', 'main', 1, 0, 'claude', '2026-01-01 00:00:00')",
  ).run();
  db.close();
  return p;
}

describe('afx db consolidate (Issue #1118)', () => {
  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    h.globalDbPath = resolve(dir, 'global.db');
    h.getGlobalDbCalled = false;
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it('dry-run is side-effect-free — does not open getGlobalDb() or create the target', () => {
    h.globalDbPath = resolve(dir, 'should-not-be-created.db');
    const src = makeSource('source-state.db');

    dbConsolidate(src); // no --apply

    expect(h.getGlobalDbCalled).toBe(false);
    expect(existsSync(h.globalDbPath)).toBe(false);
    expect(existsSync(src)).toBe(true); // dry-run doesn't rename the source
  });

  it('is a friendly no-op on a missing source (re-run after the source was renamed)', () => {
    expect(() => dbConsolidate(resolve(dir, 'already-migrated-state.db'))).not.toThrow();
    expect(h.getGlobalDbCalled).toBe(false);
  });

  it('skips an already-archived *.pre-merge-* file instead of re-migrating it', () => {
    const archived = resolve(dir, 'state.db.pre-merge-2026-01-01T00-00-00-000Z');
    writeFileSync(archived, 'x');
    expect(() => dbConsolidate(archived)).not.toThrow();
    expect(h.getGlobalDbCalled).toBe(false);
  });
});
