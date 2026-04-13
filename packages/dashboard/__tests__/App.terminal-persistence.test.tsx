/**
 * Regression test for Bugfix #205: Terminal renders garbled output when revisiting tabs.
 *
 * Root cause: App.tsx unmounted/remounted Terminal components on every tab switch,
 * triggering WebSocket reconnection and full ring-buffer replay on a fresh xterm.js
 * instance, producing garbled output.
 *
 * Fix: Keep Terminal components mounted (hidden via CSS display:none) when switching
 * to non-terminal tabs, so no reconnection or replay occurs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// --- Mocks (hoisted by vitest) ---

vi.mock('../src/hooks/useBuilderStatus.js', () => ({
  useBuilderStatus: () => ({
    state: {
      architect: { port: 4201, pid: 1234, terminalId: 'arch-1' },
      builders: [
        {
          id: 'B1', name: 'builder-spir-001', port: 4210, pid: 2345,
          status: 'running', phase: 'phase-1', worktree: '.builders/0001',
          branch: 'builder/0001', type: 'spec', terminalId: 'term-b1',
        },
      ],
      utils: [],
      annotations: [],
    },
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

describe('App - Terminal Tab Persistence (Bugfix #205)', () => {
  it('keeps builder terminal mounted when switching to dashboard tab', async () => {
    render(<App />);

    // Click builder tab to activate terminal
    fireEvent.click(screen.getByTestId('tab-B1'));

    // Wait for Terminal to appear after activatedTerminals state update
    await waitFor(() => {
      expect(screen.getByTestId('terminal-/ws/terminal/term-b1')).toBeTruthy();
    });

    // Switch to dashboard
    fireEvent.click(screen.getByTestId('tab-work'));

    // Terminal should STILL be in the DOM (not unmounted)
    expect(screen.queryByTestId('terminal-/ws/terminal/term-b1')).toBeTruthy();

    // The terminal's wrapper should be hidden via display:none
    const pane = screen.getByTestId('terminal-/ws/terminal/term-b1').closest('.terminal-tab-pane');
    expect(pane).toBeTruthy();
    expect((pane as HTMLElement).style.display).toBe('none');

    // Dashboard should be visible
    expect(screen.getByTestId('work-view')).toBeTruthy();
  });

  it('preserves the same terminal DOM element across tab switches', async () => {
    render(<App />);

    // Activate builder terminal
    fireEvent.click(screen.getByTestId('tab-B1'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-/ws/terminal/term-b1')).toBeTruthy();
    });

    // Capture reference to the terminal element
    const terminalBefore = screen.getByTestId('terminal-/ws/terminal/term-b1');

    // Switch away and back
    fireEvent.click(screen.getByTestId('tab-work'));
    fireEvent.click(screen.getByTestId('tab-B1'));

    // Should be the exact same DOM element (no unmount/remount)
    const terminalAfter = screen.getByTestId('terminal-/ws/terminal/term-b1');
    expect(terminalAfter).toBe(terminalBefore);
  });

  it('shows terminal wrapper when tab is active', async () => {
    render(<App />);

    // Activate builder terminal
    fireEvent.click(screen.getByTestId('tab-B1'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-/ws/terminal/term-b1')).toBeTruthy();
    });

    // Active terminal should NOT have display:none
    const pane = screen.getByTestId('terminal-/ws/terminal/term-b1').closest('.terminal-tab-pane');
    expect((pane as HTMLElement).style.display).toBe('');

    // Switch away → hidden
    fireEvent.click(screen.getByTestId('tab-work'));
    expect((pane as HTMLElement).style.display).toBe('none');

    // Switch back → visible again
    fireEvent.click(screen.getByTestId('tab-B1'));
    expect((pane as HTMLElement).style.display).toBe('');
  });
});
