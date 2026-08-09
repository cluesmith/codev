import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PtySession, type PtySessionConfig } from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';
import { capRingSeed, RING_SEED_MAX_BYTES } from '../../agent-farm/servers/tower-terminals.js';
import { classifyAgentScreen } from '../../agent-farm/servers/mailbox-wiring.js';
import { CLAUDE_PROFILE } from '../../agent-farm/servers/gate-profiles.js';

/**
 * Fix E (#1047): attachShellper must be idempotent — re-attaching a session to
 * a new shellper client must drop the listeners it installed on the previous
 * client, so a reconnect can't accumulate duplicate `data` listeners that each
 * re-run onPtyData for every PTY byte (the listener-leak the hardening targets).
 */

function makeFakeClient(): IShellperClient & { connectedState: boolean } {
  const emitter = new EventEmitter() as unknown as IShellperClient & { connectedState: boolean };
  // attachShellper reads client.lastDataAt and subscribes data/exit/close.
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  // #1198: PtySession.writable and write() consult the client's connection
  // state; the fake models it with a mutable flag.
  emitter.connectedState = true;
  Object.defineProperty(emitter, 'connected', { get: () => emitter.connectedState });
  emitter.write = () => emitter.connectedState;
  emitter.resize = () => emitter.connectedState;
  return emitter;
}

function makeSession(): PtySession {
  const config: PtySessionConfig = {
    id: 'sess-1',
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

describe('PtySession.attachShellper idempotency (#1047 Fix E)', () => {
  it('removes listeners from the previous client on re-attach', () => {
    const session = makeSession();
    const clientA = makeFakeClient();
    const clientB = makeFakeClient();

    session.attachShellper(clientA, Buffer.alloc(0), 1234);
    expect(clientA.listenerCount('data')).toBe(1);

    // Re-attach to a new client (a reconnect): A's listeners must be dropped.
    session.attachShellper(clientB, Buffer.alloc(0), 5678);
    expect(clientA.listenerCount('data')).toBe(0);
    expect(clientA.listenerCount('exit')).toBe(0);
    expect(clientA.listenerCount('close')).toBe(0);
    expect(clientB.listenerCount('data')).toBe(1);
  });

  it('a data frame on the detached client no longer reaches the ring buffer', () => {
    const session = makeSession();
    const clientA = makeFakeClient();
    const clientB = makeFakeClient();

    session.attachShellper(clientA, Buffer.alloc(0), 1234);
    session.attachShellper(clientB, Buffer.alloc(0), 5678);

    const seqBefore = session.ringBuffer.currentSeq;
    clientA.emit('data', Buffer.from('stale\n', 'utf-8')); // from the old client
    expect(session.ringBuffer.currentSeq).toBe(seqBefore); // ignored

    clientB.emit('data', Buffer.from('fresh\n', 'utf-8')); // from the live client
    expect(session.ringBuffer.currentSeq).toBe(seqBefore + 1);
  });

  it('does not drop listeners when re-attaching the same client instance', () => {
    const session = makeSession();
    const clientA = makeFakeClient();

    session.attachShellper(clientA, Buffer.alloc(0), 1234);
    session.attachShellper(clientA, Buffer.alloc(0), 1234); // same instance
    // Guard only fires for a *different* client, so this is a no-op re-subscribe
    // path; the session stays attached and functional.
    expect(clientA.listenerCount('data')).toBeGreaterThanOrEqual(1);
  });
});

describe('PtySession disk-log handle on re-attach (#1198)', () => {
  it('does not reopen the disk log when a recovery re-attach arrives', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-attach-log-'));
    const config: PtySessionConfig = {
      id: 'sess-log',
      command: '',
      args: [],
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      env: {},
      label: 'test',
      logDir,
      diskLogEnabled: true,
    };
    const session = new PtySession(config);
    const openSpy = vi.spyOn(fs, 'openSync');
    const logOpens = () => openSpy.mock.calls.filter((c) => String(c[0]).startsWith(logDir)).length;

    try {
      session.attachShellper(makeFakeClient(), Buffer.alloc(0), 1234);
      expect(logOpens()).toBe(1);

      // In-place recovery delivers a replacement client. Before the guard,
      // this leaked one append handle per reconnect.
      session.attachShellper(makeFakeClient(), Buffer.alloc(0), 1234);
      expect(logOpens()).toBe(1);

      // After a real teardown the handle is closed, so a fresh attach must
      // reopen it.
      session.detachShellper();
      session.attachShellper(makeFakeClient(), Buffer.alloc(0), 1234);
      expect(logOpens()).toBe(2);
    } finally {
      openSpy.mockRestore();
      session.detachShellper();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe('PtySession.writable (#1198)', () => {
  it('reflects the shellper client connection state, not just session status', () => {
    const session = makeSession();
    const client = makeFakeClient();
    session.attachShellper(client, Buffer.alloc(0), 1234);

    expect(session.writable).toBe(true);
    expect(session.write('reaches the pty')).toBe(true);

    // The connection dies but the session still reports status 'running':
    // this is exactly the zombie state the getter exists to expose.
    client.connectedState = false;
    expect(session.status).toBe('running');
    expect(session.writable).toBe(false);
    expect(session.write('dropped')).toBe(false);
    expect(session.resize(100, 50)).toBe(false);
  });

  it('is false with no backing client', () => {
    const session = makeSession();
    expect(session.writable).toBe(false);
    expect(session.write('nowhere')).toBe(false);
  });
});

describe('PtySession.attachShellper adopt-path gate seed (Spec 1313 round 2, fail-safe HOLD — #1361)', () => {
  // Counterpart to the render-gate production-path CLEAN test: there the mirror is fed the WHOLE live
  // stream, so the live-ring tear is gone. Here we pin the ADOPT/reconnect path — tower-terminals
  // reconcile (:775) and reconnect (:1034) cap the shellper replay to the last 1 MiB via the real
  // `capRingSeed` BEFORE `attachShellper` seeds the gate mirror with it. A long-lived alt-screen frame
  // whose coherent start predates that 1 MiB tail is seeded born-torn, so the gate HOLDS (busy) —
  // fail-safe: mail is delayed, never fused onto a non-empty screen — until the agent's next repaint
  // or a viewer's post-connect nudge heals the mirror. This is PRE-EXISTING (before round 2 the
  // whole-ring gate classified this same capped seed), not a round-2 regression; the residual liveness
  // gap is deferred as #1361. Pin the HOLD so no future change can silently turn a torn adopt seed into
  // a false-CLEAN misdelivery.
  const FIXTURE_DIR = fileURLToPath(new URL('../../agent-farm/__tests__/fixtures/gate', import.meta.url));
  const loadGz = (name: string): string => gunzipSync(fs.readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');

  function makeSessionAt(cols: number, rows: number): PtySession {
    return new PtySession({
      id: 'adopt-1', command: '', args: [], cols, rows, cwd: '/tmp', env: {},
      label: 'test', logDir: '/tmp', diskLogEnabled: false,
    });
  }

  // Both captures are IDLE empty-composer screens (TRUE verdict CLEAN) each > 1 MiB, so capRingSeed
  // drops their coherent front → the seeded mirror is torn. (Empirically the 1 MiB tail classifies
  // busy/no-composer-marker for bigring and busy/no-region-end for bgtask.)
  for (const file of ['claude-bigring-empty.replay.bin.gz', 'claude-bgtask-empty.replay.bin.gz']) {
    it(`${file}: real capRingSeed(>1MiB) → attachShellper seeds a torn mirror → gate HOLDS busy`, async () => {
      const full = Buffer.from(loadGz(file), 'utf8');
      expect(full.length).toBeGreaterThan(RING_SEED_MAX_BYTES); // crosses the 1 MiB adopt-seed cap

      const seed = capRingSeed(full, 'adopt-1'); // the REAL cap → last 1 MiB, coherent front dropped
      expect(seed.length).toBe(RING_SEED_MAX_BYTES);

      const session = makeSessionAt(139, 65); // the captures' geometry
      session.attachShellper(makeFakeClient(), seed, 1234); // seeds ring + gate mirror with the capped tail

      // The seeded mirror has no coherent composer frame → fail-safe HOLD, never a CLEAN delivery.
      const verdict = await classifyAgentScreen(session, CLAUDE_PROFILE);
      expect(verdict).toMatchObject({ clean: false, reason: 'busy' });

      session.detachShellper(); // disposes the gate mirror (cleanupShellper)
    });
  }
});
