import { formatAge } from '@cluesmith/codev-sdk/builder-helpers';
import type { AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';

/**
 * How a workspace's attention reads at a glance — shared by the Tower tree row and the switch
 * quick-pick so the two surfaces describe the same workspace identically (one source of truth for
 * "what needs a human here", one level below the SDK's `AttentionSummary` it projects).
 */
export interface AttentionGlance {
  /** Codicon id for the row's icon. */
  icon: string;
  /** `ThemeColor` id to tint the icon, when the state warrants it. */
  color?: string;
  /** Short human description (e.g. `plan review · 6m`, `3 held · escalated`). */
  text: string;
}

/** The primary (highest-urgency) signal a summary carries, or `null` when the workspace is quiet. */
export function describeAttention(a: AttentionSummary): AttentionGlance | null {
  if (a.pendingGates.length > 0) {
    const gate = a.pendingGates[0];
    const age = formatAge(gate.since);
    let text = gate.gate;
    if (age) { text = `${gate.gate} · ${age}`; }
    return { icon: 'warning', color: 'list.warningForeground', text };
  }
  if (a.waiting.length > 0) {
    const age = formatAge(a.waiting[0].since);
    let text = 'waiting';
    if (age) { text = `waiting ${age}`; }
    return { icon: 'clock', text };
  }
  // Mirror `urgencyBucket`'s held predicate (heldTotal OR heldMail rows), so a workspace never
  // buckets as held-mail yet reads as quiet here.
  if (a.heldTotal > 0 || a.heldMail.length > 0) {
    const held = Math.max(a.heldTotal, a.heldMail.length);
    let text = `${held} held`;
    if (a.heldEscalated) { text = `${held} held · escalated`; }
    let color: string | undefined;
    if (a.heldEscalated) { color = 'list.errorForeground'; }
    return { icon: 'mail', color, text };
  }
  const queued = totalQueued(a);
  if (queued > 0) {
    return { icon: 'comment', text: `${queued} queued` };
  }
  return null;
}

/** Total queued review comments across a summary's per-builder counts. */
export function totalQueued(a: AttentionSummary): number {
  let total = 0;
  for (const item of a.queuedFeedback) { total += item.count; }
  return total;
}
