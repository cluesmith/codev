/**
 * Agent attention state (Spec 1595): wire shapes only.
 *
 * Each spawned agent whose harness supports lifecycle signals reports its own
 * activity to Tower; Tower fuses that with porch's `blocked` and its own
 * process-liveness knowledge and serves one `ServedAgentState` per agent on the
 * overview. Nothing here computes anything: the projection is codev-core
 * (`@cluesmith/codev-core/agent-state`), the `working` staleness rule and the
 * waiting predicate are codev-sdk (`builder-helpers`).
 */

/** The served state of an agent. */
export type AgentState = 'working' | 'needs-input' | 'idle' | 'blocked' | 'dead';

/** The subset of `AgentState` an agent can report about itself. */
export type AgentActivity = 'working' | 'needs-input' | 'idle';

/**
 * What a `needs-input` agent is waiting on.
 *
 * Limits: `tool` at most 64 characters; `summary` at most 200 characters, one
 * line, control characters removed. `summary` is plain text built by the
 * reporter from the tool's primary argument (a command or a file path). Every
 * surface renders it as text, never as markup. It is held only for the current
 * needs-input episode and cleared when the activity changes.
 */
export interface NeedsInputDetail {
  kind: 'permission' | 'question' | 'other';
  tool?: string;
  summary?: string;
}

/**
 * The served state row, carried as `agentState` on `OverviewBuilder` and
 * `ArchitectState`. Optional and nullable there: absent and `null` both mean
 * unknown, and consumers fall back to the PTY-silence rule.
 */
export interface ServedAgentState {
  state: AgentState;
  /** ISO time the served `state` began. */
  since: string;
  /** `harness`: `state` came from a lifecycle report. `tower`: from porch or liveness. */
  source: 'harness' | 'tower';
  /** Whether the agent process is alive; `null` when Tower could not determine it. */
  alive: boolean | null;
  /** The latest accepted reported activity, or `null` when none has been reported. */
  activity: AgentActivity | null;
  /**
   * ISO hook time of the latest report applied to the served fields, or `null`. A claim-less turn end repeated while `backgroundWork` is held advances ordering only and does not move it.
   */
  activityAt: string | null;
  /** True when the agent ended its turn with its own background work still running. */
  backgroundWork: boolean;
  /** Present only while `activity` is `needs-input`. */
  needsInput?: NeedsInputDetail;
}

/** The five harness-neutral lifecycle event names. No harness hook name crosses the wire. */
export type AgentLifecycleEventName =
  | 'session-started'
  | 'turn-started'
  | 'tool-activity'
  | 'needs-input'
  | 'turn-ended';

/**
 * Who the reporting agent is: copied verbatim from the launch environment
 * (`CODEV_BUILDER_WORKTREE`; or `CODEV_ARCHITECT_WORKSPACE` and
 * `CODEV_ARCHITECT_NAME`), never derived from the reporter's working directory.
 * Tower normalizes the paths and resolves the identity to its own canonical
 * agent id; the raw identity is never served.
 *
 * Limits: paths at most 4096 characters, `name` at most 128.
 */
export type AgentLaunchIdentity =
  | { kind: 'builder'; worktreePath: string }
  | { kind: 'architect'; workspacePath: string; name: string };

/**
 * A lifecycle report, posted by an agent's reporter to Tower's ingestion route.
 *
 * Limits: `sessionId` at most 128 characters; the request body at most 8 KB.
 */
export interface AgentLifecycleEvent {
  agent: AgentLaunchIdentity;
  /** The harness's own session id, used to order reports across context resets. */
  sessionId: string;
  event: AgentLifecycleEventName;
  /** Epoch milliseconds when the hook ran. */
  at: number;
  needsInput?: NeedsInputDetail;
  backgroundWork?: boolean;
}
