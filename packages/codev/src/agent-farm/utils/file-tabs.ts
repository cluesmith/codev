/**
 * File tab persistence helpers for SQLite.
 * Manages file_tabs table for persisting open file tabs across Tower restarts.
 */

import type Database from 'better-sqlite3';
import path from 'node:path';

export interface FileTab {
  id: string;
  path: string;
  createdAt: number;
}

/**
 * Save a file tab to SQLite.
 */
export function saveFileTab(
  db: Database.Database,
  id: string,
  workspacePath: string,
  filePath: string,
  createdAt: number
): void {
  db.prepare(`
    INSERT OR REPLACE INTO file_tabs (id, workspace_path, file_path, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, workspacePath, filePath, createdAt);
}

/**
 * Delete a file tab from SQLite.
 */
export function deleteFileTab(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM file_tabs WHERE id = ?').run(id);
}

/**
 * Delete all file tabs for a workspace from SQLite.
 * Used when a workspace is stopped or fully cleaned up.
 */
export function deleteFileTabsForWorkspace(db: Database.Database, workspacePath: string): void {
  db.prepare('DELETE FROM file_tabs WHERE workspace_path = ?').run(workspacePath);
}

/**
 * Delete file tabs whose file_path is inside a given directory.
 * Used during builder cleanup to remove tabs pointing into a deleted worktree.
 * Ensures path boundary safety by normalizing the prefix to end with the host
 * separator (`\` on Windows, Spec 1658).
 */
export function deleteFileTabsByPathPrefix(db: Database.Database, pathPrefix: string): number {
  // Ensure trailing slash to prevent prefix collisions (e.g. bugfix-42 matching bugfix-424)
  const safePrefix = pathPrefix.endsWith(path.sep) ? pathPrefix : pathPrefix + path.sep;
  const result = db.prepare('DELETE FROM file_tabs WHERE file_path LIKE ? || \'%\'').run(safePrefix);
  return result.changes;
}

/**
 * Load file tabs for a workspace from SQLite.
 */
export function loadFileTabsForWorkspace(
  db: Database.Database,
  workspacePath: string
): Map<string, FileTab> {
  const tabs = new Map<string, FileTab>();
  const rows = db.prepare('SELECT id, file_path, created_at FROM file_tabs WHERE workspace_path = ?')
    .all(workspacePath) as Array<{ id: string; file_path: string; created_at: number }>;
  for (const row of rows) {
    tabs.set(row.id, { id: row.id, path: row.file_path, createdAt: row.created_at });
  }
  return tabs;
}

/**
 * Ensure the file_tabs table exists (for use in tests).
 */
export function ensureFileTabsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_tabs (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_tabs_workspace ON file_tabs(workspace_path);
  `);
}
