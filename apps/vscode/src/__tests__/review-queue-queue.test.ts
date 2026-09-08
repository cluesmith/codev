/**
 * Pure queue helpers for the pending review-comment queue (#1037): schema
 * round-trip and tolerant parsing, immutable mutations, the exact submit
 * packaging format (plan decision 2), bracketed-paste wrapping (a raw `\n` on
 * the PTY stdin would submit the builder's prompt mid-message), and the
 * idempotent `info/exclude` managed block (plan decision 8).
 */

import { describe, it, expect } from 'vitest';
import {
  addComment,
  buildSubmitMessage,
  editComment,
  formatCommentRef,
  mergeExcludeBlock,
  parseQueueFile,
  QUEUE_FILE_RELPATH,
  removeComments,
  serializeQueueFile,
  wrapBracketedPaste,
  type PendingComment,
} from '../review-queue/queue.js';

function comment(overrides: Partial<PendingComment> = {}): PendingComment {
  return {
    id: 'id-1',
    createdAt: '2026-08-06T10:00:00Z',
    file: 'packages/foo/src/bar.ts',
    lineRange: { start: 42, end: 58 },
    body: 'the early return here is wrong',
    ...overrides,
  };
}

describe('parse/serialize round-trip', () => {
  it('round-trips a queue through serialize + parse', () => {
    const comments = [comment(), comment({ id: 'id-2', lineRange: null, body: 'whole-file note' })];
    const raw = serializeQueueFile('pir-859', comments);
    expect(parseQueueFile(raw)).toEqual(comments);
  });

  it('records version and builderId in the on-disk shape', () => {
    const parsed = JSON.parse(serializeQueueFile('pir-859', []));
    expect(parsed.version).toBe(1);
    expect(parsed.builderId).toBe('pir-859');
    expect(parsed.comments).toEqual([]);
  });
});

describe('tolerant parsing', () => {
  it('reads corrupt JSON as empty', () => {
    expect(parseQueueFile('{not json')).toEqual([]);
    expect(parseQueueFile('')).toEqual([]);
  });

  it('reads wrong top-level shapes as empty', () => {
    expect(parseQueueFile('null')).toEqual([]);
    expect(parseQueueFile('[]')).toEqual([]);
    expect(parseQueueFile('{"comments": "nope"}')).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      version: 1,
      builderId: 'x',
      comments: [comment(), { id: '', body: 'missing everything' }, 42],
    });
    expect(parseQueueFile(raw)).toEqual([comment()]);
  });

  it('ignores unknown fields on entries (forward compatibility)', () => {
    const raw = JSON.stringify({
      version: 1,
      builderId: 'x',
      comments: [{ ...comment(), diffContext: '@@ -1 +1 @@' }],
    });
    const parsed = parseQueueFile(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('id-1');
  });
});

describe('mutations', () => {
  it('add appends without mutating the input', () => {
    const base = [comment()];
    const next = addComment(base, comment({ id: 'id-2' }));
    expect(next.map(c => c.id)).toEqual(['id-1', 'id-2']);
    expect(base).toHaveLength(1);
  });

  it('edit replaces only the matching body', () => {
    const base = [comment(), comment({ id: 'id-2' })];
    const next = editComment(base, 'id-2', 'revised');
    expect(next[0]!.body).toBe('the early return here is wrong');
    expect(next[1]!.body).toBe('revised');
  });

  it('removeComments drops exactly the given ids', () => {
    const base = [comment(), comment({ id: 'id-2' }), comment({ id: 'id-3' })];
    const next = removeComments(base, ['id-1', 'id-3']);
    expect(next.map(c => c.id)).toEqual(['id-2']);
  });
});

describe('submit packaging', () => {
  it('formats range, single-line, and whole-file refs', () => {
    expect(formatCommentRef('a/b.ts', { start: 42, end: 58 })).toBe('a/b.ts:L42-L58');
    expect(formatCommentRef('a/b.ts', { start: 7, end: 7 })).toBe('a/b.ts:L7');
    expect(formatCommentRef('a/b.ts', null)).toBe('a/b.ts');
  });

  it('builds the exact sectioned message', () => {
    const msg = buildSubmitMessage([
      comment({ body: 'first note\nwith a second line' }),
      comment({ id: 'id-2', file: 'apps/x.ts', lineRange: { start: 7, end: 7 }, body: 'second note' }),
    ]);
    expect(msg).toBe(
      'Review feedback (2 comments):\n\n' +
      '### packages/foo/src/bar.ts:L42-L58\nfirst note\nwith a second line\n\n' +
      '### apps/x.ts:L7\nsecond note\n',
    );
  });

  it('uses the singular for one comment', () => {
    expect(buildSubmitMessage([comment()])).toMatch(/^Review feedback \(1 comment\):/);
  });
});

describe('wrapBracketedPaste', () => {
  it('wraps in paste escapes and converts newlines to carriage returns', () => {
    expect(wrapBracketedPaste('a\nb\r\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~');
  });
});

describe('mergeExcludeBlock', () => {
  it('appends the managed block to existing content', () => {
    const merged = mergeExcludeBlock('node_modules/\n');
    expect(merged).toBe(
      'node_modules/\n' +
      '# codev: builder worktree local state (managed block)\n' +
      '.builder-*\n' +
      `${QUEUE_FILE_RELPATH}\n`,
    );
  });

  it('adds a separating newline when existing content lacks one', () => {
    expect(mergeExcludeBlock('node_modules/')).toMatch(/^node_modules\/\n# codev/);
  });

  it('is idempotent: returns null when the block is already present', () => {
    const merged = mergeExcludeBlock('');
    expect(merged).not.toBeNull();
    expect(mergeExcludeBlock(merged!)).toBeNull();
  });

  it('the family glob does not cover the .builders directory itself', () => {
    // `.builder-*` requires a dash after "builder": scaffolding files match,
    // the worktree parent directory `.builders` must not.
    const glob = /^\.builder-.*$/;
    expect('.builder-prompt.txt').toMatch(glob);
    expect('.builder-session-id').toMatch(glob);
    expect('.builders').not.toMatch(glob);
  });
});
