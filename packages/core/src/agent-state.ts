import type {
  AgentActivity,
  NeedsInputDetail,
  ServedAgentState,
} from '@cluesmith/codev-types';

/**
 * Agent-state projection (Spec 1595): the one policy that turns Tower's facts about
 * an agent into the `ServedAgentState` served on the overview.
 *
 * Precedence, first match wins:
 *   1. `blocked` — porch reports a requested, pending gate. The caller computes this
 *      with the overview's existing `detectBlocked`; nothing here parses `status.yaml`
 *      or holds a gate list (Constraint 14).
 *   2. `dead` — the agent process is gone, unless the builder is `complete` or
 *      `verified` (the normal end of a lane, not an alert).
 *   3. the reported activity — `needs-input`, `working` or `idle`.
 *   4. otherwise `null` (unknown).
 *
 * Pure: no I/O, no clock reads (the caller passes `now`).
 */

/** Porch phases at which a builder's lane is finished. Mirrors the sdk predicate's check. */
const FINISHED_PHASES: ReadonlySet<string> = new Set(['complete', 'verified']);

/** Tower's liveness verdict for an agent. */
export interface AgentLivenessFact {
  /** `null` when liveness could not be determined. */
  alive: boolean | null;
  /** ISO time the current `alive` value was first published. */
  since: string;
}

/** The latest accepted lifecycle report for an agent. */
export interface ReportedActivityFact {
  activity: AgentActivity;
  /** ISO time the current activity began. */
  since: string;
  /** ISO hook time of the latest accepted report. */
  at: string;
  backgroundWork: boolean;
  /** Held only while `activity` is `needs-input`. */
  needsInput?: NeedsInputDetail;
}

export interface AgentStateFacts {
  /** Whether porch reports a requested, pending gate (the overview's `detectBlocked`). */
  blocked: boolean;
  /** ISO time the gate was requested, when known. */
  blockedSince: string | null;
  /**
   * The builder's display `phase` (the field the sdk predicate reads). Pass `''` for
   * an architect, which has no porch phase.
   */
  phase: string;
  liveness: AgentLivenessFact | null;
  reported: ReportedActivityFact | null;
  /** ISO time to use when a `since` is otherwise unknown. */
  now: string;
}

export function projectAgentState(facts: AgentStateFacts): ServedAgentState | null {
  const alive = facts.liveness?.alive ?? null;
  const reported = facts.reported;

  // The raw inputs ride on every served row, whatever wins precedence, so a consumer
  // (#1672) can build its own chain from the same facts. The needs-input detail is part
  // of them: it follows the raw `activity`, not the served `state`.
  const raw: Omit<ServedAgentState, 'state' | 'since' | 'source'> = {
    alive,
    activity: reported?.activity ?? null,
    activityAt: reported?.at ?? null,
    backgroundWork: reported?.backgroundWork ?? false,
  };
  if (reported?.activity === 'needs-input' && reported.needsInput) {
    raw.needsInput = reported.needsInput;
  }

  if (facts.blocked) {
    return { state: 'blocked', since: facts.blockedSince ?? facts.now, source: 'tower', ...raw };
  }

  if (alive === false && !FINISHED_PHASES.has(facts.phase)) {
    return { state: 'dead', since: facts.liveness!.since, source: 'tower', ...raw };
  }

  if (reported) {
    return { state: reported.activity, since: reported.since, source: 'harness', ...raw };
  }

  return null;
}
