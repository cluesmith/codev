import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

/** WebSocket frame prefixes matching packages/codev/src/terminal/ws-protocol.ts */
const FRAME_CONTROL = 0x00;
const FRAME_DATA = 0x01;

interface TerminalProps {
  /** WebSocket path for the terminal session, e.g. /ws/terminal/<id> */
  wsPath: string;
}

/**
 * Terminal component — renders an xterm.js instance connected to the
 * node-pty backend via WebSocket using the hybrid binary protocol.
 */
export function Terminal({ wsPath }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm.js instance
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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

    // Try WebGL renderer for performance, fall back silently
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // Canvas renderer is fine
    }

    fitAddon.fit();

    // Build WebSocket URL from the relative path
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${wsPath}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

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
        term.write(text);
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

    // Handle window resize
    const handleResize = () => fitAddon.fit();
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
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
