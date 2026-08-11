/**
 * attachWithReplay routing (PIR #1354) — the shared attach-site decision:
 * snapshot for fresh attaches and alt-screen resumes, delta lines for
 * normal-buffer resumes, raw-ring fallback (with the detection log line) when
 * the snapshot cannot be produced.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachWithReplay } from '../attach-replay.js';
import { PtySession, type PtySessionConfig } from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';

function makeSession(): { session: PtySession; feed: (data: string) => void } {
  const config: PtySessionConfig = {
    id: 'route-1',
    command: '',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp',
    diskLogEnabled: false,
  };
  const session = new PtySession(config);
  const emitter = new EventEmitter() as unknown as IShellperClient;
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  Object.defineProperty(emitter, 'connected', { get: () => true });
  emitter.write = () => true;
  emitter.resize = () => true;
  session.attachShellper(emitter, Buffer.alloc(0), 1234);
  const feed = (data: string): void => {
    (emitter as unknown as EventEmitter).emit('data', Buffer.from(data, 'utf-8'));
  };
  return { session, feed };
}

const nullClient = { send: (): void => undefined };

describe('attachWithReplay (PIR #1354)', () => {
  it('fresh attach serves the snapshot and attaches the client', async () => {
    const { session, feed } = makeSession();
    feed('hello world\r\n');
    const logs: string[] = [];
    const replay = await attachWithReplay(session, nullClient, null, (level, msg) => logs.push(`${level} ${msg}`));
    expect(replay.kind).toBe('snapshot');
    expect(session.clientCount).toBe(1);
    expect(logs.some((l) => l.startsWith('INFO replay-snapshot session=route-1'))).toBe(true);
  });

  it('normal-buffer resume keeps the delta-lines path (no snapshot)', async () => {
    const { session, feed } = makeSession();
    feed('line one\nline two\nline three\n');
    await session.gateScreen!.read();
    const replaySpy = vi.spyOn(session, 'replaySnapshot');
    const replay = await attachWithReplay(session, nullClient, session.ringBuffer.currentSeq - 1, undefined);
    expect(replay).toEqual({ kind: 'lines', lines: ['line three'] });
    expect(replaySpy).not.toHaveBeenCalled();
    expect(session.clientCount).toBe(1);
  });

  it('alternate-buffer resume serves the snapshot (the nudge-dependent case)', async () => {
    const { session, feed } = makeSession();
    feed('shell\r\n\x1b[?1049h\x1b[2J\x1b[1;1HTUI SCREEN');
    await session.gateScreen!.read();
    expect(session.screenBufferType).toBe('alternate');
    const replay = await attachWithReplay(session, nullClient, session.ringBuffer.currentSeq, undefined);
    expect(replay.kind).toBe('snapshot');
    if (replay.kind !== 'snapshot') return;
    expect(replay.data).toContain('TUI SCREEN');
  });

  it('no-mirror falls back to raw attach at INFO (routine, not a desync)', async () => {
    const config: PtySessionConfig = {
      id: 'route-idle', command: '', args: [], cols: 80, rows: 24,
      cwd: '/tmp', env: {}, label: 'test', logDir: '/tmp', diskLogEnabled: false,
    };
    const session = new PtySession(config);
    const logs: string[] = [];
    const replay = await attachWithReplay(session, nullClient, null, (level, msg) => logs.push(`${level} ${msg}`));
    expect(replay).toEqual({ kind: 'lines', lines: [] });
    expect(logs).toEqual(['INFO replay-snapshot-fallback session=route-idle reason=no-mirror bytesWritten=0']);
  });

  it('serialize-error falls back to the raw ring replay with a WARN detection line', async () => {
    const { session, feed } = makeSession();
    feed('recoverable content\n');
    vi.spyOn(session.gateScreen!, 'serialize').mockImplementation(() => {
      throw new Error('desync');
    });
    const logs: string[] = [];
    const replay = await attachWithReplay(session, nullClient, null, (level, msg) => logs.push(`${level} ${msg}`));
    expect(replay.kind).toBe('lines');
    if (replay.kind !== 'lines') return;
    expect(replay.lines).toEqual(['recoverable content']);
    expect(session.clientCount).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(
      `WARN replay-snapshot-fallback session=route-1 reason=serialize-error bytesWritten=${session.bytesWritten} err=desync`,
    );
  });

  it('fallback on an alt-screen resume degrades to the delta path (todays behavior)', async () => {
    const { session, feed } = makeSession();
    feed('\x1b[?1049h\x1b[2J\x1b[1;1Halt content no newlines');
    await session.gateScreen!.read();
    vi.spyOn(session.gateScreen!, 'serialize').mockImplementation(() => {
      throw new Error('desync');
    });
    const replay = await attachWithReplay(session, nullClient, session.ringBuffer.currentSeq, undefined);
    // getSince for a caught-up alt-screen client returns just the partial — exactly today.
    expect(replay.kind).toBe('lines');
  });
});
