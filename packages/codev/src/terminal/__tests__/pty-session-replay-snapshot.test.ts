/**
 * PtySession.replaySnapshot (PIR #1354) — the O(screen) viewer-attach payload.
 *
 * Covers the flush-until-quiescent token loop, every fallback reason, the
 * snapshot/live byte-partition property the no-await caller protocol guarantees,
 * and the screenBufferType routing signal the attach sites use to decide
 * snapshot-vs-delta on resume.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PtySession, REPLAY_FLUSH_ATTEMPTS, type PtySessionConfig } from '../pty-session.js';
import { SessionScreen } from '../session-screen.js';
import type { IShellperClient } from '../shellper-client.js';

const COLS = 80;
const ROWS = 24;

function makeFakeClient(): IShellperClient {
  const emitter = new EventEmitter() as unknown as IShellperClient;
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  Object.defineProperty(emitter, 'connected', { get: () => true });
  emitter.write = () => true;
  emitter.resize = () => true;
  return emitter;
}

/** A session backed by a fake shellper client so tests can feed output via 'data' events. */
function makeSession(): { session: PtySession; feed: (data: string) => void } {
  const config: PtySessionConfig = {
    id: 'snap-1',
    command: '',
    args: [],
    cols: COLS,
    rows: ROWS,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp',
    diskLogEnabled: false,
  };
  const session = new PtySession(config);
  const client = makeFakeClient();
  session.attachShellper(client, Buffer.alloc(0), 1234);
  const feed = (data: string): void => {
    (client as unknown as EventEmitter).emit('data', Buffer.from(data, 'utf-8'));
  };
  return { session, feed };
}

/** Render a byte stream in a reference screen and return its viewport text. */
async function screenText(stream: string): Promise<string> {
  const scr = new SessionScreen(COLS, ROWS);
  scr.feed(stream);
  const { term, rows } = await scr.read();
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    if (line) {
      out.push(line.translateToString(true).trimEnd());
    } else {
      out.push('');
    }
  }
  scr.dispose();
  return out.join('\n');
}

describe('PtySession.replaySnapshot (PIR #1354)', () => {
  it('returns a snapshot that renders the same screen as the full byte history', async () => {
    const { session, feed } = makeSession();
    const history = '\x1b[?1049h\x1b[2J\x1b[1;1HTUI CONTENT\x1b[2;1Hline two';
    feed(history);

    const result = await session.replaySnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe(session.bytesWritten);
    expect(await screenText(result.data)).toBe(await screenText(history));
  });

  it('no-mirror: a session that never produced output falls back', async () => {
    const config: PtySessionConfig = {
      id: 'snap-idle', command: '', args: [], cols: COLS, rows: ROWS,
      cwd: '/tmp', env: {}, label: 'test', logDir: '/tmp', diskLogEnabled: false,
    };
    const session = new PtySession(config);
    const result = await session.replaySnapshot();
    expect(result).toEqual({ ok: false, reason: 'no-mirror' });
  });

  it('serialize-error: an addon throw is caught and reported, not propagated', async () => {
    const { session, feed } = makeSession();
    feed('some output\r\n');
    const screen = session.gateScreen;
    expect(screen).not.toBeNull();
    vi.spyOn(screen!, 'serialize').mockImplementation(() => {
      throw new Error('boom');
    });
    const result = await session.replaySnapshot();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('serialize-error');
    expect((result.error as Error).message).toBe('boom');
  });

  it('empty-snapshot: an empty serialization from a non-empty session is the desync canary', async () => {
    const { session, feed } = makeSession();
    feed('some output\r\n');
    vi.spyOn(session.gateScreen!, 'serialize').mockReturnValue('');
    const result = await session.replaySnapshot();
    expect(result).toEqual({ ok: false, reason: 'empty-snapshot' });
  });

  it('flush-timeout: output arriving during every flush exhausts the bounded retries', async () => {
    const { session, feed } = makeSession();
    feed('initial output\r\n');
    const screen = session.gateScreen!;
    const realRead = screen.read.bind(screen);
    const readSpy = vi.spyOn(screen, 'read').mockImplementation(async () => {
      // Simulate output landing while the parser flushes: the token moves.
      feed('drift');
      return realRead();
    });
    const result = await session.replaySnapshot();
    expect(result).toEqual({ ok: false, reason: 'flush-timeout' });
    expect(readSpy).toHaveBeenCalledTimes(REPLAY_FLUSH_ATTEMPTS);
  });

  it('retries once when output lands mid-flush, then succeeds on the quiet pass', async () => {
    const { session, feed } = makeSession();
    feed('first\r\n');
    const screen = session.gateScreen!;
    const realRead = screen.read.bind(screen);
    let drifted = false;
    vi.spyOn(screen, 'read').mockImplementation(async () => {
      if (!drifted) {
        drifted = true;
        feed('late output\r\n');
      }
      return realRead();
    });
    const result = await session.replaySnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The retried snapshot includes the late output — nothing was lost.
    expect(await screenText(result.data)).toContain('late output');
  });

  it('no-mirror when the session is torn down mid-flush', async () => {
    const { session, feed } = makeSession();
    feed('output\r\n');
    const screen = session.gateScreen!;
    const realRead = screen.read.bind(screen);
    vi.spyOn(screen, 'read').mockImplementation(async () => {
      session.detachShellper(); // nulls the mirror (teardown path)
      return realRead();
    });
    const result = await session.replaySnapshot();
    expect(result).toEqual({ ok: false, reason: 'no-mirror' });
  });

  it('byte partition: snapshot + live broadcast after addClient reconstructs the reference screen exactly', async () => {
    const { session, feed } = makeSession();
    const before = '\x1b[?1049h\x1b[2J\x1b[1;1Hframe one';
    const after = '\x1b[2;1Hframe two arrives after attach';
    feed(before);

    const result = await session.replaySnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Caller protocol: same-microtask token re-check, then attach — no await between.
    expect(session.bytesWritten).toBe(result.token);
    let received = '';
    session.addClient({
      send: (data: Buffer | string) => {
        received += data.toString();
      },
    });
    feed(after);

    expect(await screenText(result.data + received)).toBe(await screenText(before + after));
    // And the live bytes were not duplicated into the snapshot.
    expect(received).toBe(after);
  });

  it('screenBufferType: null before output, then tracks normal/alternate', async () => {
    const { session, feed } = makeSession();
    // attachShellper with an empty replay creates no mirror until the first byte.
    expect(session.screenBufferType).toBeNull();
    feed('plain shell output\r\n');
    await session.gateScreen!.read();
    expect(session.screenBufferType).toBe('normal');
    feed('\x1b[?1049h');
    await session.gateScreen!.read();
    expect(session.screenBufferType).toBe('alternate');
    feed('\x1b[?1049l');
    await session.gateScreen!.read();
    expect(session.screenBufferType).toBe('normal');
  });

  it('attach/attachResume still return raw ring replay (the fallback contract is unchanged)', () => {
    const { session, feed } = makeSession();
    feed('line a\nline b\npartial');
    const receivedA: string[] = [];
    const linesA = session.attach({ send: () => receivedA.push('x') });
    expect(linesA).toEqual(['line a', 'line b', 'partial']);
    const linesResume = session.attachResume({ send: () => undefined }, session.ringBuffer.currentSeq - 1);
    expect(linesResume).toEqual(['line b', 'partial']);
  });
});
