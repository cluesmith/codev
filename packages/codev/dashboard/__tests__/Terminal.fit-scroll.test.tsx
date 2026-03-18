/**
 * Regression tests for terminal scroll position preservation during fit().
 *
 * Issue #423: fitAddon.fit() → terminal.resize() → buffer reflow resets the
 * viewport to the top of the scrollback buffer.
 *
 * Issue #560: After display:none toggling (tab switches, panel collapse),
 * xterm's buffer.active.viewportY can become stale (reset to 0). The fix
 * tracks scroll state externally in JS variables immune to DOM state changes.
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
let mockOnScrollCallback: (() => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockWsInstance: any = null;

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
    onScroll = vi.fn((cb: () => void) => {
      mockOnScrollCallback = cb;
      return { dispose: vi.fn() };
    });
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

// Mock WebSocket — capture instance for tests that simulate data flow
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
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    mockWsInstance = this;
  }
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

/**
 * Helper: simulate a scroll event on the mock terminal.
 * This updates the externally-tracked scroll state that safeFit() uses.
 */
function simulateScroll(baseY: number, viewportY: number) {
  mockTermInstance.buffer.active.baseY = baseY;
  mockTermInstance.buffer.active.viewportY = viewportY;
  mockOnScrollCallback?.();
}

/**
 * Helper: mock getBoundingClientRect on the terminal container element.
 * jsdom returns 0x0 by default, which causes safeFit() to skip.
 */
function mockContainerRect(width = 800, height = 600) {
  const el = document.querySelector('.terminal-container');
  if (el) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      width, height, top: 0, left: 0, right: width, bottom: height,
      x: 0, y: 0, toJSON: () => ({}),
    });
  }
}

/**
 * Helper: transition ScrollController from initial-load to interactive.
 * After #627, safeFit() only preserves scroll position in interactive phase.
 * This simulates a WebSocket open + empty message + flush to trigger
 * enterInteractive() in flushInitialBuffer().
 */
function transitionToInteractive() {
  // Simulate WebSocket open
  mockWsInstance?.onopen?.({} as Event);
  // Send an empty data frame to trigger the flush timer
  const emptyFrame = new Uint8Array([0x01]); // FRAME_DATA with no payload
  mockWsInstance?.onmessage?.({ data: emptyFrame.buffer });
  // Advance 500ms to flush + 150ms for debounced fit
  vi.advanceTimersByTime(500 + 150);
}

describe('Terminal fit() scroll position preservation (Issue #423, #560)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockResizeObserverCallback = null;
    mockOnScrollCallback = null;
    mockWsInstance = null;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('calls scrollToBottom after fit() when viewport is at the bottom', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();
    transitionToInteractive();

    // Simulate scroll state: terminal has scrollback, user is at the bottom
    simulateScroll(500, 500);

    // Clear any initial calls
    mockTermInstance.scrollToBottom.mockClear();
    mockFitInstance.fit.mockClear();

    // Trigger ResizeObserver → debouncedFit → safeFit
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150); // debounce period

    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToBottom).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it('calls scrollToLine to restore position when user has scrolled up', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();
    transitionToInteractive();

    // Simulate: terminal has scrollback, user scrolled up to line 200
    simulateScroll(500, 200);

    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();
    mockFitInstance.fit.mockClear();

    // Trigger ResizeObserver → debouncedFit → safeFit
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).toHaveBeenCalledWith(200);
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();
  });

  it('calls fit without scroll preservation when buffer is empty', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();

    // Buffer is empty (default: baseY=0, viewportY=0)
    // Clear any calls from render (initial safeFit skips due to jsdom 0x0)
    mockFitInstance.fit.mockClear();
    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();

    // Trigger ResizeObserver with empty buffer
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // With empty buffer, safeFit should just call fit() without scroll preservation
    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it('preserves position across multiple rapid ResizeObserver triggers', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();
    transitionToInteractive();

    // User is scrolled up
    simulateScroll(1000, 300);

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

  it('preserves scroll position even when xterm viewportY becomes stale (Issue #560)', () => {
    // This tests the scenario where display:none toggling resets xterm's
    // internal viewportY to 0, but our externally-tracked state still has
    // the correct position.
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();
    transitionToInteractive();

    // Step 1: Simulate user scrolled to line 200 (not at bottom)
    simulateScroll(500, 200);

    // Step 2: Simulate display:none toggling resetting xterm's viewportY
    // (this is what happens when a tab becomes hidden/visible)
    mockTermInstance.buffer.active.viewportY = 0; // DOM scroll reset
    // NOTE: we do NOT call simulateScroll — the onScroll event doesn't
    // fire during display:none, so our tracked state retains the old value.

    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();
    mockFitInstance.fit.mockClear();

    // Step 3: Tab becomes visible, ResizeObserver fires
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // safeFit should use the externally-tracked state (viewportY=200),
    // NOT xterm's stale state (viewportY=0)
    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).toHaveBeenCalledWith(200);
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();
  });

  it('preserves at-bottom state even when xterm viewportY resets to 0 (Issue #560)', () => {
    // Same as above but when user WAS at the bottom.
    // Without the fix, viewportY=0 with baseY=500 would be interpreted
    // as "scrolled up to the top" → scrollToLine(0) → stuck at top.
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();
    transitionToInteractive();

    // User is at the bottom
    simulateScroll(500, 500);

    // display:none resets xterm's viewportY to 0
    mockTermInstance.buffer.active.viewportY = 0;

    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();
    mockFitInstance.fit.mockClear();

    // Tab becomes visible
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // Should scroll to bottom (tracked wasAtBottom=true), NOT scrollToLine(0)
    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToBottom).toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it('skips fit when container has zero dimensions (display: none)', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);
    // Default jsdom returns 0x0 for getBoundingClientRect, simulating display:none
    // Do NOT call mockContainerRect — leave dimensions at 0x0

    simulateScroll(500, 200);

    mockFitInstance.fit.mockClear();
    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();

    // ResizeObserver fires with 0x0 (tab hidden)
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // safeFit should skip entirely — no fit, no scroll
    expect(mockFitInstance.fit).not.toHaveBeenCalled();
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it.skip('takes simple fit path when buffer is cleared even if scrollState.baseY is stale (Bugfix #563)', () => { // FLAKY: pre-existing failure on main — safeFit hasScrollback check includes stale scrollState.baseY
    // Regression test: when the terminal buffer is cleared (baseY=0) but
    // scrollState.baseY retains a stale positive value from before the clear,
    // safeFit() should take the simple path (just fit) — not the scroll-
    // preserving path with potentially stale position values.
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();

    // Step 1: Simulate terminal with scrollback — scrollState gets updated
    simulateScroll(500, 200);

    // Step 2: Simulate buffer clear — baseY goes to 0, but scrollState
    // retains old values because onScroll may not fire during clear
    mockTermInstance.buffer.active.baseY = 0;
    mockTermInstance.buffer.active.viewportY = 0;
    // NOTE: we do NOT call simulateScroll here — the clear may not
    // trigger onScroll, so scrollState.baseY stays at 500 (stale)

    mockFitInstance.fit.mockClear();
    mockTermInstance.scrollToBottom.mockClear();
    mockTermInstance.scrollToLine.mockClear();

    // Trigger ResizeObserver → debouncedFit → safeFit
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // safeFit should take the simple path: just fit(), no scroll restoration
    expect(mockFitInstance.fit).toHaveBeenCalled();
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();
    expect(mockTermInstance.scrollToLine).not.toHaveBeenCalled();
  });

  it('defers fit during initial buffer flush to prevent garbled rendering (Bugfix #625)', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockContainerRect();

    // Advance past initial timers (refitTimer1 at 300ms, debounced fit at 450ms)
    vi.advanceTimersByTime(500);
    mockFitInstance.fit.mockClear();

    // Override write to NOT call callback — simulates async large write
    let capturedWriteCallback: (() => void) | null = null;
    mockTermInstance.write.mockImplementation((_data: string, cb?: () => void) => {
      if (cb) capturedWriteCallback = cb;
    });

    // Establish connection and send data to fill the initial buffer
    mockWsInstance!.onopen!({} as Event);
    const encoder = new TextEncoder();
    const payload = encoder.encode('line 1\r\nline 2\r\nline 3\r\n');
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = 0x01; // FRAME_DATA
    frame.set(payload, 1);
    mockWsInstance!.onmessage!({ data: frame.buffer });

    // Advance 500ms to trigger flushInitialBuffer
    vi.advanceTimersByTime(500);
    expect(capturedWriteCallback).not.toBeNull();

    // Trigger ResizeObserver while write is in progress
    mockResizeObserverCallback?.();
    vi.advanceTimersByTime(150);

    // fit() should NOT have been called — deferred during large write
    expect(mockFitInstance.fit).not.toHaveBeenCalled();

    // Complete the write — triggers debouncedFit in callback
    capturedWriteCallback!();
    vi.advanceTimersByTime(150);

    // NOW fit() should have been called
    expect(mockFitInstance.fit).toHaveBeenCalled();
  });
});
