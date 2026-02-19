/**
 * Tests for WebSocket auto-reconnection with session resumption (Bugfix #442).
 *
 * Covers: exponential backoff, seq tracking, reconnecting overlay,
 * rapid failure detection (session gone), and max attempt limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

// Capture WebSocket instances for test control
const wsInstances: MockWs[] = [];

class MockWs {
  static OPEN = 1;
  readyState = 0; // CONNECTING
  binaryType = 'arraybuffer';
  url: string;
  send = vi.fn();
  close = vi.fn();
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }
  /** Simulate successful connection. */
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  /** Simulate connection close. */
  simulateClose() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 } as CloseEvent);
  }
  /** Send a seq control frame to the client. */
  sendSeqFrame(seq: number) {
    const msg = JSON.stringify({ type: 'seq', payload: { seq } });
    const encoded = new TextEncoder().encode(msg);
    const frame = new Uint8Array(1 + encoded.length);
    frame[0] = 0x00; // FRAME_CONTROL
    frame.set(encoded, 1);
    this.onmessage?.({ data: frame.buffer });
  }
}

vi.stubGlobal('WebSocket', MockWs);

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
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
    element = null;
  }
  return { Terminal: MockTerminal };
});

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
  WebLinksAddon: class { dispose = vi.fn(); constructor(_h?: unknown, _o?: unknown) {} },
}));
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
});
vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => false,
}));

// Import after mocks
import { Terminal } from '../src/components/Terminal.js';

// ============================================================================
// Tests
// ============================================================================

describe('Terminal WebSocket auto-reconnect (Bugfix #442)', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('creates initial WebSocket without ?resume param', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0].url).not.toContain('resume=');
  });

  it('attempts reconnection with backoff after connection loss', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    const ws1 = wsInstances[0];
    act(() => { ws1.simulateOpen(); });
    act(() => { ws1.simulateClose(); });

    // No immediate reconnect
    expect(wsInstances).toHaveLength(1);

    // After 1s (first backoff), a new WebSocket is created
    act(() => { vi.advanceTimersByTime(1000); });
    expect(wsInstances).toHaveLength(2);
  });

  it('uses exponential backoff: 1s, 2s, 4s', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });
    act(() => { wsInstances[0].simulateClose(); });

    // 1st attempt at 1s
    act(() => { vi.advanceTimersByTime(1000); });
    expect(wsInstances).toHaveLength(2);
    act(() => { wsInstances[1].simulateClose(); });

    // 2nd attempt at 2s
    act(() => { vi.advanceTimersByTime(1999); });
    expect(wsInstances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(wsInstances).toHaveLength(3);
    act(() => { wsInstances[2].simulateClose(); });

    // 3rd attempt at 4s
    act(() => { vi.advanceTimersByTime(3999); });
    expect(wsInstances).toHaveLength(3);
    act(() => { vi.advanceTimersByTime(1); });
    expect(wsInstances).toHaveLength(4);
  });

  it('passes ?resume=seq on reconnection when server sent seq', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    const ws1 = wsInstances[0];
    act(() => { ws1.simulateOpen(); });

    // Server sends seq update
    act(() => { ws1.sendSeqFrame(42); });

    // Disconnect and reconnect
    act(() => { ws1.simulateClose(); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(wsInstances).toHaveLength(2);
    expect(wsInstances[1].url).toContain('?resume=42');
  });

  it('shows reconnecting overlay during reconnection', () => {
    const { container } = render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });

    // No overlay while connected
    expect(container.querySelector('.terminal-reconnecting-overlay')).toBeNull();

    // Disconnect triggers overlay
    act(() => { wsInstances[0].simulateClose(); });
    expect(container.querySelector('.terminal-reconnecting-overlay')).not.toBeNull();
    expect(container.querySelector('.terminal-reconnecting-overlay')!.textContent).toContain('Reconnecting');
  });

  it('hides overlay on successful reconnection', () => {
    const { container } = render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });
    act(() => { wsInstances[0].simulateClose(); });

    // Overlay is shown
    expect(container.querySelector('.terminal-reconnecting-overlay')).not.toBeNull();

    // Reconnect
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { wsInstances[1].simulateOpen(); });

    // Overlay is hidden
    expect(container.querySelector('.terminal-reconnecting-overlay')).toBeNull();
  });

  it('gives up after max attempts and shows session ended', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });

    // Advance so the first close isn't a rapid failure
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { wsInstances[0].simulateClose(); });

    // Exhaust all 15 reconnection attempts — advance enough time for each timer
    // to fire, then wait for the close to not be a rapid failure
    for (let i = 0; i < 20; i++) {
      act(() => { vi.advanceTimersByTime(35_000); });
      const lastWs = wsInstances[wsInstances.length - 1];
      if (lastWs.readyState !== 3) {
        // Not yet closed — simulate close with enough elapsed time
        act(() => { lastWs.simulateClose(); });
      }
    }

    // After exhausting attempts, no more WebSocket instances should be created
    const countBefore = wsInstances.length;
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(wsInstances).toHaveLength(countBefore);

    // Should not exceed initial + MAX_ATTEMPTS reconnection attempts
    expect(wsInstances.length).toBeLessThanOrEqual(1 + 15);
  });

  it('detects rapid failures as session gone and stops reconnecting', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });

    // Advance some time so the first close isn't a rapid failure
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { wsInstances[0].simulateClose(); });

    // 5 rapid failures: advance exactly to the timer, then close immediately
    // (same tick = 0ms elapsed = rapid failure)
    for (let i = 0; i < 5; i++) {
      const delay = Math.min(1000 * Math.pow(2, i), 30_000);
      act(() => { vi.advanceTimersByTime(delay); });
      // Close immediately — same tick as creation means elapsed < 2000
      act(() => { wsInstances[wsInstances.length - 1].simulateClose(); });
    }

    const countBefore = wsInstances.length;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(wsInstances).toHaveLength(countBefore);
  });

  it('resets attempt counter on successful reconnect', () => {
    render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });

    // Advance time so close isn't rapid
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { wsInstances[0].simulateClose(); });

    // A few failed attempts
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { vi.advanceTimersByTime(5000); }); // advance past creation
    act(() => { wsInstances[1].simulateClose(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { wsInstances[2].simulateClose(); });

    // Successful reconnect
    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { wsInstances[3].simulateOpen(); });

    // Advance time and disconnect again — should start back at 1s delay
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { wsInstances[3].simulateClose(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(wsInstances.length).toBe(5); // New attempt at 1s, not 8s
  });

  it('does not reconnect after component unmounts', () => {
    const { unmount } = render(<Terminal wsPath="/ws/terminal/t1" />);
    act(() => { wsInstances[0].simulateOpen(); });
    act(() => { wsInstances[0].simulateClose(); });

    unmount();

    act(() => { vi.advanceTimersByTime(30_000); });
    // Only the initial connection, no reconnect attempts
    expect(wsInstances).toHaveLength(1);
  });
});
