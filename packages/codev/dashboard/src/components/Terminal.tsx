import { useEffect, useRef, useState } from 'react';
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

/**
 * Floating controls overlay for terminal windows — refresh (re-fit + resize)
 * and scroll-to-bottom buttons. Uses onPointerDown+preventDefault to avoid
 * stealing focus from xterm (same pattern as VirtualKeyboard).
 * Spec 0364.
 */
function TerminalControls({
  fitRef,
  wsRef,
  xtermRef,
  connStatus,
}: {
  fitRef: React.RefObject<FitAddon | null>;
  wsRef: React.RefObject<WebSocket | null>;
  xtermRef: React.RefObject<XTerm | null>;
  connStatus: 'connected' | 'reconnecting' | 'disconnected';
}) {
  const handleRefresh = (e: React.PointerEvent) => {
    e.preventDefault();
    const fit = fitRef.current;
    const ws = wsRef.current;
    const term = xtermRef.current;
    if (!fit || !ws || ws.readyState !== WebSocket.OPEN || !term) return;

    // Debug: trace the full resize path (Issue #382)
    const beforeCols = term.cols;
    const beforeRows = term.rows;
    const container = term.element?.parentElement;
    const containerStyle = container ? window.getComputedStyle(container) : null;
    console.log('[refresh] before:', {
      cols: beforeCols, rows: beforeRows,
      containerW: containerStyle?.width, containerH: containerStyle?.height,
    });

    // Preserve scroll position across fit() (Bugfix #423)
    const baseY = term.buffer?.active?.baseY;
    const viewportY = term.buffer?.active?.viewportY;
    const wasAtBottom = !baseY || viewportY == null || viewportY >= baseY;

    fit.fit();

    if (wasAtBottom) {
      term.scrollToBottom();
    } else {
      term.scrollToLine(viewportY);
    }

    console.log('[refresh] after fit():', {
      cols: term.cols, rows: term.rows,
      changed: term.cols !== beforeCols || term.rows !== beforeRows,
    });

    // Always send resize to PTY — even if fit() didn't change dimensions,
    // force SIGWINCH so the shell redraws.
    sendControl(ws, 'resize', { cols: term.cols, rows: term.rows });
    console.log('[refresh] sent resize control frame:', { cols: term.cols, rows: term.rows });
  };

  const handleScrollToBottom = (e: React.PointerEvent) => {
    e.preventDefault();
    xtermRef.current?.scrollToBottom();
  };

  return (
    <div className="terminal-controls">
      <button
        className="terminal-control-btn"
        onPointerDown={handleRefresh}
        tabIndex={-1}
        aria-label="Refresh terminal"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.5 2.5v4h-4" />
          <path d="M2.5 8a5.5 5.5 0 0 1 9.35-3.5L13.5 6.5" />
          <path d="M2.5 13.5v-4h4" />
          <path d="M13.5 8a5.5 5.5 0 0 1-9.35 3.5L2.5 9.5" />
        </svg>
      </button>
      <button
        className="terminal-control-btn"
        onPointerDown={handleScrollToBottom}
        tabIndex={-1}
        aria-label="Scroll to bottom"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3v8" />
          <path d="M4 8l4 4 4-4" />
          <line x1="4" y1="13" x2="12" y2="13" />
        </svg>
      </button>
      {connStatus !== 'connected' && (
        <span
          className={`terminal-control-btn terminal-status-icon ${connStatus === 'reconnecting' ? 'terminal-status-reconnecting' : 'terminal-status-disconnected'}`}
          role="status"
          title={connStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'}
          aria-label={connStatus === 'reconnecting' ? 'Reconnecting' : 'Disconnected'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="4" fill="currentColor" />
          </svg>
        </span>
      )}
    </div>
  );
}

/** WebSocket frame prefixes matching packages/codev/src/terminal/ws-protocol.ts */
const FRAME_CONTROL = 0x00;
const FRAME_DATA = 0x01;

interface TerminalProps {
  /** WebSocket path for the terminal session, e.g. /ws/terminal/<id> */
  wsPath: string;
  /** Callback when user clicks a file path in terminal output (Spec 0092, 0101) */
  onFileOpen?: (path: string, line?: number, column?: number, terminalId?: string) => void;
  /** Whether this session is backed by a persistent shellper process (Spec 0104) */
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
  const [connStatus, setConnStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('connected');

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
      // Override xterm's default OSC 8 link handler which shows a confirm()
      // dialog ("This link could potentially be dangerous"). We trust links
      // from our own terminal sessions.
      linkHandler: {
        activate: (_event: MouseEvent, uri: string) => {
          window.open(uri, '_blank', 'noopener');
        },
      },
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

    // Scroll-aware fit: preserves the viewport scroll position across
    // fit() calls.  Without this, fit() → resize() → buffer reflow can
    // reset the viewport to the top of the scrollback (Bugfix #423).
    // Only activates when there IS scrollback (baseY > 0); when the buffer
    // is empty or all content fits in the viewport, there's nothing to lose.
    const safeFit = () => {
      // Skip fit when container is hidden (display: none) or has zero dimensions.
      // ResizeObserver fires with 0x0 when tabs switch — fitting at that size
      // causes buffer reflow that resets the viewport to the top.
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;

      const baseY = term.buffer?.active?.baseY;
      if (!baseY) {
        fitAddon.fit();
        return;
      }
      const viewportY = term.buffer.active.viewportY;
      const wasAtBottom = viewportY == null || viewportY >= baseY;
      fitAddon.fit();
      if (wasAtBottom) {
        term.scrollToBottom();
      } else {
        term.scrollToLine(viewportY);
      }
    };

    // Debounced fit: coalesce multiple fit() triggers into one resize event.
    // This prevents resize storms from multiple sources (initial fit, CSS
    // layout settling, ResizeObserver, visibility change, buffer flush).
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFit = () => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        safeFit();
      }, 150);
    };

    safeFit();
    // Single delayed re-fit to catch CSS layout settling
    const refitTimer1 = setTimeout(debouncedFit, 300);

    // Build WebSocket URL base
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsBase = `${wsProtocol}//${window.location.host}${wsPath}`;

    // Reconnection state (Bugfix #442, #451)
    const rc = {
      lastSeq: 0,
      attempts: 0,
      timer: null as ReturnType<typeof setTimeout> | null,
      disposed: false,
      initialPhase: true,
      initialBuffer: '',
      flushTimer: null as ReturnType<typeof setTimeout> | null,
    };
    const MAX_ATTEMPTS = 50;
    const BACKOFF_CAP_MS = 30_000;

    const filterDA = (text: string): string => {
      text = text.replace(/\x1b\[[\?>][\d;]*c/g, '');
      text = text.replace(/\[[\?>][\d;]*c/g, '');
      return text;
    };

    /** Create a WebSocket connection, optionally resuming from a sequence number. */
    const connect = (resumeSeq?: number) => {
      const wsUrl = resumeSeq !== undefined ? `${wsBase}?resume=${resumeSeq}` : wsBase;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // Reset DA filter state for this connection
      rc.initialPhase = true;
      rc.initialBuffer = '';
      if (rc.flushTimer) { clearTimeout(rc.flushTimer); rc.flushTimer = null; }

      const flushInitialBuffer = () => {
        rc.initialPhase = false;
        rc.flushTimer = null;
        if (rc.initialBuffer) {
          const filtered = filterDA(rc.initialBuffer);
          if (filtered) {
            term.write(filtered, () => { term.scrollToBottom(); });
          }
          rc.initialBuffer = '';
        }
        debouncedFit();
        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            sendControl(wsRef.current, 'resize', { cols: term.cols, rows: term.rows });
          }
          term.scrollToBottom();
        }, 350);
      };

      ws.onopen = () => {
        // Reset reconnection counter on successful connect
        rc.attempts = 0;
        setConnStatus('connected');
        sendControl(ws, 'resize', { cols: term.cols, rows: term.rows });
      };

      ws.onmessage = (event) => {
        const data = new Uint8Array(event.data as ArrayBuffer);
        if (data.length === 0) return;

        const prefix = data[0];
        const payload = data.subarray(1);

        if (prefix === FRAME_DATA) {
          const text = new TextDecoder().decode(payload);
          if (rc.initialPhase) {
            rc.initialBuffer += text;
            if (!rc.flushTimer) {
              rc.flushTimer = setTimeout(flushInitialBuffer, 500);
            }
          } else {
            const filtered = filterDA(text);
            if (filtered) term.write(filtered);
          }
        } else if (prefix === FRAME_CONTROL) {
          // Parse control frames for seq updates (Bugfix #442)
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload));
            if (msg.type === 'seq' && typeof msg.payload?.seq === 'number') {
              rc.lastSeq = msg.payload.seq;
            }
          } catch { /* ignore malformed control frames */ }
        }
      };

      ws.onclose = () => {
        if (rc.disposed) return;

        if (rc.attempts >= MAX_ATTEMPTS) {
          setConnStatus('disconnected');
          return;
        }

        // Start reconnection — status icon in toolbar handles visual feedback
        setConnStatus('reconnecting');

        const delay = Math.min(1000 * Math.pow(2, rc.attempts), BACKOFF_CAP_MS);
        rc.attempts++;
        rc.timer = setTimeout(() => {
          if (rc.disposed) return;
          connect(rc.lastSeq || undefined);
        }, delay);
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — reconnect logic is in onclose
      };
    };

    // Mobile/IME input deduplication (Issue #253, #517)
    //
    // On mobile browsers, all keyboard input goes through IME composition.
    // xterm.js has multiple code paths (keydown, compositionend, input event)
    // that can each fire onData for the same keystroke, causing duplicates.
    //
    // Strategy: Two complementary dedup triggers:
    // 1. Composition tracking — dedup during/after IME composition on ANY
    //    device (catches mobile + desktop CJK input)
    // 2. Touch device detection — always-on dedup for soft keyboard devices
    //    where delayed duplicates can arrive outside the composition window
    //    (e.g. near line wraps). Uses pointer:coarse media query instead of
    //    UA string to correctly detect iPads (iPadOS sends desktop UA).
    //    Tradeoff: iPad + external keyboard would still get dedup, but
    //    default keyboard repeat rates (>250ms) are above the 150ms window.
    const isTouchDevice = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const textarea = term.textarea;
    let isComposing = false;
    let compositionEndTime = 0;
    let lastSentData = '';
    let lastSentTime = 0;

    const onCompositionStart = () => { isComposing = true; };
    const onCompositionEnd = () => {
      isComposing = false;
      compositionEndTime = Date.now();
    };

    if (textarea) {
      textarea.addEventListener('compositionstart', onCompositionStart);
      textarea.addEventListener('compositionend', onCompositionEnd);
    }

    // Send user input to the PTY (uses wsRef so it works across reconnections)
    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Suppress exact duplicate onData calls within 150ms when:
      // - We're in/near an IME composition (composing or <150ms after), OR
      // - This is a touch device (soft keyboard can produce late duplicates)
      const now = Date.now();
      const inCompositionWindow = isComposing || (now - compositionEndTime < 150);
      if ((inCompositionWindow || isTouchDevice) &&
          data === lastSentData && now - lastSentTime < 150) {
        return;
      }
      lastSentData = data;
      lastSentTime = now;

      if (rc.initialPhase) {
        const filtered = data
          .replace(/\x1b\[[\?>][\d;]*c/g, '')
          .replace(/\x1b\[\d+;\d+R/g, '')
          .replace(/\x1b\[\?[\d;]*\$y/g, '');
        if (!filtered) return;
        data = filtered;
      }

      // Sticky modifier handling for mobile virtual keyboard
      const mod = modifierRef.current;
      if ((mod.ctrl || mod.cmd) && data.length === 1) {
        const charCode = data.charCodeAt(0);
        if (mod.ctrl) {
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

    // Send resize events (uses wsRef so it works across reconnections)
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        sendControl(ws, 'resize', { cols, rows });
      }
    });

    // Initial connection
    connect();

    // Handle window resize (debounced to prevent resize storms)
    const resizeObserver = new ResizeObserver(debouncedFit);
    resizeObserver.observe(containerRef.current);

    // Re-fit when browser tab becomes visible again
    const handleVisibility = () => {
      if (!document.hidden) debouncedFit();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      rc.disposed = true;
      if (rc.timer) clearTimeout(rc.timer);
      if (rc.flushTimer) clearTimeout(rc.flushTimer);
      clearTimeout(refitTimer1);
      if (fitTimer) clearTimeout(fitTimer);
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompositionStart);
        textarea.removeEventListener('compositionend', onCompositionEnd);
      }
      decorationManager?.dispose();
      linkProviderDisposable?.dispose();
      containerRef.current?.removeEventListener('paste', onNativePaste);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      wsRef.current?.close();
      term.dispose();
      xtermRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [wsPath]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
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
      <div
        ref={containerRef}
        className="terminal-container"
        style={{
          width: '100%',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          backgroundColor: '#1a1a1a',
        }}
      />
      <TerminalControls fitRef={fitRef} wsRef={wsRef} xtermRef={xtermRef} connStatus={connStatus} />
      {isMobile && (
        <VirtualKeyboard wsRef={wsRef} modifierRef={modifierRef} />
      )}
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
