/**
 * Unit tests for the pure Code Review projection (#1559): queue state (pending + sent) + diff-session
 * files → panel payload.
 */

import { describe, it, expect } from 'vitest';
import { deriveCodeReview } from '../contextual-panel/code-review.js';
import type { PendingComment, SentComment } from '../review-queue/queue.js';

function comment(over: Partial<PendingComment> & { id: string; file: string }): PendingComment {
  return { createdAt: '2026-10-05T00:00:00Z', lineRange: null, body: 'body', ...over };
}

describe('deriveCodeReview', () => {
  it('is the honest empty summary with no queue and no diff files', () => {
    expect(deriveCodeReview({ comments: [], sent: [] }, [])).toEqual({ comments: [], sent: [], files: [], isEmpty: true });
  });

  it('projects comments in queue order with their anchor refs', () => {
    const summary = deriveCodeReview(
      { sent: [], comments: [
        comment({ id: 'a', file: 'src/x.ts', lineRange: { start: 42, end: 58 }, body: 'range' }),
        comment({ id: 'b', file: 'src/x.ts', lineRange: { start: 7, end: 7 }, body: 'line' }),
        comment({ id: 'c', file: 'README.md', body: 'whole file' }),
      ] },
      [],
    );
    expect(summary.comments).toEqual([
      { id: 'a', file: 'src/x.ts', ref: 'src/x.ts:L42-L58', body: 'range' },
      { id: 'b', file: 'src/x.ts', ref: 'src/x.ts:L7', body: 'line' },
      { id: 'c', file: 'README.md', ref: 'README.md', body: 'whole file' },
    ]);
    expect(summary.isEmpty).toBe(false);
  });

  it('lists diff files in session order, deduplicated, then commented files the session lacks', () => {
    const summary = deriveCodeReview(
      { sent: [], comments: [comment({ id: 'a', file: 'src/b.ts' }), comment({ id: 'b', file: 'src/b.ts' }), comment({ id: 'c', file: 'src/z.ts' })] },
      ['src/a.ts', 'src/b.ts', 'src/a.ts', ''],
    );
    expect(summary.files).toEqual([
      { relPath: 'src/a.ts', commentCount: 0 },
      { relPath: 'src/b.ts', commentCount: 2 },
      { relPath: 'src/z.ts', commentCount: 1 },
    ]);
  });

  it('is not empty when only diff files exist (files to review, no comments yet)', () => {
    const summary = deriveCodeReview({ comments: [], sent: [] }, ['src/a.ts']);
    expect(summary.comments).toEqual([]);
    expect(summary.isEmpty).toBe(false);
  });

  it('projects sent-unconfirmed comments separately, excluded from file counts', () => {
    const sent: SentComment = { ...comment({ id: 'old', file: 'src/old.ts', body: 'earlier' }), sentAt: '2026-10-05T01:00:00Z' };
    const summary = deriveCodeReview({ comments: [comment({ id: 'new', file: 'src/new.ts' })], sent: [sent] }, []);
    expect(summary.comments.map((c) => c.id)).toEqual(['new']);
    expect(summary.sent).toEqual([
      { id: 'old', file: 'src/old.ts', ref: 'src/old.ts', body: 'earlier', sentAt: '2026-10-05T01:00:00Z' },
    ]);
    expect(summary.files).toEqual([{ relPath: 'src/new.ts', commentCount: 1 }]);
  });

  it('is not empty when only sent-unconfirmed comments remain', () => {
    const sent: SentComment = { ...comment({ id: 'old', file: 'src/old.ts' }), sentAt: '2026-10-05T01:00:00Z' };
    const summary = deriveCodeReview({ comments: [], sent: [sent] }, []);
    expect(summary.isEmpty).toBe(false);
    expect(summary.files).toEqual([]);
  });
});
