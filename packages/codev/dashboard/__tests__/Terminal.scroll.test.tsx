/**
 * Regression test for GitHub Issue #220: Terminal scrolling
 *
 * Verifies that the Terminal component does NOT intercept wheel events with
 * custom key sequence translation. Scrolling is handled natively by xterm.js
 * scrollback buffer. Previous approaches of sending arrow keys or Page Up/Down
 * sequences caused command history navigation or unwanted side effects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Track the buffer type so tests can switch between normal and alternate
let mockBufferType = 'alternate';

// Capture WebSocket send calls to verify no key sequences are sent
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
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
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

describe('Terminal scroll handling (Issue #220)', () => {
  beforeEach(() => {
    mockBufferType = 'alternate';
  });

  afterEach(cleanup);

  function renderTerminal() {
    const { container } = render(<Terminal wsPath="/ws/terminal/test" />);
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

  describe('alternate screen buffer', () => {
    it('does NOT send any key sequences on wheel (handled natively)', () => {
      const el = renderTerminal();
      const sendCallsBefore = mockWsSend.mock.calls.length;
      dispatchWheel(el, -60); // scroll up

      // No data frames should be sent — xterm.js handles scroll natively
      const newDataFrames = mockWsSend.mock.calls.slice(sendCallsBefore).filter((call) => {
        const bytes = new Uint8Array(call[0]);
        return bytes[0] === 0x01; // FRAME_DATA
      });
      expect(newDataFrames).toHaveLength(0);
    });

    it('does NOT prevent default on wheel event', () => {
      const el = renderTerminal();
      const event = dispatchWheel(el, -60);
      // Let the event propagate to xterm.js for native mouse reporting
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('normal screen buffer', () => {
    beforeEach(() => {
      mockBufferType = 'normal';
    });

    it('does NOT send any key sequences (xterm.js handles scrollback)', () => {
      const el = renderTerminal();
      const sendCallsBefore = mockWsSend.mock.calls.length;
      dispatchWheel(el, -60);

      const newDataFrames = mockWsSend.mock.calls.slice(sendCallsBefore).filter((call) => {
        const bytes = new Uint8Array(call[0]);
        return bytes[0] === 0x01;
      });
      expect(newDataFrames).toHaveLength(0);
    });
  });
});
