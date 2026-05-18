/**
 * Spec 761: App multi-architect rendering tests.
 *
 * Verifies:
 *  - N=0: existing empty-state, no architect strip.
 *  - N=1: bare Terminal in the left pane, no architect strip (DOM-snapshot stability).
 *  - N=2: ArchitectTabStrip with two entries; clicking each toggles which terminal
 *         pane is visible (display:none vs visible); both terminals remain mounted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// localStorage mock for jsdom (same pattern as TipBanner/useTabs tests)
const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (index: number) => [...storageMap.keys()][index] ?? null,
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

// --- Mocks (hoisted by vitest) ---

const mockUseBuilderStatus = vi.fn();
vi.mock('../src/hooks/useBuilderStatus.js', () => ({
  useBuilderStatus: () => mockUseBuilderStatus(),
}));

vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => false, // desktop layout
}));

vi.mock('../src/components/Terminal.js', () => ({
  Terminal: ({ wsPath }: { wsPath: string }) => (
    <div data-testid={`terminal-${wsPath}`}>Terminal: {wsPath}</div>
  ),
}));

vi.mock('../src/components/WorkView.js', () => ({
  WorkView: () => <div data-testid="work-view">Work</div>,
}));

vi.mock('../src/components/AnalyticsView.js', () => ({
  AnalyticsView: () => <div data-testid="analytics-view">Analytics</div>,
}));

vi.mock('../src/components/FileViewer.js', () => ({
  FileViewer: () => <div data-testid="file-viewer">File</div>,
}));

vi.mock('../src/components/SplitPane.js', () => ({
  SplitPane: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div data-testid="split-pane">
      <div data-testid="split-left">{left}</div>
      <div data-testid="split-right">{right}</div>
    </div>
  ),
}));

vi.mock('../src/components/MobileLayout.js', () => ({
  MobileLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mobile-layout">{children}</div>
  ),
}));

vi.mock('../src/components/TabBar.js', () => ({
  TabBar: ({ tabs }: { tabs: Array<{ id: string; label: string }> }) => (
    <div data-testid="tab-bar">{tabs.map(t => <span key={t.id}>{t.label}</span>)}</div>
  ),
}));

import { App } from '../src/components/App.js';

afterEach(() => {
  cleanup();
  storageMap.clear();
  mockUseBuilderStatus.mockReset();
});

function archEntry(name: string, terminalId: string) {
  return { name, port: 0, pid: 1, terminalId, persistent: false };
}

describe('App multi-architect dashboard (Spec 761)', () => {
  it('N=0: renders empty-state, no architect strip', () => {
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: null,
        architects: [],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    expect(screen.getByText(/No architect terminal/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Architect tabs')).toBeNull();
  });

  it('N=1: renders bare Terminal in the left pane, no architect strip', () => {
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [archEntry('main', 'term-main')],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    // Architect strip should NOT be rendered when N=1 (DOM-snapshot stability)
    expect(screen.queryByLabelText('Architect tabs')).toBeNull();
    // The left pane should render exactly one architect Terminal.
    const leftPane = screen.getByTestId('split-left');
    expect(leftPane).toHaveTextContent('Terminal:');
  });

  it('N=2: renders ArchitectTabStrip with two entries', () => {
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [
          archEntry('main', 'term-main'),
          archEntry('sibling', 'term-sibling'),
        ],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    const strip = screen.getByLabelText('Architect tabs');
    expect(strip).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'main' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'sibling' })).toBeInTheDocument();
  });

  it('N=2: clicking a strip tab flips display style; both terminals remain mounted', () => {
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [
          archEntry('main', 'term-main'),
          archEntry('sibling', 'term-sibling'),
        ],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    // Both terminals should be in the DOM (persistent rendering pattern).
    const mainTerm = screen.getByTestId('terminal-/ws/terminal/term-main');
    const siblingTerm = screen.getByTestId('terminal-/ws/terminal/term-sibling');
    expect(mainTerm).toBeInTheDocument();
    expect(siblingTerm).toBeInTheDocument();

    // Initially: main visible (first architect), sibling hidden.
    expect(mainTerm.closest('.terminal-tab-pane')!).not.toHaveStyle({ display: 'none' });
    expect(siblingTerm.closest('.terminal-tab-pane')!).toHaveStyle({ display: 'none' });

    // Click sibling tab in the strip.
    fireEvent.click(screen.getByRole('tab', { name: 'sibling' }));

    // After click: visibility flipped, both still mounted.
    expect(mainTerm.closest('.terminal-tab-pane')!).toHaveStyle({ display: 'none' });
    expect(siblingTerm.closest('.terminal-tab-pane')!).not.toHaveStyle({ display: 'none' });

    // Both elements are the same DOM nodes — not remounted.
    expect(screen.getByTestId('terminal-/ws/terminal/term-main')).toBe(mainTerm);
    expect(screen.getByTestId('terminal-/ws/terminal/term-sibling')).toBe(siblingTerm);
  });

  it('N=2: persists clicked architect to localStorage', () => {
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [
          archEntry('main', 'term-main'),
          archEntry('sibling', 'term-sibling'),
        ],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'sibling' }));

    expect(storageMap.get(`codev-active-architect:${window.location.pathname}`)).toBe('sibling');
  });

  it('N=2: restores persisted active architect on initial render', () => {
    storageMap.set(`codev-active-architect:${window.location.pathname}`, 'sibling');
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [
          archEntry('main', 'term-main'),
          archEntry('sibling', 'term-sibling'),
        ],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    const mainTerm = screen.getByTestId('terminal-/ws/terminal/term-main');
    const siblingTerm = screen.getByTestId('terminal-/ws/terminal/term-sibling');
    // sibling should be visible because it was persisted as the active architect.
    expect(siblingTerm.closest('.terminal-tab-pane')!).not.toHaveStyle({ display: 'none' });
    expect(mainTerm.closest('.terminal-tab-pane')!).toHaveStyle({ display: 'none' });
  });

  it('N=2: reload with persisted architect keeps work view active on the right pane (Claude iter-1 bug fix)', () => {
    // Spec 761 regression guard: previously, useTabs restored the persisted
    // architect into activeTabId on mount, which blanked the entire right
    // pane (work/analytics/team all hidden since activeTab.type === 'architect').
    // The fix removed useTabs's localStorage read; App.tsx handles left-pane
    // restoration independently.
    storageMap.set(`codev-active-architect:${window.location.pathname}`, 'sibling');
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [
          archEntry('main', 'term-main'),
          archEntry('sibling', 'term-sibling'),
        ],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    // Right pane: work view should be visible (default activeTabId === 'work').
    const workView = screen.getByTestId('work-view');
    expect(workView.parentElement).not.toHaveStyle({ display: 'none' });
    // Left pane: sibling is still the active architect.
    const siblingTerm = screen.getByTestId('terminal-/ws/terminal/term-sibling');
    expect(siblingTerm.closest('.terminal-tab-pane')!).not.toHaveStyle({ display: 'none' });
  });

  it('N=2: deep-link ?tab=architect:<name> syncs the left pane selection', () => {
    // Simulate a deep-link by setting the search string before render. Leave
    // pathname at the default '/' to keep getTerminalWsPath()'s output
    // matching the existing terminal-/ws/terminal/<id> testids.
    window.history.replaceState({}, '', '/?tab=architect:sibling');
    mockUseBuilderStatus.mockReturnValue({
      state: {
        architect: archEntry('main', 'term-main'),
        architects: [
          archEntry('main', 'term-main'),
          archEntry('sibling', 'term-sibling'),
        ],
        builders: [],
        utils: [],
        annotations: [],
      },
      refresh: vi.fn(),
    });

    render(<App />);

    const mainTerm = screen.getByTestId('terminal-/ws/terminal/term-main');
    const siblingTerm = screen.getByTestId('terminal-/ws/terminal/term-sibling');
    expect(siblingTerm.closest('.terminal-tab-pane')!).not.toHaveStyle({ display: 'none' });
    expect(mainTerm.closest('.terminal-tab-pane')!).toHaveStyle({ display: 'none' });

    // Restore the URL for subsequent tests.
    window.history.replaceState({}, '', '/');
  });
});
