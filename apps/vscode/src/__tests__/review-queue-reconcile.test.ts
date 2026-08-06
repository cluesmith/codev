/**
 * Thread reconcile planning (#1037, plan decision 6): a queued comment is
 * visible exactly while its file is registered in the active diff session for
 * its builder. Repeated reconciles are stable (no duplicate mounts), queue
 * removals dispose, session swaps dispose the old builder's threads, and
 * worktree derivation from a diff-inject entry never guesses.
 */

import { describe, it, expect } from 'vitest';
import {
  planThreadReconcile,
  deriveWorktreePath,
  type RegisteredFile,
} from '../review-queue/reconcile.js';
import type { PendingComment } from '../review-queue/queue.js';

function comment(id: string, file: string): PendingComment {
  return { id, createdAt: '2026-08-06T10:00:00Z', file, lineRange: { start: 3, end: 4 }, body: id };
}

const FILE_A: RegisteredFile = { fsPath: '/wt/a/src/x.ts', builderId: 'A', relPath: 'src/x.ts' };
const FILE_B: RegisteredFile = { fsPath: '/wt/b/src/y.ts', builderId: 'B', relPath: 'src/y.ts' };

describe('planThreadReconcile', () => {
  it('mounts queued comments whose file is registered for their builder', () => {
    const queues = new Map([
      ['A', [comment('a1', 'src/x.ts'), comment('a2', 'src/other.ts')]],
      ['B', [comment('b1', 'src/y.ts')]],
    ]);
    const plan = planThreadReconcile([FILE_A, FILE_B], queues, new Set());
    expect(plan.toCreate.map(e => e.comment.id).sort()).toEqual(['a1', 'b1']);
    expect(plan.toDispose).toEqual([]);
  });

  it('is stable across repeated reconciles (no duplicate mounts)', () => {
    const queues = new Map([['A', [comment('a1', 'src/x.ts')]]]);
    const plan = planThreadReconcile([FILE_A], queues, new Set(['a1']));
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDispose).toEqual([]);
  });

  it('does not leak one builder’s comments onto another’s same-named file', () => {
    // Builder B has a file with the same repo-relative path as A's commented
    // file; A's comment must only mount on A's fsPath.
    const bSamePath: RegisteredFile = { fsPath: '/wt/b/src/x.ts', builderId: 'B', relPath: 'src/x.ts' };
    const queues = new Map([['A', [comment('a1', 'src/x.ts')]]]);
    const plan = planThreadReconcile([bSamePath], queues, new Set());
    expect(plan.toCreate).toEqual([]);
  });

  it('disposes threads whose comment left the queue (submit / delete)', () => {
    const queues = new Map([['A', [comment('a2', 'src/x.ts')]]]);
    const plan = planThreadReconcile([FILE_A], queues, new Set(['a1', 'a2']));
    expect(plan.toDispose).toEqual(['a1']);
    expect(plan.toCreate).toEqual([]);
  });

  it('disposes threads whose file left the diff session (session swap)', () => {
    const queues = new Map([['A', [comment('a1', 'src/x.ts')]]]);
    const plan = planThreadReconcile([FILE_B], queues, new Set(['a1']));
    expect(plan.toDispose).toEqual(['a1']);
  });

  it('mount target carries the registered fsPath (threads anchor on the right side)', () => {
    const queues = new Map([['A', [comment('a1', 'src/x.ts')]]]);
    const plan = planThreadReconcile([FILE_A], queues, new Set());
    expect(plan.toCreate[0]).toMatchObject({ fsPath: '/wt/a/src/x.ts', builderId: 'A' });
  });
});

describe('deriveWorktreePath', () => {
  it('strips the relPath suffix from the entry fsPath', () => {
    expect(deriveWorktreePath('/repo/.builders/pir-9/src/x.ts', 'src/x.ts', '/'))
      .toBe('/repo/.builders/pir-9');
  });

  it('handles Windows separators', () => {
    expect(deriveWorktreePath('C:\\repo\\.builders\\pir-9\\src\\x.ts', 'src/x.ts', '\\'))
      .toBe('C:\\repo\\.builders\\pir-9');
  });

  it('returns null instead of guessing when the suffix does not match', () => {
    expect(deriveWorktreePath('/somewhere/else.ts', 'src/x.ts', '/')).toBeNull();
  });
});
