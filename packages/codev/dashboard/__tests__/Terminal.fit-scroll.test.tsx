/**
 * Regression test for GitHub Issue #423: Terminal scroll position lost during fit().
 *
 * When fitAddon.fit() is called (via ResizeObserver, visibility change, or manual
 * refresh), the terminal viewport could jump to the top of the scrollback buffer.
 * The fix wraps fit() with scroll position preservation: save viewportY before,
 * restore after (scrollToBottom if was at bottom, scrollToLine if scrolled up).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Capture mock instances
let mockTermInstance: {
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
  buffer: {
    active: {
      type: string;
      viewportY: number;
      baseY: number;
    };
  };
};
let mockFitInstance: { fit: ReturnType<typeof vi.fn> };
let mockResizeObserverCallback: (() => void) | null = null;

// Mock @xterm/xterm
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn((data: string, cb?: () => void) => { if (cb) cb(); });
    paste = vi.fn();
    scrollToBottom = vi.fn();
    scrollToTop = vi.fn();
    scrollToLine = vi.fn();
    getSelection = vi.fn().mockReturnValue('');
    dispose = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    cols = 80;
    rows = 24;
    buffer = {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 0,
      },
    };
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      mockTermInstance = this as unknown as typeof mockTermInstance;
    }
  }
  return { Terminal: MockTerminal };
});

// Mock FitAddon — capture instance
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      mockFitInstance = this as unknown as typeof mockFitInstance;
    }
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

// Mock WebSocket
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

// Mock ResizeObserver — capture callback for manual triggering
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(cb: () => void) {
    mockResizeObserverCallback = cb;
  }
});

// Import after mocks
import { Terminal } from '../src/components/Terminal.js';

describe('Terminal fit() scroll position preservation (Issue #423)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockResizeObserverCallback = null;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('calls scrollToBottom after fit() when viewport is at the bottom', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Simulate: terminal has scrollback, user is at the bottom
    mockTermInstance.buffer.active.baseY = 500;
    mockTermInstance.buffer.active.viewportY = 500; // at bottom: viewportY >= baseY

    // Clear any initial scrollToBottom calls
    mockTermInstance.scrollToBottom.mockClear();

    // Trigger ResizeObserver → debouncedFit → safeFit
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150); // debounce period

    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToBottom).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it('calls scrollToLine to restore position when user has scrolled up', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Simulate: terminal has scrollback, user scrolled up to line 200
    mockTermInstance.buffer.active.baseY = 500;
    mockTermInstance.buffer.active.viewportY = 200; // scrolled up: viewportY < baseY

    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();

    // Trigger ResizeObserver → debouncedFit → safeFit
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).toHaveBeenCalledWith(200);
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();
  });

  it('skips scroll preservation on initial safeFit when buffer is empty', () => {
    // The initial safeFit() runs synchronously during render.
    // With an empty buffer (baseY=0), scroll preservation is skipped —
    // there's no scrollback content to lose.
    render(<Terminal wsPath="/ws/terminal/test" />);

    expect(mockFitInstance.fit).toHaveBeenCalled();
    // No scrollToBottom or scrollToLine calls (no scrollback to preserve)
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it('preserves position across multiple rapid ResizeObserver triggers', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // User is scrolled up
    mockTermInstance.buffer.active.baseY = 1000;
    mockTermInstance.buffer.active.viewportY = 300;

    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();
    mockFitInstance.fit.mockClear();

    // Rapid-fire ResizeObserver events (debounce should coalesce)
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(50);
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(50);
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // fit() should only be called once (debounced)
    expect(mockFitInstance.fit).toHaveBeenCalledTimes(1);
    // Scroll position should be restored
    expect(mockTermInstance.scrollToLine).toHaveBeenCalledWith(300);
  });
});
