/**
 * Issue #1919: the Team view no longer fetches on every SSE event.
 *
 * Tower broadcasts an SSE event for nearly every agent tool call, and each Team
 * fetch made Tower spawn `git` (a visible console window on Windows) and run the
 * team-activity GraphQL query. The view now fetches on SSE only while visible,
 * at most once per throttle window, and immediately on reveal, connect and
 * manual refresh, never two fetches at once. Mocks `vscode` (the established
 * pattern) + a fake ConnectionManager / TowerClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const vscode = await import('vscode');
const { TeamProvider, TEAM_SSE_THROTTLE_MS } = await import('../views/team.js');

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

function makeHarness() {
  const sseListeners: Array<() => void> = [];
  const stateListeners: Array<(s: ConnectionState) => void> = [];
  let resolveFetch: (() => void) | null = null;
  let holdFetches = false;
  const request = vi.fn(() => {
    if (!holdFetches) { return Promise.resolve({ ok: true, data: { enabled: true, members: [] } }); }
    return new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, data: { enabled: true, members: [] } });
    });
  });
  const cm = {
    getClient: () => ({ request }),
    getWorkspacePath: () => '/ws',
    onSSEEvent: (l: () => void) => { sseListeners.push(l); return { dispose() {} }; },
    onStateChange: (l: (s: ConnectionState) => void) => { stateListeners.push(l); return { dispose() {} }; },
  } as unknown as import('../connection-manager.js').ConnectionManager;

  const visibility = new vscode.EventEmitter<{ visible: boolean }>();
  const view = { visible: false, onDidChangeVisibility: visibility.event };
  const provider = new TeamProvider(cm);

  return {
    provider,
    request,
    attach: (visible: boolean) => { view.visible = visible; provider.attachView(view as never); },
    setVisible: (visible: boolean) => { view.visible = visible; visibility.fire({ visible }); },
    fireSse: (n = 1) => { for (let i = 0; i < n; i++) { sseListeners.forEach((l) => l()); } },
    fireState: (s: ConnectionState) => stateListeners.forEach((l) => l(s)),
    holdFetches: () => { holdFetches = true; },
    settleFetch: async () => { resolveFetch?.(); resolveFetch = null; await vi.advanceTimersByTimeAsync(0); },
  };
}

describe('TeamProvider refresh policy (#1919)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fetch on SSE events while the view is hidden', async () => {
    const h = makeHarness();
    h.attach(false);
    h.fireSse(50);
    await vi.advanceTimersByTimeAsync(TEAM_SSE_THROTTLE_MS * 3);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('fetches when attached to a visible view and when the view becomes visible', async () => {
    const h = makeHarness();
    h.attach(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(1);

    h.setVisible(false);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of SSE events into one fetch per throttle window, keeping the trailing one', async () => {
    const h = makeHarness();
    h.attach(true); // fetch #1 at t=0
    await vi.advanceTimersByTimeAsync(0);

    h.fireSse(40); // an agent turn: many events inside the window
    await vi.advanceTimersByTimeAsync(TEAM_SSE_THROTTLE_MS - 1);
    expect(h.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // the trailing fetch
    expect(h.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(TEAM_SSE_THROTTLE_MS * 2); // quiet: nothing more
    expect(h.request).toHaveBeenCalledTimes(2);

    h.fireSse(); // past the window: immediate
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(3);
  });

  it('drops a pending throttled fetch if the view is hidden before it fires', async () => {
    const h = makeHarness();
    h.attach(true);
    await vi.advanceTimersByTimeAsync(0);
    h.fireSse();
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(TEAM_SSE_THROTTLE_MS);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('fetches on connect only while visible', async () => {
    const h = makeHarness();
    h.attach(false);
    h.fireState('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).not.toHaveBeenCalled();

    h.setVisible(true); // fetch #1
    await vi.advanceTimersByTimeAsync(0);
    h.fireState('connected'); // fetch #2
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('never runs two fetches at once: a trigger during one re-runs it once after', async () => {
    const h = makeHarness();
    h.holdFetches();
    h.attach(true); // fetch #1 in flight
    h.provider.refresh();
    h.provider.refresh();
    expect(h.request).toHaveBeenCalledTimes(1);

    await h.settleFetch(); // #1 settles; the queued re-run starts
    expect(h.request).toHaveBeenCalledTimes(2);
    await h.settleFetch();
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('a manual refresh fetches immediately even inside the throttle window', async () => {
    const h = makeHarness();
    h.attach(true);
    await vi.advanceTimersByTimeAsync(0);
    h.provider.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(2);
  });
});
