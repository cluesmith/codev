/**
 * Tests for terminal session persistence and reconciliation (Spec 0090 TICK-001)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Schema for terminal_sessions table (updated for Spec 0104 — shellper replaces tmux)
const TERMINAL_SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
  role_id TEXT,
  pid INTEGER,
  shellper_socket TEXT,
  shellper_pid INTEGER,
  shellper_start_time INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_path);
`;

describe('Terminal Session Persistence (TICK-001)', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    // Create temp directory and database
    tempDir = mkdtempSync(join(tmpdir(), 'terminal-sessions-test-'));
    db = new Database(join(tempDir, 'test.db'));
    db.exec(TERMINAL_SESSIONS_SCHEMA);
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('saveTerminalSession', () => {
    it('should insert a new terminal session', () => {
      const stmt = db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, role_id, pid, shellper_socket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run('term-123', '/path/to/project', 'architect', null, 12345, null);

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-123') as {
        id: string;
        project_path: string;
        type: string;
        role_id: string | null;
        pid: number | null;
      };

      expect(row).toBeDefined();
      expect(row.id).toBe('term-123');
      expect(row.project_path).toBe('/path/to/project');
      expect(row.type).toBe('architect');
      expect(row.pid).toBe(12345);
    });

    it('should replace existing session with same ID', () => {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO terminal_sessions (id, project_path, type, role_id, pid, shellper_socket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run('term-123', '/path/to/project', 'architect', null, 12345, null);
      stmt.run('term-123', '/path/to/project', 'architect', null, 99999, null);

      const count = db.prepare('SELECT COUNT(*) as count FROM terminal_sessions').get() as { count: number };
      expect(count.count).toBe(1);

      const row = db.prepare('SELECT pid FROM terminal_sessions WHERE id = ?').get('term-123') as { pid: number };
      expect(row.pid).toBe(99999);
    });

    it('should enforce type constraint', () => {
      const stmt = db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, role_id, pid, shellper_socket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      expect(() => {
        stmt.run('term-123', '/path/to/project', 'invalid_type', null, 12345, null);
      }).toThrow();
    });
  });

  describe('deleteTerminalSession', () => {
    it('should delete a terminal session by ID', () => {
      // Insert a session
      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid)
        VALUES ('term-123', '/path/to/project', 'architect', 12345)
      `).run();

      // Delete it
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run('term-123');

      // Verify it's gone
      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-123');
      expect(row).toBeUndefined();
    });

    it('should not error when deleting non-existent session', () => {
      const result = db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run('non-existent');
      expect(result.changes).toBe(0);
    });
  });

  describe('deleteProjectTerminalSessions', () => {
    it('should delete all sessions for a project', () => {
      // Insert multiple sessions for same project
      const stmt = db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, role_id, pid)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run('term-1', '/path/to/project', 'architect', null, 1001);
      stmt.run('term-2', '/path/to/project', 'shell', 'shell-1', 1002);
      stmt.run('term-3', '/path/to/project', 'builder', 'builder-1', 1003);
      stmt.run('term-4', '/other/project', 'architect', null, 2001);

      // Delete all for /path/to/project
      db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run('/path/to/project');

      // Verify only other project remains
      const rows = db.prepare('SELECT * FROM terminal_sessions').all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as { project_path: string }).project_path).toBe('/other/project');
    });
  });

  describe('reconciliation queries', () => {
    it('should retrieve all sessions for reconciliation', () => {
      const stmt = db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, role_id, pid, shellper_socket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run('term-1', '/project-a', 'architect', null, 1001, '/tmp/shellper-1.sock');
      stmt.run('term-2', '/project-b', 'shell', 'shell-1', 1002, null);

      const sessions = db.prepare('SELECT * FROM terminal_sessions').all() as Array<{
        id: string;
        project_path: string;
        type: string;
        shellper_socket: string | null;
        pid: number | null;
      }>;

      expect(sessions).toHaveLength(2);

      const shellperSession = sessions.find(s => s.shellper_socket !== null);
      expect(shellperSession?.shellper_socket).toBe('/tmp/shellper-1.sock');
    });

    it('should retrieve sessions by project path', () => {
      const stmt = db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run('term-1', '/project-a', 'architect', 1001);
      stmt.run('term-2', '/project-a', 'shell', 1002);
      stmt.run('term-3', '/project-b', 'architect', 2001);

      const sessions = db.prepare('SELECT * FROM terminal_sessions WHERE project_path = ?')
        .all('/project-a');

      expect(sessions).toHaveLength(2);
    });
  });

  describe('migration compatibility', () => {
    it('should handle sessions without shellper (non-persistent)', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid, shellper_socket)
        VALUES ('term-1', '/project', 'shell', 1234, NULL)
      `).run();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-1') as {
        shellper_socket: string | null;
      };
      expect(row.shellper_socket).toBeNull();
    });

    it('should handle shellper-backed sessions', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid, shellper_socket, shellper_pid, shellper_start_time)
        VALUES ('term-1', '/project', 'architect', NULL, '/tmp/shellper-1.sock', 12345, 1700000000)
      `).run();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('term-1') as {
        pid: number | null;
        shellper_socket: string | null;
        shellper_pid: number | null;
        shellper_start_time: number | null;
      };
      expect(row.pid).toBeNull();
      expect(row.shellper_socket).toBe('/tmp/shellper-1.sock');
      expect(row.shellper_pid).toBe(12345);
      expect(row.shellper_start_time).toBe(1700000000);
    });
  });

  describe('path normalization', () => {
    it('should handle different path representations for same project', () => {
      // Simulate: architect saved with resolved path, shell with raw path
      const resolvedPath = '/Users/test/project';
      const rawPath = '/Users/test/./project'; // Non-normalized

      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid)
        VALUES ('arch-1', ?, 'architect', 1001)
      `).run(resolvedPath);

      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, role_id, pid)
        VALUES ('shell-1', ?, 'shell', 'shell-1', 1002)
      `).run(rawPath);

      // Query by resolved path only finds architect
      const byResolved = db.prepare('SELECT * FROM terminal_sessions WHERE project_path = ?')
        .all(resolvedPath);
      expect(byResolved).toHaveLength(1);

      // This demonstrates the problem that our fix addresses:
      // Deleting by one path variant leaves the other
      db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(resolvedPath);

      const remaining = db.prepare('SELECT * FROM terminal_sessions').all();
      expect(remaining).toHaveLength(1);

      // Our fix: delete by both paths to handle inconsistencies
      db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(rawPath);
      const afterBothDeletes = db.prepare('SELECT * FROM terminal_sessions').all();
      expect(afterBothDeletes).toHaveLength(0);
    });
  });

  describe('race condition scenarios', () => {
    it('should demonstrate INSERT after DELETE race (zombie row)', () => {
      // Scenario: Stop races with shell creation
      // 1. Shell creation starts (not yet saved)
      // 2. Stop handler runs: DELETE all sessions for project
      // 3. Shell creation completes: INSERT new session
      // Result: Zombie row exists after project was stopped

      const projectPath = '/project-a';

      // Initial state: project has architect
      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid)
        VALUES ('arch-1', ?, 'architect', 1001)
      `).run(projectPath);

      // Step 2: Stop handler runs
      db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(projectPath);

      // Step 3: Shell creation completes (INSERT after DELETE)
      db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, role_id, pid)
        VALUES ('shell-1', ?, 'shell', 'shell-1', 1002)
      `).run(projectPath);

      // Result: zombie row
      const remaining = db.prepare('SELECT * FROM terminal_sessions').all();
      expect(remaining).toHaveLength(1);

      // This is the problem our race guard fixes by checking
      // if project is still active before saving
    });
  });

  describe('destructive reconciliation', () => {
    it('should clean up all rows during reconciliation (fresh start)', () => {
      // Insert sessions that survived a crash
      const stmt = db.prepare(`
        INSERT INTO terminal_sessions (id, project_path, type, pid, shellper_socket)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run('arch-1', '/project-a', 'architect', 1001, '/tmp/shellper-a.sock');
      stmt.run('shell-1', '/project-a', 'shell', 1002, null);
      stmt.run('arch-2', '/project-b', 'architect', 2001, '/tmp/shellper-b.sock');

      expect(db.prepare('SELECT COUNT(*) as count FROM terminal_sessions').get())
        .toEqual({ count: 3 });

      // Destructive reconciliation: delete ALL rows (fresh start)
      // This is what our updated reconcileTerminalSessions() does
      const sessions = db.prepare('SELECT * FROM terminal_sessions').all() as Array<{ id: string }>;
      for (const session of sessions) {
        db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(session.id);
      }

      expect(db.prepare('SELECT COUNT(*) as count FROM terminal_sessions').get())
        .toEqual({ count: 0 });
    });
  });
});
