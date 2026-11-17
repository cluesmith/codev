/**
 * Serve an agent's attention state on the overview (Spec 1595).
 *
 * Gathers Tower's facts about one agent (porch's `blocked`, the caller already
 * holds; the published liveness; the stored reported activity) and hands them to
 * the one projection policy in codev-core. Called per request: nothing here is
 * cached, so a served row is never older than the store and the liveness sweep.
 */

import type { ServedAgentState } from '@cluesmith/codev-types';
import {
  projectAgentState,
  type AgentLivenessFact,
  type ReportedActivityFact,
} from '@cluesmith/codev-core/agent-state';
import { agentStateStore, type AgentStateStore } from './store.js';
import { getAgentLiveness, type AgentLiveness } from './liveness.js';

/** The porch facts the overview already computed for the agent. */
export interface AgentPorchFacts {
  /** Whether porch reports a requested, pending gate (`detectBlocked` is non-null). */
  blocked: boolean;
  blockedSince: string | null;
  /** The builder's display phase; `''` for an architect. */
  phase: string;
}

export interface ServeAgentStateOptions {
  store?: AgentStateStore;
  liveness?: (workspacePath: string, agentId: string) => AgentLiveness | undefined;
  now?: () => number;
}

function livenessFact(liveness: AgentLiveness | undefined): AgentLivenessFact | null {
  if (liveness === undefined) return null;
  return { alive: liveness.alive, since: new Date(liveness.since).toISOString() };
}

function reportedFact(store: AgentStateStore, workspacePath: string, agentId: string): ReportedActivityFact | null {
  const stored = store.get(workspacePath, agentId);
  if (stored === undefined) return null;
  const fact: ReportedActivityFact = {
    activity: stored.activity,
    since: new Date(stored.activitySince).toISOString(),
    at: new Date(stored.reportedAt).toISOString(),
    backgroundWork: stored.backgroundWork,
  };
  if (stored.needsInput !== undefined) fact.needsInput = stored.needsInput;
  return fact;
}

/**
 * The served state for the agent `(workspacePath, agentId)`, keyed as the store
 * and liveness key it: the normalized workspace path and the canonical agent id
 * (a builder's lowercased role id, an architect's name). `null` when unknown.
 */
export function serveAgentState(
  workspacePath: string,
  agentId: string,
  porch: AgentPorchFacts,
  options: ServeAgentStateOptions = {},
): ServedAgentState | null {
  const store = options.store ?? agentStateStore;
  const liveness = options.liveness ?? getAgentLiveness;
  const now = options.now ?? Date.now;
  return projectAgentState({
    blocked: porch.blocked,
    blockedSince: porch.blockedSince,
    phase: porch.phase,
    liveness: livenessFact(liveness(workspacePath, agentId)),
    reported: reportedFact(store, workspacePath, agentId),
    now: new Date(now()).toISOString(),
  });
}
