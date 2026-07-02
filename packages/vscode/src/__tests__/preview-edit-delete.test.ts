/**
 * Regression tests for #1055: the markdown-preview host must edit / delete a review marker by its
 * own physical file line, verifying the marker still matches (author + body-prefix) before writing.
 * Covers the acceptance criteria: edit/delete of a stacked second-of-three, the race condition
 * (marker moved between click and write), delete-single, and a mismatched expected shape.
 *
 * We drive the exported `editReviewMarker` / `deleteReviewMarker` directly with a mocked `vscode`
 * (the established pattern from plan-review-append.test.ts) and inspect the `WorkspaceEdit`
 * operations + the race refresh/notify side effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  class WorkspaceEdit {
    replaces: Array<{ uri: unknown; range: Range; text: string }> = [];
    deletes: Array<{ uri: unknown; range: Range }> = [];
    replace(uri: unknown, range: Range, text: string): void {
      this.replaces.push({ uri, range, text });
    }
    delete(uri: unknown, range: Range): void {
      this.deletes.push({ uri, range });
    }
  }
  return {
    Position,
    Range,
    WorkspaceEdit,
    workspace: {
      applyEdit: vi.fn(async () => true),
    },
    window: {
      showInformationMessage: vi.fn(async () => undefined),
    },
  };
});

const vscode = (await import('vscode')) as unknown as {
  workspace: { applyEdit: ReturnType<typeof vi.fn> };
  window: { showInformationMessage: ReturnType<typeof vi.fn> };
};
const { editReviewMarker, deleteReviewMarker } = await import('../markdown-preview/preview-provider.js');

/** A minimal TextDocument backed by a plain string. */
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

/** The single WorkspaceEdit applied during the last call (replace or delete). */
function lastEdit() {
  const calls = vscode.workspace.applyEdit.mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as {
    replaces: Array<{ range: { start: { line: number }; end: { line: number; character: number } }; text: string }>;
    deletes: Array<{ range: { start: { line: number }; end: { line: number; character: number } } }>;
  }) : null;
}

// Three markers stacked on one block (lines 1, 2, 3), all anchored to the heading on line 0.
const STACK = [
  '## Heading', // 0
  '<!-- REVIEW(@bob): first -->', // 1
  '<!-- REVIEW(@carol): second -->', // 2
  '<!-- REVIEW(@dave): third -->', // 3
  'body', // 4
].join('\n');

describe('preview host editReviewMarker (#1055)', () => {
  beforeEach(() => {
    vscode.workspace.applyEdit.mockClear();
    vscode.window.showInformationMessage.mockClear();
  });

  it('edits the second-of-three, rewriting only its line and preserving its author', async () => {
    const doc = makeDoc(STACK);
    const refresh = vi.fn();

    await editReviewMarker(doc as never, 2, 'carol', 'second', 'second EDITED', refresh);

    const edit = lastEdit();
    expect(edit?.deletes).toHaveLength(0);
    expect(edit?.replaces).toHaveLength(1);
    // Only marker line #2 is touched.
    expect(edit?.replaces[0].range.start.line).toBe(2);
    expect(edit?.replaces[0].range.end.line).toBe(2);
    // Author preserved, body updated.
    expect(edit?.replaces[0].text).toBe('<!-- REVIEW(@carol): second EDITED -->');
    expect(refresh).not.toHaveBeenCalled();
    expect(doc.save).toHaveBeenCalled();
  });

  it('refuses to edit when the marker moved between click and write (race), refreshing + notifying', async () => {
    const doc = makeDoc(STACK);
    const refresh = vi.fn();

    // The card thought line #2 was carol/"second"; the file now has dave/"third" there (a marker
    // was removed above, shifting the stack). The expected shape no longer matches.
    await editReviewMarker(doc as never, 2, 'carol', 'second... but stale', 'new body', refresh);

    // Wrong assumption caught: nothing written, refresh + info message fired.
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses to edit a mismatched shape (line points at a non-marker), cleanly', async () => {
    const doc = makeDoc(STACK);
    const refresh = vi.fn();

    await editReviewMarker(doc as never, 0, 'bob', 'first', 'x', refresh); // line 0 is the heading, not a marker

    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty new body', async () => {
    const doc = makeDoc(STACK);
    const refresh = vi.fn();
    await editReviewMarker(doc as never, 1, 'bob', 'first', '   ', refresh);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('preview host deleteReviewMarker (#1055)', () => {
  beforeEach(() => {
    vscode.workspace.applyEdit.mockClear();
    vscode.window.showInformationMessage.mockClear();
  });

  it('deletes a single marker: the whole line including its trailing newline', async () => {
    const doc = makeDoc(['## Heading', '<!-- REVIEW(@bob): only -->', 'body'].join('\n'));
    const refresh = vi.fn();

    await deleteReviewMarker(doc as never, 1, 'bob', 'only', refresh);

    const edit = lastEdit();
    expect(edit?.replaces).toHaveLength(0);
    expect(edit?.deletes).toHaveLength(1);
    // From (1,0) to (2,0): the marker line plus its newline.
    expect(edit?.deletes[0].range.start.line).toBe(1);
    expect(edit?.deletes[0].range.end.line).toBe(2);
    expect(edit?.deletes[0].range.end.character).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('deletes the second-of-three, removing only marker line #2', async () => {
    const doc = makeDoc(STACK);
    const refresh = vi.fn();

    await deleteReviewMarker(doc as never, 2, 'carol', 'second', refresh);

    const edit = lastEdit();
    expect(edit?.deletes).toHaveLength(1);
    expect(edit?.deletes[0].range.start.line).toBe(2);
    expect(edit?.deletes[0].range.end.line).toBe(3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses to delete on a race (expected author no longer matches), refreshing + notifying', async () => {
    const doc = makeDoc(STACK);
    const refresh = vi.fn();

    await deleteReviewMarker(doc as never, 2, 'bob', 'second', refresh); // line 2 is carol, not bob

    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('deletes a marker on the last line (no trailing newline) without over-running the range', async () => {
    const doc = makeDoc(['para', '<!-- REVIEW(@bob): last -->'].join('\n')); // marker is the final line
    const refresh = vi.fn();

    await deleteReviewMarker(doc as never, 1, 'bob', 'last', refresh);

    const edit = lastEdit();
    expect(edit?.deletes).toHaveLength(1);
    expect(edit?.deletes[0].range.start.line).toBe(1);
    // No line 2 to reach; the range ends at the marker line's own end.
    expect(edit?.deletes[0].range.end.line).toBe(1);
  });
});
