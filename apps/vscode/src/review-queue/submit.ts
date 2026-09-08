/**
 * Submit Review + Discard (#1037): flush a builder's pending comment queue to
 * its PTY as ONE batched message, or drop the queue without sending.
 *
 * Submit packages the queue (`buildSubmitMessage`), opens/reveals the builder
 * terminal through the same open-and-recover flow as #789's forward command
 * (plan decision 4), and types the message into the prompt buffer WITHOUT
 * pressing Enter — the reviewer reads the packaged message and submits it
 * themselves (deliberate human-in-the-loop step). The message is wrapped in
 * bracketed-paste escapes because the PTY receives `sendText` bytes raw: an
 * unwrapped `\n` would act as Enter and submit the prompt mid-message.
 *
 * Only the ids that were packaged are removed on success, so a comment queued
 * while the message sits unsent in the prompt buffer survives to the next
 * cycle rather than being silently flushed.
 */

import * as vscode from 'vscode';
import { buildSubmitMessage, wrapBracketedPaste } from './queue.js';
import { getDiffInjectEntry } from '../diff-inject-codelens.js';
import type { ReviewQueueStore } from './store.js';
import type { TerminalManager } from '../terminal-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

export interface SubmitDeps {
  store: ReviewQueueStore;
  terminalManager: TerminalManager;
  overviewCache: OverviewCache;
}

/**
 * Resolve which builder a queue action targets: the owner of the active
 * builder-diff file wins; otherwise the sole builder with pending comments;
 * otherwise a QuickPick over builders with non-empty queues. Returns
 * undefined on cancel / nothing pending.
 */
export async function resolveTargetBuilder(store: ReviewQueueStore): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const entry = getDiffInjectEntry(editor.document.uri.fsPath);
    if (entry) { return entry.builderId; }
  }
  const pending = store.buildersWithPending();
  if (pending.length === 0) {
    vscode.window.setStatusBarMessage('Codev: No pending review comments', 3000);
    return undefined;
  }
  if (pending.length === 1) { return pending[0]; }
  const picked = await vscode.window.showQuickPick(
    pending.map(id => ({ label: id, description: `${store.count(id)} pending` })),
    { placeHolder: 'Select the builder whose review to act on' },
  );
  return picked?.label;
}

export async function submitReview(deps: SubmitDeps, builderIdArg?: string): Promise<void> {
  let builderId = builderIdArg;
  if (!builderId) { builderId = await resolveTargetBuilder(deps.store); }
  if (!builderId) { return; }

  registerWorktreeFromOverview(deps, builderId);
  const comments = await deps.store.load(builderId);
  if (comments.length === 0) {
    vscode.window.setStatusBarMessage(`Codev: No pending comments for ${builderId}`, 3000);
    return;
  }

  const message = buildSubmitMessage(comments);
  const resolvedId = await deps.terminalManager.openBuilderByRoleOrId(builderId, true);
  if (!resolvedId || !deps.terminalManager.injectBuilderText(resolvedId, wrapBracketedPaste(message))) {
    vscode.window.showWarningMessage('Codev: Builder terminal not available — review comments kept in the queue');
    return;
  }
  await deps.store.remove(builderId, comments.map(c => c.id));
  vscode.window.setStatusBarMessage(
    `Codev: ${comments.length} review comment(s) placed in ${builderId}'s prompt — press Enter there to send`,
    5000,
  );
}

export async function discardReviewComments(deps: SubmitDeps, builderIdArg?: string): Promise<void> {
  let builderId = builderIdArg;
  if (!builderId) { builderId = await resolveTargetBuilder(deps.store); }
  if (!builderId) { return; }

  registerWorktreeFromOverview(deps, builderId);
  const comments = await deps.store.load(builderId);
  if (comments.length === 0) {
    vscode.window.setStatusBarMessage(`Codev: No pending comments for ${builderId}`, 3000);
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Discard ${comments.length} pending review comment(s) for ${builderId}?`,
    { modal: true },
    'Discard',
  );
  if (confirm !== 'Discard') { return; }
  await deps.store.clear(builderId);
}

/**
 * Make sure the store knows the builder's worktree even when no diff has been
 * opened this session (palette-driven submit after a reload): the Tower
 * overview's `worktreePath` is authoritative.
 */
function registerWorktreeFromOverview(deps: SubmitDeps, builderId: string): void {
  if (deps.store.getWorktreePath(builderId)) { return; }
  const builder = deps.overviewCache.getData()?.builders.find(b => b.id === builderId);
  if (builder?.worktreePath) {
    deps.store.registerWorktree(builderId, builder.worktreePath);
  }
}
