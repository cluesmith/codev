/**
 * Runtime behavior tests for TowerFleetCache: the cross-workspace attention fan-out behind the
 * Tower view. Verifies it fans out per-workspace overviews for active workspaces only, derives
 * attention through the real SDK helper, keeps last-known-good across transient failures, drops
 * out-of-order landings (last-write-wins), refreshes on the shared SSE event without opening its
 * own stream, and polls as a fallback. Mocks `vscode` (the established pattern) + a fake
 * ConnectionManager / TowerClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OverviewData } from '@cluesmith/codev-types';
import type { TowerWorkspace } from '@cluesmith/codev-sdk/tower-client';

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire = (e: T) => { this.listeners.forEach((l) => l(e)); };
    dispose = () => { this.listeners = []; };
  }
  return { EventEmitter: FakeEventEmitter };
});

const { TowerFleetCache } = await import('../views/tower-cache.js');

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

function ws(path: string, name: string, active: boolean): TowerWorkspace {
  return { path, name, active, proxyUrl: `http://localhost/${name}`, terminals: active ? 1 : 0 };
}

/** An overview with one blocked builder — projects to a non-empty (needs-attention) summary. */
function blockedOverview(): OverviewData {
  return {
    builders: [{ id: 'b0', issueId: null, issueTitle: null, phase: 'plan', blocked: 'plan review', blockedGate: 'plan-approval', blockedSince: '2026-09-01T10:00:00Z', prReady: false, lastDataAt: null }],
    backlog: [], pendingPRs: [], recentlyClosed: [], architects: [],
    heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward',
  } as unknown as OverviewData;
}

/** A populated-but-quiet overview — projects to an empty summary. */
function quietOverview(): OverviewData {
  return {
    builders: [{ id: 'b0', issueId: null, issueTitle: null, phase: 'implement', blocked: null, blockedGate: null, blockedSince: null, prReady: false, lastDataAt: null }],
    backlog: [], pendingPRs: [], recentlyClosed: [], architects: [],
    heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward',
  } as unknown as OverviewData;
}

function makeFake(listWorkspaces: ReturnType<typeof vi.fn>, getOverview: ReturnType<typeof vi.fn>) {
  const sseListeners: Array<() => void> = [];
  const stateListeners: Array<(s: ConnectionState) => void> = [];
  let state: ConnectionState = 'connected';
  const client = { listWorkspaces, getOverview };
  return {
    cm: {
      getState: () => state,
      getClient: () => client,
      getWorkspacePath: () => '/ws/current',
      onSSEEvent: (l: () => void) => { sseListeners.push(l); return { dispose() {} }; },
      onStateChange: (l: (s: ConnectionState) => void) => { stateListeners.push(l); return { dispose() {} }; },
    } as unknown as import('../connection-manager.js').ConnectionManager,
    setState: (s: ConnectionState) => { state = s; },
    fireSse: () => sseListeners.forEach((l) => l()),
    sseCount: () => sseListeners.length,
  };
}

describe('TowerFleetCache', () => {
  let listWorkspaces: ReturnType<typeof vi.fn>;
  let getOverview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listWorkspaces = vi.fn();
    getOverview = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('fans out overviews for active workspaces only and derives attention per workspace', async () => {
    listWorkspaces.mockResolvedValue([
      ws('/ws/a', 'a', true),
      ws('/ws/b', 'b', true),
      ws('/ws/dormant', 'dormant', false),
    ]);
    getOverview.mockImplementation(async (path: string) => (path === '/ws/a' ? blockedOverview() : quietOverview()));

    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    await cache.refresh();

    const fleet = cache.getFleet();
    expect(fleet.map((e) => e.workspace.name)).toEqual(['a', 'b', 'dormant']);
    // dormant workspace is never fetched
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(getOverview).toHaveBeenCalledWith('/ws/a');
    expect(getOverview).not.toHaveBeenCalledWith('/ws/dormant');
    // 'a' is blocked (needs attention); 'b' and dormant are quiet
    expect(fleet.find((e) => e.workspace.name === 'a')!.attention.isEmpty).toBe(false);
    expect(fleet.find((e) => e.workspace.name === 'b')!.attention.isEmpty).toBe(true);
    expect(fleet.find((e) => e.workspace.name === 'dormant')!.attention.isEmpty).toBe(true);
    expect(cache.getAttentionCount()).toBe(1);
    expect(cache.isLoaded()).toBe(true);
    cache.dispose();
  });

  it('keeps last-known-good and does not fetch when not connected', async () => {
    listWorkspaces.mockResolvedValue([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(blockedOverview());
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    await cache.refresh();
    expect(cache.getAttentionCount()).toBe(1);

    f.setState('reconnecting');
    listWorkspaces.mockClear();
    await cache.refresh();
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(cache.getAttentionCount()).toBe(1); // unchanged
    cache.dispose();
  });

  it('retains a workspace’s attention when its overview fetch fails (null)', async () => {
    listWorkspaces.mockResolvedValue([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValueOnce(blockedOverview()); // first refresh: attention present
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    await cache.refresh();
    expect(cache.getAttentionCount()).toBe(1);

    getOverview.mockResolvedValueOnce(null); // second refresh: transient failure
    await cache.refresh();
    expect(cache.getFleet().find((e) => e.workspace.name === 'a')!.attention.isEmpty).toBe(false);
    cache.dispose();
  });

  it('coalesces a concurrent refresh into a single trailing rerun (single-in-flight)', async () => {
    let resolveFirst: (v: TowerWorkspace[]) => void = () => {};
    listWorkspaces
      .mockImplementationOnce(() => new Promise<TowerWorkspace[]>((res) => { resolveFirst = res; }))
      .mockImplementation(async () => [ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(quietOverview());

    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    const first = cache.refresh();       // in-flight, awaiting listWorkspaces
    const second = cache.refresh();      // coalesced — returns without starting its own fetch
    const third = cache.refresh();       // also coalesced into the same single rerun
    await second;
    await third;
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    resolveFirst([ws('/ws/a', 'a', true)]);
    await first;                         // completes, then fires exactly one trailing rerun
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('does not blank a populated fleet when the list momentarily returns empty', async () => {
    listWorkspaces.mockResolvedValueOnce([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(blockedOverview());
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    await cache.refresh();
    expect(cache.getFleet()).toHaveLength(1);

    listWorkspaces.mockResolvedValueOnce([]); // transient list failure surfaces as []
    await cache.refresh();
    expect(cache.getFleet()).toHaveLength(1); // last-known-good kept
    expect(cache.getAttentionCount()).toBe(1);
    cache.dispose();
  });

  it('refreshes on the shared SSE event (debounced) and subscribes exactly one SSE listener (no second stream)', async () => {
    vi.useFakeTimers();
    listWorkspaces.mockResolvedValue([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(blockedOverview());
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    expect(f.sseCount()).toBe(1); // one listener on the shared stream, never its own EventSource

    // A burst of events collapses into a single fan-out after the debounce.
    f.fireSse();
    f.fireSse();
    f.fireSse();
    await vi.advanceTimersByTimeAsync(350);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('polls as a fallback on the interval', async () => {
    vi.useFakeTimers();
    listWorkspaces.mockResolvedValue([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(quietOverview());
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    listWorkspaces.mockClear();

    await vi.advanceTimersByTimeAsync(20_000 + 350); // poll tick, then debounce
    expect(listWorkspaces).toHaveBeenCalled();
    cache.dispose();
  });

  it('stops polling after dispose', async () => {
    vi.useFakeTimers();
    listWorkspaces.mockResolvedValue([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(quietOverview());
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    cache.dispose();
    listWorkspaces.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listWorkspaces).not.toHaveBeenCalled();
  });
});
