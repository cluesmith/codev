/**
 * #1546 — viewport-anchored hunk stepping (`diffStepHunk` in commands/diff-nav.ts).
 *
 * The pure anchor decision is the behavior: an on-screen caret is left alone
 * (unscrolled stepping identical to the built-in), an off-screen one moves to
 * just above the viewport for next / just below it for previous. The glue tests
 * pin the shared tracked-diff guard: the move lands on the MODIFIED side of a
 * per-file builder diff (the side the built-in reads), a plain editor or the
 * multi-file View Diff keeps its caret, and the built-in always runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn();
const registered = new Set<string>();
const state: {
  activeInput: unknown;
  visibleTextEditors: unknown[];
  activeTextEditor: unknown;
} = { activeInput: undefined, visibleTextEditors: [], activeTextEditor: undefined };

vi.mock('vscode', () => {
  class Position { constructor(public line: number, public character: number) {} }
  class Selection {
    constructor(public anchor: Position, public active: Position) {}
  }
  class TabInputTextDiff {
    constructor(public original: { toString(): string }, public modified: { toString(): string }) {}
  }
  return {
    Position,
    Selection,
    TabInputTextDiff,
    commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
    window: {
      tabGroups: { get activeTabGroup() { return { activeTab: { input: state.activeInput } }; } },
      get visibleTextEditors() { return state.visibleTextEditors; },
      get activeTextEditor() { return state.activeTextEditor; },
    },
  };
});
vi.mock('../diff-inject-codelens.js', () => ({
  getDiffInjectEntry: (fsPath: string) => (registered.has(fsPath) ? { fsPath } : undefined),
}));
vi.mock('../commands/view-diff.js', () => ({ openBuilderFileDiff: vi.fn() }));
vi.mock('../builder-lookup.js', () => ({ builderWithWorktree: vi.fn() }));
vi.mock('../builders-config.js', () => ({ readBuildersFileViewAsTree: vi.fn(() => false) }));

const vscode = await import('vscode');
const { viewportAnchorLine, diffStepHunk, diffFirstHunk } = await import('../commands/diff-nav.js');

const NEXT = 'workbench.action.compareEditor.nextChange';
const PREV = 'workbench.action.compareEditor.previousChange';

describe('viewportAnchorLine', () => {
  const view = [{ start: 100, end: 140 }];

  it('leaves an on-screen caret alone in both directions', () => {
    expect(viewportAnchorLine(120, view, 1)).toBeUndefined();
    expect(viewportAnchorLine(120, view, -1)).toBeUndefined();
  });

  it('treats the first and last visible lines as on-screen', () => {
    expect(viewportAnchorLine(100, view, 1)).toBeUndefined();
    expect(viewportAnchorLine(140, view, -1)).toBeUndefined();
  });

  it('anchors next just above the viewport, whether the caret is above or below it', () => {
    expect(viewportAnchorLine(10, view, 1)).toBe(99);
    expect(viewportAnchorLine(500, view, 1)).toBe(99);
  });

  it('anchors previous just below the viewport', () => {
    expect(viewportAnchorLine(10, view, -1)).toBe(141);
    expect(viewportAnchorLine(500, view, -1)).toBe(141);
  });

  it('never anchors above line 0', () => {
    expect(viewportAnchorLine(500, [{ start: 0, end: 40 }], 1)).toBe(0);
  });

  it('spans folded/hidden regions: top of the first range, bottom of the last', () => {
    const split = [{ start: 100, end: 110 }, { start: 200, end: 220 }];
    expect(viewportAnchorLine(150, split, 1)).toBe(99);
    expect(viewportAnchorLine(150, split, -1)).toBe(221);
    expect(viewportAnchorLine(205, split, 1)).toBeUndefined();
  });

  // The built-in (VS Code 1.140 DiffEditorWidget.goToDiff) reads the MODIFIED
  // caret and picks the first hunk whose 1-based start line is STRICTLY greater
  // than the caret's (next) / strictly less (previous). Modelled here to pin why
  // the anchor sits one line outside the viewport.
  function builtinNext(caretLine0: number, hunkStarts0: number[]): number {
    const caret1 = caretLine0 + 1;
    return hunkStarts0.find(start0 => start0 + 1 > caret1) ?? hunkStarts0[0];
  }

  it('lands next on a hunk starting exactly at the top visible line (not skipped)', () => {
    const anchor = viewportAnchorLine(10, view, 1)!;
    expect(builtinNext(anchor, [20, 100, 300])).toBe(100);
    // Anchoring ON the top line would have skipped it.
    expect(builtinNext(100, [20, 100, 300])).toBe(300);
  });

  it('steps past a hunk that starts above the viewport but is partially visible (no hunk-aware logic, by design)', () => {
    const anchor = viewportAnchorLine(10, view, 1)!;
    expect(builtinNext(anchor, [20, 95, 300])).toBe(300);
  });

  it('leaves the caret alone when nothing is visible', () => {
    expect(viewportAnchorLine(10, [], 1)).toBeUndefined();
  });
});

interface FakeEditor {
  document: { uri: { fsPath: string; toString(): string }; lineCount: number };
  visibleRanges: Array<{ start: { line: number }; end: { line: number } }>;
  selection: { active: { line: number } };
}

function fakeEditor(uri: string, caretLine: number, start: number, end: number): FakeEditor {
  const fsPath = uri.replace(/^[a-z-]+:/, '');
  return {
    document: { uri: { fsPath, toString: () => uri }, lineCount: 400 },
    visibleRanges: [{ start: { line: start }, end: { line: end } }],
    selection: { active: { line: caretLine } },
  };
}

/** A per-file builder diff tab: original + modified editors, modified registered. */
function openBuilderDiff(caretLine: number, start: number, end: number) {
  const original = fakeEditor('codev-diff:/a.ts', caretLine, start, end);
  const modified = fakeEditor('file:/a.ts', caretLine, start, end);
  const DiffInput = vscode.TabInputTextDiff as unknown as new (
    original: { toString(): string }, modified: { toString(): string }) => unknown;
  state.activeInput = new DiffInput({ toString: () => 'codev-diff:/a.ts' }, { toString: () => 'file:/a.ts' });
  state.visibleTextEditors = [original, modified];
  state.activeTextEditor = modified;
  registered.add('/a.ts');
  return { original, modified };
}

describe('diffStepHunk', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    registered.clear();
    state.activeInput = undefined;
    state.visibleTextEditors = [];
    state.activeTextEditor = undefined;
  });

  it('re-anchors the modified side above the viewport, then runs nextChange', async () => {
    const { modified } = openBuilderDiff(5, 100, 140);
    await diffStepHunk(1);
    expect(modified.selection.active.line).toBe(99);
    expect(executeCommand).toHaveBeenCalledWith(NEXT);
  });

  it('re-anchors the modified side even with the original side focused', async () => {
    const { original, modified } = openBuilderDiff(5, 100, 140);
    state.activeTextEditor = original;
    await diffStepHunk(1);
    expect(modified.selection.active.line).toBe(99);
    expect(original.selection.active.line).toBe(5);
  });

  it('re-anchors below the viewport, then runs previousChange', async () => {
    const { modified } = openBuilderDiff(5, 100, 140);
    await diffStepHunk(-1);
    expect(modified.selection.active.line).toBe(141);
    expect(executeCommand).toHaveBeenCalledWith(PREV);
  });

  it('clamps the previous anchor to the last line', async () => {
    const { modified } = openBuilderDiff(5, 360, 399);
    await diffStepHunk(-1);
    expect(modified.selection.active.line).toBe(399);
  });

  it('leaves an on-screen caret untouched and delegates unchanged', async () => {
    const { modified } = openBuilderDiff(120, 100, 140);
    const before = modified.selection;
    await diffStepHunk(1);
    expect(modified.selection).toBe(before);
    expect(executeCommand).toHaveBeenCalledWith(NEXT);
  });

  it('not a diff editor: caret untouched, built-in still runs (as before #1546)', async () => {
    const plain = fakeEditor('file:/a.ts', 5, 100, 140);
    const before = plain.selection;
    state.activeTextEditor = plain;
    state.visibleTextEditors = [plain];
    registered.add('/a.ts'); // even a worktree file open in a plain tab
    await diffStepHunk(1);
    expect(plain.selection).toBe(before);
    expect(executeCommand).toHaveBeenCalledWith(NEXT);
  });

  it('an untracked per-file diff delegates unchanged', async () => {
    const { modified } = openBuilderDiff(5, 100, 140);
    registered.clear();
    const before = modified.selection;
    await diffStepHunk(1);
    expect(modified.selection).toBe(before);
    expect(executeCommand).toHaveBeenCalledWith(NEXT);
  });
});

describe('diffFirstHunk (shared guard)', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    registered.clear();
    state.activeInput = undefined;
    state.visibleTextEditors = [];
    state.activeTextEditor = undefined;
  });

  it('puts the modified caret at the top, then runs nextChange', async () => {
    const { original, modified } = openBuilderDiff(250, 230, 270);
    state.activeTextEditor = original;
    await diffFirstHunk();
    expect(modified.selection.active.line).toBe(0);
    expect(executeCommand).toHaveBeenCalledWith(NEXT);
  });

  it('is a no-op outside a tracked diff', async () => {
    state.activeTextEditor = fakeEditor('file:/b.ts', 5, 0, 40);
    await diffFirstHunk();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
