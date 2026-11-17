/**
 * Spec 1819 Phase 4: the Decisions tab in the desktop and mobile layouts —
 * shown with `decisionsEnabled`, mounted for as long as the tab exists, and
 * toggled by `display` like Analytics/Team so its state survives tab switches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { DashboardState } from '@cluesmith/codev-types';

const storageMap = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => storageMap.set(key, value),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    get length() { return storageMap.size; },
    key: (index: number) => [...storageMap.keys()][index] ?? null,
  },
  writable: true,
});

const mockUseBuilderStatus = vi.fn();
vi.mock('../src/hooks/useBuilderStatus.js', () => ({
  useBuilderStatus: () => mockUseBuilderStatus(),
}));

let isMobile = false;
vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => isMobile,
}));

vi.mock('../src/components/Terminal.js', () => ({
  Terminal: ({ wsPath }: { wsPath: string }) => <div data-testid={`terminal-${wsPath}`} />,
}));
vi.mock('../src/components/WorkView.js', () => ({
  WorkView: () => <div data-testid="work-view" />,
}));
vi.mock('../src/components/AnalyticsView.js', () => ({
  AnalyticsView: () => <div data-testid="analytics-view" />,
}));
vi.mock('../src/components/FileViewer.js', () => ({
  FileViewer: () => <div data-testid="file-viewer" />,
}));
vi.mock('../src/components/SplitPane.js', () => ({
  SplitPane: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div><div>{left}</div><div>{right}</div></div>
  ),
}));
vi.mock('../src/components/DecisionsView.js', () => ({
  DecisionsView: ({ isActive }: { isActive: boolean }) => (
    <div data-testid="decisions-view" data-active={String(isActive)} />
  ),
}));

import { App } from '../src/components/App.js';

function makeState(overrides: Partial<DashboardState>): DashboardState {
  return {
    architect: null,
    architects: [{ name: 'main', port: 0, pid: 1, terminalId: 'term-main', persistent: false }],
    builders: [],
    utils: [],
    annotations: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  storageMap.clear();
  mockUseBuilderStatus.mockReset();
  isMobile = false;
});

describe.each([
  { layout: 'desktop', mobile: false },
  { layout: 'mobile', mobile: true },
])('App Decisions tab — $layout', ({ mobile }) => {
  it('shows the tab and mounts the view hidden and inactive until selected', () => {
    isMobile = mobile;
    mockUseBuilderStatus.mockReturnValue({ state: makeState({ decisionsEnabled: true }), refresh: vi.fn() });
    render(<App />);

    const tab = screen.getByRole('tab', { name: /Decisions/ });
    const view = screen.getByTestId('decisions-view');
    expect(view.dataset.active).toBe('false');
    expect(view.parentElement).toHaveStyle({ display: 'none' });

    fireEvent.click(tab);
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(view.dataset.active).toBe('true');
    expect(view.parentElement).not.toHaveStyle({ display: 'none' });

    // Switching away hides the same mounted view rather than unmounting it.
    fireEvent.click(screen.getByRole('tab', { name: /Work/ }));
    expect(screen.getByTestId('decisions-view')).toBe(view);
    expect(view.dataset.active).toBe('false');
  });

  it('shows no tab and mounts no view without the decisions file', () => {
    isMobile = mobile;
    mockUseBuilderStatus.mockReturnValue({ state: makeState({}), refresh: vi.fn() });
    render(<App />);
    expect(screen.queryByRole('tab', { name: /Decisions/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('decisions-view')).not.toBeInTheDocument();
  });
});
