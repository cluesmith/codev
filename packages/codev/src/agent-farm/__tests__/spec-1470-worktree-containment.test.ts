/**
 * Spec 1470 — path containment for the worktree-match refusal.
 *
 * The check exists so a registry row pointing at a DIFFERENT worktree cannot
 * send reads and writes into the wrong tree. Its first implementation used
 * `resolve(cwd).startsWith(resolve(worktree))`, which is a string test rather
 * than a path test: `/a/b-other` starts with `/a/b`, so a sibling directory
 * passed the guard.
 *
 * These tests pin the containment predicate directly, against REAL directories,
 * because the interesting cases (prefix siblings, symlinks) cannot be
 * constructed through the command with mocked paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInside } from '../commands/self-refresh.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contain-1470-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isInside', () => {
  it('accepts the directory itself', () => {
    const wt = join(root, 'spir-1470');
    mkdirSync(wt, { recursive: true });
    expect(isInside(wt, wt)).toBe(true);
  });

  it('accepts a subdirectory, since builders often run from one', () => {
    const wt = join(root, 'spir-1470');
    const sub = join(wt, 'packages', 'codev');
    mkdirSync(sub, { recursive: true });
    expect(isInside(wt, sub)).toBe(true);
  });

  it('REJECTS a prefix sibling — the bypass a startsWith check allowed', () => {
    // The whole reason this predicate exists rather than a string comparison.
    const wt = join(root, 'spir-1470');
    const sibling = join(root, 'spir-1470-other');
    mkdirSync(wt, { recursive: true });
    mkdirSync(sibling, { recursive: true });

    expect(isInside(wt, sibling)).toBe(false);
    // Prove the old implementation WOULD have accepted it, so this test cannot
    // quietly stop discriminating if the predicate is rewritten.
    expect(sibling.startsWith(wt)).toBe(true);
  });

  it('rejects a parent directory', () => {
    const wt = join(root, 'spir-1470');
    mkdirSync(wt, { recursive: true });
    expect(isInside(wt, root)).toBe(false);
  });

  it('rejects an unrelated tree', () => {
    const wt = join(root, 'spir-1470');
    const other = join(root, 'elsewhere');
    mkdirSync(wt, { recursive: true });
    mkdirSync(other, { recursive: true });
    expect(isInside(wt, other)).toBe(false);
  });

  it('accepts a symlinked spelling of the same directory', () => {
    // The false-refusal direction: the registry may record one spelling and
    // process.cwd() report the physical target. Refusing a legitimate refresh
    // over a symlink would be its own bug.
    const wt = join(root, 'spir-1470');
    const link = join(root, 'linked');
    mkdirSync(wt, { recursive: true });
    symlinkSync(wt, link);

    expect(isInside(link, wt)).toBe(true);
    expect(isInside(wt, link)).toBe(true);
  });

  it('tolerates a path that does not exist rather than erroring', () => {
    // realpathSync throws on a missing path; refusing on that basis would turn
    // a missing directory into a confusing identity error.
    const missing = join(root, 'not-there');
    expect(() => isInside(missing, missing)).not.toThrow();
    expect(isInside(missing, missing)).toBe(true);
  });
});
