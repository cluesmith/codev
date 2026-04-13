/**
 * Regression test for GitHub Issue #254: Mobile virtual modifier key buttons
 *
 * Tests the VirtualKeyboard component (Esc, Tab, Ctrl, Cmd buttons) and
 * the sticky modifier integration in Terminal's onData handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

// Capture onData callback for testing sticky modifier integration
let capturedOnData: ((data: string) => void) | null = null;
let mockWsSend: ReturnType<typeof vi.fn>;
let mockPaste: ReturnType<typeof vi.fn>;
let mockGetSelection: ReturnType<typeof vi.fn>;
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
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
    constructor() {
      mockPaste = this.paste;
      mockGetSelection = this.getSelection;
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

// Mock useMediaQuery to simulate mobile viewport
let mockIsMobile = true;
vi.mock('../src/hooks/useMediaQuery.js', () => ({
  useMediaQuery: () => mockIsMobile,
}));

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

/** Exit initial phase by sending a WS message and advancing time. */
function exitInitialPhase() {
  mockWsInstance.onmessage?.({ data: buildDataFrame('') });
  vi.advanceTimersByTime(600);
}

describe('VirtualKeyboard (Issue #254)', () => {
  beforeEach(() => {
    capturedOnData = null;
    mockIsMobile = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderTerminal() {
    const result = render(<Terminal wsPath="/ws/terminal/test" />);
    expect(capturedOnData).not.toBeNull();
    return result;
  }

  describe('rendering', () => {
    it('shows virtual keyboard on mobile', () => {
      mockIsMobile = true;
      const { container } = renderTerminal();
      const keyboard = container.querySelector('.virtual-keyboard');
      expect(keyboard).not.toBeNull();
    });

    it('hides virtual keyboard on desktop', () => {
      mockIsMobile = false;
      const { container } = renderTerminal();
      const keyboard = container.querySelector('.virtual-keyboard');
      expect(keyboard).toBeNull();
    });

    it('renders Esc, Tab, Ctrl, Cmd buttons', () => {
      const { container } = renderTerminal();
      const buttons = container.querySelectorAll('.virtual-key');
      const labels = Array.from(buttons).map(b => b.textContent);
      expect(labels).toEqual(['Esc', 'Tab', 'Ctrl', 'Cmd']);
    });
  });

  describe('Esc key', () => {
    it('sends escape via WebSocket data frame (not paste) when tapped', () => {
      const { container } = renderTerminal();
      const sendsBefore = mockWsSend.mock.calls.length;
      const escBtn = container.querySelector('.virtual-key')!;
      fireEvent.pointerDown(escBtn);

      // Should NOT use paste (which wraps in bracketed paste sequences)
      expect(mockPaste).not.toHaveBeenCalled();

      // Should send raw \x1b via WebSocket data frame
      const newFrames = mockWsSend.mock.calls.slice(sendsBefore)
        .filter(call => new Uint8Array(call[0])[0] === FRAME_DATA)
        .map(call => decodeDataFrame(call[0]));
      expect(newFrames).toHaveLength(1);
      expect(newFrames[0]).toBe('\x1b');
    });
  });

  describe('Tab key', () => {
    it('sends tab via WebSocket data frame (not paste) when tapped', () => {
      const { container } = renderTerminal();
      const sendsBefore = mockWsSend.mock.calls.length;
      const buttons = container.querySelectorAll('.virtual-key');
      const tabBtn = buttons[1]; // Tab is second button
      fireEvent.pointerDown(tabBtn);

      // Should NOT use paste (which wraps in bracketed paste sequences)
      expect(mockPaste).not.toHaveBeenCalled();

      // Should send raw \t via WebSocket data frame
      const newFrames = mockWsSend.mock.calls.slice(sendsBefore)
        .filter(call => new Uint8Array(call[0])[0] === FRAME_DATA)
        .map(call => decodeDataFrame(call[0]));
      expect(newFrames).toHaveLength(1);
      expect(newFrames[0]).toBe('\t');
    });
  });

  describe('Ctrl sticky modifier', () => {
    it('highlights Ctrl button when tapped', () => {
      const { container } = renderTerminal();
      const ctrlBtn = container.querySelectorAll('.virtual-key')[2];
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(false);
      fireEvent.pointerDown(ctrlBtn);
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(true);
    });

    it('deactivates on second tap (toggle off)', () => {
      const { container } = renderTerminal();
      const ctrlBtn = container.querySelectorAll('.virtual-key')[2];
      fireEvent.pointerDown(ctrlBtn);
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(true);
      fireEvent.pointerDown(ctrlBtn);
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(false);
    });

    it('transforms next lowercase letter to control character (Ctrl+C)', () => {
      const { container } = renderTerminal();
      exitInitialPhase();
      const sendsBefore = mockWsSend.mock.calls.length;

      // Tap Ctrl
      const ctrlBtn = container.querySelectorAll('.virtual-key')[2];
      fireEvent.pointerDown(ctrlBtn);

      // Simulate typing 'c' via onData
      capturedOnData!('c');

      const newFrames = mockWsSend.mock.calls.slice(sendsBefore)
        .filter(call => new Uint8Array(call[0])[0] === FRAME_DATA)
        .map(call => decodeDataFrame(call[0]));
      expect(newFrames).toHaveLength(1);
      expect(newFrames[0]).toBe('\x03'); // Ctrl+C = 0x03
    });

    it('transforms uppercase letter to control character (Ctrl+Z)', () => {
      const { container } = renderTerminal();
      exitInitialPhase();
      const sendsBefore = mockWsSend.mock.calls.length;

      const ctrlBtn = container.querySelectorAll('.virtual-key')[2];
      fireEvent.pointerDown(ctrlBtn);
      capturedOnData!('Z');

      const newFrames = mockWsSend.mock.calls.slice(sendsBefore)
        .filter(call => new Uint8Array(call[0])[0] === FRAME_DATA)
        .map(call => decodeDataFrame(call[0]));
      expect(newFrames).toHaveLength(1);
      expect(newFrames[0]).toBe('\x1a'); // Ctrl+Z = 0x1a
    });

    it('auto-clears after consuming one key', () => {
      const { container } = renderTerminal();
      exitInitialPhase();

      const ctrlBtn = container.querySelectorAll('.virtual-key')[2];
      fireEvent.pointerDown(ctrlBtn);
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(true);

      // Type a letter - should consume modifier (clearCallback triggers React state update)
      act(() => { capturedOnData!('c'); });
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(false);
    });
  });

  describe('Cmd sticky modifier', () => {
    it('highlights Cmd button when tapped', () => {
      const { container } = renderTerminal();
      const cmdBtn = container.querySelectorAll('.virtual-key')[3];
      expect(cmdBtn.classList.contains('virtual-key-active')).toBe(false);
      fireEvent.pointerDown(cmdBtn);
      expect(cmdBtn.classList.contains('virtual-key-active')).toBe(true);
    });

    it('Cmd+V triggers clipboard paste', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: vi.fn().mockResolvedValue('clipboard content'), writeText: vi.fn() },
        writable: true,
        configurable: true,
      });

      const { container } = renderTerminal();
      exitInitialPhase();
      const sendsBefore = mockWsSend.mock.calls.length;

      const cmdBtn = container.querySelectorAll('.virtual-key')[3];
      fireEvent.pointerDown(cmdBtn);
      capturedOnData!('v');

      // 'v' should NOT be sent to terminal (paste handles it)
      const newFrames = mockWsSend.mock.calls.slice(sendsBefore)
        .filter(call => new Uint8Array(call[0])[0] === FRAME_DATA)
        .map(call => decodeDataFrame(call[0]));
      expect(newFrames).toHaveLength(0);

      // Clipboard should have been read
      expect(navigator.clipboard.readText).toHaveBeenCalled();
    });

    it('Cmd+C triggers clipboard copy when there is a selection', () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: vi.fn(), writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      const { container } = renderTerminal();
      exitInitialPhase();

      mockGetSelection.mockReturnValue('selected text');

      const cmdBtn = container.querySelectorAll('.virtual-key')[3];
      fireEvent.pointerDown(cmdBtn);
      capturedOnData!('c');

      expect(mockWriteText).toHaveBeenCalledWith('selected text');
    });

    it('deactivates Ctrl when Cmd is tapped', () => {
      const { container } = renderTerminal();
      const ctrlBtn = container.querySelectorAll('.virtual-key')[2];
      const cmdBtn = container.querySelectorAll('.virtual-key')[3];

      fireEvent.pointerDown(ctrlBtn);
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(true);

      fireEvent.pointerDown(cmdBtn);
      expect(ctrlBtn.classList.contains('virtual-key-active')).toBe(false);
      expect(cmdBtn.classList.contains('virtual-key-active')).toBe(true);
    });
  });
});
