/**
 * Regression test for GitHub Issue #228: Architect terminal has stale input characters on start
 *
 * When the terminal WebSocket connects and tmux attaches, tmux sends DA queries.
 * xterm.js auto-responds with DA responses (e.g., ESC[?62;22c), which flow back
 * through term.onData() → sendData() → WebSocket → pty → tmux → Claude Code stdin.
 *
 * The fix filters these auto-response patterns in the onData handler during the
 * initial phase (first ~500ms), preventing them from reaching the pty as keyboard input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Capture the onData callback so tests can invoke it directly
let capturedOnData: ((data: string) => void) | null = null;

// Capture WebSocket send calls and instance
let mockWsSend: ReturnType<typeof vi.fn>;
let mockWsInstance: {
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
  send: ReturnType<typeof vi.fn>;
};

// Mock @xterm/xterm
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    paste = vi.fn();
    getSelection = vi.fn().mockReturnValue('');
    dispose = vi.fn();
    onData = vi.fn((cb: (data: string) => void) => {
      capturedOnData = cb;
    });
    onResize = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
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

// Mock WebSocket — capture instance for simulating incoming messages
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    mockWsInstance = this as unknown as typeof mockWsInstance;
  }
});

// Mock ResizeObserver
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
});

// Import after mocks
import { Terminal } from '../src/components/Terminal.js';

const FRAME_DATA = 0x01;

/** Build a binary FRAME_DATA message from a string. */
function buildDataFrame(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_DATA;
  frame.set(encoded, 1);
  return frame.buffer;
}

/** Decode a FRAME_DATA WebSocket message to a string. */
function decodeDataFrame(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  expect(bytes[0]).toBe(FRAME_DATA);
  return new TextDecoder().decode(bytes.subarray(1));
}

/** Get all data frame payloads sent via WebSocket. */
function getDataFrames(): string[] {
  return mockWsSend.mock.calls
    .filter((call) => {
      const bytes = new Uint8Array(call[0]);
      return bytes[0] === FRAME_DATA;
    })
    .map((call) => decodeDataFrame(call[0]));
}

describe('Terminal input filtering (Issue #228)', () => {
  beforeEach(() => {
    capturedOnData = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderAndGetOnData() {
    render(<Terminal wsPath="/ws/terminal/test" />);
    expect(capturedOnData).not.toBeNull();
    return capturedOnData!;
  }

  /** Simulate a WS message and advance past the initial phase (500ms). */
  function exitInitialPhase() {
    // Send a trivial WS data message to trigger the flush timer
    mockWsInstance.onmessage?.({ data: buildDataFrame('') });
    // Advance past the 500ms flush deadline
    vi.advanceTimersByTime(600);
  }

  describe('during initial phase (first 500ms)', () => {
    it('filters DA1 response (ESC[?62;22c)', () => {
      const onData = renderAndGetOnData();
      onData('\x1b[?62;22c');
      expect(getDataFrames()).toHaveLength(0);
    });

    it('filters DA2 response (ESC[>1;4600;0c)', () => {
      const onData = renderAndGetOnData();
      onData('\x1b[>1;4600;0c');
      expect(getDataFrames()).toHaveLength(0);
    });

    it('filters DSR cursor position response (ESC[1;1R)', () => {
      const onData = renderAndGetOnData();
      onData('\x1b[1;1R');
      expect(getDataFrames()).toHaveLength(0);
    });

    it('filters DECRPM mode report (ESC[?1;2$y)', () => {
      const onData = renderAndGetOnData();
      onData('\x1b[?1;2$y');
      expect(getDataFrames()).toHaveLength(0);
    });

    it('filters multiple auto-responses in a single onData call', () => {
      const onData = renderAndGetOnData();
      onData('\x1b[?62;22c\x1b[1;1R\x1b[?1;2$y');
      expect(getDataFrames()).toHaveLength(0);
    });

    it('passes through real user input during initial phase', () => {
      const onData = renderAndGetOnData();
      onData('hello');

      const frames = getDataFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toBe('hello');
    });

    it('strips auto-responses but passes remaining user input', () => {
      const onData = renderAndGetOnData();
      onData('\x1b[?62;22chello');

      const frames = getDataFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toBe('hello');
    });
  });

  describe('after initial phase (500ms elapsed)', () => {
    it('passes all data through without filtering', () => {
      const onData = renderAndGetOnData();
      exitInitialPhase();

      const sendCallsBefore = mockWsSend.mock.calls.length;
      onData('\x1b[?62;22c');

      const newFrames = mockWsSend.mock.calls.slice(sendCallsBefore)
        .filter((call) => new Uint8Array(call[0])[0] === FRAME_DATA)
        .map((call) => decodeDataFrame(call[0]));
      expect(newFrames).toHaveLength(1);
      expect(newFrames[0]).toBe('\x1b[?62;22c');
    });
  });
});
