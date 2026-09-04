/**
 * #1592 — restored-preview recovery.
 *
 * A codev-issue preview tab VSCode restores on launch has an open document but,
 * until fetched, no cache entry. The refresh loop iterates `openIssueDocIds()`
 * (the open documents), not just cache keys, so such a tab is filled once Tower
 * connects instead of staying stuck on "Content unavailable". These tests pin
 * the enumeration: it returns codev-issue ids from open documents and ignores
 * every other scheme.
 */

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ docs: [] as Array<{ uri: { scheme: string; path: string } }> }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (): { dispose(): void } => ({ dispose() {} });
    fire(): void {}
    dispose(): void {}
  },
  ViewColumn: { One: 1, Two: 2 },
  Uri: { parse: (s: string): { toString(): string } => ({ toString: () => s }) },
  workspace: {
    get textDocuments() { return h.docs; },
  },
}));

const { openIssueDocIds } = await import('../commands/view-issue.js');

function doc(scheme: string, path: string): { uri: { scheme: string; path: string } } {
  return { uri: { scheme, path } };
}

describe('openIssueDocIds', () => {
  it('returns the ids of open codev-issue documents', () => {
    h.docs = [doc('codev-issue', '4710.md'), doc('codev-issue', '4765.md')];
    expect(openIssueDocIds()).toEqual(['4710', '4765']);
  });

  it('ignores documents of other schemes (real files, git, output, etc.)', () => {
    h.docs = [
      doc('file', '/repo/src/foo.ts'),
      doc('codev-issue', '4710.md'),
      doc('git', '/repo/src/foo.ts'),
      doc('output', 'extension-output-1'),
    ];
    expect(openIssueDocIds()).toEqual(['4710']);
  });

  it('returns an empty array when no previews are open', () => {
    h.docs = [];
    expect(openIssueDocIds()).toEqual([]);
  });
});
