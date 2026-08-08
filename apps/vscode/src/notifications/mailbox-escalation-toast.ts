import * as vscode from 'vscode';
import type { MailboxEscalationPayload } from '@cluesmith/codev-types';
import { parseSseEnvelope, parseSseBody } from '../sse-envelope.js';
import { escalationToastText, escalationMatchesWorkspace } from '../mailbox-indicators.js';
import type { ConnectionManager } from '../connection-manager.js';

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
 */
export function activateMailboxEscalationToasts(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
): void {
  const seen = new Set<string>();

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

      void vscode.window.showWarningMessage(escalationToastText(payload));
    }),
  );
}
