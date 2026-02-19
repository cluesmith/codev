/**
 * Tests for Spec 443: Show machine hostname in dashboard header and tab title.
 *
 * Tests both the pure helper function (buildDashboardTitle) and the
 * rendered App component to verify hostname appears in header and document.title.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { buildDashboardTitle } from '../src/components/App.js';

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

// --- Unit tests for buildDashboardTitle helper ---

describe('buildDashboardTitle', () => {
  it('returns hostname + workspaceName when both present and different', () => {
    expect(buildDashboardTitle('Mac-Pro', 'myproject')).toBe('Mac-Pro myproject dashboard');
  });

  it('deduplicates when hostname equals workspaceName', () => {
    expect(buildDashboardTitle('myproject', 'myproject')).toBe('myproject dashboard');
  });

  it('deduplicates case-insensitively', () => {
    expect(buildDashboardTitle('MyProject', 'myproject')).toBe('myproject dashboard');
  });

  it('falls back to workspaceName when hostname is undefined', () => {
    expect(buildDashboardTitle(undefined, 'myproject')).toBe('myproject dashboard');
  });

  it('falls back to workspaceName when hostname is empty', () => {
    expect(buildDashboardTitle('', 'myproject')).toBe('myproject dashboard');
  });

  it('falls back to workspaceName when hostname is whitespace', () => {
    expect(buildDashboardTitle('  ', 'myproject')).toBe('myproject dashboard');
  });

  it('returns "dashboard" when both are undefined', () => {
    expect(buildDashboardTitle(undefined, undefined)).toBe('dashboard');
  });

  it('trims whitespace from hostname and workspaceName', () => {
    expect(buildDashboardTitle(' Mac-Pro ', ' myproject ')).toBe('Mac-Pro myproject dashboard');
  });
});

// --- Integration tests for App component rendering ---

describe('App - Hostname Display (Spec 443)', () => {
  beforeEach(() => {
    document.title = '';
  });

  it('displays hostname in header when hostname differs from workspaceName', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
      workspaceName: 'myproject',
      hostname: 'Mac-Pro',
    };
    render(<App />);
    expect(screen.getByText('Mac-Pro myproject dashboard')).toBeTruthy();
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
    expect(document.title).toBe('Mac-Pro myproject dashboard');
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
    expect(screen.getByText('myproject dashboard')).toBeTruthy();
    expect(document.title).toBe('myproject dashboard');
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
    expect(screen.getByText('myproject dashboard')).toBeTruthy();
    expect(document.title).toBe('myproject dashboard');
  });

  it('shows just "dashboard" when state has no workspaceName or hostname', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
    };
    render(<App />);
    expect(screen.getByText('dashboard')).toBeTruthy();
    expect(document.title).toBe('dashboard');
  });
});
