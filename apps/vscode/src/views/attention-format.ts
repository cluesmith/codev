import { formatAge } from '@cluesmith/codev-sdk/builder-helpers';
import type { AttentionSummary, ArchitectAttentionItem, WaitingItem } from '@cluesmith/codev-sdk/builder-helpers';

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
  const wait = mostUrgentWait(a);
  if (wait !== null) {
    return describeWait(wait.state, wait.since);
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

/** What a waiting builder or architect is waiting in; absent for the PTY-silence fallback. */
export type WaitState = WaitingItem['state'] | ArchitectAttentionItem['state'];

/** Urgency of a wait within the waiting bucket: at a prompt, then dead, then idle or silent. */
function waitRank(state: WaitState): number {
  if (state === 'needs-input') { return 0; }
  if (state === 'dead') { return 1; }
  return 2;
}

/**
 * The waiting item a workspace's glance shows (Spec 1595): across waiting builders and architects,
 * the first at a prompt, else the first dead, else the first idle. `null` when nothing waits.
 */
function mostUrgentWait(a: AttentionSummary): { state?: WaitState; since: string | null } | null {
  let best: { state?: WaitState; since: string | null } | null = null;
  for (const item of [...a.waiting, ...a.architects]) {
    if (best === null || waitRank(item.state) < waitRank(best.state)) { best = item; }
  }
  return best;
}

/**
 * How one wait reads (Spec 1595), shared by the workspace glance and its expanded rows: `needs
 * input · 6m` at a prompt, `agent exited · 6m` when dead, `waiting 6m` when idle or silent.
 */
export function describeWait(state: WaitState, since: string | null): AttentionGlance {
  const age = formatAge(since);
  if (state === 'needs-input') {
    return { icon: 'question', color: 'list.warningForeground', text: withAge('needs input', age) };
  }
  if (state === 'dead') {
    return { icon: 'debug-disconnect', color: 'list.errorForeground', text: withAge('agent exited', age) };
  }
  let text = 'waiting';
  if (age) { text = `waiting ${age}`; }
  return { icon: 'clock', text };
}

/** `<text> · <age>`, or just the text when there is no age. */
function withAge(text: string, age: string | null): string {
  if (age) { return `${text} · ${age}`; }
  return text;
}

/**
 * The one-word badge for a wait (Spec 1595): `needs input` at a prompt, `agent exited` when dead,
 * `idle` for a served turn end, and `waiting` for the PTY-silence fallback (no served state).
 */
export function waitWord(state: WaitState | undefined): string {
  if (state === 'needs-input') { return 'needs input'; }
  if (state === 'dead') { return 'agent exited'; }
  if (state === 'idle') { return 'idle'; }
  return 'waiting';
}
