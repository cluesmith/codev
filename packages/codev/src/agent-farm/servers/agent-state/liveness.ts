/**
 * Agent liveness: the one place Tower decides whether an agent's process is
 * running (Spec 1595, SC7, Constraint 14).
 *
 * A sweep every `LIVENESS_SWEEP_INTERVAL_MS` takes one process snapshot through
 * the shared `listProcessCensus()` (#1227) and walks each registered agent's
 * process tree from its session's pid:
 *
 * - shellper-backed builder: shellper → launch loop → agent. Alive while some
 *   launch loop has a child. The loop's relaunch-pause `sleep` is a child, so it
 *   counts as alive; its `read -r` relaunch prompt is not, so a loop waiting
 *   there reads as not alive although the loop itself still runs.
 * - direct builder: `session.pid` is the launch loop; same child test.
 * - shellper-backed architect: shellper → agent. Alive while the shellper has a
 *   child.
 * - direct architect: `session.pid` is the agent; alive while it is running.
 * - any agent: not alive with no session, an exited session, or (architects) a
 *   session in restart wait.
 *
 * A transition to not alive is published only after `NOT_ALIVE_CONFIRMATIONS`
 * consecutive not-alive sweeps, so a transient gap never flashes `dead`. A
 * failed snapshot (`[]`) publishes `alive: null` (unknown) for every agent, and
 * an unrecognized process shape for its agent; neither advances nor resets the
 * confirmation, so a not-alive observation before an unknown sweep still counts.
 * A published not alive's `since` is the confirming sweep, up to one interval
 * after the process went. Lifecycle reports never feed liveness.
 *
 * The sweep also drops the store entries of agents no longer registered (SC11)
 * and raises `AGENT_STATE_CHANGED` whenever a published value changes. The
 * snapshot's command lines can carry secrets, so only pid and ppid are read and
 * nothing from it is logged.
 */

import { EventEmitter } from 'node:events';
import { listProcessCensus, type ProcessCensusEntry } from '../process-census.js';
import { AGENT_STATE_CHANGED, agentStateStore, type AgentStateChange, type AgentStateStore } from './store.js';
import type { WorkspaceTerminals } from '../tower-types.js';

/** How often liveness is swept. */
export const LIVENESS_SWEEP_INTERVAL_MS = 5_000;

/** Consecutive not-alive sweeps before not alive is published. */
export const NOT_ALIVE_CONFIRMATIONS = 2;

/** The session facts liveness reads (a `PtySession` satisfies it). */
export interface LivenessSession {
  /** The shellper's pid for a shellper-backed session, else the PTY child's. */
  pid: number;
  shellperBacked: boolean;
  status: 'running' | 'exited';
  awaitingRestart: boolean;
}

/** One agent registered with Tower, with its session when it has one. */
export interface RegisteredAgent {
  /** Normalized workspace path. */
  workspacePath: string;
  /** Canonical id: a builder's lowercased role id, or an architect's name. */
  agentId: string;
  kind: 'builder' | 'architect';
  session: LivenessSession | undefined;
}

/** An agent's published liveness. */
export interface AgentLiveness {
  /** `null` while liveness cannot be determined. */
  alive: boolean | null;
  /** When `alive` took its current value (epoch ms). */
  since: number;
}

export interface AgentLivenessOptions {
  /** The registered agents, read once per sweep. */
  agents: () => RegisteredAgent[];
  /** The process snapshot. Defaults to `listProcessCensus`. */
  census?: () => Promise<ProcessCensusEntry[]>;
  /** The store whose entries follow registration. Defaults to Tower's store. */
  store?: AgentStateStore;
  now?: () => number;
  log?: (message: string) => void;
}

interface LivenessRecord {
  published: AgentLiveness;
  notAliveSweeps: number;
}

/** The process table, indexed for the tree walk. */
interface ProcessTree {
  running: Set<number>;
  children: Map<number, number[]>;
}

function agentKey(workspacePath: string, agentId: string): string {
  return `${workspacePath}\0${agentId}`;
}

function processTree(census: ProcessCensusEntry[]): ProcessTree {
  const running = new Set<number>();
  const children = new Map<number, number[]>();
  for (const entry of census) {
    running.add(entry.pid);
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) {
      children.set(entry.ppid, [entry.pid]);
    } else {
      siblings.push(entry.pid);
    }
  }
  return { running, children };
}

function hasChild(tree: ProcessTree, pid: number): boolean {
  return tree.children.has(pid);
}

/** Whether a launch loop at `pid` is running an agent. */
function launchLoopRunsAgent(tree: ProcessTree, pid: number): boolean {
  return tree.running.has(pid) && hasChild(tree, pid);
}

/**
 * This sweep's observation for one agent; `null` when it cannot be told. A
 * failed snapshot makes every observation unknown, session facts included, so a
 * failing `ps` never advances any agent toward not alive.
 */
function observe(agent: RegisteredAgent, tree: ProcessTree | null): boolean | null {
  if (tree === null) return null;
  const session = agent.session;
  if (session === undefined || session.status === 'exited') return false;
  if (agent.kind === 'architect' && session.awaitingRestart) return false;
  if (!Number.isInteger(session.pid) || session.pid <= 0) return null;

  if (agent.kind === 'builder') {
    if (!session.shellperBacked) return launchLoopRunsAgent(tree, session.pid);
    const loops = tree.children.get(session.pid) ?? [];
    return loops.some(loop => hasChild(tree, loop));
  }
  if (session.shellperBacked) return hasChild(tree, session.pid);
  return tree.running.has(session.pid);
}

export class AgentLivenessTracker extends EventEmitter {
  private readonly records = new Map<string, LivenessRecord>();
  private readonly census: () => Promise<ProcessCensusEntry[]>;
  private readonly store: AgentStateStore;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly options: AgentLivenessOptions) {
    super();
    this.census = options.census ?? listProcessCensus;
    this.store = options.store ?? agentStateStore;
    this.now = options.now ?? Date.now;
  }

  /** An agent's published liveness, or `undefined` when it is not registered. */
  get(workspacePath: string, agentId: string): AgentLiveness | undefined {
    return this.records.get(agentKey(workspacePath, agentId))?.published;
  }

  /** Run one sweep: observe every registered agent, publish, and drop the removed. */
  async sweep(): Promise<void> {
    const agents = this.options.agents();
    let tree: ProcessTree | null = null;
    if (agents.length > 0) {
      const census = await this.census();
      if (census.length > 0) tree = processTree(census);
    }

    const registered = new Set<string>();
    for (const agent of agents) {
      const key = agentKey(agent.workspacePath, agent.agentId);
      if (registered.has(key)) continue;
      registered.add(key);
      this.publish(agent, key, observe(agent, tree));
    }

    for (const key of this.records.keys()) {
      if (!registered.has(key)) this.records.delete(key);
    }
    for (const held of this.store.agents()) {
      if (!registered.has(agentKey(held.workspacePath, held.agentId))) {
        this.store.drop(held.workspacePath, held.agentId);
      }
    }
  }

  /** Sweep now and then every `intervalMs`, until `stop`. */
  start(intervalMs: number = LIVENESS_SWEEP_INTERVAL_MS): void {
    if (this.timer !== null) return;
    this.runSweep();
    this.timer = setInterval(() => this.runSweep(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** A timer-driven sweep: never overlaps another, never throws. */
  private runSweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    this.sweep()
      .catch((err: unknown) => {
        this.options.log?.(`Agent liveness sweep failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.sweeping = false;
      });
  }

  private publish(agent: RegisteredAgent, key: string, observed: boolean | null): void {
    let record = this.records.get(key);
    if (record === undefined) {
      record = { published: { alive: null, since: this.now() }, notAliveSweeps: 0 };
      this.records.set(key, record);
    }

    let next = record.published.alive;
    if (observed === null) {
      next = null;
    } else if (observed) {
      record.notAliveSweeps = 0;
      next = true;
    } else {
      record.notAliveSweeps += 1;
      if (record.notAliveSweeps >= NOT_ALIVE_CONFIRMATIONS) next = false;
    }
    if (next === record.published.alive) return;

    record.published = { alive: next, since: this.now() };
    const change: AgentStateChange = { workspacePath: agent.workspacePath, agentId: agent.agentId };
    this.emit(AGENT_STATE_CHANGED, change);
  }
}

/**
 * The agents Tower's terminal registry holds: every builder and architect in
 * each workspace's entry, keyed as the store keys them, with its session when
 * the terminal manager still has one.
 */
export function registeredAgents(
  workspaceTerminals: Map<string, WorkspaceTerminals>,
  getSession: (terminalId: string) => LivenessSession | undefined,
  normalizeWorkspace: (workspacePath: string) => string,
): RegisteredAgent[] {
  const agents: RegisteredAgent[] = [];
  for (const [rawWorkspacePath, entry] of workspaceTerminals) {
    const workspacePath = normalizeWorkspace(rawWorkspacePath);
    for (const [roleId, terminalId] of entry.builders) {
      agents.push({ workspacePath, agentId: roleId.toLowerCase(), kind: 'builder', session: getSession(terminalId) });
    }
    for (const [name, terminalId] of entry.architects) {
      agents.push({ workspacePath, agentId: name, kind: 'architect', session: getSession(terminalId) });
    }
  }
  return agents;
}

let towerLiveness: AgentLivenessTracker | null = null;

/** Start Tower's one liveness sweep; returns the tracker so boot can subscribe to it. */
export function startAgentLiveness(options: AgentLivenessOptions): AgentLivenessTracker {
  towerLiveness?.stop();
  towerLiveness = new AgentLivenessTracker(options);
  towerLiveness.start();
  return towerLiveness;
}

/** Stop Tower's liveness sweep (shutdown). */
export function stopAgentLiveness(): void {
  towerLiveness?.stop();
  towerLiveness = null;
}

/** Tower's published liveness for an agent; `undefined` before the sweep has seen it. */
export function getAgentLiveness(workspacePath: string, agentId: string): AgentLiveness | undefined {
  return towerLiveness?.get(workspacePath, agentId);
}
