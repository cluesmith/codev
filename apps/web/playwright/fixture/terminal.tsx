/**
 * The dashboard's real Terminal component against a PTY stand-in: a fake
 * WebSocket that records every data frame and echoes it like a line editor
 * (DEL erases one character). Tests read `window.__pty`.
 */
import { createRoot } from 'react-dom/client';
import { Terminal } from '../../src/components/Terminal.js';

const FRAME_DATA = 0x01;
const DEL = '\x7f';

const pty = { frames: [] as string[], line: '', submitted: [] as string[] };
(window as unknown as { __pty: typeof pty }).__pty = pty;

function dataFrame(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const frame = new Uint8Array(1 + encoded.length);
  frame[0] = FRAME_DATA;
  frame.set(encoded, 1);
  return frame.buffer;
}

class FakePtySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakePtySocket.OPEN;
  binaryType = 'arraybuffer';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor() {
    setTimeout(() => {
      this.onopen?.(new Event('open'));
      this.echo('$ ');
    }, 0);
  }

  send(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== FRAME_DATA) return;
    const text = new TextDecoder().decode(bytes.subarray(1));
    pty.frames.push(text);
    let echo = '';
    for (const ch of Array.from(text)) {
      if (ch === DEL) {
        if (pty.line) {
          pty.line = Array.from(pty.line).slice(0, -1).join('');
          echo += '\b \b';
        }
      } else if (ch === '\r') {
        pty.submitted.push(pty.line);
        pty.line = '';
        echo += '\r\n$ ';
      } else {
        pty.line += ch;
        echo += ch;
      }
    }
    if (echo) this.echo(echo);
  }

  close(): void {
    this.readyState = FakePtySocket.CLOSED;
  }

  private echo(text: string): void {
    setTimeout(() => this.onmessage?.({ data: dataFrame(text) }), 0);
  }
}

(window as unknown as { WebSocket: unknown }).WebSocket = FakePtySocket;

createRoot(document.getElementById('root')!).render(<Terminal wsPath="/ws/terminal/fixture" />);
