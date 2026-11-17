/**
 * Coalesce agent-state changes into `overview-changed` notifications (Spec 1595).
 *
 * The store raises a change on nearly every report (each one moves the served
 * `activityAt`), which is one per tool call per agent. Each `overview-changed`
 * makes every connected surface refetch and rebuild the overview, so changes are
 * collapsed per workspace into one notification at the trailing edge of a short
 * window, well inside the 5-second visibility budget (SC1).
 */

import type { AgentStateChange } from './store.js';

/** The coalescing window, in milliseconds. */
export const AGENT_STATE_BROADCAST_DELAY_MS = 500;

/**
 * A change listener that calls `notify(workspacePath)` once per workspace,
 * `delayMs` after the first change in a burst. Changes arriving inside the
 * window ride the pending notification.
 */
export function coalesceAgentStateChanges(
  notify: (workspacePath: string) => void,
  delayMs: number = AGENT_STATE_BROADCAST_DELAY_MS,
): (change: AgentStateChange) => void {
  const pending = new Set<string>();
  return (change: AgentStateChange) => {
    if (pending.has(change.workspacePath)) return;
    pending.add(change.workspacePath);
    const timer = setTimeout(() => {
      pending.delete(change.workspacePath);
      notify(change.workspacePath);
    }, delayMs);
    timer.unref();
  };
}
