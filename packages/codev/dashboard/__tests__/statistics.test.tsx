/**
 * Tests for the Statistics tab (Spec 456, Phase 3).
 *
 * Tests: useStatistics hook behavior, StatisticsView rendering,
 * null value formatting, error states, and range switching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { StatisticsResponse } from '../src/lib/api.js';

// ==========================================================================
// Mocks
// ==========================================================================

const mockFetchStatistics = vi.fn<(range: string, refresh?: boolean) => Promise<StatisticsResponse>>();

vi.mock('../src/lib/api.js', () => ({
  fetchStatistics: (...args: unknown[]) => mockFetchStatistics(...(args as [string, boolean?])),
}));

// ==========================================================================
// Fixtures
// ==========================================================================

function makeStats(overrides: Partial<StatisticsResponse> = {}): StatisticsResponse {
  return {
    timeRange: '7d',
    github: {
      prsMerged: 12,
      avgTimeToMergeHours: 3.5,
      bugBacklog: 4,
      nonBugBacklog: 8,
      issuesClosed: 6,
      avgTimeToCloseBugsHours: 1.2,
    },
    builders: {
      projectsCompleted: 5,
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
      costByProject: [
        { projectId: '456', totalCost: 0.75 },
        { projectId: '123', totalCost: 0.48 },
      ],
    },
    ...overrides,
  };
}

// ==========================================================================
// useStatistics hook tests
// ==========================================================================

describe('useStatistics', () => {
  beforeEach(() => {
    mockFetchStatistics.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('fetches data on mount when active', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { useStatistics } = await import('../src/hooks/useStatistics.js');
    const { result } = renderHook(() => useStatistics(true));

    // Flush the async effect
    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetchStatistics).toHaveBeenCalledWith('7', false);
    expect(result.current.data?.github.prsMerged).toBe(12);
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch on mount when inactive', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { useStatistics } = await import('../src/hooks/useStatistics.js');
    renderHook(() => useStatistics(false));

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    expect(mockFetchStatistics).not.toHaveBeenCalled();
  });

  it('fetches when tab becomes active', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { useStatistics } = await import('../src/hooks/useStatistics.js');
    const { result, rerender } = renderHook(
      ({ isActive }: { isActive: boolean }) => useStatistics(isActive),
      { initialProps: { isActive: false } },
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    expect(mockFetchStatistics).not.toHaveBeenCalled();

    rerender({ isActive: true });

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetchStatistics).toHaveBeenCalledTimes(1);
  });

  it('passes refresh=true when refresh() is called', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { useStatistics } = await import('../src/hooks/useStatistics.js');
    const { result } = renderHook(() => useStatistics(true));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchStatistics).toHaveBeenCalledWith('7', true);
    });
  });

  it('sets error on fetch failure', async () => {
    mockFetchStatistics.mockRejectedValue(new Error('Network error'));

    const { useStatistics } = await import('../src/hooks/useStatistics.js');
    const { result } = renderHook(() => useStatistics(true));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.data).toBeNull();
  });
});

// ==========================================================================
// StatisticsView component tests
// ==========================================================================

describe('StatisticsView', () => {
  beforeEach(() => {
    mockFetchStatistics.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state initially', async () => {
    mockFetchStatistics.mockReturnValue(new Promise(() => {}));

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    expect(screen.getByText('Loading statistics...')).toBeInTheDocument();
  });

  it('renders all three section headers', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });

    expect(screen.getByText('Builders')).toBeInTheDocument();
    expect(screen.getByText('Consultation')).toBeInTheDocument();
  });

  it('renders GitHub metric values', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('PRs Merged')).toBeInTheDocument();
    });

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3.5h')).toBeInTheDocument();
  });

  it('renders consultation total cost', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeInTheDocument();
    });

    expect(screen.getByText('$1.23')).toBeInTheDocument();
  });

  it('displays null values as em-dash', async () => {
    const stats = makeStats({
      github: {
        prsMerged: 3,
        avgTimeToMergeHours: null,
        bugBacklog: 0,
        nonBugBacklog: 0,
        issuesClosed: 0,
        avgTimeToCloseBugsHours: null,
      },
    });
    mockFetchStatistics.mockResolvedValue(stats);

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });

    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders per-section error messages', async () => {
    const stats = makeStats({
      errors: { github: 'GitHub CLI unavailable' },
    });
    mockFetchStatistics.mockResolvedValue(stats);

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub CLI unavailable')).toBeInTheDocument();
    });
  });

  it('renders per-model breakdown table', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Per Model')).toBeInTheDocument();
    });

    expect(screen.getByText('gemini-3-pro')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.2-codex')).toBeInTheDocument();
  });

  it('renders cost per project list', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('Cost per Project')).toBeInTheDocument();
    });

    expect(screen.getByText('#456')).toBeInTheDocument();
    expect(screen.getByText('$0.75')).toBeInTheDocument();
  });

  it('calls fetchStatistics with new range when range button is clicked', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });

    mockFetchStatistics.mockResolvedValue(makeStats({ timeRange: '30d' }));
    fireEvent.click(screen.getByText('30d'));

    await waitFor(() => {
      expect(mockFetchStatistics).toHaveBeenCalledWith('30', false);
    });
  });

  it('calls fetchStatistics with refresh=true when Refresh button is clicked', async () => {
    mockFetchStatistics.mockResolvedValue(makeStats());

    const { StatisticsView } = await import('../src/components/StatisticsView.js');
    render(<StatisticsView isActive={true} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });

    const refreshBtn = screen.getByRole('button', { name: /Refresh/ });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mockFetchStatistics).toHaveBeenCalledWith('7', true);
    });
  });
});
