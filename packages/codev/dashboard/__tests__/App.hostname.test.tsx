/**
 * Tests for Spec 443: Show machine hostname in dashboard header and tab title.
 *
 * Tests both the pure helper function (buildOverviewTitle) and the
 * rendered App component to verify hostname appears in header and document.title.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { buildOverviewTitle } from '../src/components/App.js';

// --- Mocks (hoisted by vitest) ---

let mockState: Record<string, unknown> | null = null;

vi.mock('../src/hooks/useBuilderStatus.js', () => ({
  useBuilderStatus: () => ({
    state: mockState,
    refresh: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => false,
}));

vi.mock('../src/components/Terminal.js', () => ({
  Terminal: ({ wsPath }: { wsPath: string }) => (
    <div data-testid={`terminal-${wsPath}`}>Terminal: {wsPath}</div>
  ),
}));

vi.mock('../src/components/WorkView.js', () => ({
  WorkView: () => <div data-testid="work-view">Work</div>,
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
  TabBar: ({ tabs, activeTabId, onSelectTab }: {
    tabs: Array<{ id: string; label: string }>;
    activeTabId: string;
    onSelectTab: (id: string) => void;
    onRefresh: () => void;
  }) => (
    <div data-testid="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          data-testid={`tab-${tab.id}`}
          aria-selected={tab.id === activeTabId}
          onClick={() => onSelectTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));

import { App } from '../src/components/App.js';

afterEach(cleanup);

// --- Unit tests for buildOverviewTitle helper ---

describe('buildOverviewTitle', () => {
  it('returns "workspace on hostname overview" when both present and different', () => {
    expect(buildOverviewTitle('Mac-Pro', 'myproject')).toBe('myproject on Mac-Pro overview');
  });

  it('deduplicates when hostname equals workspaceName', () => {
    expect(buildOverviewTitle('myproject', 'myproject')).toBe('myproject overview');
  });

  it('deduplicates case-insensitively', () => {
    expect(buildOverviewTitle('MyProject', 'myproject')).toBe('myproject overview');
  });

  it('falls back to workspaceName when hostname is undefined', () => {
    expect(buildOverviewTitle(undefined, 'myproject')).toBe('myproject overview');
  });

  it('falls back to workspaceName when hostname is empty', () => {
    expect(buildOverviewTitle('', 'myproject')).toBe('myproject overview');
  });

  it('falls back to workspaceName when hostname is whitespace', () => {
    expect(buildOverviewTitle('  ', 'myproject')).toBe('myproject overview');
  });

  it('returns "overview" when both are undefined', () => {
    expect(buildOverviewTitle(undefined, undefined)).toBe('overview');
  });

  it('trims whitespace from hostname and workspaceName', () => {
    expect(buildOverviewTitle(' Mac-Pro ', ' myproject ')).toBe('myproject on Mac-Pro overview');
  });
});

// --- Integration tests for App component rendering ---

describe('App - Hostname Display (Spec 443)', () => {
  beforeEach(() => {
    document.title = '';
  });

  it('displays "workspace on hostname overview" when hostname differs from workspaceName', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
      workspaceName: 'myproject',
      hostname: 'Mac-Pro',
    };
    render(<App />);
    expect(screen.getByText('myproject on Mac-Pro overview')).toBeTruthy();
  });

  it('sets document.title with hostname', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
      workspaceName: 'myproject',
      hostname: 'Mac-Pro',
    };
    render(<App />);
    expect(document.title).toBe('myproject on Mac-Pro overview');
  });

  it('deduplicates hostname when it matches workspaceName', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
      workspaceName: 'myproject',
      hostname: 'myproject',
    };
    render(<App />);
    expect(screen.getByText('myproject overview')).toBeTruthy();
    expect(document.title).toBe('myproject overview');
  });

  it('falls back gracefully when hostname is absent', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
      workspaceName: 'myproject',
    };
    render(<App />);
    expect(screen.getByText('myproject overview')).toBeTruthy();
    expect(document.title).toBe('myproject overview');
  });

  it('shows just "overview" when state has no workspaceName or hostname', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
    };
    render(<App />);
    expect(screen.getByText('overview')).toBeTruthy();
    expect(document.title).toBe('overview');
  });
});
