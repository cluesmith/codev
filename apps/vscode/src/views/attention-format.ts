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
    const age = ageSince(gate.since);
    let text = gate.gate;
    if (age) { text = `${gate.gate} · ${age}`; }
    return { icon: 'warning', color: 'list.warningForeground', text };
  }
  if (a.waiting.length > 0) {
    const age = ageSince(a.waiting[0].since);
    let text = 'waiting';
    if (age) { text = `waiting ${age}`; }
    return { icon: 'clock', text };
  }
  if (a.heldTotal > 0) {
    let text = `${a.heldTotal} held`;
    if (a.heldEscalated) { text = `${a.heldTotal} held · escalated`; }
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

/** Compact relative age ("6m", "2h", "3d") from an ISO timestamp; `null` when absent or in the future. */
export function ageSince(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) { return null; }
  const ms = now - new Date(iso).getTime();
  if (ms < 0) { return null; }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.floor(hours / 24)}d`;
}
