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

/** An activity-bar badge value: a number bubble plus its hover tooltip. */
export interface BadgeValue {
  value: number;
  tooltip: string;
}

/**
 * Compose the full Codev status-bar text from the live overview counts. Pure so
 * the held-mail folding (icon, `$(warning)` swap on escalation) is unit-tested
 * without a `vscode` mock — the extension closure only assigns the result and the
 * warning background. Mirrors the pre-existing `$(bell) N blocked` /
 * `$(comment-discussion) N waiting` segment style; the held segment is appended
 * (empty when nothing is held).
 */
export function composeStatusBarText(
  builderCount: number,
  blockedCount: number,
  idleCount: number,
  heldCount: number,
  escalated: boolean,
): string {
  let text = `$(server) Codev: ${builderCount} builders`;
  if (blockedCount > 0) {
    text += ` · $(bell) ${blockedCount} blocked`;
  }
  if (idleCount > 0) {
    text += ` · $(comment-discussion) ${idleCount} waiting`;
  }
  text += heldStatusSegment(heldCount, escalated);
  return text;
}

/**
 * Compose the activity-bar badge (value + tooltip) from the live "needs me"
 * counts, folding the workspace held-mail count into the total so the icon
 * reflects held mail even when the sidebar is collapsed. Returns `undefined`
 * when nothing needs the user (blocked + idle + held all zero) so the caller
 * clears the badge. The blocked/idle tooltip phrasing is preserved verbatim from
 * the original inline logic; the held clause is appended after a ` · `. Pure so
 * the fold + tooltip composition is unit-tested (previously inline + untested).
 */
export function composeActivityBadge(
  blockedCount: number,
  idleCount: number,
  heldCount: number,
): BadgeValue | undefined {
  const held = heldBadgeCount(heldCount);
  const total = blockedCount + idleCount + held;
  if (total === 0) {
    return undefined;
  }
  const builderTip = (blockedCount > 0 && idleCount > 0)
    ? `${blockedCount} blocked, ${idleCount} waiting on input`
    : blockedCount > 0
      ? (blockedCount === 1 ? '1 builder blocked at a human-approval gate' : `${blockedCount} builders blocked at human-approval gates`)
      : idleCount > 0
        ? (idleCount === 1 ? '1 builder waiting on input' : `${idleCount} builders waiting on input`)
        : '';
  const tooltip = [builderTip, heldTooltipClause(held)].filter(Boolean).join(' · ');
  return { value: total, tooltip };
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
