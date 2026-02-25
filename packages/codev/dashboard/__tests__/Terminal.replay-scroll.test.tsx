/**
 * Regression test for GitHub Issue #205 (reopened): Terminal viewport stuck at top after replay.
 *
 * After Tower restart, the shellper replay buffer is sent to the browser via WebSocket.
 * The Terminal component buffers the first 500ms of data (to filter DA sequences),
 * then flushes it to xterm.js. Without scrollToBottom(), the viewport stays at line 0
 * (the top of the scrollback buffer) instead of showing the current terminal state.
 *
 * Fix: flushInitialBuffer() calls scrollToBottom() both in the term.write() callback
 * and again after a 350ms delay (to account for fitAddon.fit() resetting viewport).
 * A forced resize is also sent to the PTY so the shell redraws at the correct size.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Capture mock instances for assertions
let mockTermInstance: {
  write: ReturnType<typeof vi.fn>;
  scrollToBottom: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
};
let mockWsSend: ReturnType<typeof vi.fn>;
let mockWsInstance: {
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
  readyState: number;
};
// Mock @xterm/xterm — capture scrollToBottom calls
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    // write: invoke callback synchronously to simulate xterm behavior
    write = vi.fn((data: string, cb?: () => void) => { if (cb) cb(); });
    paste = vi.fn();
    scrollToBottom = vi.fn();
    getSelection = vi.fn().mockReturnValue('');
    dispose = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      mockTermInstance = this as unknown as typeof mockTermInstance;
    }
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
const FRAME_CONTROL = 0x00;

/** Build a binary FRAME_DATA message from a string. */
function buildDataFrame(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_DATA;
  frame.set(encoded, 1);
  return frame.buffer;
}

/** Decode a control frame payload from a WebSocket send call. */
function decodeControlFrame(buffer: ArrayBuffer): { type: string; payload: Record<string, unknown> } {
  const bytes = new Uint8Array(buffer);
  expect(bytes[0]).toBe(FRAME_CONTROL);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
}

describe('Terminal replay scroll-to-bottom (Issue #205 reopened)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('calls scrollToBottom after replay buffer flush', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Simulate replay data arriving during initial buffering phase
    const replayData = 'line 1\r\nline 2\r\nline 3\r\n$ ';
    mockWsInstance.onmessage?.({ data: buildDataFrame(replayData) });

    // scrollToBottom should NOT have been called yet (data is buffered)
    expect(mockTermInstance.scrollToBottom).not.toHaveBeenCalled();

    // Advance past the 500ms buffer deadline
    vi.advanceTimersByTime(500);

    // The write callback invokes scrollToBottom synchronously (see mock)
    expect(mockTermInstance.scrollToBottom).toHaveBeenCalled();
  });

  it('calls scrollToBottom again after deferred fit + resize (350ms)', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Simulate replay data
    mockWsInstance.onmessage?.({ data: buildDataFrame('replay data\r\n') });

    // Flush the initial buffer (500ms)
    vi.advanceTimersByTime(500);
    const scrollCountAfterFlush = mockTermInstance.scrollToBottom.mock.calls.length;
    expect(scrollCountAfterFlush).toBeGreaterThanOrEqual(1);

    // Advance another 350ms for the deferred scroll + resize
    vi.advanceTimersByTime(350);
    expect(mockTermInstance.scrollToBottom.mock.calls.length).toBeGreaterThan(scrollCountAfterFlush);
  });

  it('sends a forced resize to PTY after replay flush', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    mockWsInstance.onmessage?.({ data: buildDataFrame('replay data\r\n') });

    // Record send calls before the deferred resize
    const sendCallsBefore = mockWsSend.mock.calls.length;

    // Flush buffer (500ms) + deferred resize (350ms)
    vi.advanceTimersByTime(500 + 350);

    // Find control frames sent after the flush
    const controlFrames = mockWsSend.mock.calls.slice(sendCallsBefore)
      .filter((call) => {
        const bytes = new Uint8Array(call[0]);
        return bytes[0] === FRAME_CONTROL;
      })
      .map((call) => decodeControlFrame(call[0]));

    const resizeFrame = controlFrames.find(f => f.type === 'resize');
    expect(resizeFrame).toBeDefined();
    expect(resizeFrame!.payload).toEqual({
      cols: mockTermInstance.cols,
      rows: mockTermInstance.rows,
    });
  });

  it('calls scrollToBottom even when replay buffer is empty', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Send an empty data frame to trigger the flush timer
    mockWsInstance.onmessage?.({ data: buildDataFrame('') });

    // Flush (500ms) + deferred (350ms)
    vi.advanceTimersByTime(500 + 350);

    // The deferred scrollToBottom should still fire
    expect(mockTermInstance.scrollToBottom).toHaveBeenCalled();
  });

  it('filters DA sequences from replay buffer before writing', () => {
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Replay data containing a DA1 response embedded in terminal output
    const replayWithDA = 'hello\x1b[?62;22cworld';
    mockWsInstance.onmessage?.({ data: buildDataFrame(replayWithDA) });

    // Flush the buffer
    vi.advanceTimersByTime(500);

    // term.write should have been called with the DA sequence stripped
    const writeCall = mockTermInstance.write.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('hello')
    );
    expect(writeCall).toBeDefined();
    expect(writeCall![0]).toBe('helloworld');
    expect(writeCall![0]).not.toContain('\x1b[?62;22c');
  });
});
