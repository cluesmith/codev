/**
 * Regression tests for the working-tree tripwire (#1649).
 *
 * The bug: a `consult -m claude` review lane made five `Edit` calls on a
 * builder's worktree, reverting the guards it was meant to be reviewing, and
 * nothing noticed. Two halves to the fix — the consultant role now forbids it
 * (asserted in `consultant-role.test.ts`), and this tripwire makes a recurrence
 * visible instead of silent.
 *
 * These tests drive real git repositories in temp dirs rather than mocking
 * `execFileSync`. The whole point of the tripwire is what `git status` reports
 * for a given tree state, so a mocked git would only assert that the code calls
 * the function I wrote it to call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  snapshotTree,
  diffTreeSnapshots,
  relativeOutputPath,
  formatTreeChangeWarning,
  formatSnapshotLostWarning,
  appendTreeChangeWarningToOutput,
} from '../tree-tripwire.js';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/overview.ts', 'export function guard(x: number) {\n  if (x < 0) return false;\n  return true;\n}\n');
  git('add', 'src/overview.ts');
  git('commit', '-qm', 'initial');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('snapshotTree', () => {
  it('reports unavailable outside a git repository rather than claiming a clean tree', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-nogit-'));
    try {
      const snap = snapshotTree(notARepo);
      expect(snap.available).toBe(false);
      expect(snap.reason).toBeTruthy();
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('lists untracked files individually, not collapsed into their directory', () => {
    write('scratch/a.ts', 'a');
    write('scratch/b.ts', 'b');
    const entries = [...snapshotTree(repo).entries.keys()];
    expect(entries).toContain('scratch/a.ts');
    expect(entries).toContain('scratch/b.ts');
    expect(entries).not.toContain('scratch/');
  });

  it('handles paths containing spaces (NUL-separated porcelain, not C-quoted)', () => {
    write('a file with spaces.ts', 'x');
    expect([...snapshotTree(repo).entries.keys()]).toContain('a file with spaces.ts');
  });
});

describe('diffTreeSnapshots — the #1649 scenario', () => {
  it('catches a reviewer reverting a guard in an otherwise clean tree', () => {
    const before = snapshotTree(repo);

    // What the lane actually did: replaced the guard with a marker comment.
    write('src/overview.ts', 'export function guard(x: number) {\n  // REVERTED FOR VACUITY CHECK\n  return true;\n}\n');

    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual(['src/overview.ts']);
  });

  it('catches an edit to a file the builder had ALREADY modified', () => {
    // The case a plain `git status --porcelain` string diff misses: porcelain
    // prints ` M src/overview.ts` before and after, byte-identical, while the
    // contents changed underneath. A builder mid-phase always looks like this.
    write('src/overview.ts', 'export function guard(x: number) {\n  if (x < 0) return false;\n  if (x > 100) return false;\n  return true;\n}\n');
    const before = snapshotTree(repo);
    const porcelainBefore = git('status', '--porcelain');

    write('src/overview.ts', 'export function guard(x: number) {\n  // REVERTED FOR VACUITY CHECK\n  return true;\n}\n');

    expect(git('status', '--porcelain')).toBe(porcelainBefore);
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual(['src/overview.ts']);
  });

  it('catches a file the reviewer created', () => {
    const before = snapshotTree(repo);
    write('src/overview.patch', 'a suggested patch');
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual(['src/overview.patch']);
  });

  it('catches a file the reviewer deleted', () => {
    const before = snapshotTree(repo);
    fs.rmSync(path.join(repo, 'src/overview.ts'));
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual(['src/overview.ts']);
  });

  it('catches a revert that the reviewer then restored to a DIFFERENT state', () => {
    const before = snapshotTree(repo);
    write('src/overview.ts', 'reverted');
    write('src/overview.ts', 'export function guard(x: number) {\n  if (x < 0) return false;\n  return true;\n }\n');
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual(['src/overview.ts']);
  });

  it('stays silent when the lane restores the tree byte-for-byte', () => {
    // Honest about the limit: a perfectly restored edit leaves no trace for a
    // before/after comparison to find. consultant.md is what covers this case.
    const original = fs.readFileSync(path.join(repo, 'src/overview.ts'));
    const before = snapshotTree(repo);
    write('src/overview.ts', 'reverted');
    fs.writeFileSync(path.join(repo, 'src/overview.ts'), original);
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual([]);
  });

  it('stays silent on a review that touched nothing', () => {
    const before = snapshotTree(repo);
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual([]);
  });

  it('ignores its own .consult/ log even when the repo does not gitignore it', () => {
    // Found in a live run, not by reading the code: `logQuery()` appends to
    // .consult/history.log after the lane returns, inside the measured window.
    // This repo gitignores .consult/, so the false positive only appears in a
    // repo that does not — which is most adopters on day one.
    const before = snapshotTree(repo);
    write('.consult/history.log', '2026-09-09 model=claude query=…\n');
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual([]);
  });

  it('ignores gitignored paths, which is why consult output does not trip its own wire', () => {
    write('.gitignore', '.consult/\ncodev/projects/*/*.txt\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'ignore consult artifacts');
    const before = snapshotTree(repo);
    write('.consult/history.log', 'a log line');
    write('codev/projects/1649-x/1649-fix-iter1-claude.txt', 'the review');
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual([]);
  });

  it('ignores the lane\'s own output file even when it is NOT gitignored', () => {
    const before = snapshotTree(repo);
    write('reviews/claude.txt', 'the review');
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual(['reviews/claude.txt']);
    expect(diffTreeSnapshots(before, snapshotTree(repo), ['reviews/claude.txt'])).toEqual([]);
  });

  it('ignores the OTHER lanes\' review files during a cmap round', () => {
    // porch's verify step runs three `consult --output
    // codev/projects/<id>/<id>-<phase>-iter<N>-<model>.txt` lanes in parallel
    // against one worktree. A lane can only pass its own path as `ignore`, so
    // without a rule for the shared naming convention each lane would report its
    // two siblings. Hidden in this repo by a .gitignore line that
    // CODEV_GITIGNORE_ENTRIES does not ship, so every adopter would have seen it.
    const before = snapshotTree(repo);
    write('codev/projects/bugfix-1649-x/bugfix-1649-fix-iter1-codex.txt', 'codex review');
    write('codev/projects/bugfix-1649-x/bugfix-1649-fix-iter1-gemini.txt', 'gemini review');
    expect(diffTreeSnapshots(before, snapshotTree(repo))).toEqual([]);
  });

  it('still reports a non-review file written into a project directory', () => {
    // The exclusion is the lanes' review artifacts, not a blanket amnesty on
    // codev/projects/.
    const before = snapshotTree(repo);
    write('codev/projects/bugfix-1649-x/notes.md', 'a lane wrote this');
    expect(diffTreeSnapshots(before, snapshotTree(repo)))
      .toEqual(['codev/projects/bugfix-1649-x/notes.md']);
  });

  it('reports nothing when either snapshot is unavailable', () => {
    const before = snapshotTree(repo);
    write('src/overview.ts', 'changed');
    const unavailable = { available: false as const, entries: new Map<string, string>() };
    expect(diffTreeSnapshots(unavailable, snapshotTree(repo))).toEqual([]);
    expect(diffTreeSnapshots(before, unavailable)).toEqual([]);
  });
});

describe('relativeOutputPath', () => {
  it('resolves a relative --output the user typed', () => {
    // `consult -o review.txt` used to fail a raw startsWith(workspaceRoot)
    // test, so the lane named its own review file as a mutation.
    expect(relativeOutputPath('/repo', 'review.txt')).toBe('review.txt');
    expect(relativeOutputPath('/repo', './codev/reviews/x.txt')).toBe('codev/reviews/x.txt');
  });

  it('accepts an absolute path inside the workspace', () => {
    expect(relativeOutputPath('/repo', '/repo/codev/x.txt')).toBe('codev/x.txt');
  });

  it('rejects a path outside the workspace, including a sibling with a shared prefix', () => {
    // The opposite error a plain prefix test makes: /repo-2 is not inside /repo.
    expect(relativeOutputPath('/repo', '/repo-2/x.txt')).toBeNull();
    expect(relativeOutputPath('/repo', '../elsewhere/x.txt')).toBeNull();
    expect(relativeOutputPath('/repo', '/tmp/x.txt')).toBeNull();
  });

  it('is null when no output path was given', () => {
    expect(relativeOutputPath('/repo', undefined)).toBeNull();
  });
});

describe('formatSnapshotLostWarning', () => {
  it('distinguishes "cannot tell" from "nothing changed"', () => {
    const w = formatSnapshotLostWarning('claude', 'not a git repository');
    expect(w).toContain('WORKING TREE UNREADABLE');
    expect(w).toContain('not the same as "nothing changed"');
    expect(w).toContain('not a git repository');
  });
});

describe('formatTreeChangeWarning', () => {
  it('names every changed file and tells the reader what to do', () => {
    const w = formatTreeChangeWarning('claude', ['lib/forge.ts', 'servers/overview.ts']);
    expect(w).toContain('WORKING TREE CHANGED');
    expect(w).toContain('claude');
    expect(w).toContain('lib/forge.ts');
    expect(w).toContain('servers/overview.ts');
    expect(w).toContain('git status');
  });

  it('does not accuse a specific lane of the write, because cmap runs them concurrently', () => {
    const w = formatTreeChangeWarning('claude', ['a.ts']);
    expect(w).toContain('while this lane was running');
    expect(w).toMatch(/another lane/i);
  });

  it('truncates a very long file list', () => {
    const files = Array.from({ length: 45 }, (_, i) => `src/f${i}.ts`);
    const w = formatTreeChangeWarning('codex', files);
    expect(w).toContain('… and 25 more');
    expect(w).not.toContain('src/f30.ts');
  });

  it('carries no VERDICT: line, so parseVerdict still finds the reviewer\'s own', () => {
    const w = formatTreeChangeWarning('claude', ['a.ts']);
    for (const line of w.split('\n')) {
      expect(line.trim().toUpperCase().startsWith('VERDICT:')).toBe(false);
    }
  });
});

describe('appendTreeChangeWarningToOutput', () => {
  it('appends the warning below the review without displacing the verdict', () => {
    const out = path.join(repo, 'review.txt');
    fs.writeFileSync(out, 'The guards look right.\n\nVERDICT: APPROVE\n');
    appendTreeChangeWarningToOutput(out, formatTreeChangeWarning('claude', ['src/overview.ts']));

    const content = fs.readFileSync(out, 'utf-8');
    expect(content).toContain('VERDICT: APPROVE');
    expect(content).toContain('WORKING TREE CHANGED');
    expect(content.indexOf('VERDICT: APPROVE')).toBeLessThan(content.indexOf('WORKING TREE CHANGED'));
  });

  it('is a no-op when the lane wrote no output file', () => {
    expect(() => appendTreeChangeWarningToOutput(undefined, 'w')).not.toThrow();
    expect(() => appendTreeChangeWarningToOutput(path.join(repo, 'nope.txt'), 'w')).not.toThrow();
    expect(fs.existsSync(path.join(repo, 'nope.txt'))).toBe(false);
  });
});
