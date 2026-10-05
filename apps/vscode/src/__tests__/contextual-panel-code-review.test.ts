/**
 * Unit tests for the pure review-queue projection (#1559): queue state (pending + sent) → panel
 * payload, and the terminal-id → queue-key mapping across the two builder id spaces.
 */

import { describe, it, expect } from 'vitest';
import { deriveCodeReview, queueBuilderIdFor } from '../contextual-panel/code-review.js';
import type { PendingComment, SentComment } from '../review-queue/queue.js';

function comment(over: Partial<PendingComment> & { id: string; file: string }): PendingComment {
  return { createdAt: '2026-10-05T00:00:00Z', lineRange: null, body: 'body', ...over };
}

function sentComment(over: Partial<PendingComment> & { id: string; file: string }): SentComment {
  return { ...comment(over), sentAt: '2026-10-05T01:00:00Z' };
}

describe('deriveCodeReview', () => {
  it('is the honest empty summary with nothing queued or sent', () => {
    expect(deriveCodeReview({ comments: [], sent: [] })).toEqual({ comments: [], sent: [], files: [], isEmpty: true });
  });

  it('projects comments in queue order with their anchor refs and first line', () => {
    const summary = deriveCodeReview({
      sent: [],
      comments: [
        comment({ id: 'a', file: 'src/x.ts', lineRange: { start: 42, end: 58 }, body: 'range' }),
        comment({ id: 'b', file: 'src/x.ts', lineRange: { start: 7, end: 7 }, body: 'line' }),
        comment({ id: 'c', file: 'README.md', body: 'whole file' }),
      ],
    });
    expect(summary.comments).toEqual([
      { id: 'a', file: 'src/x.ts', line: 42, ref: 'src/x.ts:L42-L58', body: 'range' },
      { id: 'b', file: 'src/x.ts', line: 7, ref: 'src/x.ts:L7', body: 'line' },
      { id: 'c', file: 'README.md', line: null, ref: 'README.md', body: 'whole file' },
    ]);
    expect(summary.isEmpty).toBe(false);
  });

  it('projects sent-unconfirmed comments separately, with their sent time', () => {
    const summary = deriveCodeReview({
      comments: [comment({ id: 'new', file: 'src/new.ts' })],
      sent: [sentComment({ id: 'old', file: 'src/old.ts', lineRange: { start: 9, end: 21 }, body: 'earlier' })],
    });
    expect(summary.comments.map((c) => c.id)).toEqual(['new']);
    expect(summary.sent).toEqual([
      { id: 'old', file: 'src/old.ts', line: 9, ref: 'src/old.ts:L9-L21', body: 'earlier', sentAt: '2026-10-05T01:00:00Z' },
    ]);
  });

  it('lists only commented files, pending then sent order, with per-file counts', () => {
    const summary = deriveCodeReview({
      comments: [comment({ id: 'a', file: 'src/b.ts' }), comment({ id: 'b', file: 'src/b.ts' }), comment({ id: 'c', file: 'src/z.ts' })],
      sent: [sentComment({ id: 'd', file: 'src/old.ts' }), sentComment({ id: 'e', file: 'src/b.ts' })],
    });
    expect(summary.files).toEqual([
      { relPath: 'src/b.ts', pendingCount: 2, sentCount: 1 },
      { relPath: 'src/z.ts', pendingCount: 1, sentCount: 0 },
      { relPath: 'src/old.ts', pendingCount: 0, sentCount: 1 },
    ]);
  });

  it('is not empty when only sent-unconfirmed comments remain', () => {
    const summary = deriveCodeReview({ comments: [], sent: [sentComment({ id: 'old', file: 'src/old.ts' })] });
    expect(summary.isEmpty).toBe(false);
    expect(summary.files).toEqual([{ relPath: 'src/old.ts', pendingCount: 0, sentCount: 1 }]);
  });
});

describe('queueBuilderIdFor (terminal id → review-queue key)', () => {
  const builders = [
    { id: '5189', roleId: 'builder-spir-5189' },
    { id: 'pir-1563', roleId: 'builder-pir-1563' },
  ];

  it("maps a Tower-canonical terminal id to the builder's overview id via its roleId", () => {
    expect(queueBuilderIdFor('builder-spir-5189', builders)).toBe('5189');
    expect(queueBuilderIdFor('BUILDER-PIR-1563', builders)).toBe('pir-1563');
  });

  it('tail-matches a bare id against the canonical roleIds', () => {
    expect(queueBuilderIdFor('1563', builders)).toBe('pir-1563');
  });

  it('falls back to the overview id when a builder has no roleId', () => {
    expect(queueBuilderIdFor('air-77', [{ id: 'air-77', roleId: null }])).toBe('air-77');
  });

  it('returns undefined when nothing matches', () => {
    expect(queueBuilderIdFor('builder-spir-9999', builders)).toBeUndefined();
  });

  it('refuses a bare numeric id that tail-matches two protocol ids (e.g. two workspaces) rather than guess', () => {
    // Within one workspace a number maps to one builder, so this cannot arise from a single overview;
    // if candidates from two workspaces were ever combined, the ambiguous match must show no queue.
    const twoWorkspaces = [
      { id: '5189', roleId: 'builder-spir-5189' },
      { id: '5189', roleId: 'builder-air-5189' },
    ];
    expect(queueBuilderIdFor('5189', twoWorkspaces)).toBeUndefined();
    // The fully-qualified terminal ids still resolve exactly.
    expect(queueBuilderIdFor('builder-air-5189', twoWorkspaces)).toBe('5189');
  });
});
