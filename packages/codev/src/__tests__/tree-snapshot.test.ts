/**
 * Spec 1797: the shared tree-snapshot core. The git snapshot itself is covered by the
 * consult tripwire tests (which import it through `tree-tripwire.ts`); this file pins the
 * cases `codev bootstrap-docs` relies on beyond them: the index fingerprint, the exemption
 * predicate, and the non-git filesystem fallback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  diffRepositoryIdentity,
  diffSnapshotEntries,
  readIndexFingerprint,
  snapshotFilesystem,
  snapshotTree,
} from '../lib/tree-snapshot.js';

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-snapshot-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('git snapshot (bootstrap cases)', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main');
    write('src/a.ts', 'a\n');
    write('src/b.ts', 'b\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  function diff(mutate: () => void): { paths: string[]; identity: string[]; indexChanged: boolean } {
    const before = snapshotTree(dir);
    const indexBefore = readIndexFingerprint(dir);
    mutate();
    const after = snapshotTree(dir);
    return {
      paths: diffSnapshotEntries(before, after),
      identity: diffRepositoryIdentity(before, after).map(change => change.field),
      indexChanged: indexBefore !== readIndexFingerprint(dir),
    };
  }

  it('leaves pre-existing dirt alone when nothing moves', () => {
    write('src/a.ts', 'dirty before\n');
    write('notes.txt', 'untracked before\n');
    expect(diff(() => {})).toEqual({ paths: [], identity: [], indexChanged: false });
  });

  it('reports a new untracked file and a modified tracked file', () => {
    expect(diff(() => {
      write('src/new.ts', 'new\n');
      write('src/b.ts', 'changed\n');
    }).paths).toEqual(['src/b.ts', 'src/new.ts']);
  });

  it('reports a commit as a HEAD change', () => {
    write('src/a.ts', 'dirty\n');
    const result = diff(() => {
      git('add', 'src/a.ts');
      git('commit', '-q', '-m', 'agent commit');
    });
    expect(result.identity).toContain('HEAD');
    expect(result.paths).toEqual(['src/a.ts']);
  });

  it('reports `git add` of a modified file', () => {
    write('src/a.ts', 'dirty\n');
    const result = diff(() => git('add', 'src/a.ts'));
    expect(result.paths).toEqual(['src/a.ts']);
    expect(result.indexChanged).toBe(true);
  });

  it('sees an index-only change that porcelain and working hashes cannot', () => {
    write('src/a.ts', 'staged v1\n');
    git('add', 'src/a.ts');
    write('src/a.ts', 'working v2\n');
    const result = diff(() => {
      // Re-stage different content, then restore the working file byte-for-byte.
      write('src/a.ts', 'staged v3\n');
      git('add', 'src/a.ts');
      write('src/a.ts', 'working v2\n');
    });
    expect(result.paths).toEqual([]);
    expect(result.indexChanged).toBe(true);
  });

  it('exempts what the caller says it owns', () => {
    const before = snapshotTree(dir);
    write('codev/resources/arch.md', 'draft\n');
    write('src/c.ts', 'c\n');
    const after = snapshotTree(dir);
    expect(diffSnapshotEntries(before, after, rel => rel.startsWith('codev/'))).toEqual(['src/c.ts']);
  });
});

describe('readIndexFingerprint', () => {
  it('is null outside a git repository', () => {
    expect(readIndexFingerprint(dir)).toBeNull();
  });
});

describe('snapshotFilesystem (non-git fallback)', () => {
  it('hashes every file and reports adds, edits and deletes', () => {
    write('src/a.ts', 'a\n');
    write('src/b.ts', 'b\n');
    const before = snapshotFilesystem(dir);
    expect(before.available).toBe(true);
    expect(before.truncated).toBe(false);
    write('src/a.ts', 'edited\n');
    fs.rmSync(path.join(dir, 'src/b.ts'));
    write('src/c.ts', 'c\n');
    expect(diffSnapshotEntries(before, snapshotFilesystem(dir))).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('skips .git/, node_modules/ and root-gitignored paths', () => {
    write('.gitignore', 'dist/\n*.log\n');
    write('dist/out.js', 'x\n');
    write('debug.log', 'x\n');
    write('node_modules/pkg/index.js', 'x\n');
    write('.git/HEAD', 'x\n');
    write('src/a.ts', 'a\n');
    const keys = [...snapshotFilesystem(dir).entries.keys()].sort();
    expect(keys).toEqual(['.gitignore', 'src/a.ts']);
  });

  it('reports a retargeted symlink', () => {
    write('a.txt', 'a\n');
    write('b.txt', 'b\n');
    fs.symlinkSync('a.txt', path.join(dir, 'link'));
    const before = snapshotFilesystem(dir);
    fs.rmSync(path.join(dir, 'link'));
    fs.symlinkSync('b.txt', path.join(dir, 'link'));
    expect(diffSnapshotEntries(before, snapshotFilesystem(dir))).toEqual(['link']);
  });

  it('stops at its bound and says so', () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`, `${i}\n`);
    const snapshot = snapshotFilesystem(dir, 3);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries.size).toBe(3);
  });

  it('has no repository identity to compare', () => {
    write('a.txt', 'a\n');
    expect(diffRepositoryIdentity(snapshotFilesystem(dir), snapshotFilesystem(dir))).toEqual([]);
  });
});
