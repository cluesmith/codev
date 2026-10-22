/**
 * Tower's in-memory agent activity store (Spec 1595).
 *
 * Holds, per agent, the latest activity its harness reported through the
 * lifecycle route: the harness session id, the activity and when it began, the
 * hook time of the latest accepted report, whether background work is pending,
 * and the needs-input detail while (and only while) the agent needs input.
 *
 * Memory only, by owner ruling (2026-10-21): nothing here is ever written to
 * `global.db` or any other store, so no served state can outlive the Tower
 * process that received its report. A fresh store holds nothing.
 *
 * Keys are `(normalized workspace path, canonical agent id)`; callers resolve
 * both through `resolveAgentIdentity` before touching the store.
 *
 * Ordering (SC17): a report older than the stored hook time is ignored; a report
 * from a different harness session supersedes the stored one only with a newer
 * hook time; a hook time more than `MAX_FUTURE_SKEW_MS` ahead of Tower's clock is
 * rejected.
 *
 * Background work (SC5): a turn end with `backgroundWork: true` holds the agent
 * `working`. A later same-session turn end that makes no background-work claim
 * (the field absent) does not release that hold; a new turn does.
 */

import { EventEmitter } from 'node:events';
import type { AgentActivity, AgentLifecycleEvent, NeedsInputDetail } from '@cluesmith/codev-types';

/** How far ahead of Tower's clock a report's hook time may be. */
export const MAX_FUTURE_SKEW_MS = 60_000;

/** Raised on every accepted report that changes a served field. */
export const AGENT_STATE_CHANGED = 'agent-state-changed';

/** One agent's reported activity, as held in memory. */
export interface StoredAgentActivity {
  /** The harness session the activity belongs to. */
  sessionId: string;
  activity: AgentActivity;
  /** Hook time (epoch ms) at which `activity` began. */
  activitySince: number;
  /** Hook time (epoch ms) of the latest report that set the served state; the served `at`. */
  reportedAt: number;
  /**
   * Hook time (epoch ms) of the latest accepted report, including one that
   * changed nothing served. The ordering watermark (SC17): never behind `reportedAt`.
   */
  latestHookAt: number;
  /** True when the agent ended its turn with its own background work running. */
  backgroundWork: boolean;
  /** Present only while `activity` is `needs-input`. */
  needsInput?: NeedsInputDetail;
}

/** The payload of `AGENT_STATE_CHANGED`. */
export interface AgentStateChange {
  workspacePath: string;
  agentId: string;
}

/**
 * What `apply` did with a report: `changed` (accepted, a served field moved),
 * `unchanged` (accepted, nothing served moved), `stale` (ignored by ordering),
 * or `future` (rejected: hook time implausibly far ahead).
 */
export type ApplyOutcome = 'changed' | 'unchanged' | 'stale' | 'future';

function storeKey(workspacePath: string, agentId: string): string {
  return `${workspacePath}\0${agentId}`;
}

function sameDetail(a: NeedsInputDetail | undefined, b: NeedsInputDetail | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && a.tool === b.tool && a.summary === b.summary;
}

/** The activity a lifecycle event moves the agent into. */
function activityFor(event: AgentLifecycleEvent): AgentActivity {
  switch (event.event) {
    case 'session-started':
      return 'idle';
    case 'turn-started':
    case 'tool-activity':
      return 'working';
    case 'needs-input':
      return 'needs-input';
    case 'turn-ended':
      if (event.backgroundWork === true) return 'working';
      return 'idle';
  }
}

/**
 * True when `event` is a turn end that makes no background-work claim, arriving
 * while the same session's turn end with background work is held. Such a report
 * carries nothing new: Claude's 60 s `idle_prompt` (the second chance for a lost
 * turn end) fires while the agent's own background task still runs, and must not
 * end the background-work hold early. Real-session finding, Phase 8.
 */
function repeatsBackgroundTurnEnd(event: AgentLifecycleEvent, previous: StoredAgentActivity | undefined): boolean {
  return event.event === 'turn-ended'
    && event.backgroundWork === undefined
    && previous !== undefined
    && previous.sessionId === event.sessionId
    && previous.backgroundWork;
}

/**
 * The needs-input detail for an accepted `needs-input` report. A report without
 * a tool (the redundant permission notification names none) keeps the detail
 * already held for the same episode.
 */
function detailFor(event: AgentLifecycleEvent, previous: StoredAgentActivity | undefined): NeedsInputDetail | undefined {
  const continuesEpisode = previous !== undefined
    && previous.sessionId === event.sessionId
    && previous.activity === 'needs-input';
  if (continuesEpisode && previous.needsInput !== undefined && event.needsInput?.tool === undefined) {
    return previous.needsInput;
  }
  return event.needsInput;
}

export class AgentStateStore extends EventEmitter {
  private readonly entries = new Map<string, StoredAgentActivity>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  /** The stored activity for an agent, or `undefined` when it has reported nothing. */
  get(workspacePath: string, agentId: string): StoredAgentActivity | undefined {
    return this.entries.get(storeKey(workspacePath, agentId));
  }

  /** Apply one validated report for a resolved agent. */
  apply(workspacePath: string, agentId: string, event: AgentLifecycleEvent): ApplyOutcome {
    if (event.at > this.now() + MAX_FUTURE_SKEW_MS) return 'future';

    const key = storeKey(workspacePath, agentId);
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      if (event.at < previous.latestHookAt) return 'stale';
      if (event.sessionId !== previous.sessionId && event.at === previous.latestHookAt) return 'stale';
    }
    if (previous !== undefined && repeatsBackgroundTurnEnd(event, previous)) {
      // The hold and its served time stay; only the ordering watermark moves, so a
      // delayed report older than this one is still ignored.
      this.entries.set(key, { ...previous, latestHookAt: event.at });
      return 'unchanged';
    }

    const activity = activityFor(event);
    let activitySince = event.at;
    if (previous !== undefined && previous.sessionId === event.sessionId && previous.activity === activity) {
      activitySince = previous.activitySince;
    }
    const next: StoredAgentActivity = {
      sessionId: event.sessionId,
      activity,
      activitySince,
      reportedAt: event.at,
      latestHookAt: event.at,
      backgroundWork: event.event === 'turn-ended' && event.backgroundWork === true,
    };
    if (activity === 'needs-input') {
      const detail = detailFor(event, previous);
      if (detail !== undefined) next.needsInput = detail;
    }
    this.entries.set(key, next);

    const changed = previous === undefined
      || previous.activity !== next.activity
      || previous.reportedAt !== next.reportedAt
      || previous.backgroundWork !== next.backgroundWork
      || !sameDetail(previous.needsInput, next.needsInput);
    if (!changed) return 'unchanged';
    const change: AgentStateChange = { workspacePath, agentId };
    this.emit(AGENT_STATE_CHANGED, change);
    return 'changed';
  }

  /** Every agent the store holds state for. */
  agents(): AgentStateChange[] {
    const agents: AgentStateChange[] = [];
    for (const key of this.entries.keys()) {
      const separator = key.indexOf('\0');
      agents.push({ workspacePath: key.slice(0, separator), agentId: key.slice(separator + 1) });
    }
    return agents;
  }

  /** Forget an agent's reported state (it was removed). */
  drop(workspacePath: string, agentId: string): void {
    this.entries.delete(storeKey(workspacePath, agentId));
  }
}

/** Tower's one store. Nothing subscribes to its change event except the broadcaster. */
export const agentStateStore = new AgentStateStore();
