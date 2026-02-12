import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { parseFilePath, looksLikeFilePath } from '../lib/filePaths.js';

/** WebSocket frame prefixes matching packages/codev/src/terminal/ws-protocol.ts */
const FRAME_CONTROL = 0x00;
const FRAME_DATA = 0x01;

interface TerminalProps {
  /** WebSocket path for the terminal session, e.g. /ws/terminal/<id> */
  wsPath: string;
  /** Callback when user clicks a file path in terminal output (Spec 0092) */
  onFileOpen?: (path: string, line?: number, column?: number) => void;
}

/**
 * Terminal component — renders an xterm.js instance connected to the
 * node-pty backend via WebSocket using the hybrid binary protocol.
 */
export function Terminal({ wsPath, onFileOpen }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSelectionRef = useRef('');

  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm.js instance
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      customGlyphs: true,
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

    // Spec 0092: Add web links addon for clickable file paths
    if (onFileOpen) {
      const webLinksAddon = new WebLinksAddon(
        (event, uri) => {
          event.preventDefault();
          // Check if it looks like a file path (not a URL)
          if (looksLikeFilePath(uri)) {
            const parsed = parseFilePath(uri);
            onFileOpen(parsed.path, parsed.line, parsed.column);
          } else {
            // For actual URLs, open in new tab
            window.open(uri, '_blank');
          }
        },
        {
          // Enable URL detection (http, https, etc.)
          urlRegex: undefined, // Use default URL regex
        }
      );
      term.loadAddon(webLinksAddon);
    }

    // Clipboard handling
    const isMac = navigator.platform.toUpperCase().includes('MAC');

    // Auto-copy on select: track selection text as it changes during drag,
    // then copy to clipboard on mouseup (which qualifies as user activation
    // for the Clipboard API).
    const selectionDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) lastSelectionRef.current = sel;
    });

    const container = containerRef.current;
    const handleMouseUp = () => {
      const sel = lastSelectionRef.current;
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        lastSelectionRef.current = '';
      }
    };
    container.addEventListener('mouseup', handleMouseUp);

    // Paste: Cmd+V (Mac) or Ctrl+Shift+V (Linux/Windows)
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true;

      const modKey = isMac ? event.metaKey : event.ctrlKey && event.shiftKey;
      if (!modKey) return true;

      if (event.key === 'v' || event.key === 'V') {
        event.preventDefault();
        navigator.clipboard?.readText().then((text) => {
          if (text) term.paste(text);
        }).catch(() => {});
        return false;
      }

      return true;
    });

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

    // Filter DA (Device Attribute) response sequences that tmux echoes as visible
    // text when attaching to an existing session. Buffer the first 500ms of data
    // to catch fragmented DA sequences, then flush and switch to direct writes.
    // Uses a fixed deadline (not reset per frame) so active terminals don't starve.
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

    // Send user input to the PTY
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendData(ws, data);
      }
    });

    // Send resize events
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendControl(ws, 'resize', { cols, rows });
      }
    });

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
      selectionDisposable.dispose();
      container.removeEventListener('mouseup', handleMouseUp);
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
    <div
      ref={containerRef}
      className="terminal-container"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a1a',
      }}
    />
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
