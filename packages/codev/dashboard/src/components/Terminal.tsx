import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { FilePathLinkProvider, FilePathDecorationManager } from '../lib/filePathLinkProvider.js';
import { VirtualKeyboard, type ModifierState } from './VirtualKeyboard.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { MOBILE_BREAKPOINT } from '../lib/constants.js';
import { uploadPasteImage } from '../lib/api.js';

/** WebSocket frame prefixes matching packages/codev/src/terminal/ws-protocol.ts */
const FRAME_CONTROL = 0x00;
const FRAME_DATA = 0x01;

interface TerminalProps {
  /** WebSocket path for the terminal session, e.g. /ws/terminal/<id> */
  wsPath: string;
  /** Callback when user clicks a file path in terminal output (Spec 0092, 0101) */
  onFileOpen?: (path: string, line?: number, column?: number, terminalId?: string) => void;
  /** Whether this session is backed by a persistent shepherd process (Spec 0104) */
  persistent?: boolean;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

/**
 * Try to read an image from the clipboard and upload it. Returns true if an
 * image was found and handled, false otherwise (caller should fall back to text).
 */
async function tryPasteImage(term: XTerm): Promise<boolean> {
  if (!navigator.clipboard?.read) return false;
  let imageFound = false;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => IMAGE_TYPES.includes(t));
      if (imageType) {
        imageFound = true;
        const blob = await item.getType(imageType);
        term.write('\r\n\x1b[90m[Uploading image...]\x1b[0m');
        const { path } = await uploadPasteImage(blob);
        term.write('\r\x1b[2K');
        term.paste(path);
        return true;
      }
    }
  } catch {
    if (imageFound) {
      // Upload failed after image was detected — show error and clear status
      term.write('\r\x1b[2K\x1b[31m[Image upload failed]\x1b[0m\r\n');
      return true; // Don't fall back to text — the user intended to paste an image
    }
    // clipboard.read() denied or unavailable — fall back to text
  }
  return false;
}

/**
 * Handle paste: try image first (via Clipboard API), fall back to text.
 * Used by both the keyboard shortcut handler and the native paste event.
 */
async function handlePaste(term: XTerm): Promise<void> {
  if (await tryPasteImage(term)) return;
  // Fall back to text paste
  try {
    const text = await navigator.clipboard?.readText();
    if (text) term.paste(text);
  } catch {
    // clipboard access denied
  }
}

/**
 * Handle a native paste event (e.g. from mobile long-press menu or context menu).
 * Checks clipboardData for image files, then falls back to text.
 */
function handleNativePaste(event: ClipboardEvent, term: XTerm): void {
  const items = event.clipboardData?.items;
  if (!items) return;

  for (const item of Array.from(items)) {
    if (IMAGE_TYPES.includes(item.type)) {
      const blob = item.getAsFile();
      if (!blob) continue;
      event.preventDefault();
      term.write('\r\n\x1b[90m[Uploading image...]\x1b[0m');
      uploadPasteImage(blob).then(({ path }) => {
        term.write('\r\x1b[2K');
        term.paste(path);
      }).catch(() => {
        term.write('\r\x1b[2K\x1b[31m[Image upload failed]\x1b[0m\r\n');
      });
      return;
    }
  }
  // Text paste: let xterm.js handle it natively (no preventDefault)
}

/**
 * Terminal component — renders an xterm.js instance connected to the
 * node-pty backend via WebSocket using the hybrid binary protocol.
 */
export function Terminal({ wsPath, onFileOpen, persistent }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const modifierRef = useRef<ModifierState>({ ctrl: false, cmd: false, clearCallback: null });
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);


  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm.js instance
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      customGlyphs: true,
      scrollback: 50000,
      theme: {
        background: '#1a1a1a',
        foreground: '#e0e0e0',
        cursor: '#ffffff',
      },
      allowProposedApi: true,
    });
    xtermRef.current = term;

    // Fit addon for auto-sizing
    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);

    // Open terminal in the container
    term.open(containerRef.current);

    // Try WebGL renderer for performance, fall back to canvas on failure
    // or context loss (common Chrome/macOS GPU bug with Metal backend)
    const loadCanvasFallback = () => {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        // Default renderer will be used
      }
    };

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        loadCanvasFallback();
      });
      term.loadAddon(webglAddon);
    } catch {
      loadCanvasFallback();
    }

    // URL links: open in new browser tab (WebLinksAddon handles http/https only)
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, '_blank');
    });
    term.loadAddon(webLinksAddon);

    // Spec 0101: File path links — register custom ILinkProvider for Cmd/Ctrl+Click activation
    // and FilePathDecorationManager for persistent dotted underline decoration.
    // Extract terminalId from wsPath: "/base/ws/terminal/<id>" → "<id>"
    const terminalId = wsPath.split('/').pop();
    let linkProviderDisposable: { dispose(): void } | null = null;
    let decorationManager: FilePathDecorationManager | null = null;
    if (onFileOpen) {
      decorationManager = new FilePathDecorationManager(term);
      const filePathProvider = new FilePathLinkProvider(
        term,
        (filePath, line, column, tid) => {
          onFileOpen(filePath, line, column, tid);
        },
        terminalId,
        decorationManager,
      );
      linkProviderDisposable = term.registerLinkProvider(filePathProvider);
    }

    // Clipboard handling
    const isMac = navigator.platform.toUpperCase().includes('MAC');

    // Copy: Cmd+C (Mac) or Ctrl+Shift+C (Linux/Windows) copies selection.
    // If no selection, let the key event pass through (sends SIGINT on Ctrl+C).
    // Paste: Cmd+V (Mac) or Ctrl+Shift+V (Linux/Windows)
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true;

      // Shift+Enter: insert backslash + newline for line continuation
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        term.paste('\\\n');
        return false;
      }

      const modKey = isMac ? event.metaKey : event.ctrlKey && event.shiftKey;
      if (!modKey) return true;

      if (event.key === 'c' || event.key === 'C') {
        const sel = term.getSelection();
        if (sel) {
          event.preventDefault();
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        // No selection — let it pass through (Ctrl+C → SIGINT)
        return true;
      }

      if (event.key === 'v' || event.key === 'V') {
        event.preventDefault();
        handlePaste(term);
        return false;
      }

      return true;
    });

    // Native paste event listener for mobile browsers and context-menu paste.
    // On mobile, users paste via long-press menu which fires a native paste event
    // rather than a keyboard shortcut. This also handles image paste from context menu.
    const onNativePaste = (e: Event) => handleNativePaste(e as ClipboardEvent, term);
    containerRef.current.addEventListener('paste', onNativePaste);

    // Debounced fit: coalesce multiple fit() triggers into one resize event.
    // This prevents resize storms from multiple sources (initial fit, CSS
    // layout settling, ResizeObserver, visibility change, buffer flush).
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFit = () => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        fitAddon.fit();
      }, 150);
    };

    fitAddon.fit();
    // Single delayed re-fit to catch CSS layout settling
    const refitTimer1 = setTimeout(debouncedFit, 300);

    // Build WebSocket URL from the relative path
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${wsPath}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    // Filter DA (Device Attribute) response sequences that can appear as visible
    // text when reconnecting to an existing shepherd session. Buffer the first
    // 500ms of data to catch fragmented DA sequences, then flush and switch to
    // direct writes. Uses a fixed deadline (not reset per frame) so active
    // terminals don't starve.
    let initialBuffer = '';
    let initialPhase = true;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const filterDA = (text: string): string => {
      // DA1: ESC[?...c  DA2: ESC[>...c  (with or without ESC prefix)
      text = text.replace(/\x1b\[[\?>][\d;]*c/g, '');
      text = text.replace(/\[[\?>][\d;]*c/g, '');
      return text;
    };

    const flushInitialBuffer = () => {
      initialPhase = false;
      flushTimer = null;
      if (initialBuffer) {
        const filtered = filterDA(initialBuffer);
        if (filtered) term.write(filtered);
        initialBuffer = '';
      }
      // Re-fit after buffer flush — CSS layout may have settled since
      // the initial fit(). Uses debounced fit to avoid resize storms.
      debouncedFit();
    };

    ws.onopen = () => {
      // Send initial resize
      sendControl(ws, 'resize', { cols: term.cols, rows: term.rows });
    };

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length === 0) return;

      const prefix = data[0];
      const payload = data.subarray(1);

      if (prefix === FRAME_DATA) {
        const text = new TextDecoder().decode(payload);

        if (initialPhase) {
          // Buffer initial data to catch fragmented DA responses.
          // Set flush timer on FIRST message only (fixed 500ms deadline).
          initialBuffer += text;
          if (!flushTimer) {
            flushTimer = setTimeout(flushInitialBuffer, 500);
          }
        } else {
          // After initial phase, still filter for safety but write immediately
          const filtered = filterDA(text);
          if (filtered) term.write(filtered);
        }
      } else if (prefix === FRAME_CONTROL) {
        // Handle control messages (pong, error, etc.) if needed
      }
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[Terminal disconnected]\x1b[0m\r\n');
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
    };

    // Mobile IME deduplication: On mobile browsers, all keyboard input
    // goes through IME composition. Some browsers fire both input and
    // compositionend events, causing xterm.js to emit onData twice for
    // the same keystroke. Track composition state and deduplicate.
    const textarea = term.textarea;
    let imeActive = false;
    let imeResetTimer: ReturnType<typeof setTimeout> | null = null;
    let lastImeData = '';
    let lastImeTime = 0;

    const onCompositionStart = () => { imeActive = true; };
    const onCompositionEnd = () => {
      // Keep imeActive true briefly so the dedup window covers both
      // the compositionend-triggered and input-triggered onData calls.
      if (imeResetTimer) clearTimeout(imeResetTimer);
      imeResetTimer = setTimeout(() => { imeActive = false; }, 100);
    };

    if (textarea) {
      textarea.addEventListener('compositionstart', onCompositionStart);
      textarea.addEventListener('compositionend', onCompositionEnd);
    }

    // Send user input to the PTY
    term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // During IME composition, skip exact duplicate onData calls
      // that arrive within 100ms (caused by double event dispatch).
      if (imeActive) {
        const now = Date.now();
        if (data === lastImeData && now - lastImeTime < 100) {
          return;
        }
        lastImeData = data;
        lastImeTime = now;
      }

      // During initial handshake, filter automatic terminal responses
      // (DA, DSR, mode reports) that xterm.js sends during connection.
      // These would otherwise be interpreted as keyboard input by the shell.
      if (initialPhase) {
        const filtered = data
          .replace(/\x1b\[[\?>][\d;]*c/g, '')    // DA1/DA2 responses
          .replace(/\x1b\[\d+;\d+R/g, '')          // DSR cursor position
          .replace(/\x1b\[\?[\d;]*\$y/g, '');      // Mode reports (DECRPM)
        if (!filtered) return;
        data = filtered;
      }

      // Sticky modifier handling for mobile virtual keyboard
      const mod = modifierRef.current;
      if ((mod.ctrl || mod.cmd) && data.length === 1) {
        const charCode = data.charCodeAt(0);
        if (mod.ctrl) {
          // Ctrl+letter: convert to control character (a=0x01, z=0x1a)
          if (charCode >= 0x61 && charCode <= 0x7a) {
            data = String.fromCharCode(charCode - 96);
          } else if (charCode >= 0x41 && charCode <= 0x5a) {
            data = String.fromCharCode(charCode - 64);
          }
          mod.ctrl = false;
          mod.cmd = false;
          mod.clearCallback?.();
        } else if (mod.cmd) {
          const key = data.toLowerCase();
          if (key === 'v') {
            navigator.clipboard?.readText().then((text) => {
              if (text) term.paste(text);
            }).catch(() => {});
            mod.ctrl = false;
            mod.cmd = false;
            mod.clearCallback?.();
            return;
          }
          if (key === 'c') {
            const sel = term.getSelection();
            if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
            mod.ctrl = false;
            mod.cmd = false;
            mod.clearCallback?.();
            return;
          }
          mod.ctrl = false;
          mod.cmd = false;
          mod.clearCallback?.();
        }
      }

      sendData(ws, data);
    });

    // Send resize events
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendControl(ws, 'resize', { cols, rows });
      }
    });

    // Scroll: no custom wheel handler. In normal buffer, xterm.js handles
    // scrollback natively. In alternate buffer, scroll wheel is a known
    // limitation (#220). Arrow keys and Page Up/Down both cause undesirable
    // side effects (command history, scrollback navigation).

    // Handle window resize (debounced to prevent resize storms)
    const resizeObserver = new ResizeObserver(debouncedFit);
    resizeObserver.observe(containerRef.current);

    // Re-fit when browser tab becomes visible again
    const handleVisibility = () => {
      if (!document.hidden) debouncedFit();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearTimeout(refitTimer1);
      if (fitTimer) clearTimeout(fitTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (imeResetTimer) clearTimeout(imeResetTimer);
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompositionStart);
        textarea.removeEventListener('compositionend', onCompositionEnd);
      }
      decorationManager?.dispose();
      linkProviderDisposable?.dispose();
      containerRef.current?.removeEventListener('paste', onNativePaste);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      ws.close();
      term.dispose();
      xtermRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [wsPath]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {persistent === false && (
        <div style={{
          backgroundColor: '#3a2a00',
          color: '#ffcc00',
          padding: '4px 12px',
          fontSize: '12px',
          flexShrink: 0,
        }}>
          Session persistence unavailable — this terminal will not survive a restart
        </div>
      )}
      {isMobile && (
        <VirtualKeyboard wsRef={wsRef} modifierRef={modifierRef} />
      )}
      <div
        ref={containerRef}
        className="terminal-container"
        style={{
          width: '100%',
          flex: 1,
          backgroundColor: '#1a1a1a',
        }}
      />
    </div>
  );
}

/** Encode and send a data frame (0x01 prefix + UTF-8 payload). */
function sendData(ws: WebSocket, data: string): void {
  const encoded = new TextEncoder().encode(data);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_DATA;
  frame.set(encoded, 1);
  ws.send(frame.buffer);
}

/** Encode and send a control frame (0x00 prefix + JSON payload). */
function sendControl(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
  const json = JSON.stringify({ type, payload });
  const encoded = new TextEncoder().encode(json);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_CONTROL;
  frame.set(encoded, 1);
  ws.send(frame.buffer);
}
