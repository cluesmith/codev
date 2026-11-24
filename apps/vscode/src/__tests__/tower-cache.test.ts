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
    fireState: (s: ConnectionState) => { state = s; stateListeners.forEach((l) => l(s)); },
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

  it('does not fetch while disconnected, then re-fetches on reconnect (SSE-drop recovery)', async () => {
    vi.useFakeTimers();
    listWorkspaces.mockResolvedValue([ws('/ws/a', 'a', true)]);
    getOverview.mockResolvedValue(blockedOverview());
    const f = makeFake(listWorkspaces, getOverview);
    const cache = new TowerFleetCache(f.cm);
    await cache.refresh(); // initial connected fetch
    listWorkspaces.mockClear();

    // SSE drop flips state to disconnected; poll ticks are cheap no-ops (Tower unreachable).
    f.fireState('disconnected');
    await vi.advanceTimersByTimeAsync(20_000 + 350);
    expect(listWorkspaces).not.toHaveBeenCalled();

    // Reconnect (health-checked) returns to connected → the fleet re-fetches.
    f.fireState('connected');
    await vi.advanceTimersByTimeAsync(350); // debounce
    expect(listWorkspaces).toHaveBeenCalled();
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

/**
 * Spec 1963 Phase 2: the fan-out's overviews are kept (last-known-good), not discarded after
 * `deriveAttention`, so the Cockpit hierarchy can render other workspaces' architects and builders
 * with no additional request.
 */
describe('TowerFleetCache overview retention', () => {
  afterEach(() => { vi.useRealTimers(); });

  function entryFor(cache: InstanceType<typeof TowerFleetCache>, name: string) {
    const entry = cache.getFleet().find((e) => e.workspace.name === name);
    if (!entry) { throw new Error(`no fleet entry named ${name}`); }
    return entry;
  }

  it('keeps each active workspace’s overview on success; a dormant one has none', async () => {
    const overviewA = blockedOverview();
    const overviewB = quietOverview();
    const listWorkspaces = vi.fn().mockResolvedValue([
      ws('/ws/a', 'a', true),
      ws('/ws/b', 'b', true),
      ws('/ws/dormant', 'dormant', false),
    ]);
    const getOverview = vi.fn(async (path: string) => (path === '/ws/a' ? overviewA : overviewB));
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();

    expect(entryFor(cache, 'a').overview).toBe(overviewA);
    expect(entryFor(cache, 'b').overview).toBe(overviewB);
    expect(entryFor(cache, 'dormant').overview).toBeNull();
    expect(cache.getOverview('/ws/a')).toBe(overviewA);
    expect(cache.getOverview('/ws/b')).toBe(overviewB);
    expect(cache.getOverview('/ws/dormant')).toBeNull();
    expect(cache.getOverview('/ws/unknown')).toBeNull();
    cache.dispose();
  });

  it('keeps the last-known-good overview when a later fetch fails (null)', async () => {
    const first = blockedOverview();
    const listWorkspaces = vi.fn().mockResolvedValue([ws('/ws/a', 'a', true)]);
    const getOverview = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(null);
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    expect(cache.getOverview('/ws/a')).toBe(first);

    await cache.refresh(); // transient failure
    expect(entryFor(cache, 'a').overview).toBe(first);
    expect(cache.getOverview('/ws/a')).toBe(first);
    expect(entryFor(cache, 'a').attention.isEmpty).toBe(false); // attention retained alongside
    cache.dispose();
  });

  it('replaces the overview with the newer one on the next successful fetch', async () => {
    const first = blockedOverview();
    const second = quietOverview();
    const listWorkspaces = vi.fn().mockResolvedValue([ws('/ws/a', 'a', true)]);
    const getOverview = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    await cache.refresh();
    expect(cache.getOverview('/ws/a')).toBe(second);
    expect(entryFor(cache, 'a').attention.isEmpty).toBe(true);
    cache.dispose();
  });

  it('has no overview for an active workspace whose first fetch fails', async () => {
    const listWorkspaces = vi.fn().mockResolvedValue([ws('/ws/a', 'a', true)]);
    const getOverview = vi.fn().mockResolvedValue(null);
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    expect(entryFor(cache, 'a').overview).toBeNull();
    expect(cache.getOverview('/ws/a')).toBeNull();
    cache.dispose();
  });

  it('drops the retained overview when a workspace goes dormant, and does not revive it on reactivation failure', async () => {
    const listWorkspaces = vi.fn()
      .mockResolvedValueOnce([ws('/ws/a', 'a', true)])
      .mockResolvedValueOnce([ws('/ws/a', 'a', false)])
      .mockResolvedValueOnce([ws('/ws/a', 'a', true)]);
    const getOverview = vi.fn().mockResolvedValueOnce(blockedOverview()).mockResolvedValueOnce(null);
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    expect(cache.getOverview('/ws/a')).not.toBeNull();

    await cache.refresh(); // now dormant
    expect(entryFor(cache, 'a').overview).toBeNull();
    expect(cache.getOverview('/ws/a')).toBeNull();

    // Reactivated, but its first fetch fails: the pre-dormancy overview must not come back.
    await cache.refresh();
    expect(entryFor(cache, 'a').overview).toBeNull();
    expect(cache.getOverview('/ws/a')).toBeNull();
    cache.dispose();
  });

  it('drops the retained overview when a workspace leaves the list', async () => {
    const listWorkspaces = vi.fn()
      .mockResolvedValueOnce([ws('/ws/a', 'a', true), ws('/ws/b', 'b', true)])
      .mockResolvedValueOnce([ws('/ws/b', 'b', true)]);
    const getOverview = vi.fn().mockResolvedValue(quietOverview());
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    expect(cache.getOverview('/ws/a')).not.toBeNull();

    await cache.refresh();
    expect(cache.getFleet().map((e) => e.workspace.name)).toEqual(['b']);
    expect(cache.getOverview('/ws/a')).toBeNull();
    expect(cache.getOverview('/ws/b')).not.toBeNull();
    cache.dispose();
  });

  it('keeps the overview when the list momentarily returns empty', async () => {
    const overview = blockedOverview();
    const listWorkspaces = vi.fn().mockResolvedValueOnce([ws('/ws/a', 'a', true)]).mockResolvedValueOnce([]);
    const getOverview = vi.fn().mockResolvedValue(overview);
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    await cache.refresh(); // transient list failure surfaces as []
    expect(cache.getOverview('/ws/a')).toBe(overview);
    cache.dispose();
  });

  it('does not let a stale (out-of-sequence) fan-out overwrite a newer overview', async () => {
    // `refresh()` serialises fan-outs, so two never overlap through the public API; the sequence
    // guard is the backstop. Drive the private fan-out directly to pin that the guard covers the
    // retained overview as well as attention.
    const stale = blockedOverview();
    const fresh = quietOverview();
    let resolveStale: (v: OverviewData | null) => void = () => {};
    const listWorkspaces = vi.fn().mockResolvedValue([ws('/ws/a', 'a', true)]);
    const getOverview = vi.fn()
      .mockImplementationOnce(() => new Promise<OverviewData | null>((res) => { resolveStale = res; }))
      .mockResolvedValueOnce(fresh);
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    const fanOut = (cache as unknown as { fetchFleet(): Promise<void> }).fetchFleet.bind(cache);

    const older = fanOut();
    // Let the older fan-out reach its pending getOverview before the newer one starts.
    await vi.waitFor(() => { expect(getOverview).toHaveBeenCalledTimes(1); });
    await fanOut(); // newer fan-out lands first
    expect(cache.getOverview('/ws/a')).toBe(fresh);

    resolveStale(stale); // older fan-out lands late
    await older;
    expect(cache.getOverview('/ws/a')).toBe(fresh);
    expect(entryFor(cache, 'a').overview).toBe(fresh);
    expect(entryFor(cache, 'a').attention.isEmpty).toBe(true);
    cache.dispose();
  });

  it('makes no extra requests: one getOverview per active workspace per refresh, none from the accessor', async () => {
    const listWorkspaces = vi.fn().mockResolvedValue([
      ws('/ws/a', 'a', true),
      ws('/ws/b', 'b', true),
      ws('/ws/c', 'c', true),
      ws('/ws/dormant', 'dormant', false),
    ]);
    const getOverview = vi.fn().mockResolvedValue(quietOverview());
    const cache = new TowerFleetCache(makeFake(listWorkspaces, getOverview).cm);
    await cache.refresh();
    expect(getOverview).toHaveBeenCalledTimes(3);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    for (const path of ['/ws/a', '/ws/b', '/ws/c', '/ws/dormant', '/ws/unknown']) { cache.getOverview(path); }
    expect(getOverview).toHaveBeenCalledTimes(3);

    await cache.refresh();
    expect(getOverview).toHaveBeenCalledTimes(6);
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    cache.dispose();
  });
});
