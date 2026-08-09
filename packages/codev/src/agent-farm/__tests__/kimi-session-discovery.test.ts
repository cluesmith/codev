/**
 * Tests for Kimi session discovery via on-disk store introspection.
 *
 * Issue #1201 — Kimi Code CLI as a builder. Two UNDOCUMENTED surfaces, both
 * observed on kimi 0.34.0:
 *   <kimi-home>/sessions/wd_<hash>/session_<uuid>/state.json
 *     v2 (0.33.0+): { id, version: 2, cwd, createdAt, updatedAt, … }
 *     v1 (≤ 0.32):  { workDir, updatedAt (ISO), lastPrompt?, … }
 *   <kimi-home>/workspace-trust/wd_<basename>_<sha256(root)[:12]> → { root, trustedAt }
 *
 * Every function is fail-soft: malformed fixtures must yield null/empty, never a
 * throw, because all of this is read on the spawn path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  getKimiHome,
  findLatestKimiSessionId,
  verifyKimiSessionOwnership,
  readKimiSessionState,
  inspectKimiStoreLayout,
  inspectKimiTrustLayout,
  kimiTrustRecordPath,
  ensureKimiWorkspaceTrust,
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

    // Existing on disk is not the question — "would `kimi -c` continue it?" is.
    // Kimi's cwd listing drops archived sessions and ids it does not recognize, and
    // `-c` with nothing to continue does not fail: it starts a fresh session that
    // never saw --agent-file, i.e. a silently roleless builder (#929 class).
    it('skips an ARCHIVED session — kimi would not continue it', () => {
      writeSession('session_archived', { cwd: '/wt', updatedAt: 5, archived: true });
      expect(findLatestKimiSessionId('/wt', opts())).toBeNull();
    });

    it('prefers a live session over a NEWER archived one', () => {
      writeSession('session_archived', { cwd: '/wt', updatedAt: 99, archived: true });
      writeSession('session_live', { cwd: '/wt', updatedAt: 1 });
      expect(findLatestKimiSessionId('/wt', opts())).toBe('session_live');
    });

    it('skips a directory kimi would not recognize as a session id', () => {
      writeSession('scratch-dir', { cwd: '/wt', updatedAt: 5 });
      expect(findLatestKimiSessionId('/wt', opts())).toBeNull();
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
    // Store v2 (kimi 0.33.0+, agent-core-v2): the working-directory field was renamed
    // `workDir` → `cwd`, timestamps became epoch-ms NUMBERS instead of ISO strings, and
    // `lastPrompt` was dropped entirely. Discovery normalizes all three.
    it('returns cwd/updatedAt/version for a v2 session (epoch-ms timestamps)', () => {
      writeSession('session_full', {
        id: 'session_full',
        version: 2,
        cwd: '/wt',
        updatedAt: 1_760_000_000_000,
      });
      expect(readKimiSessionState('session_full', opts())).toEqual({
        cwd: '/wt',
        updatedAt: 1_760_000_000_000,
        version: 2,
        archived: false,
      });
    });

    // Back-compat: a v1 store (kimi < 0.33.0) still reads, so an installed-but-not-yet
    // upgraded kimi keeps resuming instead of silently starting fresh, roleless sessions.
    it('accepts the v1 shape: workDir and an ISO timestamp, normalized to epoch ms', () => {
      writeSession('session_v1', { workDir: '/wt', updatedAt: '2026-07-18T10:00:00Z' });
      expect(readKimiSessionState('session_v1', opts())).toEqual({
        cwd: '/wt',
        updatedAt: Date.parse('2026-07-18T10:00:00Z'),
        version: null,
        archived: false,
      });
    });

    it('nulls optional fields that are absent', () => {
      writeSession('session_sparse', { cwd: '/wt' });
      expect(readKimiSessionState('session_sparse', opts())).toEqual({
        cwd: '/wt',
        updatedAt: null,
        version: null,
        archived: false,
      });
    });

    it('returns null for a missing session or malformed state', () => {
      expect(readKimiSessionState('session_missing', opts())).toBeNull();
      writeSession('session_junk', 'nope');
      expect(readKimiSessionState('session_junk', opts())).toBeNull();
    });
  });

  // Kimi ships weekly and has already renamed the store's working-directory field
  // once (`workDir` → `cwd`, 0.33.0), which silently nulled every parse. The probe
  // therefore asserts the load-bearing facts EXPLICITLY and names the first one that
  // broke, so `codev doctor` can say which assumption failed instead of "something
  // changed" — or, worse, degrade silently at spawn time.
  describe('inspectKimiStoreLayout (doctor smoke probe)', () => {
    it('empty when the store does not exist (fresh install is not drift)', () => {
      expect(inspectKimiStoreLayout(opts())).toEqual({ status: 'empty' });
    });

    it('ok when at least one session carries the load-bearing shape', () => {
      writeSession('session_ok', { cwd: '/wt' });
      writeSession('session_bad', '###');
      expect(inspectKimiStoreLayout(opts())).toEqual({ status: 'ok', sampled: 1 });
    });

    // The blind spot in "any session matches" (CMAP 2026-08-09, codex #5): after a
    // store migration the pre-migration sessions keep matching forever, so the probe
    // would report healthy through exactly the rename it was built to catch.
    /** Recency is the session directory's mtime; pin it so the ordering is explicit. */
    const touchDir = (dir: string, epochSeconds: number) => utimesSync(dir, epochSeconds, epochSeconds);

    it('reports drift when the NEWEST session stopped matching but older ones still do', () => {
      touchDir(writeSession('session_old', { cwd: '/wt' }), 1_000);
      touchDir(writeSession('session_new', { someRenamedField: '/wt' }), 9_000);
      const layout = inspectKimiStoreLayout(opts());
      expect(layout.status).toBe('drifted');
      expect(layout.status === 'drifted' && layout.reason).toMatch(/most recently written session/);
    });

    it('stays ok when the non-matching session is the OLDER one (a leftover, not a migration)', () => {
      touchDir(writeSession('session_old', { someRenamedField: '/wt' }), 1_000);
      touchDir(writeSession('session_new', { cwd: '/wt' }), 9_000);
      expect(inspectKimiStoreLayout(opts())).toEqual({ status: 'ok', sampled: 1 });
    });

    it('stays ok on a tie, so the verdict never depends on directory iteration order', () => {
      touchDir(writeSession('session_a', { cwd: '/wt' }), 5_000);
      touchDir(writeSession('session_b', { someRenamedField: '/wt' }), 5_000);
      expect(inspectKimiStoreLayout(opts())).toEqual({ status: 'ok', sampled: 1 });
    });

    it('names the working-directory field when no session carries one', () => {
      writeSession('session_bad1', '###');
      writeSession('session_bad2', { noWorkDirKey: true });
      const layout = inspectKimiStoreLayout(opts());
      expect(layout.status).toBe('drifted');
      expect(layout.status === 'drifted' && layout.reason).toMatch(/working-directory field/);
    });

    // `kimi -S <id>` takes the directory basename; if that stops being
    // `session_<uuid>`, discovery returns ids the CLI would reject.
    it('names the id scheme when session dirs lose the session_ prefix', () => {
      writeSession('bare-uuid-1234', { cwd: '/wt' });
      const layout = inspectKimiStoreLayout(opts());
      expect(layout.status).toBe('drifted');
      expect(layout.status === 'drifted' && layout.reason).toMatch(/session_<uuid>/);
    });
  });

  /**
   * The trust-record probe validates OUR undocumented derivation against kimi's own
   * records. If the scheme ever changes, the pre-write lands where kimi does not look:
   * the write still "succeeds", the dialog reappears, and every unattended builder
   * stalls on it. Silent by construction — hence the probe.
   */
  describe('inspectKimiTrustLayout (undocumented trust-scheme probe)', () => {
    function writeTrustRecord(fileName: string, root: string): void {
      const dir = join(kimiHome, 'workspace-trust');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, fileName), JSON.stringify({ root, trustedAt: 1 }), 'utf-8');
    }

    it('empty when nothing has been trusted yet (or kimi predates the dialog)', () => {
      expect(inspectKimiTrustLayout(opts())).toEqual({ status: 'empty' });
    });

    it('ok when a record kimi wrote matches the name we would derive for its root', () => {
      const root = '/tmp/some-worktree';
      writeTrustRecord(basename(kimiTrustRecordPath(root, opts())), root);
      expect(inspectKimiTrustLayout(opts())).toEqual({ status: 'ok', sampled: 1 });
    });

    it('drifted when records exist but none match the derived scheme', () => {
      writeTrustRecord('wd_some-worktree_DIFFERENTHASH', '/tmp/some-worktree');
      const layout = inspectKimiTrustLayout(opts());
      expect(layout.status).toBe('drifted');
      expect(layout.status === 'drifted' && layout.reason).toMatch(/sha256\(root\)/);
    });

    it('ignores unreadable records rather than calling them drift', () => {
      const dir = join(kimiHome, 'workspace-trust');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'not-json'), 'nope', 'utf-8');
      expect(inspectKimiTrustLayout(opts())).toEqual({ status: 'empty' });
    });

    // The end-to-end property the pre-write depends on: what we WRITE is what the
    // probe recognizes. If the derivation and the writer ever diverge, this fails.
    it('agrees with what ensureKimiWorkspaceTrust actually writes', () => {
      const root = mkdtempSync(join(tmpdir(), 'kimi-trust-root-'));
      try {
        expect(ensureKimiWorkspaceTrust(root, opts())).toBe(true);
        expect(inspectKimiTrustLayout(opts())).toEqual({ status: 'ok', sampled: 1 });
        // Idempotent: a second call leaves the existing record alone.
        expect(ensureKimiWorkspaceTrust(root, opts())).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
