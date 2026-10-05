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
 * Injection is not delivery: until the reviewer presses Enter the comments
 * exist only as editable prompt text, which a cleared prompt or a dead session
 * loses. So on success the packaged ids are MOVED to the queue file's `sent`
 * list, not deleted (#1562). A comment queued while the message sits unsent in
 * the prompt buffer stays pending for the next cycle. The next submit that
 * finds sent entries asks explicitly whether to re-send them (the recovery
 * path) or mark them delivered (drop the record), never silently either.
 *
 * The contextual panel's Code Review body (#1559) offers those as separate,
 * explicit actions instead: `submitReview` with `pendingOnly` sends just the
 * pending comments (leaving the sent record alone), and `resendReview` /
 * `markReviewDelivered` act on the sent record directly.
 */

import * as vscode from 'vscode';
import { buildSubmitMessage, wrapBracketedPaste, type PendingComment } from './queue.js';
import { getDiffInjectEntry } from '../diff-inject-codelens.js';
import type { ReviewQueueStore } from './store.js';
import type { TerminalManager } from '../terminal-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

/** Choices offered when sent-but-unconfirmed comments exist at submit time. */
const RESEND = 'Re-send';
const MARK_DELIVERED = 'Mark Delivered';

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
    pending.map(id => ({ label: id, description: queueSummary(store, id) })),
    { placeHolder: 'Select the builder whose review to act on' },
  );
  return picked?.label;
}

/** QuickPick description: the pending count, plus any sent-unconfirmed count. */
function queueSummary(store: ReviewQueueStore, builderId: string): string {
  const sent = store.getSent(builderId).length;
  if (sent === 0) { return `${store.count(builderId)} pending`; }
  return `${store.count(builderId)} pending, ${sent} sent unconfirmed`;
}

export interface SubmitOptions {
  /** Send only the pending comments; skip the Re-send / Mark Delivered prompt
   *  and leave any sent record untouched (the panel offers those separately). */
  pendingOnly?: boolean;
}

export async function submitReview(deps: SubmitDeps, builderIdArg?: string, options: SubmitOptions = {}): Promise<void> {
  let builderId = builderIdArg;
  if (!builderId) { builderId = await resolveTargetBuilder(deps.store); }
  if (!builderId) { return; }

  registerWorktreeFromOverview(deps, builderId);
  const state = await deps.store.loadState(builderId);
  const comments = state.comments;
  let sent = state.sent;
  if (options.pendingOnly) { sent = []; }
  if (comments.length === 0 && sent.length === 0) {
    vscode.window.setStatusBarMessage(`Codev: No pending comments for ${builderId}`, 3000);
    return;
  }

  let resend = false;
  if (sent.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${sent.length} review comment(s) submitted to ${builderId} earlier are not confirmed as delivered. ` +
        'Re-send them, or mark them delivered?',
      { modal: true },
      // First item is the modal's default button: confirming delivery is the
      // normal case; re-sending is the recovery fallback.
      MARK_DELIVERED,
      RESEND,
    );
    if (choice === undefined) { return; }
    resend = choice === RESEND;
    if (!resend) {
      await deps.store.clearSent(builderId);
      if (comments.length === 0) {
        vscode.window.setStatusBarMessage(`Codev: ${sent.length} review comment(s) for ${builderId} marked delivered`, 3000);
        return;
      }
    }
  }

  let packaged = comments;
  if (resend) { packaged = [...sent, ...comments]; }
  if (!(await injectReview(deps, builderId, packaged))) { return; }
  await deps.store.markSent(builderId, comments.map(c => c.id));
}

/**
 * Re-send the sent-unconfirmed comments (the recovery path for feedback lost
 * from the prompt). They stay in the sent record until delivery is confirmed.
 */
export async function resendReview(deps: SubmitDeps, builderIdArg?: string): Promise<void> {
  let builderId = builderIdArg;
  if (!builderId) { builderId = await resolveTargetBuilder(deps.store); }
  if (!builderId) { return; }

  registerWorktreeFromOverview(deps, builderId);
  const { sent } = await deps.store.loadState(builderId);
  if (sent.length === 0) {
    vscode.window.setStatusBarMessage(`Codev: No sent review comments to re-send for ${builderId}`, 3000);
    return;
  }
  await injectReview(deps, builderId, sent);
}

/** Confirm the sent comments reached the builder: drop the sent record. */
export async function markReviewDelivered(deps: SubmitDeps, builderIdArg?: string): Promise<void> {
  let builderId = builderIdArg;
  if (!builderId) { builderId = await resolveTargetBuilder(deps.store); }
  if (!builderId) { return; }

  registerWorktreeFromOverview(deps, builderId);
  const { sent } = await deps.store.loadState(builderId);
  if (sent.length === 0) {
    vscode.window.setStatusBarMessage(`Codev: No sent review comments to confirm for ${builderId}`, 3000);
    return;
  }
  await deps.store.clearSent(builderId);
  vscode.window.setStatusBarMessage(`Codev: ${sent.length} review comment(s) for ${builderId} marked delivered`, 3000);
}

/**
 * Package `comments` and type them into the builder's prompt (no Enter).
 * Returns false, with a warning, when the terminal is unavailable — the caller
 * then leaves the queue untouched.
 */
async function injectReview(deps: SubmitDeps, builderId: string, comments: PendingComment[]): Promise<boolean> {
  const message = buildSubmitMessage(comments);
  const resolvedId = await deps.terminalManager.openBuilderByRoleOrId(builderId, true);
  if (!resolvedId || !deps.terminalManager.injectBuilderText(resolvedId, wrapBracketedPaste(message))) {
    vscode.window.showWarningMessage('Codev: Builder terminal not available — review comments kept in the queue');
    return false;
  }
  vscode.window.setStatusBarMessage(
    `Codev: ${comments.length} review comment(s) placed in ${builderId}'s prompt — press Enter there to send`,
    5000,
  );
  return true;
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
