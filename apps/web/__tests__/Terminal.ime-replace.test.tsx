/**
 * Issue #1883: on a touch device the Terminal sends soft-keyboard edits as
 * replaces (DELs, then the new text) and keeps them away from xterm's
 * append-only textarea handlers. Every other input path, such as real keys,
 * paste, the sticky modifiers and the virtual Esc/Tab, must keep working, and
 * none of them may make a later keyboard edit delete or resend the wrong text.
 * The desktop path is unchanged.
 *
 * The real-browser counterpart, with the real xterm.js and the browser's IME
 * pipeline, is playwright/ime-replace.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

let capturedOnData: ((data: string) => void) | null = null;
let customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;
let mockTextarea: HTMLTextAreaElement;
let mockWs: { send: ReturnType<typeof vi.fn>; readyState: number };

// The xterm.js 5.5 behaviors this relies on: the custom key handler runs
// first and can veto a key; Enter and Ctrl-C clear the textarea before the key
// is emitted; paste() emits the text, then clears the textarea.
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    textarea = mockTextarea;
    loadAddon = vi.fn();
    open = vi.fn((parent: HTMLElement) => { parent.appendChild(mockTextarea); });
    write = vi.fn();
    getSelection = vi.fn().mockReturnValue('');
    dispose = vi.fn();
    onData = vi.fn((cb: (data: string) => void) => { capturedOnData = cb; });
    input = vi.fn((data: string) => { capturedOnData?.(data); });
    onResize = vi.fn();
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => { customKeyHandler = handler; });
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
  }
  return { Terminal: MockTerminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); dispose = vi.fn(); } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { constructor() { throw new Error('no webgl'); } } }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: class { dispose = vi.fn(); } }));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class { dispose = vi.fn(); constructor(_handler?: unknown, _opts?: unknown) {} },
}));

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
  constructor() { mockWs = this; }
});
vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); });

import { Terminal } from '../src/components/Terminal.js';

const DEL = '\x7f';

function dataFrames(): string[] {
  return mockWs.send.mock.calls
    .map((call) => new Uint8Array(call[0]))
    .filter((bytes) => bytes[0] === 0x01)
    .map((bytes) => new TextDecoder().decode(bytes.subarray(1)));
}

const originalMatchMedia = window.matchMedia;
/** A phone: coarse pointer, narrow screen (so the virtual keyboard renders), or a desktop. */
function emulate(device: 'phone' | 'desktop') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: device === 'phone' && (query === '(pointer: coarse)' || query.includes('max-width')),
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

/** The soft keyboard changes the textarea, as the browser reports it. */
function keyboardEdit(value: string, inputType = 'insertCompositionText') {
  mockTextarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType }));
  mockTextarea.value = value;
  mockTextarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
}

/** A key as xterm processes it: the custom handler first, then the key's bytes. */
function xtermKey(init: KeyboardEventInit & { keyCode?: number }, data: string) {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  if (customKeyHandler?.(event) === false) return;
  if (data === '\r' || data === '\x03') mockTextarea.value = '';
  capturedOnData?.(data);
}

/** A paste as xterm's paste handler does it: emit the text, then clear the textarea. */
function xtermPaste(text: string) {
  capturedOnData?.(text);
  mockTextarea.value = '';
}

/** Let deferred bookkeeping run, as it would between two user events. */
const nextEvent = () => Promise.resolve();

describe('Terminal mobile IME replace (Issue #1883)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedOnData = null;
    customKeyHandler = null;
    mockTextarea = document.createElement('textarea');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
  });

  describe('on a phone', () => {
    beforeEach(() => {
      emulate('phone');
      render(<Terminal wsPath="/ws/terminal/test" />);
    });

    afterEach(() => {
      // None of these paths may trip the desync alarm.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('sends an autocomplete replace as DELs plus the new text', () => {
      for (const value of ['c', 'ci', 'cie', 'ciec', 'ciecu']) keyboardEdit(value);
      keyboardEdit('circumstances', 'insertReplacementText');
      expect(dataFrames().join('')).toBe(`ciecu${DEL.repeat(3)}rcumstances`);
    });

    it('keeps keydown 229 from xterm and sends double letters typed quickly', () => {
      xtermKey({ keyCode: 229, key: 'Unidentified' }, 'should-not-send');
      keyboardEdit('l');
      keyboardEdit('ll');
      expect(dataFrames()).toEqual(['l', 'l']);
    });

    it('Enter submits, and the next line starts clean', async () => {
      keyboardEdit('hello');
      xtermKey({ key: 'Enter', keyCode: 13 }, '\r');
      await nextEvent();
      keyboardEdit('n', 'insertText');
      expect(dataFrames()).toEqual(['hello', '\r', 'n']);
    });

    it('Backspace passes through, and a later replace never deletes past it', async () => {
      keyboardEdit('abc');
      xtermKey({ key: 'Backspace', keyCode: 8 }, DEL);
      await nextEvent();
      keyboardEdit('abcd', 'insertText');
      expect(dataFrames()).toEqual(['abc', DEL, 'd']);
    });

    it('arrow keys pass through, and a later replace never deletes past them', async () => {
      keyboardEdit('word');
      xtermKey({ key: 'ArrowLeft', keyCode: 37 }, '\x1b[D');
      await nextEvent();
      keyboardEdit('words', 'insertText');
      expect(dataFrames()).toEqual(['word', '\x1b[D', 's']);
    });

    it('Ctrl-C through the sticky modifier sends ^C, never the c', async () => {
      keyboardEdit('ls ');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Ctrl' }));
      keyboardEdit('ls c');
      await nextEvent();
      keyboardEdit('ls c ', 'insertText');
      expect(dataFrames()).toEqual(['ls ', '\x03', ' ']);
    });

    it('paste is sent once, and the browser inserting it into the textarea sends nothing', async () => {
      keyboardEdit('see ');
      // xterm's paste handler emits the text and clears the textarea, then the
      // browser's own paste inserts the clipboard into it.
      xtermPaste('pasted');
      await nextEvent();
      keyboardEdit('pasted', 'insertFromPaste');
      keyboardEdit('pasted!', 'insertText');
      expect(dataFrames()).toEqual(['see ', 'pasted', '!']);
    });

    it('virtual Esc and Tab pass through, and a later replace never deletes past them', async () => {
      keyboardEdit('src/comp');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Tab' }));
      await nextEvent();
      keyboardEdit('src/compo', 'insertText');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Esc' }));
      await nextEvent();
      keyboardEdit('src/compon', 'insertText');
      expect(dataFrames()).toEqual(['src/comp', '\t', 'o', '\x1b', 'n']);
    });
  });

  it('on an iPad with a hardware keyboard, keys reach the PTY exactly as on desktop', () => {
    emulate('phone');
    render(<Terminal wsPath="/ws/terminal/test" />);
    // Real keydowns: xterm sends them and the textarea never changes.
    xtermKey({ key: 'h', keyCode: 72 }, 'h');
    xtermKey({ key: 'i', keyCode: 73 }, 'i');
    xtermKey({ key: 'ArrowUp', keyCode: 38 }, '\x1b[A');
    xtermKey({ key: 'Enter', keyCode: 13 }, '\r');
    expect(dataFrames()).toEqual(['h', 'i', '\x1b[A', '\r']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a textarea rewritten behind the bridge fails loud and resyncs without deleting or resending', () => {
    emulate('phone');
    render(<Terminal wsPath="/ws/terminal/test" />);
    keyboardEdit('hello');
    mockTextarea.value = 'something else';
    keyboardEdit('something else!', 'insertText');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[Terminal IME #1883]');
    expect(dataFrames()).toEqual(['hello', '!']);
  });

  it('on desktop, IME events still go to xterm and nothing else changes', () => {
    emulate('desktop');
    const xtermSaw = vi.fn();
    mockTextarea.addEventListener('compositionstart', xtermSaw);
    mockTextarea.addEventListener('input', xtermSaw);
    render(<Terminal wsPath="/ws/terminal/test" />);
    mockTextarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    keyboardEdit('a');
    expect(xtermSaw).toHaveBeenCalledTimes(2);
    expect(customKeyHandler!(new KeyboardEvent('keydown', { keyCode: 229 }))).toBe(true);
    // The bridge sent nothing; xterm's own onData is the only source.
    expect(dataFrames()).toEqual([]);
    capturedOnData!('a');
    expect(dataFrames()).toEqual(['a']);
  });
});
