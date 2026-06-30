/**
 * Spec 755 / Issue #1118 — direct tests for `lookupBuilderSpawningArchitect`
 * against a real SQLite database.
 *
 * Issue #1118 retired the per-workspace state.db files: builders now live in the
 * single shared global.db, scoped by `workspace_path` (composite PK). The helper
 * resolves `WHERE workspace_path = ? AND id = ?`. These tests verify the
 * three-valued return contract and, crucially, that the **same builder id in two
 * workspaces resolves to the correct workspace's spawning architect** — the
 * security-relevant contract behind the spoofing check (tower-messages.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';

const testDir = resolve(process.cwd(), '.test-spec-755-lookup');
let db: Database.Database | null = null;

// Single shared global.db — getDb() and getGlobalDb() both return it (Issue #1118).
vi.mock('../db/index.js', () => {
  const ensure = () => {
    if (!db) {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE builders (
          workspace_path TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 0,
          pid INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'spawning',
          phase TEXT NOT NULL DEFAULT '',
          worktree TEXT NOT NULL,
          branch TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'spec',
          task_text TEXT,
          protocol_name TEXT,
          issue_number TEXT,
          terminal_id TEXT,
          spawned_by_architect TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_path, id)
        );
      `);
    }
    return db;
  };
  return { getDb: ensure, getGlobalDb: ensure, closeDb: () => {}, closeGlobalDb: () => {} };
});

const { lookupBuilderSpawningArchitect } = await import('../state.js');

describe('Issue #1118 — lookupBuilderSpawningArchitect (single shared global.db)', () => {
  const wsA = join(testDir, 'ws-a');
  const wsB = join(testDir, 'ws-b');

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    // Real dirs so realpathSync (the helper's canonicalization) resolves them.
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    if (db) {
      db.close();
      db = null;
    }
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** Insert a builder row scoped to a workspace, with a controlled spawning architect. */
  function insertBuilder(workspacePath: string, id: string, spawnedByArchitect: string | null) {
    // Trigger lazy init of the mocked db (getDb()) before writing to it.
    lookupBuilderSpawningArchitect('__init__', workspacePath);
    db!.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, spawned_by_architect)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(realpathSync(workspacePath), id, `builder ${id}`, join(workspacePath, '.builders', id), 'main', spawnedByArchitect);
  }

  it('returns the recorded spawned_by_architect for a builder row with an explicit name', () => {
    insertBuilder(wsA, 'spir-100', 'sibling');
    expect(lookupBuilderSpawningArchitect('spir-100', wsA)).toBe('sibling');
  });

  it('returns null for a legacy builder row where spawned_by_architect is NULL', () => {
    insertBuilder(wsA, 'legacy-1', null);
    expect(lookupBuilderSpawningArchitect('legacy-1', wsA)).toBeNull();
  });

  it('returns undefined when no row exists for the given id (non-builder sender)', () => {
    insertBuilder(wsA, 'spir-100', 'sibling');
    expect(lookupBuilderSpawningArchitect('not-a-builder', wsA)).toBeUndefined();
  });

  it('isolates lookups per workspace — same id resolves to the correct workspace', () => {
    insertBuilder(wsA, 'spir-100', 'sibling');
    insertBuilder(wsB, 'spir-100', 'main');

    // The same builder id resolves differently per workspace — the contract a
    // shared table must preserve (per-file separation no longer does it).
    expect(lookupBuilderSpawningArchitect('spir-100', wsA)).toBe('sibling');
    expect(lookupBuilderSpawningArchitect('spir-100', wsB)).toBe('main');
  });

  it('does not leak across workspaces — a row in A is undefined when queried under B', () => {
    insertBuilder(wsA, 'only-in-a', 'sibling');
    expect(lookupBuilderSpawningArchitect('only-in-a', wsB)).toBeUndefined();
  });
});
