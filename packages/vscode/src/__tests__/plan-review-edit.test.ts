/**
 * Regression tests for #1055 (editor Comments-API surface): `saveEditReviewComment` rewrites the
 * marker line at the comment's thread anchor with the edited body, preserving the on-disk author,
 * and refuses to write if the anchored line is no longer a REVIEW marker. Covers editing a stacked
 * second-of-three (only its own line changes).
 *
 * Drives the exported `saveEditReviewComment` with a mocked `vscode`, mirroring
 * plan-review-append.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  class MarkdownString {
    constructor(public value: string) {}
  }
  class WorkspaceEdit {
    replaces: Array<{ uri: unknown; range: Range; text: string }> = [];
    replace(uri: unknown, range: Range, text: string): void {
      this.replaces.push({ uri, range, text });
    }
  }
  return {
    Position,
    Range,
    MarkdownString,
    WorkspaceEdit,
    CommentMode: { Editing: 0, Preview: 1 },
    comments: { createCommentController: vi.fn() },
    workspace: {
      openTextDocument: vi.fn(),
      applyEdit: vi.fn(async () => true),
    },
  };
});

const vscode = (await import('vscode')) as unknown as {
  MarkdownString: new (v: string) => { value: string };
  CommentMode: { Editing: number; Preview: number };
  workspace: {
    openTextDocument: ReturnType<typeof vi.fn>;
    applyEdit: ReturnType<typeof vi.fn>;
  };
};
const { saveEditReviewComment } = await import('../comments/plan-review.js');

function makeDoc(text: string) {
  const lines = text.split('\n');
  return {
    uri: { toString: () => 'file:///codev/plans/1.md', fsPath: '/codev/plans/1.md' },
    getText: () => text,
    lineAt: (n: number) => ({ text: lines[n] ?? '' }),
    get lineCount() {
      return lines.length;
    },
    save: vi.fn(async () => true),
  };
}

/** A comment whose parent thread is anchored at `markerLine`, with `newBody` as the edited text. */
function makeComment(doc: ReturnType<typeof makeDoc>, markerLine: number, newBody: string) {
  return {
    body: new vscode.MarkdownString(newBody),
    mode: vscode.CommentMode.Editing,
    author: { name: 'ignored' },
    savedBody: '',
    parent: {
      uri: doc.uri,
      range: { start: { line: markerLine, character: 0 } },
    },
  } as never;
}

function lastReplace() {
  const calls = vscode.workspace.applyEdit.mock.calls;
  const edit = calls[calls.length - 1][0] as {
    replaces: Array<{ range: { start: { line: number } }; text: string }>;
  };
  return edit;
}

const STACK = [
  '## Heading', // 0
  '<!-- REVIEW(@bob): first -->', // 1
  '<!-- REVIEW(@carol): second -->', // 2
  '<!-- REVIEW(@dave): third -->', // 3
].join('\n');

describe('saveEditReviewComment (#1055)', () => {
  beforeEach(() => {
    vscode.workspace.openTextDocument.mockReset();
    vscode.workspace.applyEdit.mockClear();
  });

  it('rewrites the marker line preserving the on-disk author and updating the body', async () => {
    const doc = makeDoc('# Heading\n<!-- REVIEW(@amr): old text -->');
    vscode.workspace.openTextDocument.mockResolvedValue(doc);

    await saveEditReviewComment(makeComment(doc, 1, 'new text'));

    const edit = lastReplace();
    expect(edit.replaces).toHaveLength(1);
    expect(edit.replaces[0].range.start.line).toBe(1);
    // Author @amr is read off the existing marker, NOT from the comment (whose author was 'ignored').
    expect(edit.replaces[0].text).toBe('<!-- REVIEW(@amr): new text -->');
  });

  it('edits the second-of-three, touching only its own line', async () => {
    const doc = makeDoc(STACK);
    vscode.workspace.openTextDocument.mockResolvedValue(doc);

    await saveEditReviewComment(makeComment(doc, 2, 'second EDITED'));

    const edit = lastReplace();
    expect(edit.replaces).toHaveLength(1);
    expect(edit.replaces[0].range.start.line).toBe(2);
    expect(edit.replaces[0].text).toBe('<!-- REVIEW(@carol): second EDITED -->');
  });

  it('refuses to write if the anchored line is no longer a marker', async () => {
    const doc = makeDoc('# Heading\nplain paragraph now');
    vscode.workspace.openTextDocument.mockResolvedValue(doc);

    await saveEditReviewComment(makeComment(doc, 1, 'whatever'));

    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });
});
