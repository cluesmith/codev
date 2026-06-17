/**
 * PIR #936: reconnect-loop behavior for CodevPseudoterminal.
 *
 * These tests drive the *real* adapter close-loop — they fire genuine `ws`
 * lifecycle events (`open`/`close`/`error`) at the real `connect()`-registered
 * handlers and advance real timers, asserting the production backoff →
 * give-up → recover sequence. The only mocks are the module boundaries the
 * adapter talks to (the `ws` transport, the `vscode` API, the EscapeBuffer
 * collaborator, the wire-frame constants) — not the logic under test.
 *
 * This is deliberately distinct from the closed PR #937, which tested helper
 * functions in isolation rather than the close-loop, and pulled in `sinon`
 * where Vitest's fake timers suffice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track EscapeBuffer instantiations so we can assert the scheduled reconnect
// resets stream state before re-opening (PR #937 finding 2 / #630).
const hoisted = vi.hoisted(() => ({ escapeBufferCount: 0 }));

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire = (e: T): void => { this.listeners.forEach((l) => l(e)); };
    dispose = (): void => { this.listeners = []; };
  }
  return { EventEmitter: FakeEventEmitter };
});

vi.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 0;
    binaryType = '';
    closed = false;
    sent: unknown[] = [];
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.handlers[event] ||= []).push(cb);
      return this;
    }
    send(data: unknown): void { this.sent.push(data); }
    close(): void { this.closed = true; }
    /** Test helper: synchronously dispatch a lifecycle event to handlers. */
    emit(event: string, ...args: unknown[]): void {
      (this.handlers[event] || []).forEach((cb) => cb(...args));
    }
  }
  return { default: FakeWebSocket };
});

vi.mock('@cluesmith/codev-core/escape-buffer', () => ({
  EscapeBuffer: class {
    constructor() { hoisted.escapeBufferCount++; }
    write(data: string): string { return data; }
    flush(): string { return ''; }
  },
}));

vi.mock('@cluesmith/codev-types', () => ({ FRAME_CONTROL: 0x00, FRAME_DATA: 0x01 }));

const FRAME_CONTROL = 0x00;
const FRAME_DATA = 0x01;

/** Deliver a binary DATA frame to the adapter's `message` handler. */
function sendData(socket: { emit(e: string, ...a: unknown[]): void }, payload: Buffer): void {
  socket.emit('message', Buffer.concat([Buffer.from([FRAME_DATA]), payload]));
}

/** Deliver a binary CONTROL frame (JSON) to the adapter's `message` handler. */
function sendControl(
  socket: { emit(e: string, ...a: unknown[]): void },
  msg: { type: string; payload: Record<string, unknown> },
): void {
  const json = Buffer.from(JSON.stringify(msg), 'utf-8');
  socket.emit('message', Buffer.concat([Buffer.from([FRAME_CONTROL]), json]));
}

/** Extract the resize control frames a fake socket has sent (#1047). */
function sentResizes(socket: { sent: unknown[] }): Array<{ cols: number; rows: number }> {
  return (socket.sent as Buffer[])
    .filter((b) => b[0] === FRAME_CONTROL)
    .map((b) => JSON.parse(b.subarray(1).toString('utf-8')) as { type: string; payload: { cols: number; rows: number } })
    .filter((m) => m.type === 'resize')
    .map((m) => m.payload);
}

// Imports AFTER mocks are registered.
const WebSocket = (await import('ws')).default as unknown as {
  instances: Array<{ closed: boolean; readyState: number; sent: unknown[]; emit(e: string, ...a: unknown[]): void }>;
  OPEN: number;
};
const { CodevPseudoterminal, RECONNECT_LINK_TEXT } = await import('../terminal-adapter.js');

const fakeOutputChannel = () => ({
  name: 'test', append: () => {}, appendLine: () => {}, clear: () => {},
  show: () => {}, hide: () => {}, dispose: () => {}, replace: () => {},
});

// Mirrors REPLAY_SETTLE_MS in terminal-adapter.ts (the replay buffer-and-flush
// debounce window, #1052). Kept in sync by hand; the source value is internal.
const REPLAY_SETTLE_MS_TEST = 150;

/** Latest fake socket the adapter created. */
function currentSocket() {
  return WebSocket.instances[WebSocket.instances.length - 1];
}

function makeAdapter() {
  const writes: string[] = [];
  const pty = new (CodevPseudoterminal as unknown as new (
    url: string, authKey: string | null, ch: unknown,
  ) => {
    open(d: unknown): void;
    reconnect(): void;
    onDidWrite: (cb: (s: string) => void) => void;
  })('ws://localhost:4100/x', null, fakeOutputChannel());
  pty.onDidWrite((s: string) => { if (s) { writes.push(s); } });
  pty.open(undefined);
  return { pty, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
  WebSocket.instances.length = 0;
  hoisted.escapeBufferCount = 0;
});

describe('PIR #936 — adapter-owned reconnect loop', () => {
  it('emits one backed-off notice per close, capping the delay at 30s', () => {
    const { writes } = makeAdapter();
    const expectedDelays = [1, 2, 4, 8, 16, 30];

    for (let attempt = 1; attempt <= expectedDelays.length; attempt++) {
      writes.length = 0;
      currentSocket().emit('close');
      // Exactly one notice fired for this close — not a per-event spam burst.
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain(`retrying in ${expectedDelays[attempt - 1]}s`);
      expect(writes[0]).toContain(`(attempt ${attempt}/6)`);
      // The scheduled retry opens a fresh socket after the backoff elapses.
      const before = WebSocket.instances.length;
      vi.advanceTimersByTime(expectedDelays[attempt - 1] * 1000);
      expect(WebSocket.instances.length).toBe(before + 1);
    }
  });

  it('gives up after the 6th failed attempt and stops scheduling retries', () => {
    const { writes } = makeAdapter();
    // Burn the 6-attempt budget.
    for (let i = 0; i < 6; i++) {
      currentSocket().emit('close');
      vi.advanceTimersByTime(30000);
    }
    writes.length = 0;
    const socketsBefore = WebSocket.instances.length;

    // The 7th close exhausts the budget → give-up state.
    currentSocket().emit('close');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(RECONNECT_LINK_TEXT);
    expect(writes[0]).toContain('\x1b[31m'); // red

    // No further reconnect is scheduled once given up.
    vi.advanceTimersByTime(60000);
    expect(WebSocket.instances.length).toBe(socketsBefore);
  });

  it('gives up immediately on a 4xx upgrade rejection (session unknown)', () => {
    const { writes } = makeAdapter();
    writes.length = 0;

    currentSocket().emit('error', new Error('Unexpected server response: 404'));
    // The matching abnormal close fires right after the error.
    currentSocket().emit('close');

    // One red give-up notice, no yellow "retrying" line, no scheduled retry.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('no longer exists');
    expect(writes[0]).toContain(RECONNECT_LINK_TEXT);
    expect(writes.some((w) => w.includes('retrying'))).toBe(false);
    const sockets = WebSocket.instances.length;
    vi.advanceTimersByTime(60000);
    expect(WebSocket.instances.length).toBe(sockets);
  });

  it('keeps retrying on a 5xx / network error (transient)', () => {
    const { writes } = makeAdapter();
    writes.length = 0;
    currentSocket().emit('error', new Error('Unexpected server response: 502'));
    currentSocket().emit('close');
    // Transient → backoff, not give-up.
    expect(writes[0]).toContain('retrying in 1s');
  });

  it('ignores a stale socket\'s close after an intentional reconnect (identity guard)', () => {
    const { pty, writes } = makeAdapter();
    const stale = currentSocket();

    pty.reconnect();            // closes `stale`, opens a new active socket
    expect(stale.closed).toBe(true);
    writes.length = 0;

    stale.emit('close');        // the old socket's late close event
    // Must not schedule a stray retry against the healthy new connection.
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(5000);
  });

  it('resets decoder + EscapeBuffer before the scheduled reconnect (no stale-byte leak)', () => {
    makeAdapter();
    const baseline = hoisted.escapeBufferCount; // constructed once at init
    currentSocket().emit('close');
    expect(hoisted.escapeBufferCount).toBe(baseline); // not yet — only on the timer
    vi.advanceTimersByTime(1000);
    expect(hoisted.escapeBufferCount).toBe(baseline + 1); // fresh buffer before connect()
  });

  it('resets the backoff chain after a successful reconnect', () => {
    const { writes } = makeAdapter();
    currentSocket().emit('close');           // attempt 1 → 1s
    vi.advanceTimersByTime(1000);            // opens a new socket
    currentSocket().emit('open');            // success — clears loop state
    writes.length = 0;

    currentSocket().emit('close');           // next failure starts fresh
    expect(writes[0]).toContain('retrying in 1s');
    expect(writes[0]).toContain('(attempt 1/6)');
  });

  it('clicking reconnect after give-up starts a fresh chain (reconnect resets state)', () => {
    const { pty, writes } = makeAdapter();
    for (let i = 0; i < 6; i++) { currentSocket().emit('close'); vi.advanceTimersByTime(30000); }
    currentSocket().emit('close'); // give up
    writes.length = 0;

    pty.reconnect();               // the #939 affordance calls this
    currentSocket().emit('close'); // now retries again from the base delay
    expect(writes[0]).toContain('retrying in 1s');
    expect(writes[0]).toContain('(attempt 1/6)');
  });
});

describe('PIR #1001 — reconnect notices overwrite in place and clear on success', () => {
  const ERASE_LINE = '\r\x1b[2K'; // carriage return + erase-entire-line
  const NOTICE_RE = /Connection lost\. retrying/;

  it('overwrites the previous notice in place: each retry erases the line, none stacks', () => {
    const { writes } = makeAdapter();

    for (let attempt = 1; attempt <= 4; attempt++) {
      currentSocket().emit('close');
      const notice = writes[writes.length - 1];
      // Each notice leads with the erase-line sequence and does NOT terminate
      // with a newline — so the next attempt rewrites the same line.
      expect(notice.startsWith(ERASE_LINE)).toBe(true);
      expect(notice.endsWith('\r\n')).toBe(false);
      expect(notice).toContain(`(attempt ${attempt}/6)`);
      vi.advanceTimersByTime(30000);
    }

    // Across the whole cycle every retry notice carried the erase prefix, so no
    // bare (un-erased) notice was ever appended as a fresh scrollback line.
    const retryNotices = writes.filter((w) => NOTICE_RE.test(w));
    expect(retryNotices.length).toBe(4);
    expect(retryNotices.every((w) => w.startsWith(ERASE_LINE))).toBe(true);
  });

  it('wipes the notice line on a successful reconnect (no orphaned scrollback)', () => {
    const { writes } = makeAdapter();
    currentSocket().emit('close');   // one retry notice on the line
    expect(writes.some((w) => NOTICE_RE.test(w))).toBe(true);
    vi.advanceTimersByTime(1000);    // opens a new socket
    writes.length = 0;

    currentSocket().emit('open');    // success → wipe
    // Exactly one erase-line wipe fired, and no retry notice survives after it.
    expect(writes).toContain(ERASE_LINE);
    expect(writes.some((w) => NOTICE_RE.test(w))).toBe(false);
  });

  it('emits no cursor-control wipe on the happy-path first connect', () => {
    const { writes } = makeAdapter();
    writes.length = 0;
    currentSocket().emit('open');    // first connect, no prior notice
    // No notice was ever written, so nothing is wiped.
    expect(writes).not.toContain(ERASE_LINE);
  });

  it('give-up overwrites the last retry notice but is itself never wiped', () => {
    const { writes } = makeAdapter();
    for (let i = 0; i < 6; i++) { currentSocket().emit('close'); vi.advanceTimersByTime(30000); }
    writes.length = 0;

    currentSocket().emit('close');   // 7th close → give up
    expect(writes).toHaveLength(1);
    const giveUp = writes[0];
    expect(giveUp.startsWith(ERASE_LINE)).toBe(true); // overwrote the last retry notice
    expect(giveUp).toContain(RECONNECT_LINK_TEXT);
    expect(giveUp).toContain('\x1b[31m');             // red terminal-failure state

    // A later reconnect must NOT wipe the give-up line: gaveUp blocks the loop,
    // and the give-up cleared hadReconnectNotice. Manually re-open to be sure.
    writes.length = 0;
    currentSocket().emit('open');
    expect(writes).not.toContain(ERASE_LINE);
  });

  it('immediate 4xx give-up has no erase prefix (no retry notice to overwrite)', () => {
    const { writes } = makeAdapter();
    writes.length = 0;
    currentSocket().emit('error', new Error('Unexpected server response: 404'));
    currentSocket().emit('close');

    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith(ERASE_LINE)).toBe(false); // nothing on the line to clear
    expect(writes[0]).toContain('no longer exists');
    expect(writes[0]).toContain(RECONNECT_LINK_TEXT);
  });
});

describe('PIR #1047 — oversized replay storm prevention', () => {
  function reconnectTo(pty: unknown, url: string): void {
    (pty as { reconnect(u?: string): void }).reconnect(url);
  }

  it('renders a >1MB replay (pause-bracketed) without reconnecting', () => {
    const { pty, writes } = makeAdapter();
    currentSocket().emit('open');
    const socketsBefore = WebSocket.instances.length;
    writes.length = 0;

    // Tower brackets the buffer snapshot: pause → (big replay) → resume.
    sendControl(currentSocket(), { type: 'pause', payload: {} });
    sendData(currentSocket(), Buffer.alloc(2 * 1024 * 1024, 0x41)); // 2 MB
    sendControl(currentSocket(), { type: 'resume', payload: {} });
    // The replay is held and painted once after the settle window (#1052);
    // advance past it so flushReplay() paints (first chunk is synchronous).
    vi.advanceTimersByTime(200);

    // No reconnect (the old bug looped here ~14k times), and content rendered.
    expect(WebSocket.instances.length).toBe(socketsBefore);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.join('')).not.toContain(RECONNECT_LINK_TEXT); // did not give up
    void pty;
  });

  it('drops live output over the queue limit instead of reconnecting', () => {
    const { writes } = makeAdapter();
    currentSocket().emit('open');
    const socketsBefore = WebSocket.instances.length;
    writes.length = 0;

    // Not bracketed → treated as live. The old code called reconnect() here.
    sendData(currentSocket(), Buffer.alloc(2 * 1024 * 1024, 0x42)); // 2 MB

    expect(WebSocket.instances.length).toBe(socketsBefore); // dropped, no reconnect
  });

  it('still renders normal-sized live output', () => {
    const { writes } = makeAdapter();
    currentSocket().emit('open');
    writes.length = 0;

    sendData(currentSocket(), Buffer.from('hello world', 'utf-8'));
    expect(writes.join('')).toContain('hello world');
  });

  it('reconnect requests a resume delta from the last seq', () => {
    const { writes } = makeAdapter();
    currentSocket().emit('open');
    writes.length = 0;

    sendControl(currentSocket(), { type: 'seq', payload: { seq: 42 } });
    currentSocket().emit('close');
    vi.advanceTimersByTime(1000); // scheduled reconnect opens a new socket

    expect((currentSocket() as unknown as { url: string }).url).toContain('resume=42');
  });

  it('a successor-session reconnect resets seq and does a full (no-resume) replay', () => {
    const { pty } = makeAdapter();
    currentSocket().emit('open');
    sendControl(currentSocket(), { type: 'seq', payload: { seq: 42 } });

    reconnectTo(pty, 'ws://localhost:4100/successor');

    const url = (currentSocket() as unknown as { url: string }).url;
    expect(url).toContain('/successor');
    expect(url).not.toContain('resume');
  });
});

describe('PIR #1047 — post-connect repaint nudge', () => {
  /** Open the adapter with known dimensions and an OPEN socket so sends record. */
  function makeOpenAdapter(cols: number, rows: number) {
    const { pty, writes } = makeAdapter();
    (pty as unknown as { setDimensions(d: { columns: number; rows: number }): void })
      .setDimensions({ columns: cols, rows: rows });
    const socket = currentSocket();
    socket.readyState = WebSocket.OPEN;
    socket.emit('open');
    return { pty, writes, socket };
  }

  it('forces a redraw nudge (rows-1 then rows) when the pane stays blank after connect', () => {
    const { socket } = makeOpenAdapter(100, 40);
    socket.sent.length = 0; // drop the on-open resize; isolate the nudge

    vi.advanceTimersByTime(500);

    // The nudge is a real size delta then back: 100x39 then 100x40.
    expect(sentResizes(socket)).toEqual([
      { cols: 100, rows: 39 },
      { cols: 100, rows: 40 },
    ]);
  });

  it('skips the nudge when output already rendered during the settle window', () => {
    const { socket } = makeOpenAdapter(100, 40);
    socket.sent.length = 0;

    // Live output arrives before the settle delay → pane is no longer blank.
    sendData(socket, Buffer.from('hello', 'utf-8'));
    vi.advanceTimersByTime(500);

    expect(sentResizes(socket).some((r) => r.rows === 39)).toBe(false);
  });
});

describe('PIR #1052 — forceRepaint on window refocus', () => {
  function makeOpenAdapter(cols: number, rows: number) {
    const { pty, writes } = makeAdapter();
    (pty as unknown as { setDimensions(d: { columns: number; rows: number }): void })
      .setDimensions({ columns: cols, rows: rows });
    const socket = currentSocket();
    socket.readyState = WebSocket.OPEN;
    socket.emit('open');
    return { pty: pty as unknown as { forceRepaint(): void; close(): void }, writes, socket };
  }

  it('forces a redraw nudge (rows-1 then rows) even after output has rendered', () => {
    const { pty, socket } = makeOpenAdapter(100, 40);
    // The pane has already painted (the refocus case): renderedSinceConnect is
    // true, which would suppress the connect-time nudge — but forceRepaint is
    // ungated and must still fire.
    sendData(socket, Buffer.from('hello', 'utf-8'));
    socket.sent.length = 0;

    pty.forceRepaint();

    expect(sentResizes(socket)).toEqual([
      { cols: 100, rows: 39 },
      { cols: 100, rows: 40 },
    ]);
  });

  it('no-ops when the socket is not OPEN', () => {
    const { pty, socket } = makeOpenAdapter(100, 40);
    socket.sent.length = 0;
    socket.readyState = WebSocket.OPEN + 1; // anything but OPEN

    pty.forceRepaint();

    expect(sentResizes(socket)).toEqual([]);
  });

  it('no-ops while a connect-time replay is in flight', () => {
    const { pty, socket } = makeOpenAdapter(100, 40);
    sendControl(socket, { type: 'pause', payload: {} }); // enter replay
    socket.sent.length = 0;

    pty.forceRepaint();

    expect(sentResizes(socket)).toEqual([]);
  });

  it('no-ops after the adapter is disposed', () => {
    const { pty, socket } = makeOpenAdapter(100, 40);
    socket.sent.length = 0;
    pty.close();

    pty.forceRepaint();

    expect(sentResizes(socket)).toEqual([]);
  });
});

describe('PIR #1052 — buffer replay and flush at the settled size', () => {
  function makeOpenAdapter(cols: number, rows: number) {
    const { pty, writes } = makeAdapter();
    (pty as unknown as { setDimensions(d: { columns: number; rows: number }): void })
      .setDimensions({ columns: cols, rows: rows });
    const socket = currentSocket();
    socket.readyState = WebSocket.OPEN;
    socket.emit('open');
    return { pty: pty as unknown as { setDimensions(d: { columns: number; rows: number }): void }, writes, socket };
  }

  it('holds the replay until the settle window elapses, then paints it once', () => {
    const { writes, socket } = makeOpenAdapter(100, 40);
    writes.length = 0;

    sendControl(socket, { type: 'pause', payload: {} });
    sendData(socket, Buffer.from('REPLAYED', 'utf-8'));
    sendControl(socket, { type: 'resume', payload: {} });

    // Nothing painted yet — the replay is held.
    expect(writes.join('')).toBe('');

    vi.advanceTimersByTime(REPLAY_SETTLE_MS_TEST);
    expect(writes.join('')).toContain('REPLAYED');
  });

  it('paints at the final width when the size changes during the hold', () => {
    const { pty, writes, socket } = makeOpenAdapter(100, 40);
    writes.length = 0;

    sendControl(socket, { type: 'pause', payload: {} });
    sendData(socket, Buffer.from('FRAME', 'utf-8'));
    sendControl(socket, { type: 'resume', payload: {} }); // arms settle flush

    // Size settles to a new width mid-hold; the flush must wait for it and then
    // size the PTY to the final dimensions before painting.
    socket.sent.length = 0;
    pty.setDimensions({ columns: 116, rows: 41 });
    expect(writes.join('')).toBe(''); // still held

    vi.advanceTimersByTime(REPLAY_SETTLE_MS_TEST);
    expect(writes.join('')).toContain('FRAME');
    expect(sentResizes(socket)).toContainEqual({ cols: 116, rows: 41 });
  });

  it('a size change resets the debounce so the paint waits for quiet', () => {
    const { pty, writes, socket } = makeOpenAdapter(100, 40);
    writes.length = 0;

    sendControl(socket, { type: 'pause', payload: {} });
    sendData(socket, Buffer.from('X', 'utf-8'));
    sendControl(socket, { type: 'resume', payload: {} });

    // Keep nudging the size just under the settle window — the flush keeps waiting.
    vi.advanceTimersByTime(REPLAY_SETTLE_MS_TEST - 10);
    pty.setDimensions({ columns: 101, rows: 40 });
    vi.advanceTimersByTime(REPLAY_SETTLE_MS_TEST - 10);
    expect(writes.join('')).toBe(''); // still held — debounce reset

    vi.advanceTimersByTime(REPLAY_SETTLE_MS_TEST);
    expect(writes.join('')).toContain('X');
  });

  it('holds live output that arrives before the flush, preserving order', () => {
    const { writes, socket } = makeOpenAdapter(100, 40);
    writes.length = 0;

    sendControl(socket, { type: 'pause', payload: {} });
    sendData(socket, Buffer.from('HISTORY', 'utf-8'));
    sendControl(socket, { type: 'resume', payload: {} });
    // Live output arrives during the hold window — must be buffered after the
    // replay, not painted ahead of it.
    sendData(socket, Buffer.from('-LIVE', 'utf-8'));

    vi.advanceTimersByTime(REPLAY_SETTLE_MS_TEST);
    expect(writes.join('')).toBe('HISTORY-LIVE');
  });
});

