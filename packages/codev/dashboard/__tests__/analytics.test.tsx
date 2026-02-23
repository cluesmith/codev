/**
 * Tests for the Analytics tab (Spec 456, Bugfix #529).
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
      projectsCompleted: 5,
      projectsByProtocol: { spir: 3, aspir: 2 },
      bugsFixed: 4,
      avgTimeToMergeHours: 3.5,
      throughputPerWeek: 2.5,
      activeBuilders: 2,
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

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetchAnalytics).toHaveBeenCalledWith('7', false);
    expect(result.current.data?.activity.projectsCompleted).toBe(5);
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

  it('renders Activity and Consultation section headers', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    expect(screen.getByText('Consultation')).toBeInTheDocument();
  });

  it('does not render separate GitHub or Builders sections', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Builders')).not.toBeInTheDocument();
  });

  it('renders Activity metric values', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Projects Completed')).toBeInTheDocument();
    });

    expect(screen.getByText('Bugs Fixed')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // projectsCompleted
    expect(screen.getByText('4')).toBeInTheDocument(); // bugsFixed
    expect(screen.getByText('3.5h')).toBeInTheDocument(); // avgTimeToMerge
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
        projectsCompleted: 3,
        projectsByProtocol: {},
        bugsFixed: 0,
        avgTimeToMergeHours: null,
        throughputPerWeek: 0,
        activeBuilders: 0,
      },
    });
    mockFetchAnalytics.mockResolvedValue(stats);

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });

    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders per-section error messages', async () => {
    const stats = makeStats({
      errors: { activity: 'Project scan failed' },
    });
    mockFetchAnalytics.mockResolvedValue(stats);

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Project scan failed')).toBeInTheDocument();
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
      expect(screen.getByText('Consultation')).toBeInTheDocument();
    });

    expect(screen.queryByText('Cost per Project')).not.toBeInTheDocument();
  });

  it('renders Projects by Protocol sub-section', async () => {
    mockFetchAnalytics.mockResolvedValue(makeStats());

    const { AnalyticsView } = await import('../src/components/AnalyticsView.js');
    render(<AnalyticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Projects by Protocol')).toBeInTheDocument();
    });
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
