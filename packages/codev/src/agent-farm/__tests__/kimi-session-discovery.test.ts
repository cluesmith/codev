/**
 * Tests for Kimi session discovery via on-disk store introspection.
 *
 * Issue #1201 — Kimi Code CLI as a builder. The store layout is UNDOCUMENTED
 * (observed on kimi 0.27.0):
 *   <kimi-home>/sessions/wd_<hash>/session_<uuid>/state.json
 * with state.json carrying { workDir, updatedAt, lastPrompt }. Every function
 * is fail-soft: malformed fixtures must yield null/false, never a throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getKimiHome,
  findLatestKimiSessionId,
  verifyKimiSessionOwnership,
  readKimiSessionState,
  kimiStoreLayoutLooksDrifted,
} from '../utils/kimi-session-discovery.js';

describe('kimi session discovery', () => {
  let kimiHome: string;
  const opts = () => ({ kimiHome });

  beforeEach(() => {
    kimiHome = mkdtempSync(join(tmpdir(), 'kimi-store-'));
  });

  afterEach(() => {
    rmSync(kimiHome, { recursive: true, force: true });
  });

  function writeSession(
    sessionId: string,
    state: Record<string, unknown> | string,
    wdDir = 'wd_worktree_abc123def456',
  ): string {
    const dir = join(kimiHome, 'sessions', wdDir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      typeof state === 'string' ? state : JSON.stringify(state),
      'utf-8',
    );
    return dir;
  }

  describe('getKimiHome', () => {
    it('prefers the explicit kimiHome opt', () => {
      expect(getKimiHome({ kimiHome: '/x/y' })).toBe('/x/y');
    });

    it('falls back to KIMI_CODE_HOME env (documented seam)', () => {
      const original = process.env.KIMI_CODE_HOME;
      process.env.KIMI_CODE_HOME = '/env/kimi';
      try {
        expect(getKimiHome()).toBe('/env/kimi');
      } finally {
        if (original === undefined) delete process.env.KIMI_CODE_HOME;
        else process.env.KIMI_CODE_HOME = original;
      }
    });
  });

  describe('findLatestKimiSessionId', () => {
    it('returns null on a missing store', () => {
      expect(findLatestKimiSessionId('/some/worktree', opts())).toBeNull();
    });

    it('returns null when no session matches the workDir', () => {
      writeSession('session_aaa', { workDir: '/other/dir', updatedAt: '2026-07-18T10:00:00Z' });
      expect(findLatestKimiSessionId('/some/worktree', opts())).toBeNull();
    });

    it('returns the exact-workDir match', () => {
      writeSession('session_aaa', { workDir: '/some/worktree', updatedAt: '2026-07-18T10:00:00Z' });
      writeSession('session_bbb', { workDir: '/other/dir', updatedAt: '2026-07-18T12:00:00Z' });
      expect(findLatestKimiSessionId('/some/worktree', opts())).toBe('session_aaa');
    });

    it('picks the newest by updatedAt among matches (across wd dirs)', () => {
      writeSession('session_old', { workDir: '/wt', updatedAt: '2026-07-18T09:00:00Z' }, 'wd_a_111111111111');
      writeSession('session_new', { workDir: '/wt', updatedAt: '2026-07-18T11:00:00Z' }, 'wd_b_222222222222');
      writeSession('session_mid', { workDir: '/wt', updatedAt: '2026-07-18T10:00:00Z' }, 'wd_a_111111111111');
      expect(findLatestKimiSessionId('/wt', opts())).toBe('session_new');
    });

    it('ranks sessions with a malformed updatedAt below parseable ones, but still returns a lone one', () => {
      writeSession('session_broken-ts', { workDir: '/wt', updatedAt: 'not-a-date' });
      expect(findLatestKimiSessionId('/wt', opts())).toBe('session_broken-ts');
      writeSession('session_good', { workDir: '/wt', updatedAt: '2026-07-18T10:00:00Z' });
      expect(findLatestKimiSessionId('/wt', opts())).toBe('session_good');
    });

    it('skips sessions with malformed state.json without throwing', () => {
      writeSession('session_garbage', 'not json at all {');
      writeSession('session_ok', { workDir: '/wt', updatedAt: '2026-07-18T10:00:00Z' });
      expect(findLatestKimiSessionId('/wt', opts())).toBe('session_ok');
    });

    it('matches workDir through a symlinked worktree path (realpath tolerance)', () => {
      const realDir = mkdtempSync(join(tmpdir(), 'kimi-real-'));
      const linkPath = join(kimiHome, 'link-to-real');
      symlinkSync(realDir, linkPath);
      try {
        // Kimi recorded the physical path; the caller asks with the logical one.
        writeSession('session_sym', { workDir: realDir, updatedAt: '2026-07-18T10:00:00Z' });
        expect(findLatestKimiSessionId(linkPath, opts())).toBe('session_sym');
      } finally {
        rmSync(realDir, { recursive: true, force: true });
      }
    });
  });

  describe('verifyKimiSessionOwnership', () => {
    it('true for a session whose workDir matches exactly', () => {
      writeSession('session_mine', { workDir: '/wt' });
      expect(verifyKimiSessionOwnership('session_mine', '/wt', opts())).toBe(true);
    });

    it('false on workDir mismatch (session belongs to another directory)', () => {
      writeSession('session_other', { workDir: '/somewhere/else' });
      expect(verifyKimiSessionOwnership('session_other', '/wt', opts())).toBe(false);
    });

    it('false when the session dir is missing (store GC / manual deletion)', () => {
      expect(verifyKimiSessionOwnership('session_gone', '/wt', opts())).toBe(false);
    });

    it('false on malformed state.json', () => {
      writeSession('session_bad', '{{{');
      expect(verifyKimiSessionOwnership('session_bad', '/wt', opts())).toBe(false);
    });

    it('false for an empty session id', () => {
      expect(verifyKimiSessionOwnership('', '/wt', opts())).toBe(false);
    });
  });

  describe('readKimiSessionState', () => {
    it('returns workDir/updatedAt/lastPrompt for a valid session', () => {
      writeSession('session_full', {
        workDir: '/wt',
        updatedAt: '2026-07-18T10:00:00Z',
        lastPrompt: 'BEGIN',
      });
      expect(readKimiSessionState('session_full', opts())).toEqual({
        workDir: '/wt',
        updatedAt: '2026-07-18T10:00:00Z',
        lastPrompt: 'BEGIN',
      });
    });

    it('nulls optional fields that are absent', () => {
      writeSession('session_sparse', { workDir: '/wt' });
      expect(readKimiSessionState('session_sparse', opts())).toEqual({
        workDir: '/wt',
        updatedAt: null,
        lastPrompt: null,
      });
    });

    it('returns null for a missing session or malformed state', () => {
      expect(readKimiSessionState('session_missing', opts())).toBeNull();
      writeSession('session_junk', 'nope');
      expect(readKimiSessionState('session_junk', opts())).toBeNull();
    });
  });

  describe('kimiStoreLayoutLooksDrifted (doctor smoke probe)', () => {
    it('false when the store does not exist (fresh install is not drift)', () => {
      expect(kimiStoreLayoutLooksDrifted(opts())).toBe(false);
    });

    it('false when at least one session parses', () => {
      writeSession('session_ok', { workDir: '/wt' });
      writeSession('session_bad', '###');
      expect(kimiStoreLayoutLooksDrifted(opts())).toBe(false);
    });

    it('true when session dirs exist but none parse (layout drift)', () => {
      writeSession('session_bad1', '###');
      writeSession('session_bad2', { noWorkDirKey: true });
      expect(kimiStoreLayoutLooksDrifted(opts())).toBe(true);
    });
  });
});
