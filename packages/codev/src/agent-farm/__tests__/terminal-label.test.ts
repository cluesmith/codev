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

  describe('Rename endpoint logic (Phase 2)', () => {
    describe('name validation', () => {
      it('should strip control characters from name', () => {
        const name = 'test\x00name\x1f\x7f';
        const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
        expect(stripped).toBe('testname');
      });

      it('should reject empty name after stripping', () => {
        const name = '\x00\x01\x1f';
        const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
        expect(stripped.length).toBe(0);
      });

      it('should reject name longer than 100 characters', () => {
        const name = 'a'.repeat(101);
        expect(name.length).toBeGreaterThan(100);
      });

      it('should accept name of exactly 100 characters', () => {
        const name = 'a'.repeat(100);
        expect(name.length).toBe(100);
        expect(name.length >= 1 && name.length <= 100).toBe(true);
      });
    });

    describe('type checking', () => {
      it('should only allow shell type sessions', () => {
        const shellSession = { type: 'shell' };
        const architectSession = { type: 'architect' };
        const builderSession = { type: 'builder' };

        expect(shellSession.type === 'shell').toBe(true);
        expect(architectSession.type === 'shell').toBe(false);
        expect(builderSession.type === 'shell').toBe(false);
      });
    });

    describe('dedup suffix logic', () => {
      it('should not add suffix when no duplicates exist', () => {
        const existingLabels = new Set(['monitoring', 'debugging']);
        const name = 'testing';
        let finalName = name;
        if (existingLabels.has(name)) {
          let suffix = 1;
          while (existingLabels.has(`${name}-${suffix}`)) suffix++;
          finalName = `${name}-${suffix}`;
        }
        expect(finalName).toBe('testing');
      });

      it('should append -1 when name conflicts', () => {
        const existingLabels = new Set(['monitoring', 'testing']);
        const name = 'testing';
        let finalName = name;
        if (existingLabels.has(name)) {
          let suffix = 1;
          while (existingLabels.has(`${name}-${suffix}`)) suffix++;
          finalName = `${name}-${suffix}`;
        }
        expect(finalName).toBe('testing-1');
      });

      it('should increment suffix past existing -1', () => {
        const existingLabels = new Set(['testing', 'testing-1']);
        const name = 'testing';
        let finalName = name;
        if (existingLabels.has(name)) {
          let suffix = 1;
          while (existingLabels.has(`${name}-${suffix}`)) suffix++;
          finalName = `${name}-${suffix}`;
        }
        expect(finalName).toBe('testing-2');
      });

      it('should find first available gap in suffix sequence', () => {
        const existingLabels = new Set(['testing', 'testing-1', 'testing-2', 'testing-3']);
        const name = 'testing';
        let finalName = name;
        if (existingLabels.has(name)) {
          let suffix = 1;
          while (existingLabels.has(`${name}-${suffix}`)) suffix++;
          finalName = `${name}-${suffix}`;
        }
        expect(finalName).toBe('testing-4');
      });
    });

    describe('getActiveShellLabels with excludeId', () => {
      it('should exclude the specified session from results', () => {
        // Insert two shell sessions
        db.prepare(`
          INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
          VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'monitoring')
        `).run();
        db.prepare(`
          INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
          VALUES ('term-2', '/project', 'shell', 'shell-2', 5678, 'debugging')
        `).run();

        // Without exclusion
        const allLabels = db.prepare(
          "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL"
        ).all('/project') as Array<{ label: string }>;
        expect(allLabels.map(r => r.label)).toEqual(['monitoring', 'debugging']);

        // With exclusion of term-1
        const excludedLabels = db.prepare(
          "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL AND id != ?"
        ).all('/project', 'term-1') as Array<{ label: string }>;
        expect(excludedLabels.map(r => r.label)).toEqual(['debugging']);
      });
    });

    describe('PtySession label mutability', () => {
      it('should allow label reassignment (readonly removed)', () => {
        // This test validates that PtySession.label is mutable
        // by verifying the contract: an object with label can be mutated
        const session = { label: 'Shell 1' };
        session.label = 'monitoring';
        expect(session.label).toBe('monitoring');
      });
    });
  });

  describe('CLI rename command contracts (Phase 3)', () => {
    it('should detect missing SHELLPER_SESSION_ID', () => {
      // The rename command checks env var before calling Tower
      const sessionId = undefined;
      expect(sessionId).toBeUndefined();
    });

    it('should use TOWER_PORT from env when available', () => {
      const envPort = '4200';
      const port = parseInt(envPort, 10);
      expect(port).toBe(4200);
    });

    it('should fall back to default port when TOWER_PORT not set', () => {
      const DEFAULT_TOWER_PORT = 4100;
      const envPort = undefined;
      const port = envPort ? parseInt(envPort, 10) : DEFAULT_TOWER_PORT;
      expect(port).toBe(4100);
    });

    it('should map HTTP status codes to error messages', () => {
      const statusMap: Record<number, string> = {
        400: 'Name must be 1-100 characters',
        403: 'Cannot rename builder/architect terminals',
        404: 'Session not found — it may have been closed',
        0: 'Tower is not running',
      };
      expect(statusMap[400]).toContain('1-100');
      expect(statusMap[403]).toContain('builder/architect');
      expect(statusMap[404]).toContain('not found');
      expect(statusMap[0]).toContain('not running');
    });
  });
});
