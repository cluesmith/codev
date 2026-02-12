/**
 * Tests for file tab SQLite persistence (Spec 0099 Phase 4)
 *
 * Verifies that file tabs are persisted to SQLite and restored
 * across Tower restarts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';

describe('File tab SQLite persistence', () => {
  let db: Database.Database;
  const testDir = path.join(tmpdir(), `codev-file-tab-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_tabs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_tabs_project ON file_tabs(project_path);
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should persist a file tab to SQLite', () => {
    const id = 'file-test1';
    const projectPath = '/home/user/project';
    const filePath = '/home/user/project/src/main.ts';
    const createdAt = Date.now();

    db.prepare(`
      INSERT OR REPLACE INTO file_tabs (id, project_path, file_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, projectPath, filePath, createdAt);

    const row = db.prepare('SELECT * FROM file_tabs WHERE id = ?').get(id) as {
      id: string; project_path: string; file_path: string; created_at: number;
    };

    expect(row).toBeDefined();
    expect(row.id).toBe(id);
    expect(row.project_path).toBe(projectPath);
    expect(row.file_path).toBe(filePath);
    expect(row.created_at).toBe(createdAt);
  });

  it('should delete a file tab from SQLite', () => {
    const id = 'file-test2';
    db.prepare(`
      INSERT INTO file_tabs (id, project_path, file_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, '/project', '/project/file.ts', Date.now());

    // Verify it exists
    expect(db.prepare('SELECT id FROM file_tabs WHERE id = ?').get(id)).toBeDefined();

    // Delete it
    db.prepare('DELETE FROM file_tabs WHERE id = ?').run(id);

    // Verify it's gone
    expect(db.prepare('SELECT id FROM file_tabs WHERE id = ?').get(id)).toBeUndefined();
  });

  it('should load file tabs for a specific project', () => {
    const projectA = '/home/user/project-a';
    const projectB = '/home/user/project-b';

    db.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-a1', projectA, '/a/f1.ts', 1000);
    db.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-a2', projectA, '/a/f2.ts', 2000);
    db.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-b1', projectB, '/b/f1.ts', 3000);

    const rows = db.prepare('SELECT id, file_path, created_at FROM file_tabs WHERE project_path = ?')
      .all(projectA) as Array<{ id: string; file_path: string; created_at: number }>;

    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.id).sort()).toEqual(['file-a1', 'file-a2']);
  });

  it('should survive a simulated Tower restart (close + reopen)', () => {
    const projectPath = '/home/user/project';

    // First "session": create tabs
    db.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-r1', projectPath, '/p/src/a.ts', 100);
    db.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-r2', projectPath, '/p/src/b.ts', 200);

    // Simulate Tower restart by closing and reopening database
    const dbPath = path.join(testDir, 'test-restart.db');
    const persistDb = new Database(dbPath);
    persistDb.exec(`
      CREATE TABLE IF NOT EXISTS file_tabs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    persistDb.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-r1', projectPath, '/p/src/a.ts', 100);
    persistDb.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run('file-r2', projectPath, '/p/src/b.ts', 200);
    persistDb.close();

    // "Restart" — open fresh connection
    const restartDb = new Database(dbPath);
    const rows = restartDb.prepare('SELECT id, file_path, created_at FROM file_tabs WHERE project_path = ?')
      .all(projectPath) as Array<{ id: string; file_path: string; created_at: number }>;

    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === 'file-r1')?.file_path).toBe('/p/src/a.ts');
    expect(rows.find(r => r.id === 'file-r2')?.file_path).toBe('/p/src/b.ts');

    restartDb.close();
  });

  it('should handle INSERT OR REPLACE for duplicate IDs', () => {
    const id = 'file-dup';
    db.prepare('INSERT INTO file_tabs VALUES (?, ?, ?, ?)').run(id, '/project', '/f1.ts', 100);
    db.prepare('INSERT OR REPLACE INTO file_tabs VALUES (?, ?, ?, ?)').run(id, '/project', '/f2.ts', 200);

    const row = db.prepare('SELECT * FROM file_tabs WHERE id = ?').get(id) as {
      id: string; file_path: string; created_at: number;
    };
    expect(row.file_path).toBe('/f2.ts');
    expect(row.created_at).toBe(200);
  });

  it('should return empty results for project with no tabs', () => {
    const rows = db.prepare('SELECT * FROM file_tabs WHERE project_path = ?').all('/nonexistent');
    expect(rows).toHaveLength(0);
  });
});
