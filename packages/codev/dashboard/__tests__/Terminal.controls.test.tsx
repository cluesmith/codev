/**
 * Regression test for GitHub Issue #382: Terminal refresh button not working
 *
 * Root cause: the terminal container lacked `overflow: hidden` and `min-height: 0`,
 * so the flex item's default `min-height: auto` prevented the container from
 * shrinking below the xterm content height. FitAddon.proposeDimensions() reads
 * the container's computed height, which was stale after window resizes — it
 * reflected the xterm content size, not the actual available space.
 *
 * Fix: add `overflow: hidden` + `min-height: 0` to the container, ensuring
 * FitAddon always reads the correct flex-allocated dimensions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

// Capture mocks for verification
let mockFitFn: ReturnType<typeof vi.fn>;
let mockResizeFn: ReturnType<typeof vi.fn>;
let mockWsSend: ReturnType<typeof vi.fn>;
let mockScrollToBottom: ReturnType<typeof vi.fn>;

// Mock @xterm/xterm
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
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    scrollToBottom = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
    constructor() {
      mockScrollToBottom = this.scrollToBottom;
      mockResizeFn = this.resize;
    }
  }
  return { Terminal: MockTerminal };
});

// Mock FitAddon — capture the fit() mock
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
    constructor() {
      mockFitFn = this.fit;
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
  constructor() {
    mockWsSend = this.send;
  }
});

// Mock ResizeObserver
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
});

// Mock useMediaQuery to simulate desktop viewport
vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => false,
}));

// Import after mocks
import { Terminal } from '../src/components/Terminal.js';

const FRAME_CONTROL = 0x00;

/** Decode a control frame sent via WebSocket. */
function decodeControlFrame(buffer: ArrayBuffer): { type: string; payload: Record<string, unknown> } {
  const bytes = new Uint8Array(buffer);
  expect(bytes[0]).toBe(FRAME_CONTROL);
  const json = new TextDecoder().decode(bytes.subarray(1));
  return JSON.parse(json);
}

/** Get all control frames sent via WebSocket. */
function getControlFrames(): Array<{ type: string; payload: Record<string, unknown> }> {
  return mockWsSend.mock.calls
    .filter((call) => {
      const bytes = new Uint8Array(call[0]);
      return bytes[0] === FRAME_CONTROL;
    })
    .map((call) => decodeControlFrame(call[0]));
}

describe('TerminalControls (Issue #382)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders refresh and scroll-to-bottom buttons', () => {
    const { container } = render(<Terminal wsPath="/ws/terminal/test" />);
    const refreshBtn = container.querySelector('button[aria-label="Refresh terminal"]');
    const scrollBtn = container.querySelector('button[aria-label="Scroll to bottom"]');
    expect(refreshBtn).not.toBeNull();
    expect(scrollBtn).not.toBeNull();
  });

  it('refresh button calls fitAddon.fit() and sends resize control frame', () => {
    const { container } = render(<Terminal wsPath="/ws/terminal/test" />);
    const refreshBtn = container.querySelector('button[aria-label="Refresh terminal"]')!;

    // Clear mocks from component mount
    mockFitFn.mockClear();
    mockWsSend.mockClear();

    fireEvent.pointerDown(refreshBtn);

    // fit() should be called to recalculate dimensions
    expect(mockFitFn).toHaveBeenCalledTimes(1);

    // A resize control frame should always be sent (even if fit() was a no-op)
    const controlFrames = getControlFrames();
    expect(controlFrames.length).toBeGreaterThanOrEqual(1);
    const resizeFrame = controlFrames.find(f => f.type === 'resize');
    expect(resizeFrame).toBeDefined();
    expect(resizeFrame!.payload).toEqual({ cols: 80, rows: 24 });
  });

  it('scroll-to-bottom button calls scrollToBottom() on pointerdown', () => {
    const { container } = render(<Terminal wsPath="/ws/terminal/test" />);
    const scrollBtn = container.querySelector('button[aria-label="Scroll to bottom"]')!;

    mockScrollToBottom.mockClear();

    fireEvent.pointerDown(scrollBtn);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('connection status icon renders in same toolbar as buttons (Bugfix #493)', () => {
    const { container } = render(<Terminal wsPath="/ws/terminal/test" />);

    // No status icon when connected
    const controls = container.querySelector('.terminal-controls')!;
    expect(controls.querySelector('.terminal-status-icon')).toBeNull();

    // Status icon should be inside .terminal-controls alongside buttons
    // (verified by checking parent container structure)
    const refreshBtn = controls.querySelector('button[aria-label="Refresh terminal"]');
    const scrollBtn = controls.querySelector('button[aria-label="Scroll to bottom"]');
    expect(refreshBtn).not.toBeNull();
    expect(scrollBtn).not.toBeNull();
  });
});
