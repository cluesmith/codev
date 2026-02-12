/**
 * Tests for file tab SQLite persistence (Spec 0099 Phase 4)
 *
 * Exercises the actual exported functions from utils/file-tabs.ts
 * to verify save, delete, load, and restart behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  saveFileTab,
  deleteFileTab,
  loadFileTabsForProject,
  ensureFileTabsTable,
} from '../utils/file-tabs.js';

describe('File tab SQLite persistence (utils/file-tabs)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureFileTabsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should persist a file tab via saveFileTab', () => {
    const id = 'file-test1';
    const projectPath = '/home/user/project';
    const filePath = '/home/user/project/src/main.ts';
    const createdAt = Date.now();

    saveFileTab(db, id, projectPath, filePath, createdAt);

    const row = db.prepare('SELECT * FROM file_tabs WHERE id = ?').get(id) as {
      id: string; project_path: string; file_path: string; created_at: number;
    };

    expect(row).toBeDefined();
    expect(row.id).toBe(id);
    expect(row.project_path).toBe(projectPath);
    expect(row.file_path).toBe(filePath);
    expect(row.created_at).toBe(createdAt);
  });

  it('should delete a file tab via deleteFileTab', () => {
    saveFileTab(db, 'file-test2', '/project', '/project/file.ts', Date.now());

    // Verify it exists
    const tabs = loadFileTabsForProject(db, '/project');
    expect(tabs.size).toBe(1);

    // Delete it
    deleteFileTab(db, 'file-test2');

    // Verify it's gone
    const tabsAfter = loadFileTabsForProject(db, '/project');
    expect(tabsAfter.size).toBe(0);
  });

  it('should load file tabs for a specific project via loadFileTabsForProject', () => {
    const projectA = '/home/user/project-a';
    const projectB = '/home/user/project-b';

    saveFileTab(db, 'file-a1', projectA, '/a/f1.ts', 1000);
    saveFileTab(db, 'file-a2', projectA, '/a/f2.ts', 2000);
    saveFileTab(db, 'file-b1', projectB, '/b/f1.ts', 3000);

    const tabsA = loadFileTabsForProject(db, projectA);
    expect(tabsA.size).toBe(2);
    expect(tabsA.get('file-a1')?.path).toBe('/a/f1.ts');
    expect(tabsA.get('file-a2')?.path).toBe('/a/f2.ts');

    const tabsB = loadFileTabsForProject(db, projectB);
    expect(tabsB.size).toBe(1);
    expect(tabsB.get('file-b1')?.path).toBe('/b/f1.ts');
  });

  it('should handle INSERT OR REPLACE for duplicate IDs', () => {
    saveFileTab(db, 'file-dup', '/project', '/f1.ts', 100);
    saveFileTab(db, 'file-dup', '/project', '/f2.ts', 200);

    const tabs = loadFileTabsForProject(db, '/project');
    expect(tabs.size).toBe(1);
    expect(tabs.get('file-dup')?.path).toBe('/f2.ts');
    expect(tabs.get('file-dup')?.createdAt).toBe(200);
  });

  it('should return empty Map for project with no tabs', () => {
    const tabs = loadFileTabsForProject(db, '/nonexistent');
    expect(tabs.size).toBe(0);
    expect(tabs).toBeInstanceOf(Map);
  });

  it('should return correct FileTab shape from loadFileTabsForProject', () => {
    saveFileTab(db, 'file-shape', '/project', '/project/src/index.ts', 12345);

    const tabs = loadFileTabsForProject(db, '/project');
    const tab = tabs.get('file-shape');

    expect(tab).toBeDefined();
    expect(tab).toHaveProperty('id', 'file-shape');
    expect(tab).toHaveProperty('path', '/project/src/index.ts');
    expect(tab).toHaveProperty('createdAt', 12345);
  });
});
