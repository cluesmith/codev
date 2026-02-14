/**
 * Regression test for GitHub Issue #203: Copy/paste text in dashboard terminals
 * Extended for Issue #252: Image paste support and mobile clipboard
 *
 * Verifies that the Terminal component registers a custom key event handler
 * on xterm.js for explicit clipboard operations via navigator.clipboard API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Capture the custom key event handler registered on the xterm instance
let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;
let mockPaste: ReturnType<typeof vi.fn>;
let mockWrite: ReturnType<typeof vi.fn>;
let mockGetSelection: ReturnType<typeof vi.fn>;

// Mock @xterm/xterm — use a class so `new Terminal(...)` works
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
    cols = 80;
    rows = 24;
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      capturedKeyHandler = handler;
    });
    registerLinkProvider = vi.fn();
    constructor() {
      mockPaste = this.paste;
      mockWrite = this.write;
      mockGetSelection = this.getSelection;
    }
  }
  return { Terminal: MockTerminal };
});

// Mock addons — use classes
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

// Mock uploadPasteImage from api.ts (Issue #252)
const mockUploadPasteImage = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  uploadPasteImage: (...args: unknown[]) => mockUploadPasteImage(...args),
}));

// Mock WebSocket as a class
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
});

// Mock ResizeObserver
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
});

// Import after mocks are set up
import { Terminal } from '../src/components/Terminal.js';

describe('Terminal clipboard handling (Issue #203, #252)', () => {
  let clipboardReadText: ReturnType<typeof vi.fn>;
  let clipboardWriteText: ReturnType<typeof vi.fn>;
  let clipboardRead: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedKeyHandler = null;
    clipboardReadText = vi.fn().mockResolvedValue('pasted text');
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    // Default: clipboard.read() returns text-only items (no images)
    clipboardRead = vi.fn().mockResolvedValue([
      { types: ['text/plain'], getType: vi.fn() },
    ]);

    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: clipboardReadText, writeText: clipboardWriteText, read: clipboardRead },
      writable: true,
      configurable: true,
    });

    mockUploadPasteImage.mockReset();
  });

  afterEach(cleanup);

  function renderTerminal() {
    render(<Terminal wsPath="/ws/terminal/test" />);
    expect(capturedKeyHandler).not.toBeNull();
    return capturedKeyHandler!;
  }

  function makeKeyEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return { type: 'keydown', key, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), ...opts } as unknown as KeyboardEvent;
  }

  it('registers attachCustomKeyEventHandler on the xterm instance', () => {
    renderTerminal();
    expect(typeof capturedKeyHandler).toBe('function');
  });

  describe('text paste (Cmd+V on Mac)', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    });

    it('reads clipboard and calls term.paste() on Cmd+V', async () => {
      const handler = renderTerminal();
      const event = makeKeyEvent('v', { metaKey: true });
      const result = handler(event);

      expect(result).toBe(false); // Prevent xterm default handling
      expect(event.preventDefault).toHaveBeenCalled(); // Prevent native paste (double-paste fix)
      await vi.waitFor(() => {
        expect(clipboardReadText).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockPaste).toHaveBeenCalledWith('pasted text');
      });
    });
  });

  describe('text paste (Ctrl+Shift+V on Linux/Windows)', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    });

    it('reads clipboard and calls term.paste() on Ctrl+Shift+V', async () => {
      const handler = renderTerminal();
      const event = makeKeyEvent('V', { ctrlKey: true, shiftKey: true });
      const result = handler(event);

      expect(result).toBe(false);
      expect(event.preventDefault).toHaveBeenCalled(); // Prevent native paste (double-paste fix)
      await vi.waitFor(() => {
        expect(clipboardReadText).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockPaste).toHaveBeenCalledWith('pasted text');
      });
    });
  });

  describe('image paste (Cmd+V on Mac) — Issue #252', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    });

    it('detects image in clipboard, uploads, and pastes the file path', async () => {
      const mockBlob = new Blob(['fake-image'], { type: 'image/png' });
      clipboardRead.mockResolvedValue([
        {
          types: ['image/png'],
          getType: vi.fn().mockResolvedValue(mockBlob),
        },
      ]);
      mockUploadPasteImage.mockResolvedValue({ path: '/tmp/codev-paste/paste-123.png' });

      const handler = renderTerminal();
      const event = makeKeyEvent('v', { metaKey: true });
      handler(event);

      await vi.waitFor(() => {
        expect(clipboardRead).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockUploadPasteImage).toHaveBeenCalledWith(mockBlob);
      });
      await vi.waitFor(() => {
        expect(mockPaste).toHaveBeenCalledWith('/tmp/codev-paste/paste-123.png');
      });
      // Should NOT fall back to text paste
      expect(clipboardReadText).not.toHaveBeenCalled();
    });

    it('falls back to text paste when clipboard.read() is unavailable', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: clipboardReadText, writeText: clipboardWriteText },
        writable: true,
        configurable: true,
      });

      const handler = renderTerminal();
      handler(makeKeyEvent('v', { metaKey: true }));

      await vi.waitFor(() => {
        expect(clipboardReadText).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockPaste).toHaveBeenCalledWith('pasted text');
      });
    });

    it('shows uploading status and clears it after success', async () => {
      const mockBlob = new Blob(['fake-image'], { type: 'image/png' });
      clipboardRead.mockResolvedValue([
        {
          types: ['image/png'],
          getType: vi.fn().mockResolvedValue(mockBlob),
        },
      ]);
      mockUploadPasteImage.mockResolvedValue({ path: '/tmp/codev-paste/paste-456.png' });

      const handler = renderTerminal();
      handler(makeKeyEvent('v', { metaKey: true }));

      await vi.waitFor(() => {
        expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining('[Uploading image...]'));
      });
      await vi.waitFor(() => {
        // Clear line after upload completes
        expect(mockWrite).toHaveBeenCalledWith('\r\x1b[2K');
      });
    });

    it('shows error message when image upload fails', async () => {
      const mockBlob = new Blob(['fake-image'], { type: 'image/png' });
      clipboardRead.mockResolvedValue([
        {
          types: ['image/png'],
          getType: vi.fn().mockResolvedValue(mockBlob),
        },
      ]);
      mockUploadPasteImage.mockRejectedValue(new Error('Upload failed: 500'));

      const handler = renderTerminal();
      handler(makeKeyEvent('v', { metaKey: true }));

      await vi.waitFor(() => {
        expect(mockUploadPasteImage).toHaveBeenCalledWith(mockBlob);
      });
      await vi.waitFor(() => {
        expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining('[Image upload failed]'));
      });
      // Should NOT fall back to text paste when image was detected
      expect(clipboardReadText).not.toHaveBeenCalled();
    });
  });

  describe('native paste event (mobile/context menu) — Issue #252', () => {
    it('uploads image from native paste event and pastes path', async () => {
      const mockFile = new File(['fake-image'], 'screenshot.png', { type: 'image/png' });
      mockUploadPasteImage.mockResolvedValue({ path: '/tmp/codev-paste/paste-789.png' });

      render(<Terminal wsPath="/ws/terminal/test" />);

      // Get the terminal container and dispatch a native paste event
      const container = document.querySelector('.terminal-container');
      expect(container).not.toBeNull();

      const pasteEvent = new Event('paste', { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [
            { type: 'image/png', getAsFile: () => mockFile },
          ],
        },
      });
      Object.defineProperty(pasteEvent, 'preventDefault', { value: vi.fn() });

      container!.dispatchEvent(pasteEvent);

      await vi.waitFor(() => {
        expect(mockUploadPasteImage).toHaveBeenCalledWith(mockFile);
      });
      await vi.waitFor(() => {
        expect(mockPaste).toHaveBeenCalledWith('/tmp/codev-paste/paste-789.png');
      });
    });

    it('does not preventDefault when image-type item yields null from getAsFile()', () => {
      render(<Terminal wsPath="/ws/terminal/test" />);

      const container = document.querySelector('.terminal-container');
      expect(container).not.toBeNull();

      const preventDefault = vi.fn();
      const pasteEvent = new Event('paste', { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [
            { type: 'image/png', getAsFile: () => null },
          ],
        },
      });
      Object.defineProperty(pasteEvent, 'preventDefault', { value: preventDefault });

      container!.dispatchEvent(pasteEvent);

      // If getAsFile() returns null, we should NOT block default paste behavior
      expect(preventDefault).not.toHaveBeenCalled();
      expect(mockUploadPasteImage).not.toHaveBeenCalled();
    });

    it('does not preventDefault for text-only paste events', () => {
      render(<Terminal wsPath="/ws/terminal/test" />);

      const container = document.querySelector('.terminal-container');
      expect(container).not.toBeNull();

      const preventDefault = vi.fn();
      const pasteEvent = new Event('paste', { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [
            { type: 'text/plain', getAsFile: () => null },
          ],
        },
      });
      Object.defineProperty(pasteEvent, 'preventDefault', { value: preventDefault });

      container!.dispatchEvent(pasteEvent);

      // Text paste: should let xterm handle natively (no preventDefault)
      expect(preventDefault).not.toHaveBeenCalled();
      expect(mockUploadPasteImage).not.toHaveBeenCalled();
    });
  });

  describe('copy (Cmd+C on Mac)', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    });

    it('copies selection to clipboard when text is selected', () => {
      const handler = renderTerminal();
      mockGetSelection.mockReturnValue('selected text');
      const result = handler(makeKeyEvent('c', { metaKey: true }));

      expect(result).toBe(false); // Handled by our clipboard code
      expect(clipboardWriteText).toHaveBeenCalledWith('selected text');
    });

    it('passes through when no selection (allows ^C / SIGINT)', () => {
      const handler = renderTerminal();
      mockGetSelection.mockReturnValue('');
      const result = handler(makeKeyEvent('c', { metaKey: true }));
      expect(result).toBe(true); // Let xterm handle it (sends SIGINT)
    });
  });

  describe('non-clipboard keys pass through', () => {
    it('returns true for regular keys', () => {
      const handler = renderTerminal();
      const result = handler(makeKeyEvent('a'));
      expect(result).toBe(true);
    });

    it('returns true for keyup events', () => {
      const handler = renderTerminal();
      const result = handler({ type: 'keyup', key: 'v', metaKey: true } as unknown as KeyboardEvent);
      expect(result).toBe(true);
    });
  });
});
