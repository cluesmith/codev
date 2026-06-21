/**
 * Tests for the Tower editor + command relay.
 *
 * Scope: the editor relay (wants-position demand gating, position fan-out, scroll
 * pass-through), the command relay (canonical verbs), and the presence-expiry
 * timer that releases editor-position demand when the controller goes away. The
 * module reads NO project files.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import {
  initEditorRelay,
  shutdownEditorRelay,
  markPresence,
  handleWantsPosition,
  handleEditorPosition,
  handleScroll,
  handleCommand,
  type EditorRelayDeps,
} from '../editor-relay.js';

function fakeReq(body: unknown): http.IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
}

function fakeRes(): { statusCode: number; body: string; res: http.ServerResponse } {
  const captured = { statusCode: 0, body: '', res: null as unknown as http.ServerResponse };
  captured.res = {
    writeHead(code: number) {
      captured.statusCode = code;
    },
    end(b?: string) {
      captured.body = b ?? '';
    },
  } as unknown as http.ServerResponse;
  return captured;
}

describe('editor + command relay', () => {
  let broadcast: Mock<EditorRelayDeps['broadcast']>;

  beforeEach(() => {
    broadcast = vi.fn<EditorRelayDeps['broadcast']>();
    initEditorRelay({ broadcast });
  });

  afterEach(() => {
    shutdownEditorRelay();
    vi.restoreAllMocks();
  });

  it('signals the provider only on the 0->1 and 1->0 demand transitions', async () => {
    await handleWantsPosition(fakeReq({ wanted: true }), fakeRes().res);
    await handleWantsPosition(fakeReq({ wanted: true }), fakeRes().res); // second controller: no re-signal
    const wantsCalls = broadcast.mock.calls.filter((c) => c[0] === 'editor-wants-position');
    expect(wantsCalls).toEqual([['editor-wants-position', { wanted: true }]]);

    await handleWantsPosition(fakeReq({ wanted: false }), fakeRes().res); // one left: still wanted
    await handleWantsPosition(fakeReq({ wanted: false }), fakeRes().res); // none left: stop
    const finalWants = broadcast.mock.calls.filter((c) => c[0] === 'editor-wants-position');
    expect(finalWants).toEqual([
      ['editor-wants-position', { wanted: true }],
      ['editor-wants-position', { wanted: false }],
    ]);
  });

  it('fans every editor-position report out as-is (provider already throttles)', async () => {
    await handleEditorPosition(fakeReq({ value: { visibleStart: 0, visibleEnd: 40, totalLines: 500, file: 'a' } }), fakeRes().res);
    await handleEditorPosition(fakeReq({ value: { visibleStart: 5, visibleEnd: 45, totalLines: 500, file: 'a' } }), fakeRes().res);
    await handleEditorPosition(fakeReq({ value: null }), fakeRes().res);

    const posCalls = broadcast.mock.calls.filter((c) => c[0] === 'editor-position');
    expect(posCalls).toHaveLength(3);
    expect(posCalls[0][1]).toMatchObject({ visibleStart: 0 });
    expect(posCalls[2][1]).toBeNull();
  });

  it('passes a scroll request straight through to the provider and acks immediately', async () => {
    const out = fakeRes();
    await handleScroll(fakeReq({ action: 'scrollEditor', to: 'down', by: 'line', value: 3 }), out.res);

    const scrollCall = broadcast.mock.calls.find((c) => c[0] === 'editor-scroll');
    expect(scrollCall).toBeTruthy();
    expect(scrollCall![1]).toEqual({ action: 'scrollEditor', to: 'down', by: 'line', value: 3 });
    expect(JSON.parse(out.body)).toEqual({ ok: true });
  });

  it('broadcasts a canonical verb and rejects a verb-less command', async () => {
    const ok = fakeRes();
    await handleCommand(fakeReq({ verb: 'view-diff', args: ['0809'] }), ok.res);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    expect(broadcast).toHaveBeenLastCalledWith('command', { verb: 'view-diff', args: ['0809'] });

    const bad = fakeRes();
    await handleCommand(fakeReq({}), bad.res);
    expect(bad.statusCode).toBe(400);
  });
});

describe('presence expiry', () => {
  let broadcast: Mock<EditorRelayDeps['broadcast']>;

  beforeEach(() => {
    broadcast = vi.fn<EditorRelayDeps['broadcast']>();
    initEditorRelay({ broadcast });
  });

  afterEach(() => {
    shutdownEditorRelay();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('releases editor-position demand when controller presence goes stale', async () => {
    // A controller wants positions (real timers so the stream body parses cleanly).
    await handleWantsPosition(fakeReq({ wanted: true }), fakeRes().res);

    // Presence starts the expiry timer; advancing past the TTL with no refresh
    // makes it release the demand (broadcasting wants:false) and stop.
    vi.useFakeTimers();
    markPresence();
    vi.advanceTimersByTime(60_000);

    const wants = broadcast.mock.calls.filter((c) => c[0] === 'editor-wants-position');
    expect(wants).toEqual([
      ['editor-wants-position', { wanted: true }],
      ['editor-wants-position', { wanted: false }],
    ]);
  });
});
