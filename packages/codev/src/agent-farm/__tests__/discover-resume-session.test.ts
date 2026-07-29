/**
 * Tests for the discoverResumeSession helper — the spawn-CLI wrapper that
 * gates the harness's buildResume on the --resume flag and surfaces a
 * user-facing log line. (Issues #829 / #831 / #929.)
 *
 * Issue #929: resume is now gated on the builder harness, not the Claude
 * session store directly. Only the Claude harness implements buildResume;
 * codex/gemini return undefined even when a stale Claude jsonl exists (the
 * regression guard against `codex --resume <claude-uuid>` crash-loops).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { discoverResumeSession } from '../commands/spawn.js';
import { encodeClaudeProjectDir } from '../utils/claude-session-discovery.js';
import { CLAUDE_HARNESS, CODEX_HARNESS, GEMINI_HARNESS, KIMI_HARNESS } from '../utils/harness.js';

// discoverResumeSession reads from $HOME via os.homedir() through
// findLatestSessionId. Override the env var for the duration of the test so
// the helper looks at our fake home instead of the user's real one.
function pinHome<T>(fakeHome: string, fn: () => T): T {
  const original = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

function writeSession(projectsRoot: string, absPath: string, uuid: string, mtimeMs: number): void {
  const dir = join(projectsRoot, encodeClaudeProjectDir(absPath));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${uuid}.jsonl`);
  writeFileSync(file, `{"sessionId":"${uuid}"}\n`, 'utf-8');
  const t = mtimeMs / 1000;
  utimesSync(file, t, t);
}

describe('discoverResumeSession', () => {
  let fakeHome: string;
  let projectsRoot: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'drs-test-'));
    projectsRoot = join(fakeHome, '.claude', 'projects');
    mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns undefined when isResume is false (no filesystem touch)', () => {
    // Even if a jsonl exists, a non-resume spawn must not pick it up.
    const worktree = '/Users/x/repo/.builders/spir-1';
    writeSession(projectsRoot, worktree, 'should-not-pick', 1_700_000_000_000);
    pinHome(fakeHome, () => {
      expect(discoverResumeSession(worktree, false, CLAUDE_HARNESS)).toBeUndefined();
    });
  });

  it('returns undefined when isResume is undefined', () => {
    const worktree = '/Users/x/repo/.builders/spir-2';
    writeSession(projectsRoot, worktree, 'should-not-pick', 1_700_000_000_000);
    pinHome(fakeHome, () => {
      expect(discoverResumeSession(worktree, undefined, CLAUDE_HARNESS)).toBeUndefined();
    });
  });

  it('returns undefined when isResume is true but no jsonl exists', () => {
    const worktree = '/Users/x/repo/.builders/spir-3-no-jsonl';
    pinHome(fakeHome, () => {
      expect(discoverResumeSession(worktree, true, CLAUDE_HARNESS)).toBeUndefined();
    });
  });

  it('returns the newest jsonl resume object (claude) when isResume is true and jsonls exist', () => {
    const worktree = '/Users/x/repo/.builders/pir-1661';
    writeSession(projectsRoot, worktree, 'older-uuid', 1_500_000_000_000);
    writeSession(projectsRoot, worktree, 'newest-uuid', 1_700_000_000_000);
    pinHome(fakeHome, () => {
      const resume = discoverResumeSession(worktree, true, CLAUDE_HARNESS);
      expect(resume).toEqual({
        sessionId: 'newest-uuid',
        args: ['--resume', 'newest-uuid'],
        scriptFragment: "--resume 'newest-uuid'",
      });
    });
  });

  it('returns undefined for codex even when a stale Claude jsonl exists (regression guard)', () => {
    // The crash-loop bug: a codex builder must NOT pick up a Claude session id
    // and build `codex --resume <claude-uuid>`. CODEX_HARNESS has no buildResume.
    const worktree = '/Users/x/repo/.builders/pir-codex';
    writeSession(projectsRoot, worktree, 'stale-claude-uuid', 1_700_000_000_000);
    pinHome(fakeHome, () => {
      expect(discoverResumeSession(worktree, true, CODEX_HARNESS)).toBeUndefined();
    });
  });

  it('returns undefined for gemini even when a stale Claude jsonl exists (regression guard)', () => {
    const worktree = '/Users/x/repo/.builders/pir-gemini';
    writeSession(projectsRoot, worktree, 'stale-claude-uuid', 1_700_000_000_000);
    pinHome(fakeHome, () => {
      expect(discoverResumeSession(worktree, true, GEMINI_HARNESS)).toBeUndefined();
    });
  });

  it('does not consult the filesystem when isResume is false (perf safety)', () => {
    // Negative case: isResume=false short-circuits before any filesystem
    // access happens. Tests pass even if HOME points at /nonexistent.
    pinHome('/nonexistent-home-path', () => {
      expect(discoverResumeSession('/some/worktree', false, CLAUDE_HARNESS)).toBeUndefined();
    });
  });

  // =========================================================================
  // Issue #1201 — kimi. KIMI_HARNESS reads only the Kimi store, so a stale
  // Claude jsonl for the same worktree must never surface as a kimi resume
  // (the #929-class guard: `kimi --resume <claude-uuid>` is impossible).
  // KIMI_CODE_HOME (documented seam) pins the kimi store to the fixture home.
  // =========================================================================

  function pinKimiHome<T>(kimiHome: string, fn: () => T): T {
    const original = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = kimiHome;
    try {
      return fn();
    } finally {
      if (original === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = original;
    }
  }

  it('returns undefined for kimi when only a stale Claude jsonl exists (#929-class guard)', () => {
    const worktree = '/Users/x/repo/.builders/pir-kimi';
    writeSession(projectsRoot, worktree, 'stale-claude-uuid', 1_700_000_000_000);
    pinKimiHome(join(fakeHome, '.kimi-code'), () => {
      expect(discoverResumeSession(worktree, true, KIMI_HARNESS)).toBeUndefined();
    });
  });

  it('returns the kimi store session as -S resume when one exists for the worktree', () => {
    const worktree = '/Users/x/repo/.builders/pir-kimi-2';
    // A stale Claude jsonl AND a kimi session both exist — the kimi id wins
    // (and the claude uuid never appears in any form).
    writeSession(projectsRoot, worktree, 'stale-claude-uuid', 1_700_000_000_000);
    const kimiHome = join(fakeHome, '.kimi-code');
    const sessionDir = join(kimiHome, 'sessions', 'wd_x_000000000000', 'session_kimi-1');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'state.json'),
      JSON.stringify({ workDir: worktree, updatedAt: '2026-07-18T10:00:00Z' }),
      'utf-8',
    );
    pinKimiHome(kimiHome, () => {
      const resume = discoverResumeSession(worktree, true, KIMI_HARNESS);
      expect(resume).toEqual({
        sessionId: 'session_kimi-1',
        args: ['-S', 'session_kimi-1'],
        scriptFragment: "-S 'session_kimi-1'",
      });
    });
  });
});
