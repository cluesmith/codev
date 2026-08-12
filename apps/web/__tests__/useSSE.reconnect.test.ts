/**
 * Regression test for GitHub Issue #472: Dashboard shows stale/empty state after Tower restart
 *
 * Verifies that when the SSE connection receives a message (e.g. after Tower
 * restarts and sends a "connected" event), the polling hooks immediately
 * re-fetch data instead of waiting for the next poll interval.
 *
 * useSSE streams via fetch + ReadableStream (not EventSource) so it can send the
 * codev-web-key header (advisory GHSA-xvjp-7748-v88v). This test mocks fetch to
 * return a controllable stream and drives SSE frames into it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DashboardState, OverviewData } from '../src/lib/api.js';

// Each fetch() call to the SSE endpoint creates a connection we can push frames
// into and observe aborting (the fetch-stream analogue of an EventSource).
interface MockSSEConnection {
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  aborted: boolean;
  abort: ReturnType<typeof vi.fn>;
}
let connections: MockSSEConnection[] = [];
const encoder = new TextEncoder();

const mockFetch = vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
  const conn: MockSSEConnection = { controller: null, aborted: false, abort: vi.fn() };
  connections.push(conn);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      conn.controller = controller;
      const signal = opts?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          conn.aborted = true;
          conn.abort();
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* already closed */ }
        });
      }
    },
  });
  return Promise.resolve({ ok: true, body } as unknown as Response);
});
(globalThis as Record<string, unknown>).fetch = mockFetch;

// Mock api module
const mockFetchState = vi.fn<() => Promise<DashboardState>>();
const mockFetchOverview = vi.fn<() => Promise<OverviewData>>();
const mockRefreshOverview = vi.fn<() => Promise<void>>();

vi.mock('../src/lib/api.js', () => ({
  fetchState: (...args: unknown[]) => mockFetchState(...(args as [])),
  fetchOverview: (...args: unknown[]) => mockFetchOverview(...(args as [])),
  refreshOverview: (...args: unknown[]) => mockRefreshOverview(...(args as [])),
  getSSEEventsUrl: () => 'http://localhost:0/api/events',
  getWebKey: () => null,
}));

const MOCK_STATE: DashboardState = {
  architect: null,
  builders: [],
  utils: [],
  annotations: [],
};

const MOCK_OVERVIEW: OverviewData = {
  builders: [],
  pendingPRs: [],
  backlog: [],
  recentlyClosed: [],
  architects: [],
};

/** Push an SSE `data:` frame into every open connection's stream. */
function simulateSSEMessage(data: Record<string, unknown> = { type: 'connected' }): void {
  const frame = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const conn of connections) {
    if (conn.controller && !conn.aborted) {
      conn.controller.enqueue(frame);
    }
  }
}

/** Simulate the server closing the stream (→ useSSE schedules a reconnect). */
function endStream(conn: MockSSEConnection): void {
  if (conn.controller && !conn.aborted) {
    try { conn.controller.close(); } catch { /* already closed */ }
  }
}

describe('SSE reconnect triggers immediate refresh (bugfix #472)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    connections = [];
    mockFetch.mockClear();
    mockFetchState.mockReset().mockResolvedValue(MOCK_STATE);
    mockFetchOverview.mockReset().mockResolvedValue(MOCK_OVERVIEW);
    mockRefreshOverview.mockReset().mockResolvedValue(undefined);
    // Ensure tab is "visible" by default
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset module registry so the singleton connection is cleaned up between tests
    vi.resetModules();
  });

  it('useBuilderStatus triggers immediate refresh on SSE message', async () => {
    const { useBuilderStatus } = await import('../src/hooks/useBuilderStatus.js');
    const { result } = renderHook(() => useBuilderStatus());

    // Wait for initial poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.state).toEqual(MOCK_STATE);

    // Record call count after initial fetch
    const callsAfterInit = mockFetchState.mock.calls.length;

    // Simulate SSE message (as if Tower just restarted and sent "connected")
    await act(async () => {
      simulateSSEMessage({ type: 'connected', id: 'abc123' });
      // Allow the async refresh to settle
      await vi.advanceTimersByTimeAsync(50);
    });

    // Should have fetched again immediately (not waiting for poll interval)
    expect(mockFetchState.mock.calls.length).toBeGreaterThan(callsAfterInit);
  });

  it('useOverview triggers immediate poll on SSE message', async () => {
    const { useOverview } = await import('../src/hooks/useOverview.js');
    const { result } = renderHook(() => useOverview());

    // Wait for initial poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.data).toEqual(MOCK_OVERVIEW);

    const callsAfterInit = mockFetchOverview.mock.calls.length;

    // Simulate SSE reconnect event
    await act(async () => {
      simulateSSEMessage({ type: 'connected', id: 'def456' });
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(mockFetchOverview.mock.calls.length).toBeGreaterThan(callsAfterInit);
  });

  it('disconnects SSE when tab is hidden and reconnects on visible', async () => {
    const { useSSE } = await import('../src/hooks/useSSE.js');
    const listener = vi.fn();
    const { unmount } = renderHook(() => useSSE(listener));

    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Record baseline — prior tests may have leaked connections via module resets
    const baseCount = connections.length;
    expect(baseCount).toBeGreaterThanOrEqual(1);
    const currentConn = connections[baseCount - 1];

    // Hide the tab
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // SSE should be aborted (the fetch-stream analogue of EventSource.close)
    expect(currentConn.abort).toHaveBeenCalled();

    // Show the tab again
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Should have reconnected (at least one new connection)
    expect(connections.length).toBeGreaterThan(baseCount);

    // Listener should have been notified on re-visible (to refresh stale data)
    expect(listener).toHaveBeenCalled();

    unmount();
  });

  it('does not connect SSE if tab starts hidden', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { useSSE } = await import('../src/hooks/useSSE.js');
    const listener = vi.fn();
    const baseCount = connections.length;
    const { unmount } = renderHook(() => useSSE(listener));

    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Should NOT have connected (no new connections beyond baseline)
    expect(connections.length).toBe(baseCount);

    // Make visible — should connect now
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(connections.length).toBeGreaterThan(baseCount);
    unmount();
  });

  it('schedules reconnect when the stream ends (Bugfix #1124)', async () => {
    const { useSSE } = await import('../src/hooks/useSSE.js');
    const listener = vi.fn();
    const { unmount } = renderHook(() => useSSE(listener));

    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const baseCount = connections.length;
    expect(baseCount).toBeGreaterThanOrEqual(1);
    const currentConn = connections[baseCount - 1];

    // Simulate the server dropping the stream (non-200 / restart / capacity).
    await act(async () => {
      endStream(currentConn);
      // Advance past the jittered reconnect window (max 5s)
      await vi.advanceTimersByTimeAsync(6000);
    });

    // Should have reconnected (new connection)
    expect(connections.length).toBeGreaterThan(baseCount);

    unmount();
  });

  it('useOverview responds to overview-changed SSE event', async () => {
    const { useOverview } = await import('../src/hooks/useOverview.js');
    const { result } = renderHook(() => useOverview());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.data).toEqual(MOCK_OVERVIEW);

    const callsAfterInit = mockFetchOverview.mock.calls.length;

    // Simulate overview-changed event (sent when overview cache is invalidated)
    await act(async () => {
      simulateSSEMessage({ type: 'overview-changed', title: 'Overview updated', body: 'Cache invalidated' });
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(mockFetchOverview.mock.calls.length).toBeGreaterThan(callsAfterInit);
  });
});
