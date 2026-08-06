/**
 * Status-bar Submit Review button (#1037): visible while the active editor is
 * a builder-diff file whose builder has pending comments; shows the live
 * count and triggers `codev.submitReview` for that builder. Hidden otherwise —
 * the palette command remains the anytime entry point.
 */

import * as vscode from 'vscode';
import { getDiffInjectEntry, onDidChangeDiffInjectRegistry } from '../diff-inject-codelens.js';
import type { ReviewQueueStore } from './store.js';

export function activateSubmitReviewStatusBar(
  context: vscode.ExtensionContext,
  store: ReviewQueueStore,
): void {
  // Priority 97: just below the Tower connection item (100) and dev chip (99).
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.command = 'codev.submitReview';

  const update = (): void => {
    const editor = vscode.window.activeTextEditor;
    let entry;
    if (editor) { entry = getDiffInjectEntry(editor.document.uri.fsPath); }
    if (!entry) {
      item.hide();
      return;
    }
    const count = store.count(entry.builderId);
    if (count === 0) {
      item.hide();
      return;
    }
    item.text = `$(comment) Submit Review (${count})`;
    item.tooltip = `Send ${count} pending review comment(s) to builder ${entry.builderId}'s prompt`;
    item.show();
  };

  context.subscriptions.push(
    item,
    vscode.window.onDidChangeActiveTextEditor(update),
    onDidChangeDiffInjectRegistry(update),
    store.onDidChangeQueue(update),
  );
  update();
}
