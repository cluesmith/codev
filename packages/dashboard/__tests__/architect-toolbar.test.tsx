/**
 * Regression test for GitHub Issue #522: Dashboard controls consolidated into
 * a single architect toolbar.
 *
 * Before: Collapse buttons were in the app header, terminal controls (refresh,
 * scroll-to-bottom, connection status) were in a separate floating overlay.
 * After: All controls live in one unified toolbar at the top-right of the
 * architect terminal window, with a visual divider separating control groups.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Mock xterm and addons
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    paste = vi.fn();
    getSelection = vi.fn().mockReturnValue('');
    dispose = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    scrollToBottom = vi.fn();
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no webgl'); } },
}));
vi.mock('@xterm/addon-canvas', () => ({
  CanvasAddon: class { dispose = vi.fn(); },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class { dispose = vi.fn(); constructor(_handler?: unknown, _opts?: unknown) {} },
}));

vi.stubGlobal('WebSocket', class {
  static OPEN = 1;
  readyState = 1;
  binaryType = 'arraybuffer';
  send = vi.fn();
  close = vi.fn();
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
});

vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
});

vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => false,
}));

import { Terminal } from '../src/components/Terminal.js';

afterEach(cleanup);

describe('Architect toolbar consolidation (Bugfix #522)', () => {
  it('renders toolbarExtra content inside the terminal controls toolbar', () => {
    const { container } = render(
      <Terminal
        wsPath="/ws/terminal/arch"
        toolbarExtra={
          <>
            <button aria-label="Collapse architect panel">Collapse</button>
            <button aria-label="Collapse work panel">Collapse work</button>
          </>
        }
      />,
    );

    const toolbar = container.querySelector('.terminal-controls')!;
    expect(toolbar).not.toBeNull();

    // Collapse buttons should be INSIDE the terminal controls toolbar
    const collapseArchBtn = toolbar.querySelector('[aria-label="Collapse architect panel"]');
    const collapseWorkBtn = toolbar.querySelector('[aria-label="Collapse work panel"]');
    expect(collapseArchBtn).not.toBeNull();
    expect(collapseWorkBtn).not.toBeNull();

    // Terminal controls (refresh, scroll-to-bottom) should also be in the same toolbar
    const refreshBtn = toolbar.querySelector('[aria-label="Refresh terminal"]');
    const scrollBtn = toolbar.querySelector('[aria-label="Scroll to bottom"]');
    expect(refreshBtn).not.toBeNull();
    expect(scrollBtn).not.toBeNull();
  });

  it('renders a visual divider between terminal controls and extra controls', () => {
    const { container } = render(
      <Terminal
        wsPath="/ws/terminal/arch"
        toolbarExtra={<button>Extra</button>}
      />,
    );

    const toolbar = container.querySelector('.terminal-controls')!;
    const divider = toolbar.querySelector('.toolbar-divider');
    expect(divider).not.toBeNull();
  });

  it('does not render divider when no toolbarExtra is provided', () => {
    const { container } = render(
      <Terminal wsPath="/ws/terminal/builder" />,
    );

    const toolbar = container.querySelector('.terminal-controls')!;
    const divider = toolbar.querySelector('.toolbar-divider');
    expect(divider).toBeNull();
  });

  it('keeps terminal controls and extra controls in a single .terminal-controls container', () => {
    const { container } = render(
      <Terminal
        wsPath="/ws/terminal/arch"
        toolbarExtra={<button aria-label="Test extra">X</button>}
      />,
    );

    // There should be exactly ONE .terminal-controls container
    const toolbars = container.querySelectorAll('.terminal-controls');
    expect(toolbars.length).toBe(1);

    // It should contain both terminal controls and the extra button
    const toolbar = toolbars[0];
    expect(toolbar.querySelector('[aria-label="Refresh terminal"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Test extra"]')).not.toBeNull();
  });
});
