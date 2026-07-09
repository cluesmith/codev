/**
 * Tests for Claude session discovery via on-disk jsonl introspection.
 *
 * Issue #829 — conversation resume.
 * Issue #1145 — ownership verification: a candidate jsonl must record a cwd
 * matching the requested path before it may be offered for resume.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeClaudeProjectDir,
  findLatestSessionId,
  readSessionCwd,
  verifySessionOwnership,
} from '../utils/claude-session-discovery.js';

describe('encodeClaudeProjectDir', () => {
  it('replaces / with -', () => {
    expect(encodeClaudeProjectDir('/Users/x/repo')).toBe('-Users-x-repo');
  });

  it('replaces . with -', () => {
    expect(encodeClaudeProjectDir('/Users/x/repo/.builders/pir-1')).toBe(
      '-Users-x-repo--builders-pir-1',
    );
  });

  it('leaves dashes in the source path untouched', () => {
    expect(encodeClaudeProjectDir('/Users/x/repo/pir-1298')).toBe(
      '-Users-x-repo-pir-1298',
    );
  });

  it('handles paths with multiple dots and slashes', () => {
    expect(encodeClaudeProjectDir('/a/b.c/.d.e/f')).toBe('-a-b-c--d-e-f');
  });
});

describe('claude session discovery', () => {
  let fakeHome: string;
  let projectsRoot: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'csd-test-'));
    projectsRoot = join(fakeHome, '.claude', 'projects');
    mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  /**
   * Write a session jsonl shaped like the real store: leading metadata records
   * without a cwd, then a user record carrying the launch cwd. `recordedCwd`
   * defaults to the path the store dir is keyed by; pass a different value to
   * simulate an encoding-collision foreign session, or null to simulate a
   * session that never got a user message.
   */
  function writeSession(
    absPath: string,
    uuid: string,
    mtime: number,
    recordedCwd: string | null = absPath,
  ): void {
    const dir = join(projectsRoot, encodeClaudeProjectDir(absPath));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${uuid}.jsonl`);
    const lines = [
      `{"type":"mode","mode":"default","sessionId":"${uuid}"}`,
      '{"type":"file-history-snapshot"}',
    ];
    if (recordedCwd !== null) {
      lines.push(`{"type":"user","cwd":"${recordedCwd}","sessionId":"${uuid}"}`);
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    const t = mtime / 1000;
    utimesSync(file, t, t);
  }

  describe('findLatestSessionId', () => {
    it('returns the newest session UUID by mtime', () => {
      const worktree = '/Users/x/repo/.builders/pir-1';
      writeSession(worktree, 'old-uuid', 1_000_000_000_000);
      writeSession(worktree, 'newest-uuid', 1_700_000_000_000);
      writeSession(worktree, 'middle-uuid', 1_400_000_000_000);
      expect(findLatestSessionId(worktree, { homeDir: fakeHome })).toBe('newest-uuid');
    });

    it('returns null when the project dir does not exist', () => {
      expect(findLatestSessionId('/nonexistent/path', { homeDir: fakeHome })).toBeNull();
    });

    it('returns null when the project dir exists but contains no jsonl files', () => {
      const worktree = '/Users/x/repo/.builders/pir-2';
      const dir = join(projectsRoot, encodeClaudeProjectDir(worktree));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'memory'), 'not a jsonl', 'utf-8');
      expect(findLatestSessionId(worktree, { homeDir: fakeHome })).toBeNull();
    });

    it('ignores non-jsonl files and subdirectories', () => {
      const worktree = '/Users/x/repo/.builders/pir-3';
      const dir = join(projectsRoot, encodeClaudeProjectDir(worktree));
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(dir, 'some-uuid'), { recursive: true });
      writeFileSync(join(dir, 'history.txt'), 'text', 'utf-8');
      writeSession(worktree, 'the-uuid', 1_500_000_000_000);
      expect(findLatestSessionId(worktree, { homeDir: fakeHome })).toBe('the-uuid');
    });

    it('returns the single jsonl when only one exists', () => {
      const worktree = '/Users/x/repo/.builders/pir-4';
      writeSession(worktree, 'only-uuid', 1_500_000_000_000);
      expect(findLatestSessionId(worktree, { homeDir: fakeHome })).toBe('only-uuid');
    });

    // Issue #1145: ownership verification.

    it('skips a newer jsonl whose recorded cwd is a different path (encoding collision)', () => {
      // '/x/foo.bar' and '/x/foo/bar' both encode to '-x-foo-bar'.
      const requested = '/x/foo/bar';
      const collider = '/x/foo.bar';
      writeSession(requested, 'ours-uuid', 1_400_000_000_000);
      writeSession(requested, 'foreign-uuid', 1_700_000_000_000, collider);
      expect(findLatestSessionId(requested, { homeDir: fakeHome })).toBe('ours-uuid');
    });

    it('returns null when the only candidates belong to a different path', () => {
      const requested = '/x/foo/bar';
      writeSession(requested, 'foreign-uuid', 1_700_000_000_000, '/x/foo.bar');
      expect(findLatestSessionId(requested, { homeDir: fakeHome })).toBeNull();
    });

    it('skips a jsonl that never recorded a cwd (no user message)', () => {
      const worktree = '/Users/x/repo/.builders/pir-5';
      writeSession(worktree, 'empty-uuid', 1_700_000_000_000, null);
      writeSession(worktree, 'real-uuid', 1_400_000_000_000);
      expect(findLatestSessionId(worktree, { homeDir: fakeHome })).toBe('real-uuid');
    });
  });

  describe('readSessionCwd', () => {
    it('returns the cwd from the first record that carries one', () => {
      const worktree = '/Users/x/repo/.builders/pir-6';
      writeSession(worktree, 'uuid-6', 1_500_000_000_000);
      const file = join(projectsRoot, encodeClaudeProjectDir(worktree), 'uuid-6.jsonl');
      expect(readSessionCwd(file)).toBe(worktree);
    });

    it('returns null for a cwd-less session', () => {
      const worktree = '/Users/x/repo/.builders/pir-7';
      writeSession(worktree, 'uuid-7', 1_500_000_000_000, null);
      const file = join(projectsRoot, encodeClaudeProjectDir(worktree), 'uuid-7.jsonl');
      expect(readSessionCwd(file)).toBeNull();
    });

    it('returns null for a missing file', () => {
      expect(readSessionCwd(join(fakeHome, 'nope.jsonl'))).toBeNull();
    });
  });

  describe('verifySessionOwnership', () => {
    it('accepts a session whose jsonl exists and records the same cwd', () => {
      const worktree = '/Users/x/repo/ws-1';
      writeSession(worktree, 'owned-uuid', 1_500_000_000_000);
      expect(verifySessionOwnership(worktree, 'owned-uuid', { homeDir: fakeHome })).toBe(true);
    });

    it('rejects a session id with no jsonl on disk (stale stored id)', () => {
      const worktree = '/Users/x/repo/ws-2';
      mkdirSync(join(projectsRoot, encodeClaudeProjectDir(worktree)), { recursive: true });
      expect(verifySessionOwnership(worktree, 'gone-uuid', { homeDir: fakeHome })).toBe(false);
    });

    it('rejects a session whose recorded cwd is a different path', () => {
      const requested = '/x/foo/bar';
      writeSession(requested, 'foreign-uuid', 1_500_000_000_000, '/x/foo.bar');
      expect(verifySessionOwnership(requested, 'foreign-uuid', { homeDir: fakeHome })).toBe(false);
    });

    it('rejects a session that never recorded a cwd', () => {
      const worktree = '/Users/x/repo/ws-3';
      writeSession(worktree, 'empty-uuid', 1_500_000_000_000, null);
      expect(verifySessionOwnership(worktree, 'empty-uuid', { homeDir: fakeHome })).toBe(false);
    });
  });
});

// Issue #832 introduced the stored-UUID spawn/revive path for architects;
// Issue #1145 removed the architect-side jsonl-discovery fallback entirely.
// findLatestSessionId (above) now serves builder resume only.
