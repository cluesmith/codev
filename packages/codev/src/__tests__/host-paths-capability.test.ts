/**
 * Spec 1658, Amendment 2 phase A2-2: the host paths capability.
 *
 * Both implementations are pure enough to check directly: the POSIX one keeps
 * the macOS/Linux forms the call sites had (byte prefixes, `/` only, identity
 * keys), the Windows one treats `\` as a separator and compares
 * case-insensitively. The accessor follows the seam. Canonicalization and the
 * Windows native-answer cache are covered in spec-1658-workspace-path-canonical.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostPaths, type WorkspacePathOps } from '../lib/platform/host-paths.js';
import { posixHostPaths } from '../lib/platform/host-paths.posix.js';
import { windowsHostPaths } from '../lib/platform/host-paths.windows.js';
import { useHostPlatform } from './helpers/host-platform.js';

const failingOps: WorkspacePathOps = {
  realpath: () => {
    throw new Error('ENOENT');
  },
  realpathNative: () => {
    throw new Error('ENOENT');
  },
};

describe('hostPaths() follows the host seam', () => {
  describe('on linux', () => {
    useHostPlatform('linux');
    it('returns the POSIX implementation', () => {
      expect(hostPaths()).toBe(posixHostPaths);
    });
  });
  describe('on win32', () => {
    useHostPlatform('win32');
    it('returns the Windows implementation', () => {
      expect(hostPaths()).toBe(windowsHostPaths);
    });
  });
});

describe('POSIX implementation: the pre-refactor forms, verbatim', () => {
  const p = posixHostPaths;

  it('key is the path exactly as given; canonicalize falls back to resolve', () => {
    expect(p.key('/Repo/./x')).toBe('/Repo/./x');
    expect(p.canonicalize('/repo/a/../b', failingOps)).toBe('/repo/b');
  });

  it('separators are `/` only', () => {
    expect(p.lastSegment('/a/b\\c')).toBe('b\\c');
    expect(p.endsWithSeparator('/a/')).toBe(true);
    expect(p.endsWithSeparator('C:\\a\\')).toBe(false);
    expect(p.toForwardSlashes('a\\b')).toBe('a\\b');
    expect(p.expandHome('~\\x', '/home/u')).toBe('~\\x');
    expect(p.expandHome('~/x', '/home/u')).toBe('/home/u/x');
  });

  it('isUnder is a byte prefix with a `/` boundary (no trailing-separator folding)', () => {
    expect(p.isUnder('/a/b', '/a')).toBe(true);
    expect(p.isUnder('/A/b', '/a')).toBe(false);
    expect(p.isUnder('/a/b', '/a/')).toBe(false);
    expect(p.isAtOrUnder('/a', '/a')).toBe(true);
  });

  it('builder-worktree forms', () => {
    expect(p.splitBuilderWorktree('/w/.builders/bugfix-1/x')).toEqual({ workspacePath: '/w', worktreeDirName: 'bugfix-1' });
    expect(p.splitBuilderWorktree('C:\\w\\.builders\\bugfix-1')).toBeNull();
    expect(p.hasBuildersSegment('/w/.builders/x')).toBe(true);
    expect(p.lastBuildersMarkerIndex('/w/.builders/a/.builders/b')).toBe(14);
    expect(p.lastBuildersMarkerIndex('C:\\w\\.builders\\b')).toBe(-1);
    expect(p.workspaceOfBuilderCwd('/w/.builders/x')).toBe('/w');
    expect(p.workspaceOfBuilderCwd('/w/.builders/x/sub')).toBeNull();
    expect(p.isAbsoluteBuilderWorktree('/w/.builders/x')).toBe(true);
    expect(p.isAbsoluteBuilderWorktree('w/.builders/x')).toBe(false);
  });

  it('canonicalFilePath: realpath, else the real parent joined with the name, else resolve', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spec1658-a22-')));
    try {
      const file = join(dir, 'a.md');
      writeFileSync(file, 'x');
      expect(p.canonicalFilePath(join(dir, '.', 'a.md'))).toBe(file);
      expect(p.canonicalFilePath(join(dir, 'missing.md'))).toBe(join(dir, 'missing.md'));
      expect(p.canonicalFilePath('/no/such/1658/dir/file.md')).toBe('/no/such/1658/dir/file.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sameDirectory compares exact spellings (and realpaths)', () => {
    expect(p.sameDirectory('/no/such/a', '/no/such/a')).toBe(true);
    expect(p.sameDirectory('/no/such/A', '/no/such/a')).toBe(false);
  });
});

describe('Windows implementation: either separator, case-insensitive', () => {
  const w = windowsHostPaths;

  it('key canonicalizes only drive-letter and UNC paths', () => {
    expect(w.key('/driveless/x')).toBe('/driveless/x');
    expect(w.key('relative\\x')).toBe('relative\\x');
  });

  it('canonicalize upper-cases the drive whatever answers', () => {
    expect(w.canonicalize('c:\\no\\such\\1658', failingOps)).toBe('C:\\no\\such\\1658');
  });

  it('separators are `/` and `\\`', () => {
    expect(w.lastSegment('C:\\a\\b')).toBe('b');
    expect(w.endsWithSeparator('C:\\a\\')).toBe(true);
    expect(w.toForwardSlashes('specs\\x.md')).toBe('specs/x.md');
    expect(w.expandHome('~\\x', 'C:\\Users\\u')).toBe('C:\\Users\\u\\x');
  });

  it('isUnder folds case, separators and a trailing separator', () => {
    expect(w.isUnder('c:/Repo/x', 'C:\\repo\\')).toBe(true);
    expect(w.isAtOrUnder('C:\\repo\\', 'c:/REPO')).toBe(true);
  });

  it('builder-worktree forms accept either separator', () => {
    expect(w.splitBuilderWorktree('C:\\w\\.builders\\bugfix-1\\x')).toEqual({ workspacePath: 'C:\\w', worktreeDirName: 'bugfix-1' });
    expect(w.hasBuildersSegment('C:\\w\\.builders\\x')).toBe(true);
    expect(w.lastBuildersMarkerIndex('C:\\w\\.builders\\b')).toBe(4);
    expect(w.workspaceOfBuilderCwd('C:\\w/.builders\\x')).toBe('C:\\w');
    expect(w.isAbsoluteBuilderWorktree('C:\\w\\.builders\\x')).toBe(true);
    expect(w.isAbsoluteBuilderWorktree('w\\.builders\\x')).toBe(false);
  });

  it('canonicalFilePath canonicalizes the parent of a missing file and keeps the name', () => {
    // The parent goes through `key` (upper-case drive, Win32 spelling); the join uses
    // the host's own path module, as the call site did.
    expect(w.canonicalFilePath('c:/no/such/1658/x.md')).toBe(join('C:\\no\\such\\1658', 'x.md'));
  });

  it('sameDirectory is case-insensitive with separators normalized', () => {
    expect(w.sameDirectory('c:/Repo/./x', 'C:\\REPO\\x')).toBe(true);
    expect(w.sameDirectory('C:\\repo\\x', 'C:\\repo\\y')).toBe(false);
  });
});
