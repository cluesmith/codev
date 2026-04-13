/**
 * Regression test for GitHub Issue #205 (reopened): Terminal viewport stuck at top after replay.
 *
 * After Tower restart, the shellper replay buffer is sent to the browser via WebSocket.
 * The Terminal component buffers the first 500ms of data (to filter DA sequences),
 * then flushes it to xterm.js.
 *
 * Fix (post-#627 consolidation): flushInitialBuffer() uses ScrollController:
 * - beginReplay() suppresses fit during replay write
 * - endReplay() in term.write() callback scrolls to bottom + triggers fit
 * - sendResize() sends SIGWINCH to PTY in the callback (no 350ms delay)
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

  it('calls scrollToBottom via endReplay callback (no 350ms timer)', () => {
    // After ScrollController consolidation (#627), scrollToBottom happens
    // in the term.write() completion callback via endReplay(), not via
    // a separate 350ms setTimeout.
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Simulate replay data
    mockWsInstance.onmessage?.({ data: buildDataFrame('replay data\r\n') });

    // Flush the initial buffer (500ms) — write callback fires synchronously in mock
    vi.advanceTimersByTime(500);

    // scrollToBottom should have been called at least once (via endReplay)
    expect(mockTermInstance.scrollToBottom).toHaveBeenCalled();

    // No additional scrollToBottom should fire after 350ms (timer removed)
    const countAfterFlush = mockTermInstance.scrollToBottom.mock.calls.length;
    vi.advanceTimersByTime(350);
    expect(mockTermInstance.scrollToBottom.mock.calls.length).toBe(countAfterFlush);
  });

  it('sends a forced resize to PTY after replay flush', () => {
    // After ScrollController consolidation (#627), the resize is sent
    // in the term.write() completion callback, not after a 350ms delay.
    render(<Terminal wsPath="/ws/terminal/test" />);

    mockWsInstance.onmessage?.({ data: buildDataFrame('replay data\r\n') });

    // Record send calls before the flush
    const sendCallsBefore = mockWsSend.mock.calls.length;

    // Flush buffer (500ms) — write callback fires synchronously in mock
    vi.advanceTimersByTime(500);

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

  it('transitions to interactive even when replay buffer is empty', () => {
    // With ScrollController (#627), empty buffer takes the enterInteractive()
    // path — no beginReplay/endReplay needed. The sendResize + debouncedFit
    // handle the transition. No explicit scrollToBottom is needed since there's
    // nothing to scroll to (buffer is empty).
    render(<Terminal wsPath="/ws/terminal/test" />);

    // Send an empty data frame to trigger the flush timer
    mockWsInstance.onmessage?.({ data: buildDataFrame('') });

    // Flush (500ms) + debounced fit (150ms)
    vi.advanceTimersByTime(500 + 150);

    // A resize control message should have been sent to PTY
    const controlFrames = mockWsSend.mock.calls
      .filter((call) => {
        const bytes = new Uint8Array(call[0]);
        return bytes[0] === FRAME_CONTROL;
      })
      .map((call) => decodeControlFrame(call[0]));
    const resizeFrame = controlFrames.find(f => f.type === 'resize');
    expect(resizeFrame).toBeDefined();
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
