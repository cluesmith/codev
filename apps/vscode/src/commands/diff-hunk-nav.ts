/**
 * Viewport-anchored hunk stepping in a diff editor (#1546).
 *
 * `codev.diffNextHunk` / `codev.diffPrevHunk` wrap VS Code's built-in
 * `workbench.action.compareEditor.nextChange` / `previousChange`. The built-in
 * steps relative to the modified-side CURSOR, and mouse-wheel scrolling never
 * moves the cursor: land on hunk N, scroll down to read, press next, and it jumps
 * back up to N+1. The wrapper re-anchors first: when the cursor is off-screen it
 * moves (without revealing) to the top visible line for next, the bottom visible
 * line for previous, then delegates. A cursor already on-screen delegates
 * unchanged, so the unscrolled case behaves exactly as the built-in.
 *
 * A hunk partially visible at the viewport top is "the hunk I'm looking at":
 * next from the top line lands on it; a second press advances. No skip logic.
 */

import * as vscode from 'vscode';

export type HunkDirection = 1 | -1;

/** A visible line span, inclusive, 0-based. */
export interface LineSpan {
  start: number;
  end: number;
}

const BUILTIN_STEP: Record<HunkDirection, string> = {
  [1]: 'workbench.action.compareEditor.nextChange',
  [-1]: 'workbench.action.compareEditor.previousChange',
};

/**
 * The line to move the cursor to before stepping, or `undefined` to leave it.
 * Pure (plain numbers) so it unit-tests without a live editor.
 */
export function viewportAnchorLine(
  cursorLine: number,
  visible: readonly LineSpan[],
  direction: HunkDirection,
): number | undefined {
  if (visible.length === 0) { return undefined; }
  if (visible.some(span => cursorLine >= span.start && cursorLine <= span.end)) {
    return undefined;
  }
  if (direction === 1) { return visible[0].start; }
  return visible[visible.length - 1].end;
}

/**
 * The editor whose cursor the built-in reads: the MODIFIED side of the active
 * diff tab, regardless of which side has focus. Falls back to the active editor
 * when the active tab is not a two-sided text diff.
 */
function modifiedSideEditor(): vscode.TextEditor | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    const modified = input.modified.toString();
    const match = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === modified);
    if (match) { return match; }
  }
  return vscode.window.activeTextEditor;
}

/** Step to the next (1) / previous (-1) change, continuing from the viewport. */
export async function diffStepHunk(direction: HunkDirection): Promise<void> {
  const editor = modifiedSideEditor();
  if (editor) {
    const visible = editor.visibleRanges.map(r => ({ start: r.start.line, end: r.end.line }));
    const line = viewportAnchorLine(editor.selection.active.line, visible, direction);
    if (line !== undefined) {
      const anchor = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(anchor, anchor);
    }
  }
  await vscode.commands.executeCommand(BUILTIN_STEP[direction]);
}
