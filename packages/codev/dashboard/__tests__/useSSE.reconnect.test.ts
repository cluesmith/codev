/**
 * Regression test for GitHub Issue #472: Dashboard shows stale/empty state after Tower restart
 *
 * Verifies that when the SSE connection receives a message (e.g. after Tower
 * restarts and sends a "connected" event), the polling hooks immediately
 * re-fetch data instead of waiting for the next poll interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DashboardState, OverviewData } from '../src/lib/api.js';

// Capture EventSource instances so we can simulate SSE messages
let eventSourceInstances: Array<{ onmessage: ((ev: MessageEvent) => void) | null; close: () => void }> = [];

class MockEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  readyState = 1;
  close = vi.fn();
  constructor(_url: string) {
    eventSourceInstances.push(this);
  }
}

// Override the EventSource stub from setup.ts with our instrumented mock
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

// Mock api module
const mockFetchState = vi.fn<() => Promise<DashboardState>>();
const mockFetchOverview = vi.fn<() => Promise<OverviewData>>();
const mockRefreshOverview = vi.fn<() => Promise<void>>();

vi.mock('../src/lib/api.js', () => ({
  fetchState: (...args: unknown[]) => mockFetchState(...(args as [])),
  fetchOverview: (...args: unknown[]) => mockFetchOverview(...(args as [])),
  refreshOverview: (...args: unknown[]) => mockRefreshOverview(...(args as [])),
  getSSEEventsUrl: () => 'http://localhost:0/api/events',
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
};

function simulateSSEMessage(data: Record<string, unknown> = { type: 'connected' }): void {
  for (const es of eventSourceInstances) {
    if (es.onmessage) {
      es.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }
}

describe('SSE reconnect triggers immediate refresh (bugfix #472)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    eventSourceInstances = [];
    mockFetchState.mockReset().mockResolvedValue(MOCK_STATE);
    mockFetchOverview.mockReset().mockResolvedValue(MOCK_OVERVIEW);
    mockRefreshOverview.mockReset().mockResolvedValue(undefined);
    // Ensure tab is "visible" by default
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset module registry so singleton EventSource is cleaned up between tests
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

    // Record baseline — prior tests may have leaked instances via module resets
    const baseCount = eventSourceInstances.length;
    expect(baseCount).toBeGreaterThanOrEqual(1);
    const currentES = eventSourceInstances[baseCount - 1];

    // Hide the tab
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // SSE should be closed
    expect(currentES.close).toHaveBeenCalled();

    // Show the tab again
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Should have reconnected (at least one new EventSource instance)
    expect(eventSourceInstances.length).toBeGreaterThan(baseCount);

    // Listener should have been notified on re-visible (to refresh stale data)
    expect(listener).toHaveBeenCalled();

    unmount();
  });

  it('does not connect SSE if tab starts hidden', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { useSSE } = await import('../src/hooks/useSSE.js');
    const listener = vi.fn();
    const baseCount = eventSourceInstances.length;
    const { unmount } = renderHook(() => useSSE(listener));

    // Should NOT have connected (no new instances beyond baseline)
    expect(eventSourceInstances.length).toBe(baseCount);

    // Make visible — should connect now
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(eventSourceInstances.length).toBeGreaterThan(baseCount);
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
