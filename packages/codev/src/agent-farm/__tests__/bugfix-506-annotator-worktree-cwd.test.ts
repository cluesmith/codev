/**
 * Regression test for bugfix #506: af open / annotator resolves builder file
 * paths against main workspace instead of worktree.
 *
 * Root cause: The terminal_sessions table did not store the session's cwd.
 * After Tower restart, reconciliation recreated PtySession objects using
 * workspace_path (main repo root) instead of the original cwd (worktree path
 * for builders). File links clicked in a builder terminal resolved relative
 * paths against the wrong root, producing ENOENT.
 *
 * Fix: Add a `cwd` column to terminal_sessions. Persist the actual working
 * directory when saving sessions. Use it during reconciliation and on-the-fly
 * reconnection, falling back to workspace_path for pre-migration rows.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// ============================================================================
// Test 1: Schema includes cwd column
// ============================================================================

describe('Bugfix #506: cwd column in terminal_sessions', () => {
  it('schema.ts should define cwd column on terminal_sessions', () => {
    const schemaSrc = readFileSync(
      resolve(import.meta.dirname, '../db/schema.ts'),
      'utf-8',
    );
    // The cwd column must exist in the CREATE TABLE terminal_sessions block
    const terminalSessionsBlock = schemaSrc.slice(
      schemaSrc.indexOf('CREATE TABLE IF NOT EXISTS terminal_sessions'),
      schemaSrc.indexOf(');', schemaSrc.indexOf('CREATE TABLE IF NOT EXISTS terminal_sessions')),
    );
    expect(terminalSessionsBlock).toContain('cwd TEXT');
  });

  it('migration v12 should add cwd column', () => {
    const dbSrc = readFileSync(
      resolve(import.meta.dirname, '../db/index.ts'),
      'utf-8',
    );
    expect(dbSrc).toContain('Migration v12');
    expect(dbSrc).toContain('ALTER TABLE terminal_sessions ADD COLUMN cwd TEXT');
  });
});

// ============================================================================
// Test 2: DbTerminalSession type includes cwd
// ============================================================================

describe('Bugfix #506: DbTerminalSession.cwd', () => {
  it('tower-types.ts should include cwd field in DbTerminalSession', () => {
    const typesSrc = readFileSync(
      resolve(import.meta.dirname, '../servers/tower-types.ts'),
      'utf-8',
    );
    const dbTermBlock = typesSrc.slice(
      typesSrc.indexOf('interface DbTerminalSession'),
      typesSrc.indexOf('}', typesSrc.indexOf('interface DbTerminalSession')),
    );
    expect(dbTermBlock).toContain('cwd:');
  });
});

// ============================================================================
// Test 3: saveTerminalSession persists cwd
// ============================================================================

describe('Bugfix #506: saveTerminalSession stores cwd', () => {
  it('INSERT statement should include cwd column', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../servers/tower-terminals.ts'),
      'utf-8',
    );
    // Find the INSERT in saveTerminalSession
    const fnStart = src.indexOf('export function saveTerminalSession');
    const fnEnd = src.indexOf('\n}', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('cwd');
    // The VALUES placeholder count should include cwd (10 params)
    expect(fnBody).toMatch(/VALUES\s*\(\?\s*(?:,\s*\?){9}\)/);
  });
});

// ============================================================================
// Test 4: Reconciliation uses stored cwd, not workspace_path
// ============================================================================

describe('Bugfix #506: reconciliation uses dbSession.cwd', () => {
  it('reconcileTerminalSessions should use dbSession.cwd for createSessionRaw', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../servers/tower-terminals.ts'),
      'utf-8',
    );
    // The reconciliation code should use dbSession.cwd with fallback
    expect(src).toContain('dbSession.cwd ?? workspacePath');
  });

  it('on-the-fly reconnection should use dbSession.cwd for createSessionRaw', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../servers/tower-terminals.ts'),
      'utf-8',
    );
    // The on-the-fly reconnection code should use dbSession.cwd with fallback
    expect(src).toContain('dbSession.cwd ?? dbSession.workspace_path');
  });
});

// ============================================================================
// Test 5: Terminal creation passes cwd to saveTerminalSession
// ============================================================================

describe('Bugfix #506: terminal creation passes cwd', () => {
  it('handleTerminalCreate should pass cwd to saveTerminalSession', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../servers/tower-routes.ts'),
      'utf-8',
    );
    // Find the handleTerminalCreate function
    const fnStart = src.indexOf('async function handleTerminalCreate');
    const fnEnd = src.indexOf('\nasync function', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd);
    // Both shellper and fallback paths should pass cwd
    const saveCalls = fnBody.match(/saveTerminalSession\([^)]+\)/g) ?? [];
    expect(saveCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of saveCalls) {
      expect(call).toContain('cwd');
    }
  });
});
