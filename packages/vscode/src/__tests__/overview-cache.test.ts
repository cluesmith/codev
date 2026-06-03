/**
 * PIR #916: runtime behavior tests for OverviewCache's last-known-good
 * retention.
 *
 * The bug: a transient read (connection not `connected`, or a failed
 * `/api/overview` fetch) used to overwrite the cache with null. Every
 * data-bearing sidebar provider renders a falsy cache read as `[]`, so a brief
 * SSE drop / reconnect blanked Builders + Backlog + Pull Requests + Recently
 * Closed simultaneously until the next event re-populated them.
 *
 * The invariant under test: a single null/disconnected refresh must NOT empty
 * a populated cache. Mocks `vscode` (the established pattern from
 * `workspace-sse-subscriber.test.ts`) and a fake ConnectionManager so we can
 * drive synthetic connection states and overview responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OverviewData } from '@cluesmith/codev-types';

// Mock the vscode module with a minimal EventEmitter implementation.
vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };
    fire = vi.fn((e: T) => {
      this.listeners.forEach((l) => l(e));
    });
  }
  return { EventEmitter: FakeEventEmitter };
});

// Import AFTER mocks are set up.
const { OverviewCache } = await import('../views/overview-data.js');

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Minimal ConnectionManager double exposing only what OverviewCache touches:
 * state, client, workspace path, and the two events it subscribes to.
 */
function makeFakeConnectionManager(getOverview: ReturnType<typeof vi.fn>) {
  const sseListeners: Array<() => void> = [];
  const stateListeners: Array<(s: ConnectionState) => void> = [];
  let state: ConnectionState = 'connected';

  const client = { getOverview };

  return {
    cm: {
      getState: () => state,
      getClient: () => client,
      getWorkspacePath: () => '/ws',
      onSSEEvent: (l: () => void) => { sseListeners.push(l); return { dispose() {} }; },
      onStateChange: (l: (s: ConnectionState) => void) => {
        stateListeners.push(l);
        return { dispose() {} };
      },
    } as unknown as import('../connection-manager.js').ConnectionManager,
    setState: (s: ConnectionState) => { state = s; },
    fireSse: () => sseListeners.forEach((l) => l()),
    fireState: (s: ConnectionState) => { state = s; stateListeners.forEach((l) => l(s)); },
    client,
  };
}

function overview(builders: number): OverviewData {
  return {
    builders: Array.from({ length: builders }, (_, i) => ({ id: `b${i}` })),
    backlog: [],
    pendingPRs: [],
    recentlyClosed: [],
  } as unknown as OverviewData;
}

describe('OverviewCache last-known-good retention (#916)', () => {
  let getOverview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getOverview = vi.fn();
  });

  it('does not clobber populated data when a refresh runs while not connected', async () => {
    getOverview.mockResolvedValue(overview(3));
    const { cm, setState } = makeFakeConnectionManager(getOverview);
    const cache = new OverviewCache(cm);

    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(3);

    // Connection blips to reconnecting; a refresh races that window.
    setState('reconnecting');
    await cache.refresh();

    // Last-known-good retained — views do not blank.
    expect(cache.getData()?.builders).toHaveLength(3);
  });

  it('does not clobber populated data when there is no client', async () => {
    getOverview.mockResolvedValue(overview(2));
    const { cm } = makeFakeConnectionManager(getOverview);
    // Force getClient() to return null after the first good fetch.
    const cache = new OverviewCache(cm);
    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(2);

    (cm as unknown as { getClient: () => unknown }).getClient = () => null;
    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(2);
  });

  it('retains last-known-good when a connected fetch fails (getOverview returns null)', async () => {
    getOverview.mockResolvedValueOnce(overview(4)).mockResolvedValueOnce(null);
    const { cm } = makeFakeConnectionManager(getOverview);
    const cache = new OverviewCache(cm);

    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(4);

    // A failed fetch must not empty the cache.
    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(4);
  });

  it('commits a valid empty overview (genuine emptiness still renders)', async () => {
    getOverview.mockResolvedValueOnce(overview(3)).mockResolvedValueOnce(overview(0));
    const { cm } = makeFakeConnectionManager(getOverview);
    const cache = new OverviewCache(cm);

    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(3);

    // A real empty payload replaces the cached value — empty arrays, not held.
    await cache.refresh();
    expect(cache.getData()?.builders).toHaveLength(0);
  });

  it('starts null and stays null on a not-connected initial refresh (no crash)', async () => {
    const { cm, setState } = makeFakeConnectionManager(getOverview);
    setState('connecting');
    const cache = new OverviewCache(cm);

    expect(cache.getData()).toBeNull();
    await cache.refresh();
    expect(cache.getData()).toBeNull();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('freshens on reconnect: an onStateChange("connected") triggers a refresh', async () => {
    getOverview.mockResolvedValue(overview(1));
    const { cm, fireState } = makeFakeConnectionManager(getOverview);
    new OverviewCache(cm);

    expect(getOverview).not.toHaveBeenCalled();
    fireState('connected');
    // Allow the fire-and-forget refresh() microtask to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(getOverview).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on non-connected state transitions', async () => {
    getOverview.mockResolvedValue(overview(1));
    const { cm, fireState } = makeFakeConnectionManager(getOverview);
    new OverviewCache(cm);

    fireState('reconnecting');
    fireState('disconnected');
    await Promise.resolve();
    expect(getOverview).not.toHaveBeenCalled();
  });
});
