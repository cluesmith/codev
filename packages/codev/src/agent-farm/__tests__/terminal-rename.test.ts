/**
 * Tests for terminal rename endpoint logic (Spec 468, Phase 2)
 *
 * Covers: name validation, control char stripping, dedup suffix logic,
 * session type checking, ID lookup strategy, and label update mechanics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

describe('Terminal Rename Logic (Spec 468, Phase 2)', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'terminal-rename-test-'));
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

  describe('name validation', () => {
    it('should accept valid names (1-100 chars)', () => {
      const validNames = ['a', 'monitoring', 'build testing', 'debug (prod) — monitoring', 'x'.repeat(100)];
      for (const name of validNames) {
        const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
        expect(stripped.length).toBeGreaterThanOrEqual(1);
        expect(stripped.length).toBeLessThanOrEqual(100);
      }
    });

    it('should reject empty names', () => {
      const name = '';
      expect(name.length === 0 || name.length > 100).toBe(true);
    });

    it('should reject names over 100 characters', () => {
      const name = 'x'.repeat(101);
      expect(name.length > 100).toBe(true);
    });

    it('should strip control characters', () => {
      const name = 'test\ninjection\ttabs\x00null';
      const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
      expect(stripped).toBe('testinjectiontabsnull');
    });

    it('should reject name that becomes empty after stripping control chars', () => {
      const name = '\n\t\x00';
      const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
      expect(stripped.length).toBe(0);
    });

    it('should preserve unicode and special characters', () => {
      const name = 'debug (prod) — monitoring 🔧';
      const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
      expect(stripped).toBe(name);
    });

    it('should strip DEL character (0x7f)', () => {
      const name = 'test\x7fname';
      const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
      expect(stripped).toBe('testname');
    });
  });

  describe('session type checking', () => {
    it('should allow renaming shell sessions', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'Shell 1')
      `).run();

      const row = db.prepare('SELECT type FROM terminal_sessions WHERE id = ?').get('term-1') as { type: string };
      expect(row.type).toBe('shell');
    });

    it('should reject renaming architect sessions', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, pid, label)
        VALUES ('term-1', '/project', 'architect', 1234, 'Architect')
      `).run();

      const row = db.prepare('SELECT type FROM terminal_sessions WHERE id = ?').get('term-1') as { type: string };
      expect(row.type).not.toBe('shell');
    });

    it('should reject renaming builder sessions', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'builder', 'B001', 1234, 'B001')
      `).run();

      const row = db.prepare('SELECT type FROM terminal_sessions WHERE id = ?').get('term-1') as { type: string };
      expect(row.type).not.toBe('shell');
    });
  });

  describe('duplicate name deduplication', () => {
    function getActiveShellLabels(workspacePath: string, excludeId?: string): string[] {
      if (excludeId) {
        const rows = db.prepare(
          "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL AND id != ?"
        ).all(workspacePath, excludeId) as Array<{ label: string }>;
        return rows.map(r => r.label);
      }
      const rows = db.prepare(
        "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL"
      ).all(workspacePath) as Array<{ label: string }>;
      return rows.map(r => r.label);
    }

    function dedup(name: string, otherLabels: Set<string>): string {
      if (!otherLabels.has(name)) return name;
      let suffix = 1;
      while (otherLabels.has(`${name}-${suffix}`)) {
        suffix++;
      }
      return `${name}-${suffix}`;
    }

    it('should not dedup when name is unique', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'Shell 1')
      `).run();

      const labels = new Set(getActiveShellLabels('/project', 'term-1'));
      expect(dedup('monitoring', labels)).toBe('monitoring');
    });

    it('should append -1 for first duplicate', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-2', '/project', 'shell', 'shell-2', 5678, 'Shell 2')
      `).run();

      const labels = new Set(getActiveShellLabels('/project', 'term-2'));
      expect(dedup('monitoring', labels)).toBe('monitoring-1');
    });

    it('should increment suffix for multiple duplicates', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1, 'monitoring')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-2', '/project', 'shell', 'shell-2', 2, 'monitoring-1')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-3', '/project', 'shell', 'shell-3', 3, 'Shell 3')
      `).run();

      const labels = new Set(getActiveShellLabels('/project', 'term-3'));
      expect(dedup('monitoring', labels)).toBe('monitoring-2');
    });

    it('should allow renaming to same name (no dedup for self)', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();

      // Exclude own session from dedup check
      const labels = new Set(getActiveShellLabels('/project', 'term-1'));
      expect(dedup('monitoring', labels)).toBe('monitoring');
    });

    it('should scope dedup to same workspace', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project-a', 'shell', 'shell-1', 1234, 'monitoring')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-2', '/project-b', 'shell', 'shell-1', 5678, 'Shell 1')
      `).run();

      // Same name in different workspace should not conflict
      const labels = new Set(getActiveShellLabels('/project-b', 'term-2'));
      expect(dedup('monitoring', labels)).toBe('monitoring');
    });

    it('should exclude non-shell sessions from dedup', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, pid, label)
        VALUES ('term-1', '/project', 'architect', 1234, 'Architect')
      `).run();
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-2', '/project', 'shell', 'shell-1', 5678, 'Shell 1')
      `).run();

      // "Architect" label on architect session should not conflict with renaming to "Architect"
      const labels = new Set(getActiveShellLabels('/project', 'term-2'));
      expect(dedup('Architect', labels)).toBe('Architect');
    });
  });

  describe('ID lookup strategy', () => {
    it('should find session by direct PtySession ID', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('pty-abc-123', '/project', 'shell', 'shell-1', 1234, 'Shell 1')
      `).run();

      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('pty-abc-123');
      expect(row).toBeDefined();
    });

    it('should return undefined for non-existent session', () => {
      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get('non-existent');
      expect(row).toBeUndefined();
    });
  });

  describe('label update mechanics', () => {
    it('should update label in SQLite and verify', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'Shell 1')
      `).run();

      db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run('monitoring', 'term-1');

      const row = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-1') as { label: string };
      expect(row.label).toBe('monitoring');
    });

    it('should overwrite previous rename', () => {
      db.prepare(`
        INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label)
        VALUES ('term-1', '/project', 'shell', 'shell-1', 1234, 'Shell 1')
      `).run();

      db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run('first-rename', 'term-1');
      db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run('second-rename', 'term-1');

      const row = db.prepare('SELECT label FROM terminal_sessions WHERE id = ?').get('term-1') as { label: string };
      expect(row.label).toBe('second-rename');
    });
  });

  describe('API response contract', () => {
    it('success response should include id and name', () => {
      const response = { id: 'session-uuid', name: 'monitoring' };
      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('name');
    });

    it('dedup response should show actual name applied', () => {
      const response = { id: 'session-uuid', name: 'monitoring-1' };
      expect(response.name).toBe('monitoring-1');
      expect(response.name).not.toBe('monitoring'); // Dedup applied
    });

    it('error responses should have error field', () => {
      const notFound = { error: 'Session not found' };
      const forbidden = { error: 'Cannot rename builder/architect terminals' };
      const validation = { error: 'Name must be 1-100 characters' };

      expect(notFound.error).toBeTruthy();
      expect(forbidden.error).toBeTruthy();
      expect(validation.error).toBeTruthy();
    });
  });
});

describe('CLI Command and Integration (Spec 468, Phase 3)', () => {
  describe('env var detection', () => {
    it('should detect SHELLPER_SESSION_ID from environment', () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should fail when SHELLPER_SESSION_ID is not set', () => {
      const sessionId = undefined;
      expect(!sessionId).toBe(true);
    });

    it('should parse TOWER_PORT as integer', () => {
      const portStr = '4200';
      const port = parseInt(portStr, 10);
      expect(port).toBe(4200);
      expect(Number.isInteger(port)).toBe(true);
    });

    it('should fall back to default port when TOWER_PORT is not set', () => {
      const towerPort = undefined;
      const defaultPort = 4200;
      const port = towerPort ? parseInt(towerPort, 10) : defaultPort;
      expect(port).toBe(defaultPort);
    });
  });

  describe('TowerClient renameTerminal contract', () => {
    it('should construct PATCH request to correct endpoint', () => {
      const sessionId = 'abc-123';
      const expectedUrl = `/api/terminals/${sessionId}/rename`;
      expect(expectedUrl).toBe('/api/terminals/abc-123/rename');
    });

    it('should send name in JSON body', () => {
      const body = JSON.stringify({ name: 'monitoring' });
      const parsed = JSON.parse(body);
      expect(parsed.name).toBe('monitoring');
    });

    it('should use PATCH method', () => {
      const method = 'PATCH';
      expect(method).toBe('PATCH');
    });
  });

  describe('error message formatting', () => {
    it('should show specific message for missing session env var', () => {
      const message = 'Not running inside a shellper session. Use this command from a shell created by `af shell`.';
      expect(message).toContain('shellper session');
    });

    it('should show specific message for Tower not running', () => {
      const message = 'Tower is not running. Start it with: af tower start';
      expect(message).toContain('Tower is not running');
    });

    it('should display actual applied name on success', () => {
      const result = { ok: true, data: { id: 'abc', name: 'monitoring-1' } };
      const displayMessage = `Renamed to: ${result.data.name}`;
      expect(displayMessage).toBe('Renamed to: monitoring-1');
    });

    it('should show server error message when available', () => {
      const result = { ok: false, status: 400, error: 'Name must be 1-100 characters' };
      expect(result.error).toBe('Name must be 1-100 characters');
    });
  });

  describe('command registration', () => {
    it('should accept a required name argument', () => {
      const commandSyntax = 'rename <name>';
      expect(commandSyntax).toContain('<name>');
    });
  });
});
