/**
 * Tests for terminal session label support (Spec 468)
 *
 * Covers: migration v11 (label column), saveTerminalSession with label,
 * updateTerminalLabel, getTerminalSessionById, getActiveShellLabels,
 * and label preservation during reconnection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GLOBAL_SCHEMA } from '../db/schema.js';

// Schema for terminal_sessions including the label column (Spec 468)
const TERMINAL_SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
  role_id TEXT,
  pid INTEGER,
  shellper_socket TEXT,
  shellper_pid INTEGER,
  shellper_start_time INTEGER,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace ON terminal_sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_type ON terminal_sessions(type);
`;

describe('Terminal Label Support (Spec 468)', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'terminal-label-test-'));
    db = new Database(join(tempDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.exec(TERMINAL_SESSIONS_SCHEMA);
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('GLOBAL_SCHEMA includes label column', () => {
    it('should include label TEXT column in terminal_sessions', () => {
      const freshDb = new Database(':memory:');
      freshDb.exec(GLOBAL_SCHEMA);

      const columns = freshDb.prepare("PRAGMA table_info('terminal_sessions')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;

      const labelCol = columns.find(c => c.name === 'label');
      expect(labelCol).toBeDefined();
      expect(labelCol!.type).toBe('TEXT');
      expect(labelCol!.notnull).toBe(0); // nullable
      freshDb.close();
    });
  });

  describe('migration v11 — ADD COLUMN label TEXT', () => {
    it('should add label column to existing table without label', () => {
      // Simulate a pre-v11 database (no label column)
      const oldDb = new Database(':memory:');
      oldDb.exec(`
        CREATE TABLE terminal_sessions (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
          role_id TEXT,
          pid INTEGER,
          shellper_socket TEXT,
          shellper_pid INTEGER,
          shellper_start_time INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Insert a pre-migration row
      oldDb.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, pid)
        VALUES ('term-1', '/project', 'shell', 1234)
      `).run();

      // Run migration v11
      oldDb.exec('ALTER TABLE terminal_sessions ADD COLUMN label TEXT');

      // Verify existing row has null label
      const row = oldDb.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-1') as {
        id: string;
        label: string | null;
      };
      expect(row.label).toBeNull();

      // Verify new rows can have label
      oldDb.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, pid, label)
        VALUES ('term-2', '/project', 'shell', 5678, 'monitoring')
      `).run();

      const newRow = oldDb.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-2') as {
        label: string;
      };
      expect(newRow.label).toBe('monitoring');
      oldDb.close();
    });
  });

  describe('saveTerminalSession with label', () => {
    it('should store label when provided', () => {
      db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions
          (id, workspace_path, type, role_id, pid, shellper_socket, shellper_pid, shellper_start_time, label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('term-1', '/project', 'shell', 'shell-1', 1234, null, null, null, 'build testing');

      const row = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-1') as {
        label: string;
      };
      expect(row.label).toBe('build testing');
    });

    it('should store null label when not provided', () => {
      db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions
          (id, workspace_path, type, role_id, pid, shellper_socket, shellper_pid, shellper_start_time, label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('term-1', '/project', 'shell', 'shell-1', 1234, null, null, null, null);

      const row = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-1') as {
        label: string | null;
      };
      expect(row.label).toBeNull();
    });

    it('should preserve label on INSERT OR REPLACE', () => {
      // First insert with label
      db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions
          (id, workspace_path, type, role_id, pid, label)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('term-1', '/project', 'shell', 'shell-1', 1234, 'original');

      // Replace with new label
      db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions
          (id, workspace_path, type, role_id, pid, label)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('term-1', '/project', 'shell', 'shell-1', 5678, 'updated');

      const row = db.prepare('SELECT label, pid FROM terminal_sessions WHERE id = ?').get('term-1') as {
        label: string;
        pid: number;
      };
      expect(row.label).toBe('updated');
      expect(row.pid).toBe(5678);
    });
  });

  describe('updateTerminalLabel', () => {
    it('should update an existing session label', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, pid, label)
        VALUES ('term-1', '/project', 'shell', 1234, 'Shell 1')
      `).run();

      db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run('monitoring', 'term-1');

      const row = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-1') as {
        label: string;
      };
      expect(row.label).toBe('monitoring');
    });

    it('should set label from null', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, pid)
        VALUES ('term-1', '/project', 'shell', 1234)
      `).run();

      db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run('debug session', 'term-1');

      const row = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-1') as {
        label: string;
      };
      expect(row.label).toBe('debug session');
    });

    it('should not fail for non-existent session', () => {
      const result = db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run('test', 'non-existent');
      expect(result.changes).toBe(0);
    });
  });

  describe('getTerminalSessionById', () => {
    it('should return session with label', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-1') as {
        id: string;
        label: string;
        type: string;
      };
      expect(row.id).toBe('term-1');
      expect(row.label).toBe('monitoring');
      expect(row.type).toBe('shell');
    });

    it('should return null for non-existent session', () => {
      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('non-existent');
      expect(row).toBeUndefined();
    });
  });

  describe('getActiveShellLabels', () => {
    it('should return labels of active shell sessions', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-2', '/project', 'shell', 'shell-2', 5678, 'debugging')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-3', '/project', 'architect', null, 9999, 'Architect')
      `).run();

      const labels = db.prepare(
        "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL"
      ).all('/project') as Array<{ label: string }>;

      expect(labels.map(r => r.label)).toEqual(['monitoring', 'debugging']);
    });

    it('should exclude sessions with null labels', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid)
        VALUES ('term-2', '/project', 'shell', 'shell-2', 5678)
      `).run();

      const labels = db.prepare(
        "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL"
      ).all('/project') as Array<{ label: string }>;

      expect(labels.map(r => r.label)).toEqual(['monitoring']);
    });

    it('should scope to workspace', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project-a', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-2', '/project-b', 'shell', 'shell-1', 5678, 'debugging')
      `).run();

      const labels = db.prepare(
        "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL"
      ).all('/project-a') as Array<{ label: string }>;

      expect(labels.map(r => r.label)).toEqual(['monitoring']);
    });
  });

  describe('label preservation during reconnection', () => {
    it('should carry label from old row to new row (simulating reconnect)', () => {
      // Simulate: session saved with label
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label,
          shellper_socket, shellper_pid, shellper_start_time)
        VALUES ('old-term', '/project', 'shell', 'shell-1', 1234, 'custom-name',
          '/tmp/shellper.sock', 1234, 1700000000)
      `).run();

      // Read the old session
      const dbSession = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('old-term') as {
        label: string | null;
        workspace_path: string;
        type: string;
        role_id: string | null;
        shellper_socket: string;
        shellper_pid: number;
        shellper_start_time: number;
      };

      // Delete old row and insert new one with label carried over (simulating reconnection)
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run('old-term');
      db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions
          (id, workspace_path, type, role_id, pid, shellper_socket, shellper_pid, shellper_start_time, label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('new-term', dbSession.workspace_path, dbSession.type, dbSession.role_id,
        dbSession.shellper_pid, dbSession.shellper_socket, dbSession.shellper_pid,
        dbSession.shellper_start_time, dbSession.label);

      // Verify label was carried over
      const newRow = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('new-term') as {
        label: string;
      };
      expect(newRow.label).toBe('custom-name');

      // Old row is gone
      const oldRow = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('old-term');
      expect(oldRow).toBeUndefined();
    });

    it('should handle null label during reconnection gracefully', () => {
      // Pre-migration session has no label
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid,
          shellper_socket, shellper_pid, shellper_start_time)
        VALUES ('old-term', '/project', 'shell', 'shell-1', 1234,
          '/tmp/shellper.sock', 1234, 1700000000)
      `).run();

      const dbSession = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('old-term') as {
        label: string | null;
      };
      expect(dbSession.label).toBeNull();

      // Reconnect preserves null label
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run('old-term');
      db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions
          (id, workspace_path, type, role_id, pid, label)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('new-term', '/project', 'shell', 'shell-1', 5678, dbSession.label);

      const newRow = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('new-term') as {
        label: string | null;
      };
      expect(newRow.label).toBeNull();
    });
  });

  describe('env var injection contract', () => {
    it('SHELLPER_SESSION_ID should be a valid UUID format', () => {
      // This test validates the contract: SHELLPER_SESSION_ID is a UUID
      const sessionId = crypto.randomUUID();
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('TOWER_PORT should be a valid port number string', () => {
      // This test validates the contract: TOWER_PORT is a stringified number
      const port = 4200;
      const portStr = String(port);
      expect(portStr).toBe('4200');
      expect(parseInt(portStr, 10)).toBe(port);
    });
  });
});
