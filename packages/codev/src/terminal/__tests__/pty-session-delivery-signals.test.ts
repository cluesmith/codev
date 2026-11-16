import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  PtySession,
  terminalDeliverySignals,
  QUIESCENCE_DEBOUNCE_MS,
  type PtySessionConfig,
} from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';

/**
 * Spec 1313 Phase 5 — fast delivery triggers, emit side.
 *
 * A PtySession announces two occupancy-relevant transitions on the module-singleton
 * `terminalDeliverySignals` bus: `'submit'` when the user presses Enter, and
 * `'quiescence'` when output has been idle for {@link QUIESCENCE_DEBOUNCE_MS}. The
 * mailbox wiring turns these into coalesced, gated drains (covered in
 * send-delivery.test.ts + the wiring's resolveAgentForSession). Here we prove the
 * session emits them correctly — and cheaply: no quiescence timer is armed unless a
 * subscriber is present, so the feature is zero-cost when the drainer is off.
 */

function makeFakeClient(): IShellperClient & { connectedState: boolean } {
  const emitter = new EventEmitter() as unknown as IShellperClient & { connectedState: boolean };
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  emitter.connectedState = true;
  Object.defineProperty(emitter, 'connected', { get: () => emitter.connectedState });
  emitter.write = () => emitter.connectedState;
  emitter.resize = () => emitter.connectedState;
  return emitter;
}

function makeSession(id = 'sess-1'): PtySession {
  const config: PtySessionConfig = {
    id,
    command: '',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp',
    diskLogEnabled: false, // avoid touching the filesystem
  };
  return new PtySession(config);
}

afterEach(() => {
  terminalDeliverySignals.removeAllListeners();
  vi.useRealTimers();
});

describe('PtySession delivery signals (Spec 1313 Phase 5)', () => {
  it("emits 'submit' with the session id when the user presses Enter (stopComposing)", () => {
    const session = makeSession('sess-42');
    const got: string[] = [];
    terminalDeliverySignals.on('submit', (id: string) => got.push(id));

    session.startComposing(); // user typed a draft
    session.stopComposing(); // …then pressed Enter

    expect(got).toEqual(['sess-42']);
  });

  it('handleUserInput tracks composing, writes, and fires submit on Enter (the shared input chokepoint)', () => {
    // Regression guard for the phase-5 review: EVERY live input path (Tower WS +
    // pty-manager server) routes through handleUserInput, so submit detection can't
    // diverge between clients. Here we drive the chokepoint directly.
    const session = makeSession('sess-input');
    const client = makeFakeClient();
    session.attachShellper(client, Buffer.alloc(0), 1);
    const writeSpy = vi.fn(() => true);
    client.write = writeSpy; // spy only post-hydration user-input writes
    const submits: string[] = [];
    terminalDeliverySignals.on('submit', (id: string) => submits.push(id));

    session.handleUserInput('ls -la'); // typing, no newline
    expect(session.composing).toBe(true);
    expect(submits).toEqual([]); // still composing → no submit

    session.handleUserInput('\r'); // Enter
    expect(session.composing).toBe(false);
    expect(submits).toEqual(['sess-input']); // submit fired
    expect(writeSpy).toHaveBeenCalledTimes(2); // both chunks reached the PTY
  });

  it("emits 'quiescence' with the session id once output has been idle for the window", () => {
    vi.useFakeTimers();
    const session = makeSession('sess-q');
    const got: string[] = [];
    terminalDeliverySignals.on('quiescence', (id: string) => got.push(id));

    const client = makeFakeClient();
    session.attachShellper(client, Buffer.alloc(0), 1234);
    client.emit('data', Buffer.from('working…', 'utf-8')); // output → arms the debounce

    expect(got).toEqual([]); // still within the window
    vi.advanceTimersByTime(QUIESCENCE_DEBOUNCE_MS);
    expect(got).toEqual(['sess-q']); // idle long enough → quiesced
  });

  it('re-arms while output keeps flowing, never firing mid-stream, then fires once it settles', () => {
    vi.useFakeTimers();
    const session = makeSession('sess-stream');
    const got: string[] = [];
    terminalDeliverySignals.on('quiescence', (id: string) => got.push(id));
    const client = makeFakeClient();
    session.attachShellper(client, Buffer.alloc(0), 1234);

    client.emit('data', Buffer.from('a', 'utf-8'));
    vi.advanceTimersByTime(QUIESCENCE_DEBOUNCE_MS - 100); // almost quiesced…
    client.emit('data', Buffer.from('b', 'utf-8')); // …but more output resets the idle clock
    vi.advanceTimersByTime(QUIESCENCE_DEBOUNCE_MS - 100);
    expect(got).toEqual([]); // never falsely quiesced mid-stream
    vi.advanceTimersByTime(100); // a full window since the last byte
    expect(got).toEqual(['sess-stream']);
  });

  it('arms no quiescence timer for output that arrived before any subscriber (lazy, zero-cost when off)', () => {
    vi.useFakeTimers();
    const session = makeSession('sess-lazy');
    const client = makeFakeClient();
    session.attachShellper(client, Buffer.alloc(0), 1234);
    client.emit('data', Buffer.from('early', 'utf-8')); // no subscriber yet → nothing armed

    const got: string[] = [];
    terminalDeliverySignals.on('quiescence', (id: string) => got.push(id));
    vi.advanceTimersByTime(QUIESCENCE_DEBOUNCE_MS * 3);
    expect(got).toEqual([]); // a bare subscribe does not back-fill the earlier output

    client.emit('data', Buffer.from('late', 'utf-8')); // now a subscriber exists → arms
    vi.advanceTimersByTime(QUIESCENCE_DEBOUNCE_MS);
    expect(got).toEqual(['sess-lazy']);
  });
});
