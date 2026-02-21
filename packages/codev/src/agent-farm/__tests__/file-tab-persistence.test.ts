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
  deleteFileTabsForWorkspace,
  deleteFileTabsByPathPrefix,
  loadFileTabsForWorkspace,
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
    const workspacePath = '/home/user/project';
    const filePath = '/home/user/project/src/main.ts';
    const createdAt = Date.now();

    saveFileTab(db, id, workspacePath, filePath, createdAt);

    const row = db.prepare('SELECT * FROM file_tabs WHERE id = ?').get(id) as {
      id: string; workspace_path: string; file_path: string; created_at: number;
    };

    expect(row).toBeDefined();
    expect(row.id).toBe(id);
    expect(row.workspace_path).toBe(workspacePath);
    expect(row.file_path).toBe(filePath);
    expect(row.created_at).toBe(createdAt);
  });

  it('should delete a file tab via deleteFileTab', () => {
    saveFileTab(db, 'file-test2', '/project', '/project/file.ts', Date.now());

    // Verify it exists
    const tabs = loadFileTabsForWorkspace(db, '/project');
    expect(tabs.size).toBe(1);

    // Delete it
    deleteFileTab(db, 'file-test2');

    // Verify it's gone
    const tabsAfter = loadFileTabsForWorkspace(db, '/project');
    expect(tabsAfter.size).toBe(0);
  });

  it('should load file tabs for a specific workspace via loadFileTabsForWorkspace', () => {
    const workspaceA = '/home/user/project-a';
    const workspaceB = '/home/user/project-b';

    saveFileTab(db, 'file-a1', workspaceA, '/a/f1.ts', 1000);
    saveFileTab(db, 'file-a2', workspaceA, '/a/f2.ts', 2000);
    saveFileTab(db, 'file-b1', workspaceB, '/b/f1.ts', 3000);

    const tabsA = loadFileTabsForWorkspace(db, workspaceA);
    expect(tabsA.size).toBe(2);
    expect(tabsA.get('file-a1')?.path).toBe('/a/f1.ts');
    expect(tabsA.get('file-a2')?.path).toBe('/a/f2.ts');

    const tabsB = loadFileTabsForWorkspace(db, workspaceB);
    expect(tabsB.size).toBe(1);
    expect(tabsB.get('file-b1')?.path).toBe('/b/f1.ts');
  });

  it('should handle INSERT OR REPLACE for duplicate IDs', () => {
    saveFileTab(db, 'file-dup', '/project', '/f1.ts', 100);
    saveFileTab(db, 'file-dup', '/project', '/f2.ts', 200);

    const tabs = loadFileTabsForWorkspace(db, '/project');
    expect(tabs.size).toBe(1);
    expect(tabs.get('file-dup')?.path).toBe('/f2.ts');
    expect(tabs.get('file-dup')?.createdAt).toBe(200);
  });

  it('should return empty Map for workspace with no tabs', () => {
    const tabs = loadFileTabsForWorkspace(db, '/nonexistent');
    expect(tabs.size).toBe(0);
    expect(tabs).toBeInstanceOf(Map);
  });

  it('should return correct FileTab shape from loadFileTabsForWorkspace', () => {
    saveFileTab(db, 'file-shape', '/project', '/project/src/index.ts', 12345);

    const tabs = loadFileTabsForWorkspace(db, '/project');
    const tab = tabs.get('file-shape');

    expect(tab).toBeDefined();
    expect(tab).toHaveProperty('id', 'file-shape');
    expect(tab).toHaveProperty('path', '/project/src/index.ts');
    expect(tab).toHaveProperty('createdAt', 12345);
  });

  // Bugfix #474: Stale tabs survive builder cleanup
  it('should delete all file tabs for a workspace via deleteFileTabsForWorkspace', () => {
    const workspace = '/home/user/project';
    const otherWorkspace = '/home/user/other';

    saveFileTab(db, 'file-1', workspace, '/home/user/project/a.ts', 1000);
    saveFileTab(db, 'file-2', workspace, '/home/user/project/b.ts', 2000);
    saveFileTab(db, 'file-3', otherWorkspace, '/home/user/other/c.ts', 3000);

    deleteFileTabsForWorkspace(db, workspace);

    // All tabs for the workspace should be gone
    const tabs = loadFileTabsForWorkspace(db, workspace);
    expect(tabs.size).toBe(0);

    // Other workspace's tabs should be unaffected
    const otherTabs = loadFileTabsForWorkspace(db, otherWorkspace);
    expect(otherTabs.size).toBe(1);
    expect(otherTabs.get('file-3')?.path).toBe('/home/user/other/c.ts');
  });

  it('should delete file tabs by path prefix via deleteFileTabsByPathPrefix', () => {
    const workspace = '/home/user/project';
    const worktreePath = '/home/user/project/.builders/bugfix-42';

    // Simulate tabs created by a builder via af open (stored under main workspace)
    saveFileTab(db, 'file-wt1', workspace, `${worktreePath}/src/fix.ts`, 1000);
    saveFileTab(db, 'file-wt2', workspace, `${worktreePath}/tests/fix.test.ts`, 2000);
    // A tab from the main workspace (should survive)
    saveFileTab(db, 'file-main', workspace, '/home/user/project/src/app.ts', 3000);

    const deleted = deleteFileTabsByPathPrefix(db, worktreePath);
    expect(deleted).toBe(2);

    // Main workspace tab should survive
    const tabs = loadFileTabsForWorkspace(db, workspace);
    expect(tabs.size).toBe(1);
    expect(tabs.get('file-main')?.path).toBe('/home/user/project/src/app.ts');
  });

  it('should return 0 when no tabs match path prefix', () => {
    saveFileTab(db, 'file-x', '/project', '/project/src/x.ts', 1000);

    const deleted = deleteFileTabsByPathPrefix(db, '/nonexistent/path');
    expect(deleted).toBe(0);

    // Original tab should be unaffected
    const tabs = loadFileTabsForWorkspace(db, '/project');
    expect(tabs.size).toBe(1);
  });
});
