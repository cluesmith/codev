/**
 * Issue #1950 — `afx cleanup --keep-ignored`: what is kept, and how a copy is verified.
 *
 * Runs against a real git repository in a temp directory, so the file selection is git's own
 * (`ls-files --others`, with and without `--ignored` and glob pathspecs), not a re-implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import {
  DEFAULT_KEEP_IGNORED, keepFiles, keepPatterns, keptDirFor, listKeepCandidates,
} from '../lib/keep-files.js';

function write(root: string, rel: string, content = rel): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });

describe('afx cleanup --keep-ignored (#1950)', () => {
  let root: string;
  let worktree: string;
  let keptDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'air-1950-keep-'));
    worktree = join(root, 'wt');
    keptDir = join(root, 'kept', 'ws', 'bugfix-7');
    mkdirSync(worktree);
    git(worktree, 'init', '-q');
    write(worktree, '.gitignore', 'tmp/\nnode_modules/\ndist/\ncodev/projects/\n.env\n.builder-*\nlogs/\n');
    write(worktree, 'src/tracked.ts');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'init');

    write(worktree, 'notes.md');                         // untracked, not ignored → kept
    write(worktree, 'src/draft.ts');                     // untracked, not ignored → kept
    write(worktree, 'codev/projects/7-x/status.yaml');   // ignored, on the keep list → kept
    write(worktree, '.builder-prompt.txt');              // ignored, on the keep list → kept
    write(worktree, 'tmp/review/out.md');                // ignored, on the keep list → kept
    write(worktree, 'tmp/node_modules/pkg/index.js');    // on the keep list, but dependency output → not
    write(worktree, 'node_modules/pkg/index.js');        // ignored, dependency output → not
    write(worktree, 'dist/bundle.js');                   // ignored, build output → not
    write(worktree, 'logs/run.log');                     // ignored, not on the keep list → not
    write(worktree, '.env', 'SECRET=1');                 // ignored, not on the keep list → not
    write(worktree, 'src/tracked.ts', 'modified');       // tracked → the branch carries it, not kept
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects untracked files and keep-listed ignored files, never dependency or build output', () => {
    const { files, excluded } = listKeepCandidates(worktree, DEFAULT_KEEP_IGNORED);
    // tmp/node_modules/pkg/index.js matched tmp/** but is dependency output: counted, not kept.
    expect(excluded).toBe(1);
    expect(files).toEqual([
      '.builder-prompt.txt',
      'codev/projects/7-x/status.yaml',
      'notes.md',
      'src/draft.ts',
      'tmp/review/out.md',
    ]);
  });

  it('a configured keep list replaces the default', () => {
    expect(listKeepCandidates(worktree, ['logs/**']).files).toEqual(['logs/run.log', 'notes.md', 'src/draft.ts']);
  });

  it('copies each file and verifies it', async () => {
    const { files } = listKeepCandidates(worktree, DEFAULT_KEEP_IGNORED);
    const result = await keepFiles(worktree, keptDir, files);
    expect(result).toEqual({ copied: 5, skippedSymlinks: [] });
    expect(readFileSync(join(keptDir, 'tmp/review/out.md'), 'utf-8')).toBe('tmp/review/out.md');
    expect(readFileSync(join(keptDir, 'codev/projects/7-x/status.yaml'), 'utf-8')).toBe('codev/projects/7-x/status.yaml');
    expect(existsSync(join(keptDir, '.env'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('skips symlinks rather than copy what they point at', async () => {
    symlinkSync(join(worktree, '.env'), join(worktree, 'env-link'));
    const { files } = listKeepCandidates(worktree, DEFAULT_KEEP_IGNORED);
    expect(files).toContain('env-link');
    const result = await keepFiles(worktree, keptDir, files);
    expect(result).toEqual({ copied: 5, skippedSymlinks: ['env-link'] });
    expect(existsSync(join(keptDir, 'env-link'))).toBe(false);
  });

  it('refuses to overwrite an existing kept folder, touching nothing in it', async () => {
    mkdirSync(keptDir, { recursive: true });
    writeFileSync(join(keptDir, 'earlier.md'), 'from an earlier cleanup');
    await expect(keepFiles(worktree, keptDir, ['notes.md'])).rejects.toThrow(`kept folder already exists: ${keptDir}`);
    expect(readFileSync(join(keptDir, 'earlier.md'), 'utf-8')).toBe('from an earlier cleanup');
    expect(existsSync(join(keptDir, 'notes.md'))).toBe(false);
  });

  it('a checksum mismatch fails the keep and removes the partial copy', async () => {
    const corrupting = {
      copy: async (src: string, dst: string) => {
        await copyFile(src, dst);
        if (src.endsWith('notes.md')) writeFileSync(dst, 'corrupted');
      },
    };
    await expect(keepFiles(worktree, keptDir, ['.builder-prompt.txt', 'notes.md', 'src/draft.ts'], corrupting))
      .rejects.toThrow('checksum mismatch after copying notes.md');
    expect(existsSync(keptDir)).toBe(false);
    expect(existsSync(join(worktree, 'notes.md'))).toBe(true);
  });

  it('expands an untracked nested repository into its files', () => {
    write(worktree, 'tmp/clone/readme.md');
    git(join(worktree, 'tmp/clone'), 'init', '-q');
    write(worktree, 'tmp/clone/deep/er/notes.md');
    const { files } = listKeepCandidates(worktree, ['tmp/**']);
    expect(files).toContain('tmp/clone/readme.md');
    expect(files).toContain('tmp/clone/deep/er/notes.md');
  });

  it('places the kept folder under kept/<workspace-name>/<builder-id>', () => {
    expect(keptDirFor('/home/u/.agent-farm', '/src/my-repo', 'bugfix-7')).toBe(join('/home/u/.agent-farm', 'kept', 'my-repo', 'bugfix-7'));
  });

  it('validates a configured keep list', () => {
    expect(keepPatterns(undefined)).toBe(DEFAULT_KEEP_IGNORED);
    expect(keepPatterns(['a/**'])).toEqual(['a/**']);
    expect(() => keepPatterns('tmp/**')).toThrow('cleanup.keepIgnored');
    expect(() => keepPatterns(['ok', ''])).toThrow('cleanup.keepIgnored');
  });
});
