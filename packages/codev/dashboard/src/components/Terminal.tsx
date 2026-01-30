import { useEffect, useRef } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { MOBILE_BREAKPOINT, MOBILE_TERMINAL_COLS } from '../lib/constants.js';

interface TerminalProps {
  src: string;
}

/**
 * Terminal component — renders an iframe pointing to the proxied terminal URL.
 * During Phase 2, we use iframes to ttyd (existing backend).
 * Phase 3 will replace this with direct xterm.js + WebSocket.
 */
export function Terminal({ src }: TerminalProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className="terminal-iframe"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        backgroundColor: '#1a1a1a',
      }}
      title="Terminal"
      aria-label="Terminal session"
    />
  );
}
