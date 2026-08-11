/**
 * End-to-end wire check for O(screen) replay (PIR #1354): a REAL PTY process
 * paints an alt-screen TUI, a REAL WebSocket client attaches through
 * TerminalManager's upgrade handler, and the replay data frame it receives must
 * render the CURRENT screen — with no resize nudge, which is the acceptance
 * criterion the raw-tail replay could not meet. Frames are parsed with the same
 * emulator family the production clients render with.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { TerminalManager } from '../pty-manager.js';
import { SessionScreen } from '../session-screen.js';
import { decodeFrame } from '../ws-protocol.js';

const COLS = 120;
const ROWS = 30;

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('WS attach serves the O(screen) snapshot (PIR #1354, real PTY + real WS)', () => {
  let manager: TerminalManager;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    manager = new TerminalManager({ workspaceRoot: '/tmp', diskLogEnabled: false, maxSessions: 3 });
    server = http.createServer();
    manager.attachWebSocket(server);
    server.listen(0);
    await once(server, 'listening');
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterEach(async () => {
    manager.shutdown();
    server.close();
  });

  it('a fresh attach to a live alt-screen TUI receives a snapshot that renders the current screen', async () => {
    // A minimal real TUI: enter the alt screen, paint, and stay alive.
    const info = await manager.createSession({
      command: 'bash',
      args: ['-c', 'printf "\\033[?1049h\\033[2J\\033[1;1HHELLO SNAPSHOT TUI\\033[5;3Hstatus: alive"; sleep 30'],
      cols: COLS,
      rows: ROWS,
    });
    const session = manager.getSession(info.id)!;
    // Wait for the paint to reach Tower's mirror (real PTY output is async).
    await until(() => session.bytesWritten > 0);
    await until(() => session.screenBufferType === 'alternate');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${info.id}`);
    const frames: Buffer[] = [];
    ws.on('message', (data: Buffer) => frames.push(Buffer.from(data)));
    await once(ws, 'open');
    await until(() => frames.length > 0);

    // First data frame is the replay payload.
    const dataFrames = frames.map((f) => decodeFrame(f)).filter((f) => f.type === 'data');
    expect(dataFrames.length).toBeGreaterThan(0);
    const replay = (dataFrames[0] as { type: 'data'; data: Buffer }).data.toString('utf-8');

    // O(screen), not O(history); and it must be self-sufficient — render it into a
    // fresh client-side terminal with NO nudge and see the live screen.
    expect(replay.length).toBeLessThan(64 * 1024);
    const clientView = new SessionScreen(COLS, ROWS);
    clientView.feed(replay);
    const { term, rows } = await clientView.read();
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) {
        lines.push(line.translateToString(true));
      } else {
        lines.push('');
      }
    }
    const screen = lines.join('\n');
    expect(screen).toContain('HELLO SNAPSHOT TUI');
    expect(screen).toContain('status: alive');
    expect(clientView.bufferType).toBe('alternate');

    clientView.dispose();
    ws.close();
  }, 15_000);
});
