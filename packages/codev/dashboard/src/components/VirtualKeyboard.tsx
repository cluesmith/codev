import { useState, useEffect, useCallback } from 'react';

/** WebSocket frame prefix for data frames (must match Terminal.tsx). */
const FRAME_DATA = 0x01;

export interface ModifierState {
  ctrl: boolean;
  cmd: boolean;
  clearCallback: (() => void) | null;
}

interface VirtualKeyboardProps {
  wsRef: React.RefObject<WebSocket | null>;
  modifierRef: React.RefObject<ModifierState>;
}

/** Encode and send a data frame directly via WebSocket (avoids bracketed paste). */
function sendRawKey(ws: WebSocket | null, key: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const encoded = new TextEncoder().encode(key);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_DATA;
  frame.set(encoded, 1);
  ws.send(frame.buffer);
}

/**
 * Virtual modifier key buttons for mobile terminals.
 * Renders Esc, Tab, Ctrl (sticky), Cmd (sticky) above the terminal.
 * Uses onPointerDown with preventDefault to avoid stealing focus from xterm.
 */
export function VirtualKeyboard({ wsRef, modifierRef }: VirtualKeyboardProps) {
  const [activeModifier, setActiveModifier] = useState<'ctrl' | 'cmd' | null>(null);

  useEffect(() => {
    modifierRef.current.clearCallback = () => setActiveModifier(null);
    return () => { modifierRef.current.clearCallback = null; };
  }, [modifierRef]);

  const handleEsc = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    sendRawKey(wsRef.current, '\x1b');
  }, [wsRef]);

  const handleTab = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    sendRawKey(wsRef.current, '\t');
  }, [wsRef]);

  const handleCtrl = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const next = activeModifier === 'ctrl' ? null : 'ctrl';
    setActiveModifier(next);
    modifierRef.current.ctrl = next === 'ctrl';
    modifierRef.current.cmd = false;
  }, [activeModifier, modifierRef]);

  const handleCmd = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const next = activeModifier === 'cmd' ? null : 'cmd';
    setActiveModifier(next);
    modifierRef.current.cmd = next === 'cmd';
    modifierRef.current.ctrl = false;
  }, [activeModifier, modifierRef]);

  return (
    <div className="virtual-keyboard" role="toolbar" aria-label="Virtual modifier keys">
      <button className="virtual-key" onPointerDown={handleEsc} tabIndex={-1}>Esc</button>
      <button className="virtual-key" onPointerDown={handleTab} tabIndex={-1}>Tab</button>
      <button
        className={`virtual-key virtual-key-modifier${activeModifier === 'ctrl' ? ' virtual-key-active' : ''}`}
        onPointerDown={handleCtrl}
        tabIndex={-1}
        aria-pressed={activeModifier === 'ctrl'}
      >Ctrl</button>
      <button
        className={`virtual-key virtual-key-modifier${activeModifier === 'cmd' ? ' virtual-key-active' : ''}`}
        onPointerDown={handleCmd}
        tabIndex={-1}
        aria-pressed={activeModifier === 'cmd'}
      >Cmd</button>
    </div>
  );
}
