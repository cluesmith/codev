/**
 * Regression test for GitHub Issue #220: Terminal scrolling broken after tmux mouse mode disabled
 *
 * Verifies that the Terminal component translates wheel events to arrow key
 * sequences when xterm.js is in the alternate screen buffer (e.g., tmux).
 * In normal screen buffer, wheel events should pass through to xterm.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Track the buffer type so tests can switch between normal and alternate
let mockBufferType = 'alternate';

// Capture WebSocket send calls to verify arrow key sequences
let mockWsSend: ReturnType<typeof vi.fn>;

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
    cols = 80;
    rows = 24;
    buffer = {
      active: {
        get type() { return mockBufferType; },
      },
    };
  }
  return { Terminal: MockTerminal };
});

// Mock addons
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit = vi.fn(); dispose = vi.fn(); },
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
  onmessage: ((ev: MessageEvent) => void) | null = null;
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

// Import after mocks
import { Terminal } from '../src/components/Terminal.js';

/** Decode a FRAME_DATA WebSocket message to a string. */
function decodeDataFrame(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // First byte is FRAME_DATA (0x01), rest is UTF-8 payload
  expect(bytes[0]).toBe(0x01);
  return new TextDecoder().decode(bytes.subarray(1));
}

describe('Terminal scroll handling (Issue #220)', () => {
  beforeEach(() => {
    mockBufferType = 'alternate';
  });

  afterEach(cleanup);

  function renderTerminal() {
    const { container } = render(<Terminal wsPath="/ws/terminal/test" />);
    // The Terminal component renders a div.terminal-container
    const terminalDiv = container.firstElementChild as HTMLElement;
    return terminalDiv;
  }

  function dispatchWheel(el: HTMLElement, deltaY: number, deltaMode = 0) {
    const event = new WheelEvent('wheel', {
      deltaY,
      deltaMode,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event;
  }

  describe('alternate screen buffer (tmux)', () => {
    it('sends up arrow keys on scroll up', () => {
      const el = renderTerminal();
      dispatchWheel(el, -90); // scroll up, ~3 lines

      expect(mockWsSend).toHaveBeenCalled();
      const lastCall = mockWsSend.mock.calls[mockWsSend.mock.calls.length - 1][0];
      const data = decodeDataFrame(lastCall);
      // Should contain up arrow sequences
      expect(data).toMatch(/^(\x1b\[A)+$/);
    });

    it('sends down arrow keys on scroll down', () => {
      const el = renderTerminal();
      dispatchWheel(el, 90); // scroll down, ~3 lines

      expect(mockWsSend).toHaveBeenCalled();
      const lastCall = mockWsSend.mock.calls[mockWsSend.mock.calls.length - 1][0];
      const data = decodeDataFrame(lastCall);
      // Should contain down arrow sequences
      expect(data).toMatch(/^(\x1b\[B)+$/);
    });

    it('caps lines at 15 per event', () => {
      const el = renderTerminal();
      dispatchWheel(el, 9000); // very large scroll

      expect(mockWsSend).toHaveBeenCalled();
      const lastCall = mockWsSend.mock.calls[mockWsSend.mock.calls.length - 1][0];
      const data = decodeDataFrame(lastCall);
      // Each arrow sequence is 3 bytes (\x1b[B), max 15 sequences
      const arrowCount = (data.match(/\x1b\[B/g) || []).length;
      expect(arrowCount).toBeLessThanOrEqual(15);
    });

    it('prevents default on wheel event', () => {
      const el = renderTerminal();
      const event = dispatchWheel(el, -90);
      expect(event.defaultPrevented).toBe(true);
    });

    it('accumulates sub-line deltas before sending', () => {
      const el = renderTerminal();

      // Send a very small scroll that shouldn't trigger a line
      dispatchWheel(el, 5); // ~0.17 lines, below threshold

      // Find any data frame sends (filter out the initial resize control frame)
      const dataFrameCalls = mockWsSend.mock.calls.filter((call) => {
        const bytes = new Uint8Array(call[0]);
        return bytes[0] === 0x01; // FRAME_DATA
      });
      expect(dataFrameCalls).toHaveLength(0);
    });
  });

  describe('normal screen buffer', () => {
    beforeEach(() => {
      mockBufferType = 'normal';
    });

    it('does NOT send arrow keys (lets xterm.js handle scrollback)', () => {
      const el = renderTerminal();
      const sendCallsBefore = mockWsSend.mock.calls.length;
      dispatchWheel(el, -90);

      // No new data frames should be sent
      const newDataFrames = mockWsSend.mock.calls.slice(sendCallsBefore).filter((call) => {
        const bytes = new Uint8Array(call[0]);
        return bytes[0] === 0x01;
      });
      expect(newDataFrames).toHaveLength(0);
    });

    it('does NOT prevent default on wheel event', () => {
      const el = renderTerminal();
      const event = dispatchWheel(el, -90);
      expect(event.defaultPrevented).toBe(false);
    });
  });
});
