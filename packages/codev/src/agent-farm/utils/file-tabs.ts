/**
 * File tab persistence helpers for SQLite.
 * Manages file_tabs table for persisting open file tabs across Tower restarts.
 */

import type Database from 'better-sqlite3';

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
  projectPath: string,
  filePath: string,
  createdAt: number
): void {
  db.prepare(`
    INSERT OR REPLACE INTO file_tabs (id, project_path, file_path, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, projectPath, filePath, createdAt);
}

/**
 * Delete a file tab from SQLite.
 */
export function deleteFileTab(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM file_tabs WHERE id = ?').run(id);
}

/**
 * Load file tabs for a project from SQLite.
 */
export function loadFileTabsForProject(
  db: Database.Database,
  projectPath: string
): Map<string, FileTab> {
  const tabs = new Map<string, FileTab>();
  const rows = db.prepare('SELECT id, file_path, created_at FROM file_tabs WHERE project_path = ?')
    .all(projectPath) as Array<{ id: string; file_path: string; created_at: number }>;
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
      project_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_tabs_project ON file_tabs(project_path);
  `);
}
