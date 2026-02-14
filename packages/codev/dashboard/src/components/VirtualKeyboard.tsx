import { useState, useEffect, useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';

export interface ModifierState {
  ctrl: boolean;
  cmd: boolean;
  clearCallback: (() => void) | null;
}

interface VirtualKeyboardProps {
  xtermRef: React.RefObject<Terminal | null>;
  modifierRef: React.RefObject<ModifierState>;
}

/**
 * Virtual modifier key buttons for mobile terminals.
 * Renders Esc, Tab, Ctrl (sticky), Cmd (sticky) above the terminal.
 * Uses onPointerDown with preventDefault to avoid stealing focus from xterm.
 */
export function VirtualKeyboard({ xtermRef, modifierRef }: VirtualKeyboardProps) {
  const [activeModifier, setActiveModifier] = useState<'ctrl' | 'cmd' | null>(null);

  useEffect(() => {
    modifierRef.current.clearCallback = () => setActiveModifier(null);
    return () => { modifierRef.current.clearCallback = null; };
  }, [modifierRef]);

  const handleEsc = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    xtermRef.current?.paste('\x1b');
  }, [xtermRef]);

  const handleTab = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    xtermRef.current?.paste('\t');
  }, [xtermRef]);

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
