/**
 * Tests for Claude session discovery via on-disk jsonl introspection.
 *
 * Issue #829 — conversation resume.
 * Issue #1145 — verifySessionOwnership: a stored session id is only resumable
 * while its jsonl still exists for the workspace's cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeClaudeProjectDir,
  findLatestSessionId,
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

  function writeSession(absPath: string, uuid: string, mtime: number): void {
    const dir = join(projectsRoot, encodeClaudeProjectDir(absPath));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${uuid}.jsonl`);
    writeFileSync(file, `{"sessionId":"${uuid}"}\n`, 'utf-8');
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
  });

  describe('verifySessionOwnership (Issue #1145)', () => {
    it('accepts a session whose jsonl exists for the workspace cwd', () => {
      const worktree = '/Users/x/repo/ws-1';
      writeSession(worktree, 'owned-uuid', 1_500_000_000_000);
      expect(verifySessionOwnership(worktree, 'owned-uuid', { homeDir: fakeHome })).toBe(true);
    });

    it('rejects a session id with no jsonl on disk (stale stored id)', () => {
      const worktree = '/Users/x/repo/ws-2';
      mkdirSync(join(projectsRoot, encodeClaudeProjectDir(worktree)), { recursive: true });
      expect(verifySessionOwnership(worktree, 'gone-uuid', { homeDir: fakeHome })).toBe(false);
    });

    it('rejects a session id whose jsonl lives under a different cwd', () => {
      const worktree = '/Users/x/repo/ws-3';
      writeSession('/Users/x/repo/other-ws', 'other-uuid', 1_500_000_000_000);
      expect(verifySessionOwnership(worktree, 'other-uuid', { homeDir: fakeHome })).toBe(false);
    });

    it('accepts a session stored under the physical form of a symlinked cwd', () => {
      // macOS: os.tmpdir() is /var/... which is a symlink to /private/var/....
      // Claude keys the store by its process cwd (physical form); the caller
      // may hold the logical form. Both must verify.
      const logicalDir = mkdtempSync(join(tmpdir(), 'csd-sym-'));
      try {
        const physicalDir = realpathSync(logicalDir);
        writeSession(physicalDir, 'sym-uuid', 1_500_000_000_000);
        expect(verifySessionOwnership(logicalDir, 'sym-uuid', { homeDir: fakeHome })).toBe(true);
      } finally {
        rmSync(logicalDir, { recursive: true, force: true });
      }
    });
  });
});

// Issue #832 introduced the stored-UUID spawn/revive path for architects;
// Issue #1145 removed the architect-side jsonl-discovery fallback entirely.
// findLatestSessionId (above) now serves builder resume only.
