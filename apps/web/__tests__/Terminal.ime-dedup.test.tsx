/**
 * Regression test for GitHub Issues #253 and #517:
 * Mobile typed text gets duplicated / extra periods
 *
 * On mobile browsers, all keyboard input goes through IME composition.
 * xterm.js has multiple code paths (keydown, compositionend, input event)
 * that can each fire onData for the same keystroke, causing duplicates.
 *
 * The guard drops an exact repeat during or just after an IME composition.
 * It was also always on for touch devices (pointer: coarse). Since the IME
 * bridge (#1883) owns soft-keyboard text on touch devices, that arm only
 * dropped real repeats from hardware keys (Issue #1886), and is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Capture the onData callback so tests can invoke it directly
let capturedOnData: ((data: string) => void) | null = null;

// Mock textarea element for composition event simulation
let mockTextarea: HTMLTextAreaElement;

// Capture WebSocket send calls
let mockWsSend: ReturnType<typeof vi.fn>;

// Mock @xterm/xterm — includes textarea for IME composition tracking
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
    // Expose a real textarea element so composition listeners can be attached
    textarea = mockTextarea;
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

/** Fire a composition event on the mock textarea. */
function fireComposition(type: 'compositionstart' | 'compositionend', data?: string) {
  const event = new Event(type);
  if (data !== undefined) {
    (event as any).data = data;
  }
  mockTextarea.dispatchEvent(event);
}

/** Mock matchMedia to simulate touch device (pointer: coarse). */
const originalMatchMedia = window.matchMedia;
function mockTouchDevice(isTouch: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(pointer: coarse)' ? isTouch : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
function restoreMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
}

describe('Terminal IME deduplication (Issue #253, #517)', () => {
  beforeEach(() => {
    capturedOnData = null;
    mockTextarea = document.createElement('textarea');
    // Default: not a touch device (desktop)
    mockTouchDevice(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    restoreMatchMedia();
    vi.useRealTimers();
  });

  function renderAndGetOnData() {
    render(<Terminal wsPath="/ws/terminal/test" />);
    expect(capturedOnData).not.toBeNull();
    return capturedOnData!;
  }

  it('deduplicates onData during IME composition', () => {
    const onData = renderAndGetOnData();

    // Simulate mobile IME: compositionstart → compositionend → duplicate onData
    fireComposition('compositionstart');
    fireComposition('compositionend', 'a');

    // xterm.js fires onData twice for the same character
    onData('a');
    onData('a'); // duplicate from input event

    const frames = getDataFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe('a');
  });

  it('allows different characters during IME composition', () => {
    const onData = renderAndGetOnData();

    // Type 'a'
    fireComposition('compositionstart');
    fireComposition('compositionend', 'a');
    onData('a');
    onData('a'); // duplicate

    // Type 'b' — different character, should not be deduped
    fireComposition('compositionstart');
    fireComposition('compositionend', 'b');
    onData('b');
    onData('b'); // duplicate

    const frames = getDataFrames();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe('a');
    expect(frames[1]).toBe('b');
  });

  it('does not deduplicate when not composing (desktop key repeat)', () => {
    const onData = renderAndGetOnData();

    // No composition events — simulate desktop key repeat
    onData('x');
    onData('x');

    const frames = getDataFrames();
    expect(frames).toHaveLength(2);
  });

  it('stops deduplicating after 150ms post-composition window', () => {
    const onData = renderAndGetOnData();

    // Composition happens
    fireComposition('compositionstart');
    fireComposition('compositionend', 'a');
    onData('a');

    // Advance past the 150ms post-composition dedup window
    vi.advanceTimersByTime(200);

    // Same character again — should go through since composition window expired
    onData('a');

    const frames = getDataFrames();
    expect(frames).toHaveLength(2);
  });

  it('deduplicates a doubled period from an IME composition (Issue #517)', () => {
    const onData = renderAndGetOnData();

    // Simulate typing "todo." where the period gets duplicated
    fireComposition('compositionstart');
    fireComposition('compositionend', '.');
    onData('.');
    onData('.'); // duplicate from xterm double-fire

    const frames = getDataFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe('.');
  });

  it('deduplicates Enter key during IME composition', () => {
    const onData = renderAndGetOnData();

    fireComposition('compositionstart');
    fireComposition('compositionend', '\r');
    onData('\r');
    onData('\r'); // duplicate

    const frames = getDataFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe('\r');
  });
});

describe('Terminal on a touch device: hardware keys are never deduplicated (Issue #1886)', () => {
  beforeEach(() => {
    capturedOnData = null;
    mockTextarea = document.createElement('textarea');
    // Simulate iPad/touch device: pointer: coarse matches
    mockTouchDevice(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    restoreMatchMedia();
    vi.useRealTimers();
  });

  function renderAndGetOnData() {
    render(<Terminal wsPath="/ws/terminal/test" />);
    expect(capturedOnData).not.toBeNull();
    return capturedOnData!;
  }

  // Issue #1886: with the IME bridge (#1883) owning soft-keyboard text, what
  // reaches onData outside a composition on a touch device is hardware keys,
  // paste and terminal replies. A repeat among those is the user's.
  it('sends fast double letters from a hardware keyboard', () => {
    const onData = renderAndGetOnData();

    for (const key of ['h', 'e', 'l', 'l', 'o']) onData(key);

    expect(getDataFrames()).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  it('sends every repeat of a held key (Backspace, arrows)', () => {
    const onData = renderAndGetOnData();

    for (let i = 0; i < 4; i++) onData('\x7f');
    for (let i = 0; i < 3; i++) onData('\x1b[B');

    expect(getDataFrames()).toEqual(['\x7f', '\x7f', '\x7f', '\x7f', '\x1b[B', '\x1b[B', '\x1b[B']);
  });

  it('sends Enter pressed twice quickly', () => {
    const onData = renderAndGetOnData();

    onData('\r');
    onData('\r');

    expect(getDataFrames()).toEqual(['\r', '\r']);
  });

  it('allows same character after 150ms on touch device', () => {
    const onData = renderAndGetOnData();

    onData('l');
    vi.advanceTimersByTime(200);
    onData('l'); // intentional repeat — enough time has passed

    const frames = getDataFrames();
    expect(frames).toHaveLength(2);
  });

});
