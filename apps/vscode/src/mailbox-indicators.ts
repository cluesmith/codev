/**
 * Spec 1313 Phase 8: pure, vscode-free helpers for the VSCode held-mail
 * indicators. Extracted so the count / tooltip / attention-state / toast-text
 * math is unit-testable without a `vscode` mock, mirroring how the dashboard
 * keeps `HeldCountBadge` presentational.
 *
 * The indicators are count-only and read-only (spec Decision 8): dismissal
 * stays CLI-only (`afx inbox`). Escalation (a held row crossing the escalation
 * age) puts the indicator into a distinct, log-free attention state that clears
 * when the row resolves — the visual form here is the status-bar warning
 * icon/background plus the `mailbox-escalation` toast.
 */

import * as path from 'node:path';
import type { MailboxEscalationPayload } from '@cluesmith/codev-types';

/**
 * Status-bar segment for held mail, e.g. ` · $(mail) 2 held`. Returns the empty
 * string when nothing is held (so the caller can unconditionally concatenate).
 * When escalated it swaps in the `$(warning)` codicon — the log-free attention
 * state for the persistent status-bar count. Defensive `> 0` guard also absorbs
 * an absent field from an older Tower (renders nothing rather than "undefined held").
 */
export function heldStatusSegment(heldCount: number, escalated: boolean): string {
  if (!(heldCount > 0)) {
    return '';
  }
  const icon = escalated ? '$(warning)' : '$(mail)';
  return ` · ${icon} ${heldCount} held`;
}

/**
 * Tooltip clause for held mail folded into the activity-bar badge, e.g.
 * `3 held messages` (or `1 held message`). Empty string when nothing is held.
 */
export function heldTooltipClause(heldCount: number): string {
  if (!(heldCount > 0)) {
    return '';
  }
  return `${heldCount} held message${heldCount === 1 ? '' : 's'}`;
}

/**
 * Held contribution to the activity-bar badge number. Never negative; absorbs an
 * absent/`undefined` field from an older Tower as 0.
 */
export function heldBadgeCount(heldCount: number): number {
  return heldCount > 0 ? heldCount : 0;
}

/**
 * Human-facing text for the `mailbox-escalation` toast. Metadata only — the
 * payload never carries a message body (spec redaction rule), so neither does
 * this. Points the reader at `afx inbox`, the read/dismiss surface.
 */
export function escalationToastText(payload: MailboxEscalationPayload): string {
  const seconds = Math.max(0, Math.round(payload.ageMs / 1000));
  const reason = payload.reason ? ` (${payload.reason})` : '';
  return `Codev: a message to ${payload.toAgent} has been held ${seconds}s${reason} — past the escalation age. Review with: afx inbox`;
}

/**
 * Whether an escalation payload belongs to the window's active workspace. Mirrors
 * `BuilderSpawnHandler`'s `path.resolve` comparison (handles trailing slash / `..`;
 * symlink realpath intentionally skipped — Tower emits canonical paths). A null
 * active path (no workspace detected yet) matches everything, so a toast is never
 * silently dropped during startup.
 */
export function escalationMatchesWorkspace(
  payloadWorkspacePath: string,
  activeWorkspacePath: string | null,
): boolean {
  if (!activeWorkspacePath) {
    return true;
  }
  return path.resolve(payloadWorkspacePath) === path.resolve(activeWorkspacePath);
}
