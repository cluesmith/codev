/**
 * Regression test for Bugfix #477: WorkView wrapper needs height constraint for scrollbar.
 *
 * The wrapper <div> around <WorkView> in App must have `height: 100%` so
 * the CSS height chain is unbroken: .tab-content → wrapper → .work-view → .work-content.
 * Without it, .work-content's `overflow-y: auto` never activates because the
 * wrapper expands to content height instead of being constrained by the parent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

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
  TabBar: () => <div data-testid="tab-bar" />,
}));

import { App } from '../src/components/App.js';

afterEach(cleanup);

describe('Bugfix #477 - WorkView wrapper height constraint', () => {
  it('wrapper div around WorkView has height: 100% for scrollbar to work', () => {
    mockState = {
      architect: null,
      builders: [],
      utils: [],
      annotations: [],
      workspaceName: 'test',
    };
    const { getByTestId } = render(<App />);
    const workView = getByTestId('work-view');
    const wrapper = workView.parentElement!;
    expect(wrapper.style.height).toBe('100%');
  });
});
