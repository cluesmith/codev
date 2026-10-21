/**
 * Issue #1740: `--resume` must find a tracker-key builder's worktree whatever
 * case it was spawned in. Spawn now canonicalizes keys to upper case, so a
 * builder spawned earlier as `eng-123` lives in `bugfix-eng-123-slug`; on a
 * case-sensitive filesystem a plain startsWith would miss it. Numeric ids keep
 * exact matching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExistingIssueWorktree, issueDirName } from '../commands/spawn-worktree.js';
import { generateShortId, inferProtocolFromDirs } from '../commands/spawn.js';
import { detectProjectIdFromCwd } from '../../commands/porch/state.js';
import { extractProjectIdFromWorktreeName, discoverBuilders } from '../servers/overview.js';
import { isIssueKey } from '../../lib/issue-id.js';

let buildersDir: string;

beforeEach(() => {
  buildersDir = mkdtempSync(join(tmpdir(), 'codev-1740-builders-'));
});

afterEach(() => {
  rmSync(buildersDir, { recursive: true, force: true });
});

describe('findExistingIssueWorktree with tracker keys (#1740)', () => {
  it('finds a lower-case legacy worktree by its canonical key', () => {
    mkdirSync(join(buildersDir, 'bugfix-eng-123-fix-login'));
    expect(findExistingIssueWorktree(buildersDir, 'bugfix', 'ENG-123')).toBe('bugfix-eng-123-fix-login');
  });

  it('finds a canonical worktree', () => {
    mkdirSync(join(buildersDir, 'pir-ENG-123-slug'));
    expect(findExistingIssueWorktree(buildersDir, 'pir', 'ENG-123')).toBe('pir-ENG-123-slug');
  });

  it('does not match a longer key with the same prefix', () => {
    mkdirSync(join(buildersDir, 'bugfix-ENG-1234-other'));
    expect(findExistingIssueWorktree(buildersDir, 'bugfix', 'ENG-123')).toBeNull();
  });

  it('keeps numeric ids exact', () => {
    mkdirSync(join(buildersDir, 'bugfix-42-slug'));
    expect(findExistingIssueWorktree(buildersDir, 'bugfix', 42)).toBe('bugfix-42-slug');
    expect(findExistingIssueWorktree(buildersDir, 'bugfix', 4)).toBeNull();
  });
});

describe('issueDirName', () => {
  it('folds case only for tracker keys', () => {
    expect(issueDirName('Bugfix-ENG-1-X', 'ENG-1')).toBe('bugfix-eng-1-x');
    expect(issueDirName('Bugfix-42-X', 42)).toBe('Bugfix-42-X');
  });
});

// =============================================================================
// Integration review round 2: a key-shaped short id must never be generated.
// =============================================================================

/** A `random()` that yields the given 24-bit draws in order. */
function draws(...values: number[]): () => number {
  let i = 0;
  return () => (values[i++] + 0.5) / 0xFFFFFF;
}
// Draw 4020 encodes to `AA-0` (key-shaped); draw 0 encodes to `AAAA`.
const KEY_SHAPED_DRAW = 4020;

describe('generateShortId never yields a key-shaped id (#1740)', () => {
  it('redraws a key-shaped draw', () => {
    expect(generateShortId(draws(KEY_SHAPED_DRAW, 0))).toBe('AAAA');
  });

  it('keeps a non-key draw as is', () => {
    expect(generateShortId(draws(0))).toBe('AAAA');
  });

  it('produces no key-shaped id over many real draws', () => {
    for (let i = 0; i < 50_000; i++) {
      const id = generateShortId();
      expect(isIssueKey(id), id).toBe(false);
    }
  });
});

describe('an issue-less spawn cannot collide with a tracker key (#1740)', () => {
  // What an issue-less `afx spawn --protocol pir` names its worktree, when the
  // first raw draw was key-shaped (it would have been `pir-AA-0`).
  const protocolOnlyDir = `pir-${generateShortId(draws(KEY_SHAPED_DRAW, 0))}`;

  it('porch cwd detection does not resolve it to an issue project', () => {
    expect(detectProjectIdFromCwd(`/r/.builders/${protocolOnlyDir}`)).toBeNull();
    expect(detectProjectIdFromCwd('/r/.builders/pir-AA-0')).toBe('AA-0');
  });

  it('the overview name fallback (no stored row) keeps it in soft mode', () => {
    expect(extractProjectIdFromWorktreeName(protocolOnlyDir)).toBeNull();
    const workspace = mkdtempSync(join(tmpdir(), 'codev-1740-ws-'));
    try {
      mkdirSync(join(workspace, '.builders', protocolOnlyDir), { recursive: true });
      const builders = discoverBuilders(workspace);
      expect(builders).toHaveLength(1);
      expect(builders[0].mode).toBe('soft');
      expect(builders[0].issueId).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('resuming the real issue AA-0 does not pick it up', () => {
    expect(inferProtocolFromDirs([protocolOnlyDir], 'AA-0')).toBeNull();
    mkdirSync(join(buildersDir, protocolOnlyDir));
    expect(findExistingIssueWorktree(buildersDir, 'pir', 'AA-0')).toBeNull();
  });
});
