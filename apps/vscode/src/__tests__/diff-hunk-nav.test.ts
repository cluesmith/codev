/**
 * #1546 — viewport-anchored hunk stepping.
 *
 * The pure anchor decision is the behavior: an on-screen cursor is left alone
 * (unscrolled stepping identical to the built-in), an off-screen one moves to the
 * top visible line for next / bottom visible line for previous. The glue test
 * pins that the move lands on the MODIFIED side of the diff tab (the side the
 * built-in reads) and that the built-in always runs after it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn();
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

const vscode = await import('vscode');
const { viewportAnchorLine, diffStepHunk } = await import('../commands/diff-hunk-nav.js');

describe('viewportAnchorLine', () => {
  const view = [{ start: 100, end: 140 }];

  it('leaves an on-screen cursor alone in both directions', () => {
    expect(viewportAnchorLine(120, view, 1)).toBeUndefined();
    expect(viewportAnchorLine(120, view, -1)).toBeUndefined();
  });

  it('treats the first and last visible lines as on-screen', () => {
    expect(viewportAnchorLine(100, view, 1)).toBeUndefined();
    expect(viewportAnchorLine(140, view, -1)).toBeUndefined();
  });

  it('anchors next to the top visible line when the cursor is above the viewport', () => {
    expect(viewportAnchorLine(10, view, 1)).toBe(100);
  });

  it('anchors next to the top visible line when the cursor is below the viewport', () => {
    expect(viewportAnchorLine(500, view, 1)).toBe(100);
  });

  it('anchors previous to the bottom visible line', () => {
    expect(viewportAnchorLine(10, view, -1)).toBe(140);
    expect(viewportAnchorLine(500, view, -1)).toBe(140);
  });

  it('spans folded/hidden regions: top of the first range, bottom of the last', () => {
    const split = [{ start: 100, end: 110 }, { start: 200, end: 220 }];
    expect(viewportAnchorLine(150, split, 1)).toBe(100);
    expect(viewportAnchorLine(150, split, -1)).toBe(220);
    expect(viewportAnchorLine(205, split, 1)).toBeUndefined();
  });

  it('leaves the cursor alone when nothing is visible', () => {
    expect(viewportAnchorLine(10, [], 1)).toBeUndefined();
  });
});

interface FakeEditor {
  document: { uri: { toString(): string } };
  visibleRanges: Array<{ start: { line: number }; end: { line: number } }>;
  selection: { active: { line: number } };
}

function fakeEditor(uri: string, cursorLine: number, start: number, end: number): FakeEditor {
  return {
    document: { uri: { toString: () => uri } },
    visibleRanges: [{ start: { line: start }, end: { line: end } }],
    selection: { active: { line: cursorLine } },
  };
}

describe('diffStepHunk', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    state.activeInput = undefined;
    state.visibleTextEditors = [];
    state.activeTextEditor = undefined;
  });

  it('re-anchors the modified side to the viewport top, then runs nextChange', async () => {
    const original = fakeEditor('git:/a.ts', 5, 100, 140);
    const modified = fakeEditor('file:/a.ts', 5, 100, 140);
    const DiffInput = vscode.TabInputTextDiff as unknown as new (
      original: { toString(): string }, modified: { toString(): string }) => unknown;
    state.activeInput = new DiffInput({ toString: () => 'git:/a.ts' }, { toString: () => 'file:/a.ts' });
    state.visibleTextEditors = [original, modified];
    state.activeTextEditor = original; // focus on the left side

    await diffStepHunk(1);

    expect(modified.selection.active.line).toBe(100);
    expect(original.selection.active.line).toBe(5);
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.compareEditor.nextChange');
  });

  it('re-anchors to the viewport bottom, then runs previousChange', async () => {
    const editor = fakeEditor('file:/a.ts', 5, 100, 140);
    state.activeTextEditor = editor;

    await diffStepHunk(-1);

    expect(editor.selection.active.line).toBe(140);
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.compareEditor.previousChange');
  });

  it('leaves an on-screen cursor untouched and delegates unchanged', async () => {
    const editor = fakeEditor('file:/a.ts', 120, 100, 140);
    const before = editor.selection;
    state.activeTextEditor = editor;

    await diffStepHunk(1);

    expect(editor.selection).toBe(before);
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.compareEditor.nextChange');
  });

  it('still delegates with no editor', async () => {
    await diffStepHunk(1);
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.compareEditor.nextChange');
  });
});
