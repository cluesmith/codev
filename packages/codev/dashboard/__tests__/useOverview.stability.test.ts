/**
 * Regression test for GitHub Issue #358: Work view backlog section flashes on every poll/refresh
 *
 * Verifies that useOverview() preserves object identity when poll returns
 * structurally identical data, preventing unnecessary React re-renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { OverviewData } from '../src/lib/api.js';

const makeOverview = (backlogTitle = 'Fix login bug'): OverviewData => ({
  builders: [],
  pendingPRs: [],
  backlog: [
    {
      number: 42,
      title: backlogTitle,
      type: 'bug',
      priority: 'high',
      hasSpec: false,
      hasBuilder: false,
      createdAt: '2026-02-10T12:00:00Z',
    },
  ],
});

// Mock api module — control what fetchOverview returns per call
const mockFetchOverview = vi.fn<() => Promise<OverviewData>>();
const mockRefreshOverview = vi.fn<() => Promise<void>>();

vi.mock('../src/lib/api.js', () => ({
  fetchOverview: (...args: unknown[]) => mockFetchOverview(...(args as [])),
  refreshOverview: (...args: unknown[]) => mockRefreshOverview(...(args as [])),
}));

describe('useOverview stability (bugfix #358)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchOverview.mockReset();
    mockRefreshOverview.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves data reference when poll returns identical content', async () => {
    // Both polls return structurally identical data (different object instances)
    mockFetchOverview.mockResolvedValueOnce(makeOverview());
    mockFetchOverview.mockResolvedValueOnce(makeOverview());

    const { useOverview } = await import('../src/hooks/useOverview.js');
    const { result } = renderHook(() => useOverview());

    // Wait for initial poll to settle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.data).not.toBeNull();

    const firstRef = result.current.data;

    // Trigger second poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockFetchOverview).toHaveBeenCalledTimes(2);
    // Data reference should be the SAME object (not a new one)
    expect(result.current.data).toBe(firstRef);
  });

  it('updates data reference when content actually changes', async () => {
    mockFetchOverview.mockResolvedValueOnce(makeOverview('Fix login bug'));
    mockFetchOverview.mockResolvedValueOnce(makeOverview('Fix signup bug'));

    const { useOverview } = await import('../src/hooks/useOverview.js');
    const { result } = renderHook(() => useOverview());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.data).not.toBeNull();

    const firstRef = result.current.data;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockFetchOverview).toHaveBeenCalledTimes(2);
    // Data should be a NEW reference (content changed)
    expect(result.current.data).not.toBe(firstRef);
    expect(result.current.data!.backlog[0].title).toBe('Fix signup bug');
  });
});
