/**
 * Spec 1595, Test 8: Tower agent liveness over synthetic process snapshots.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentLifecycleEvent } from '@cluesmith/codev-types';
import type { ProcessCensusEntry } from '../../process-census.js';
import type { WorkspaceTerminals } from '../../tower-types.js';
import {
  AgentLivenessTracker,
  NOT_ALIVE_CONFIRMATIONS,
  registeredAgents,
  type LivenessSession,
  type RegisteredAgent,
} from '../liveness.js';
import { AGENT_STATE_CHANGED, AgentStateStore } from '../store.js';

const WS = '/repo';
const BUILDER = 'builder-spir-1595';
const NOW = 1_800_000_000_000;

const SHELLPER = 100;
const LOOP = 101;
const AGENT = 102;

function proc(pid: number, ppid: number): ProcessCensusEntry {
  return { pid, ppid, rssKb: 1, cmdline: '' };
}

/** Unrelated processes, so a snapshot without the agent is still a real one. */
const BACKGROUND = [proc(1, 0), proc(50, 1)];

function session(overrides: Partial<LivenessSession> = {}): LivenessSession {
  return { pid: SHELLPER, shellperBacked: true, status: 'running', awaitingRestart: false, ...overrides };
}

function builder(sessionValue: LivenessSession | undefined = session()): RegisteredAgent {
  return { workspacePath: WS, agentId: BUILDER, kind: 'builder', session: sessionValue };
}

function architect(sessionValue: LivenessSession | undefined = session()): RegisteredAgent {
  return { workspacePath: WS, agentId: 'main', kind: 'architect', session: sessionValue };
}

interface Harness {
  tracker: AgentLivenessTracker;
  census: ReturnType<typeof vi.fn>;
  store: AgentStateStore;
  changes: unknown[];
  setAgents(next: RegisteredAgent[]): void;
  setProcesses(next: ProcessCensusEntry[]): void;
}

function harness(agents: RegisteredAgent[], processes: ProcessCensusEntry[]): Harness {
  let currentAgents = agents;
  let currentProcesses = processes;
  const census = vi.fn(async () => currentProcesses);
  const store = new AgentStateStore(() => NOW);
  const tracker = new AgentLivenessTracker({ agents: () => currentAgents, census, store, now: () => NOW });
  const changes: unknown[] = [];
  tracker.on(AGENT_STATE_CHANGED, change => changes.push(change));
  return {
    tracker,
    census,
    store,
    changes,
    setAgents: next => { currentAgents = next; },
    setProcesses: next => { currentProcesses = next; },
  };
}

/** Sweep enough times to confirm a not-alive observation. */
async function sweepToConfirmation(tracker: AgentLivenessTracker): Promise<void> {
  for (let i = 0; i < NOT_ALIVE_CONFIRMATIONS; i++) await tracker.sweep();
}

function event(): AgentLifecycleEvent {
  return {
    agent: { kind: 'builder', worktreePath: '/repo/.builders/spir-1595' },
    sessionId: 's1',
    event: 'turn-started',
    at: NOW - 1000,
  };
}

describe('AgentLivenessTracker: alive', () => {
  it('shellper → launch loop → agent is alive', async () => {
    const h = harness([builder()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)).toEqual({ alive: true, since: NOW });
  });

  it('a direct launch loop with an agent child is alive', async () => {
    const h = harness([builder(session({ pid: LOOP, shellperBacked: false }))], [...BACKGROUND, proc(LOOP, 1), proc(AGENT, LOOP)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);
  });

  it('shellper → architect agent is alive', async () => {
    const h = harness([architect()], [...BACKGROUND, proc(SHELLPER, 1), proc(AGENT, SHELLPER)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, 'main')?.alive).toBe(true);
  });

  it('a running direct architect is alive', async () => {
    const h = harness([architect(session({ pid: AGENT, shellperBacked: false }))], [...BACKGROUND, proc(AGENT, 1)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, 'main')?.alive).toBe(true);
  });

  it('the relaunch pause (`sleep` under the loop) stays alive', async () => {
    const h = harness([builder()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
    await h.tracker.sweep();
    const SLEEP = 103;
    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(SLEEP, LOOP)]);
    await sweepToConfirmation(h.tracker);
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);
    expect(h.changes).toHaveLength(1);
  });
});

describe('AgentLivenessTracker: not alive', () => {
  const cases: Array<[string, RegisteredAgent, ProcessCensusEntry[]]> = [
    ['a shellper-backed launch loop with no agent child', builder(), [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]],
    ['a direct launch loop with no agent child', builder(session({ pid: LOOP, shellperBacked: false })), [...BACKGROUND, proc(LOOP, 1)]],
    ['a builder shellper with no child', builder(), [...BACKGROUND, proc(SHELLPER, 1)]],
    ['a builder whose shellper is gone', builder(), [...BACKGROUND]],
    ['an architect shellper with no child', architect(), [...BACKGROUND, proc(SHELLPER, 1)]],
    ['an architect in restart wait', architect(session({ awaitingRestart: true })), [...BACKGROUND, proc(SHELLPER, 1), proc(AGENT, SHELLPER)]],
    ['a gone direct architect', architect(session({ pid: AGENT, shellperBacked: false })), [...BACKGROUND]],
    ['a registered builder with no session', builder(undefined), [...BACKGROUND]],
    ['a builder whose session exited', builder(session({ status: 'exited' })), [...BACKGROUND]],
  ];

  for (const [name, agent, processes] of cases) {
    it(`${name} is not alive once confirmed`, async () => {
      const h = harness([agent], processes);
      await sweepToConfirmation(h.tracker);
      expect(h.tracker.get(agent.workspacePath, agent.agentId)).toEqual({ alive: false, since: NOW });
    });
  }

  it('a single not-alive sweep publishes nothing', async () => {
    const h = harness([builder()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
    await h.tracker.sweep();
    expect(h.changes).toHaveLength(1);

    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);
    expect(h.changes).toHaveLength(1);

    // The agent came back before confirmation: the counter starts over.
    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
    await h.tracker.sweep();
    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);

    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(false);
    expect(h.changes).toEqual([
      { workspacePath: WS, agentId: BUILDER },
      { workspacePath: WS, agentId: BUILDER },
    ]);
  });

  it('a relaunch after death publishes alive again on the next sweep', async () => {
    const h = harness([builder()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]);
    await sweepToConfirmation(h.tracker);
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(false);
    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);
  });
});

describe('AgentLivenessTracker: unknown', () => {
  it('a failed census publishes null for every agent and advances no confirmation', async () => {
    const live = [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)];
    const h = harness([builder(), architect(session({ pid: 200 }))], live);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);

    // One not-alive sweep, then a failed census: still one observation short.
    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]);
    await h.tracker.sweep();
    h.setProcesses([]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBeNull();
    expect(h.tracker.get(WS, 'main')?.alive).toBeNull();
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBeNull();

    h.setProcesses([...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(false);
  });

  it('a failed census publishes null even for agents decided by session facts alone', async () => {
    const agents = [
      { ...builder(undefined), agentId: 'builder-no-session' },
      { ...builder(session({ status: 'exited' })), agentId: 'builder-exited' },
      architect(session({ awaitingRestart: true })),
    ];
    const h = harness(agents, []);
    await sweepToConfirmation(h.tracker);
    for (const agent of agents) {
      expect(h.tracker.get(agent.workspacePath, agent.agentId)?.alive).toBeNull();
    }
    expect(h.changes).toHaveLength(0);

    // The failed sweeps counted nothing: one good sweep is still short of confirmation.
    h.setProcesses(BACKGROUND);
    await h.tracker.sweep();
    for (const agent of agents) {
      expect(h.tracker.get(agent.workspacePath, agent.agentId)?.alive).toBeNull();
    }
    await h.tracker.sweep();
    for (const agent of agents) {
      expect(h.tracker.get(agent.workspacePath, agent.agentId)?.alive).toBe(false);
    }
  });

  it('an unrecognized process shape is unknown', async () => {
    const h = harness([builder(session({ pid: -1 }))], BACKGROUND);
    await sweepToConfirmation(h.tracker);
    expect(h.tracker.get(WS, BUILDER)?.alive).toBeNull();
    expect(h.changes).toHaveLength(0);
  });

  it('an agent is unknown until its first decisive sweep', async () => {
    const h = harness([builder()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER)]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)).toEqual({ alive: null, since: NOW });
  });
});

describe('AgentLivenessTracker: sweep cost and registration', () => {
  it('takes one census per sweep regardless of fleet size', async () => {
    const fleet: RegisteredAgent[] = [];
    for (let i = 0; i < 20; i++) {
      fleet.push({ workspacePath: WS, agentId: `builder-${i}`, kind: 'builder', session: session({ pid: 1000 + i }) });
    }
    const h = harness(fleet, BACKGROUND);
    await h.tracker.sweep();
    expect(h.census).toHaveBeenCalledTimes(1);
    await h.tracker.sweep();
    expect(h.census).toHaveBeenCalledTimes(2);
  });

  it('takes no census with no agents registered', async () => {
    const h = harness([], BACKGROUND);
    await h.tracker.sweep();
    expect(h.census).not.toHaveBeenCalled();
  });

  it('observes an agent registered twice under one key once, first entry winning', async () => {
    const h = harness(
      [builder(), builder(undefined)],
      [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)],
    );
    await sweepToConfirmation(h.tracker);
    expect(h.tracker.get(WS, BUILDER)?.alive).toBe(true);
  });

  it('drops the liveness and store entries of removed agents on the next sweep', async () => {
    const h = harness([builder(), architect()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
    h.store.apply(WS, BUILDER, event());
    h.store.apply(WS, 'main', event());
    await h.tracker.sweep();
    expect(h.store.get(WS, BUILDER)).toBeDefined();

    h.setAgents([architect()]);
    await h.tracker.sweep();
    expect(h.tracker.get(WS, BUILDER)).toBeUndefined();
    expect(h.store.get(WS, BUILDER)).toBeUndefined();
    expect(h.store.get(WS, 'main')).toBeDefined();
  });

  it('start sweeps at once and on the interval, and stop ends it', async () => {
    vi.useFakeTimers();
    try {
      const h = harness([builder()], [...BACKGROUND, proc(SHELLPER, 1), proc(LOOP, SHELLPER), proc(AGENT, LOOP)]);
      h.tracker.start(5_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.census).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.census).toHaveBeenCalledTimes(2);
      h.tracker.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.census).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps a sweep still waiting on its census', async () => {
    vi.useFakeTimers();
    try {
      let release: (entries: ProcessCensusEntry[]) => void = () => {};
      const census = vi.fn(() => new Promise<ProcessCensusEntry[]>(resolve => { release = resolve; }));
      const tracker = new AgentLivenessTracker({ agents: () => [builder()], census, store: new AgentStateStore() });
      tracker.start(5_000);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(census).toHaveBeenCalledTimes(1);
      release(BACKGROUND);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(census).toHaveBeenCalledTimes(2);
      tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('registeredAgents', () => {
  it('lists builders by lowercased role id and architects by name, with their sessions', () => {
    const entry: WorkspaceTerminals = {
      architects: new Map([['main', 't-arch']]),
      builders: new Map([['builder-SPIR-1595', 't-builder'], ['builder-spir-2', 't-gone']]),
      shells: new Map([['shell-1', 't-shell']]),
      fileTabs: new Map(),
    };
    const live = session();
    const sessions = new Map<string, LivenessSession>([['t-arch', live], ['t-builder', live]]);
    const agents = registeredAgents(new Map([['/repo/', entry]]), id => sessions.get(id), p => p.replace(/\/$/, ''));
    expect(agents).toEqual([
      { workspacePath: WS, agentId: 'builder-spir-1595', kind: 'builder', session: live },
      { workspacePath: WS, agentId: 'builder-spir-2', kind: 'builder', session: undefined },
      { workspacePath: WS, agentId: 'main', kind: 'architect', session: live },
    ]);
  });
});
