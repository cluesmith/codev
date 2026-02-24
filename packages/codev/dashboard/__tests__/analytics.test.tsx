/**
 * Tests for the Analytics tab (Bugfix #531).
 *
 * Tests: useAnalytics hook behavior, AnalyticsView rendering,
 * null value formatting, error states, and range switching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AnalyticsResponse } from '../src/lib/api.js';

// ==========================================================================
// Mocks
// ==========================================================================

const mockFetchAnalytics = vi.fn<(range: string, refresh?: boolean) => Promise<AnalyticsResponse>>();

vi.mock('../src/lib/api.js', () => ({
  fetchAnalytics: (...args: unknown[]) => mockFetchAnalytics(...(args as [string, boolean?])),
}));

// ==========================================================================
// Fixtures
// ==========================================================================

function makeStats(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    timeRange: '7d',
    activity: {
      prsMerged: 12,
      medianTimeToMergeHours: 3.5,
      issuesClosed: 6,
      medianTimeToCloseBugsHours: 1.2,
      projectsByProtocol: {
        spir: { count: 3, avgWallClockHours: 48.2 },
        bugfix: { count: 2, avgWallClockHours: 1.5 },
        aspir: { count: 1, avgWallClockHours: 24.0 },
      },
    },
    consultation: {
      totalCount: 20,
      totalCostUsd: 1.23,
      costByModel: { 'gemini-3-pro': 0.8, 'gpt-5.2-codex': 0.43 },
      avgLatencySeconds: 15.3,
      successRate: 95.0,
      byModel: [
        { model: 'gemini-3-pro', count: 10, avgLatency: 12.0, totalCost: 0.8, successRate: 90 },
        { model: 'gpt-5.2-codex', count: 10, avgLatency: 18.6, totalCost: 0.43, successRate: 100 },
      ],
      byReviewType: { spec: 5, plan: 5, pr: 10 },
      byProtocol: { spir: 15, tick: 5 },
    },
    ...overrides,
  };
}

// ==========================================================================
// useAnalytics hook tests
// ==========================================================================

describe('useAnalytics', () => {
  beforeEach(() => {
    mockFetchAnalytics.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('fetches data on mount when active', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { useAnalytics } = await import('../src/hooks/useAnalytics.js');
    const { result } = renderHook(() => useAnalytics(true));

    // Flush the async effect
    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetchAnalytics).toHaveBeenCalledWith('7', false);
    expect(result.current.data?.activity.prsMerged).toBe(12);
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch on mount when inactive', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { useAnalytics } = await import('../src/hooks/useAnalytics.js');
    renderHook(() => useAnalytics(false));

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    expect(mockFetchAnalytics).not.toHaveBeenCalled();
  });

  it('fetches when tab becomes active', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { useAnalytics } = await import('../src/hooks/useAnalytics.js');
    const { result, rerender } = renderHook(
      ({ isActive }: { isActive: boolean }) => useAnalytics(isActive),
      { initialProps: { isActive: false } },
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    expect(mockFetchAnalytics).not.toHaveBeenCalled();

    rerender({ isActive: true });

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetchAnalytics).toHaveBeenCalledTimes(1);
  });

  it('passes refresh=true when refresh() is called', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { useAnalytics } = await import('../src/hooks/useAnalytics.js');
    const { result } = renderHook(() => useAnalytics(true));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchAnalytics).toHaveBeenCalledWith('7', true);
    });
  });

  it('sets error on fetch failure', async () => {
    mockFetchAnalytics.mockRejectedValue(new Error('Network error'));

    const { useAnalytics } = await import('../src/hooks/useAnalytics.js');
    const { result } = renderHook(() => useAnalytics(true));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.data).toBeNull();
  });
});

// ==========================================================================
// AnalyticsView component tests
// ==========================================================================

describe('AnalyticsView', () => {
  beforeEach(() => {
    mockFetchAnalytics.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state initially', async () => {
    mockFetchAnalytics.mockReturnValue(new Promise(() => {}));

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    expect(screen.getByText('Loading analytics...')).toBeInTheDocument();
  });

  it('renders Activity and Consultation section headers (not GitHub/Builders)', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    expect(screen.getByText('Consultation')).toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Builders')).not.toBeInTheDocument();
  });

  it('renders Activity metric values', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('PRs Merged')).toBeInTheDocument();
    });

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3.5h')).toBeInTheDocument();
    // Removed redundant metrics
    expect(screen.queryByText('Projects Completed')).not.toBeInTheDocument();
    expect(screen.queryByText('Bugs Fixed')).not.toBeInTheDocument();
    expect(screen.queryByText('Throughput / Week')).not.toBeInTheDocument();
  });

  it('renders protocol breakdown metrics', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Projects by Protocol')).toBeInTheDocument();
    });

    expect(screen.getByText('SPIR')).toBeInTheDocument();
    expect(screen.getByText('BUGFIX')).toBeInTheDocument();
    expect(screen.getByText('ASPIR')).toBeInTheDocument();
  });

  it('renders consultation total cost', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeInTheDocument();
    });

    expect(screen.getByText('$1.23')).toBeInTheDocument();
  });

  it('displays null values as em-dash', async () => {
    const stats = makeStats({
      activity: {
        prsMerged: 3,
        medianTimeToMergeHours: null,
        issuesClosed: 0,
        medianTimeToCloseBugsHours: null,
        projectsByProtocol: {},
      },
    });
    mockFetchAnalytics.mockResolvedValue(stats);

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders per-section error messages', async () => {
    const stats = makeStats({
      errors: { github: 'GitHub CLI unavailable' },
    });
    mockFetchAnalytics.mockResolvedValue(stats);

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub CLI unavailable')).toBeInTheDocument();
    });
  });

  it('renders per-model breakdown table', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Per Model')).toBeInTheDocument();
    });

    expect(screen.getByText('gemini-3-pro')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.2-codex')).toBeInTheDocument();
  });

  it('does not render Cost per Project section', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    expect(screen.queryByText('Cost per Project')).not.toBeInTheDocument();
  });

  it('does not render Open Issue Backlog', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    expect(screen.queryByText('Open Issue Backlog')).not.toBeInTheDocument();
  });

  it('calls fetchAnalytics with new range when range button is clicked', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    mockFetchAnalytics.mockResolvedValue(makeStats({ timeRange: '30d' }));
    fireEvent.click(screen.getByText('30d'));

    await waitFor(() => {
      expect(mockFetchAnalytics).toHaveBeenCalledWith('30', false);
    });
  });

  it('calls fetchAnalytics with refresh=true when Refresh button is clicked', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    const refreshBtn = screen.getByRole('button', { name: /Refresh/ });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mockFetchAnalytics).toHaveBeenCalledWith('7', true);
    });
  });
});
