/**
 * Spec 1595, Test 2 (ordering half) and Test 6 (persistence half): the in-memory
 * agent activity store.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentLifecycleEvent } from '@cluesmith/codev-types';
import {
  AgentStateStore,
  AGENT_STATE_CHANGED,
  MAX_FUTURE_SKEW_MS,
} from '../store.js';

const WS = '/repo';
const ID = 'builder-spir-1595';
const NOW = 1_800_000_000_000;

function event(overrides: Partial<AgentLifecycleEvent> = {}): AgentLifecycleEvent {
  return {
    agent: { kind: 'builder', worktreePath: '/repo/.builders/spir-1595' },
    sessionId: 's1',
    event: 'turn-started',
    at: NOW - 1000,
    ...overrides,
  };
}

function makeStore(): AgentStateStore {
  return new AgentStateStore(() => NOW);
}

describe('AgentStateStore: event to activity', () => {
  it('a fresh store holds no state', () => {
    expect(makeStore().get(WS, ID)).toBeUndefined();
  });

  it('maps each neutral event to its activity', () => {
    const store = makeStore();
    const cases: Array<[Partial<AgentLifecycleEvent>, string]> = [
      [{ event: 'session-started' }, 'idle'],
      [{ event: 'turn-started' }, 'working'],
      [{ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash' } }, 'needs-input'],
      [{ event: 'tool-activity' }, 'working'],
      [{ event: 'turn-ended' }, 'idle'],
      [{ event: 'turn-ended', backgroundWork: true }, 'working'],
    ];
    let at = NOW - 10_000;
    for (const [overrides, activity] of cases) {
      at += 10;
      store.apply(WS, ID, event({ ...overrides, at }));
      expect(store.get(WS, ID)?.activity).toBe(activity);
    }
  });

  it('records background work only from a turn-ended report', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-ended', backgroundWork: true, at: NOW - 100 }));
    expect(store.get(WS, ID)?.backgroundWork).toBe(true);
    store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 50 }));
    expect(store.get(WS, ID)?.backgroundWork).toBe(false);
  });

  // Phase 8 real-session finding: Claude's idle_prompt (a turn-ended with no
  // background claim) fires 60 s after Stop while the background task still runs.
  it('a claim-less turn end does not release a same-session background-work hold', () => {
    const store = makeStore();
    const listener = vi.fn();
    store.apply(WS, ID, event({ event: 'turn-ended', backgroundWork: true, at: NOW - 100 }));
    store.on(AGENT_STATE_CHANGED, listener);
    expect(store.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 40 }))).toBe('unchanged');
    expect(store.get(WS, ID)).toMatchObject({
      activity: 'working', backgroundWork: true, activitySince: NOW - 100, reportedAt: NOW - 100,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('an ignored claim-less turn end still advances the ordering watermark (SC17)', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-ended', backgroundWork: true, at: NOW - 100 }));
    store.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 40 }));
    // A delayed report from between the two must not regress the held state.
    expect(store.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 70 }))).toBe('stale');
    expect(store.get(WS, ID)).toMatchObject({
      activity: 'working', backgroundWork: true, reportedAt: NOW - 100, latestHookAt: NOW - 40,
    });
    // A newer report is accepted as usual.
    expect(store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 10 }))).toBe('changed');
    expect(store.get(WS, ID)).toMatchObject({ backgroundWork: false, reportedAt: NOW - 10, latestHookAt: NOW - 10 });
  });

  it('the background-work hold is released by an explicit turn end, a new turn, or a new session', () => {
    const releases: Array<[Partial<AgentLifecycleEvent>, string]> = [
      [{ event: 'turn-ended', backgroundWork: false }, 'idle'],
      [{ event: 'turn-started' }, 'working'],
      [{ event: 'turn-ended', sessionId: 's2' }, 'idle'],
    ];
    for (const [overrides, activity] of releases) {
      const store = makeStore();
      store.apply(WS, ID, event({ event: 'turn-ended', backgroundWork: true, at: NOW - 100 }));
      expect(store.apply(WS, ID, event({ ...overrides, at: NOW - 40 }))).toBe('changed');
      expect(store.get(WS, ID)).toMatchObject({ activity, backgroundWork: false });
    }
  });

  it('a claim-less turn end still ends a working turn whose own turn end was lost', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 100 }));
    store.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 40 }));
    expect(store.get(WS, ID)).toMatchObject({ activity: 'idle', backgroundWork: false });
  });

  it('keeps activitySince across reports of the same activity, and moves it on a change', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 300 }));
    store.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 200 }));
    expect(store.get(WS, ID)).toMatchObject({ activity: 'working', activitySince: NOW - 300, reportedAt: NOW - 200 });
    store.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 100 }));
    expect(store.get(WS, ID)).toMatchObject({ activity: 'idle', activitySince: NOW - 100 });
  });
});

describe('AgentStateStore: needs-input detail', () => {
  it('holds the detail only while the agent needs input', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash', summary: 'pnpm test' }, at: NOW - 200 }));
    expect(store.get(WS, ID)?.needsInput).toEqual({ kind: 'permission', tool: 'Bash', summary: 'pnpm test' });
    store.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 100 }));
    expect(store.get(WS, ID)?.needsInput).toBeUndefined();
  });

  it('a tool-less needs-input keeps the detail stored for the episode', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash', summary: 'ls' }, at: NOW - 200 }));
    store.apply(WS, ID, event({ event: 'needs-input', at: NOW - 100 }));
    expect(store.get(WS, ID)?.needsInput).toEqual({ kind: 'permission', tool: 'Bash', summary: 'ls' });
  });

  it('a tool-less needs-input starting a new episode carries no stale detail', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash' }, at: NOW - 300 }));
    store.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 200 }));
    store.apply(WS, ID, event({ event: 'needs-input', at: NOW - 100 }));
    expect(store.get(WS, ID)?.activity).toBe('needs-input');
    expect(store.get(WS, ID)?.needsInput).toBeUndefined();
  });

  it('a needs-input naming a tool replaces the stored detail', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash' }, at: NOW - 200 }));
    store.apply(WS, ID, event({ event: 'needs-input', needsInput: { kind: 'question', tool: 'AskUserQuestion' }, at: NOW - 100 }));
    expect(store.get(WS, ID)?.needsInput).toEqual({ kind: 'question', tool: 'AskUserQuestion' });
  });
});

describe('AgentStateStore: ordering (SC17)', () => {
  it('ignores a report older than the stored hook time', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 100 }));
    expect(store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 200 }))).toBe('stale');
    expect(store.get(WS, ID)?.activity).toBe('idle');
  });

  it('accepts a same-session report with an equal hook time', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 100 }));
    expect(store.apply(WS, ID, event({ event: 'needs-input', at: NOW - 100 }))).toBe('changed');
    expect(store.get(WS, ID)?.activity).toBe('needs-input');
  });

  // Two same-session reports in one millisecond come from adjacent hooks of one
  // turn step (PreToolUse and PermissionRequest, PermissionRequest and its
  // permission_prompt Notification), which carry the same state, so arrival
  // order is safe as the tie-break.
  it('same-session reports with an equal hook time apply in arrival order (last writer wins)', () => {
    const forward = makeStore();
    forward.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 100 }));
    forward.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 100 }));
    expect(forward.get(WS, ID)?.activity).toBe('idle');

    const reverse = makeStore();
    reverse.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 100 }));
    reverse.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 100 }));
    expect(reverse.get(WS, ID)?.activity).toBe('working');
    expect(reverse.get(WS, ID)?.latestHookAt).toBe(NOW - 100);
  });

  it('a different session supersedes only with a newer hook time', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ sessionId: 'new', event: 'session-started', at: NOW - 100 }));
    expect(store.apply(WS, ID, event({ sessionId: 'old', event: 'turn-started', at: NOW - 100 }))).toBe('stale');
    expect(store.apply(WS, ID, event({ sessionId: 'old', event: 'turn-started', at: NOW - 150 }))).toBe('stale');
    expect(store.get(WS, ID)).toMatchObject({ sessionId: 'new', activity: 'idle' });

    expect(store.apply(WS, ID, event({ sessionId: 'newer', event: 'session-started', at: NOW - 50 }))).toBe('changed');
    expect(store.get(WS, ID)?.sessionId).toBe('newer');
  });

  it('rejects a hook time more than 60 s in the future', () => {
    const store = makeStore();
    expect(store.apply(WS, ID, event({ at: NOW + MAX_FUTURE_SKEW_MS + 1 }))).toBe('future');
    expect(store.get(WS, ID)).toBeUndefined();
    expect(store.apply(WS, ID, event({ at: NOW + MAX_FUTURE_SKEW_MS }))).toBe('changed');
  });
});

describe('AgentStateStore: change event', () => {
  it('raises agent-state-changed when a served field moves, and not otherwise', () => {
    const store = makeStore();
    const listener = vi.fn();
    store.on(AGENT_STATE_CHANGED, listener);

    store.apply(WS, ID, event({ event: 'turn-started', at: NOW - 300 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ workspacePath: WS, agentId: ID });

    // Same activity, newer hook time: activityAt is served, so it changed.
    store.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 200 }));
    expect(listener).toHaveBeenCalledTimes(2);

    // An identical report changes nothing served.
    expect(store.apply(WS, ID, event({ event: 'tool-activity', at: NOW - 200 }))).toBe('unchanged');
    expect(listener).toHaveBeenCalledTimes(2);

    // A stale report raises nothing.
    store.apply(WS, ID, event({ event: 'turn-ended', at: NOW - 400 }));
    expect(listener).toHaveBeenCalledTimes(2);

    // Detail-only change at the same hook time still raises.
    store.apply(WS, ID, event({ event: 'needs-input', at: NOW - 100 }));
    store.apply(WS, ID, event({ event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash' }, at: NOW - 100 }));
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('AgentStateStore: keys and drop', () => {
  it('keys by workspace and agent id', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-started' }));
    expect(store.get('/other', ID)).toBeUndefined();
    expect(store.get(WS, 'builder-spir-1')).toBeUndefined();
  });

  it('drop forgets the agent', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-started' }));
    store.drop(WS, ID);
    expect(store.get(WS, ID)).toBeUndefined();
  });

  it('agents lists every held agent', () => {
    const store = makeStore();
    store.apply(WS, ID, event({ event: 'turn-started' }));
    store.apply('/other', 'main', event({ event: 'turn-started' }));
    expect(store.agents()).toEqual([
      { workspacePath: WS, agentId: ID },
      { workspacePath: '/other', agentId: 'main' },
    ]);
    store.drop(WS, ID);
    expect(store.agents()).toEqual([{ workspacePath: '/other', agentId: 'main' }]);
  });
});
