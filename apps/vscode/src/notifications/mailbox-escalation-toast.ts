import * as vscode from 'vscode';
import type { MailboxEscalationPayload } from '@cluesmith/codev-types';
import { parseSseEnvelope, parseSseBody } from '../sse-envelope.js';
import { escalationToastText, escalationMatchesWorkspace } from '../mailbox-indicators.js';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

/**
 * Backstop bound on the dedupe set for a window that stays escalated all day, so
 * the de-escalation prune below never gets to run. Oldest-first eviction (a `Set`
 * iterates in insertion order); an evicted id can only re-toast if Tower re-emits
 * an escalation for that same row, which the one-way server-side `escalated` flag
 * makes impossible. Sized far above any plausible live escalated set.
 */
export const MAX_SEEN = 500;

/**
 * Spec 1313 Phase 8: toast on `mailbox-escalation`.
 *
 * A held message that crosses the escalation age (default 60s) is a VISIBILITY
 * signal — the human at that terminal isn't draining their mail. Tower emits the
 * `mailbox-escalation` SSE event once per row (guarded server-side by the
 * `escalated` flag); this raises a single `showWarningMessage` toast for it. The
 * toast is metadata-only (`escalationToastText` never includes a body, per the
 * spec's redaction rule) and points at `afx inbox` — the read/dismiss surface,
 * since the dashboard/VSCode indicators are read-only (Decision 8).
 *
 * Mirrors `activateGateToasts` / `BuilderSpawnHandler`:
 *   - scoped to the active workspace (`escalationMatchesWorkspace`), so a window
 *     for workspace A never toasts B's escalations on a shared Tower;
 *   - deduped by `mailboxId` so a redelivered event can't double-toast;
 *   - gated by `codev.mailboxEscalationToasts.enabled` (default true) — the same
 *     mute affordance `codev.gateToasts.enabled` gives the gate toasts. The
 *     persistent status-bar count/attention state is unaffected by the mute.
 *
 * Issue #1472: the dedupe set is BOUNDED. Its eviction key is the mailbox row
 * leaving the escalated set — the same signal that would let a legitimate
 * re-escalation re-notify — mirroring how `activateGateToasts` prunes a builder
 * that leaves the blocked set. The overview carries no per-row mailbox ids, only
 * the workspace-level `mailboxEscalated` flag, so `false` (no held row in this
 * workspace is escalated) is the finest-grained signal available here: at that
 * point every id in the set has left the escalated set, and the set is dropped
 * whole. A {@link MAX_SEEN} cap backstops a window that never sees that `false`.
 * (Tower also reports `false` when it cannot read the mailbox at all, which prunes
 * a little early — harmless: a row escalates exactly once server-side and there is
 * no SSE replay, so an evicted id has no second event to be deduped against.)
 *
 * The prune cannot fire on a stale snapshot: `OverviewCache.refresh()` is
 * last-write-wins by sequence, and the escalation event itself triggers a refresh
 * whose request starts after Tower flagged the row, so an older in-flight
 * `mailboxEscalated: false` response can never commit after it.
 */
export function activateMailboxEscalationToasts(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  cache: OverviewCache,
): void {
  const seen = new Set<string>();

  context.subscriptions.push(
    cache.onDidChange(() => {
      const data = cache.getData();
      // No data yet (or a transient read) says nothing about the escalated set.
      if (!data) {
        return;
      }
      if (!data.mailboxEscalated) {
        seen.clear();
      }
    }),
  );

  context.subscriptions.push(
    connectionManager.onSSEEvent(({ data }) => {
      const enabled = vscode.workspace
        .getConfiguration('codev')
        .get<boolean>('mailboxEscalationToasts.enabled', true);
      if (!enabled) {
        return;
      }

      const envelope = parseSseEnvelope(data);
      if (!envelope || envelope.type !== 'mailbox-escalation') {
        return;
      }

      const payload = parseSseBody<MailboxEscalationPayload>(envelope.body);
      if (!payload || !payload.mailboxId) {
        return;
      }

      if (!escalationMatchesWorkspace(payload.workspacePath, connectionManager.getWorkspacePath())) {
        return;
      }

      if (seen.has(payload.mailboxId)) {
        return;
      }
      seen.add(payload.mailboxId);
      while (seen.size > MAX_SEEN) {
        const oldest = seen.values().next().value as string;
        seen.delete(oldest);
      }

      void vscode.window.showWarningMessage(escalationToastText(payload));
    }),
  );
}
