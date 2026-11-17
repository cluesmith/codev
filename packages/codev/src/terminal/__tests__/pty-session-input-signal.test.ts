/**
 * PtySession's input observation for the delivery gate (Issue #1473).
 *
 * The gate had no input signal at all: `bytesWritten` counts OUTPUT and `lastDataAt` tracks
 * OUTPUT, so a keystroke was invisible until the TUI happened to echo it. These tests pin the
 * two signals that close that, and — just as importantly — the things that must NOT change:
 * the PTY still receives every byte verbatim, and the delivery's own write moves nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PtySession } from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';

const ESC = '\x1b';
const DA_REPLY = `${ESC}[?1;2c`;

let now = 1_000_000;
const clock = (): number => now;

/**
 * A shellper-backed session, so `write()` reaches a real backend we can inspect without
 * mocking node-pty. The observation point under test is `write()` itself, which is shared by
 * both backends.
 */
function makeSession(id = 'sig-1'): { session: PtySession; ptyWrites: string[]; setConnected(v: boolean): void } {
  const ptyWrites: string[] = [];
  const client = new EventEmitter() as unknown as IShellperClient & { connectedState: boolean };
  client.connectedState = true;
  Object.defineProperty(client, 'lastDataAt', { get: () => now });
  Object.defineProperty(client, 'connected', { get: () => client.connectedState });
  client.write = (data: string) => {
    if (!client.connectedState) return false;
    ptyWrites.push(data);
    return true;
  };
  client.resize = () => client.connectedState;

  const session = new PtySession({
    id,
    command: '',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp',
    diskLogEnabled: false,
    clock,
  });
  session.attachShellper(client, Buffer.alloc(0), 1234);
  return {
    session,
    ptyWrites,
    setConnected: (v: boolean) => {
      client.connectedState = v;
    },
  };
}

describe('PtySession input signal (Issue #1473)', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  describe('inputSeq', () => {
    it('starts at 0 and is monotone across writes', () => {
      const { session } = makeSession();
      expect(session.inputSeq).toBe(0);
      session.write('ab');
      expect(session.inputSeq).toBe(2);
      session.write('cde');
      expect(session.inputSeq).toBe(5);
    });

    it('advances by the chunk length on an external write, and moves lastInputAt', () => {
      const { session } = makeSession();
      now = 2_000_000;
      session.write('hello');
      expect(session.inputSeq).toBe(5);
      expect(session.lastInputAt).toBe(2_000_000);
    });

    it('moves NEITHER signal for a delivery write', () => {
      const { session } = makeSession();
      session.write('typed');
      const seqAfterHuman = session.inputSeq;
      const atAfterHuman = session.lastInputAt;

      now = 9_000_000;
      session.write('[FROM architect]\nbody line\n', 'delivery');
      session.write('\r', 'delivery');

      expect(session.inputSeq).toBe(seqAfterHuman);
      expect(session.lastInputAt).toBe(atAfterHuman);
    });

    it('defaults to counting — an unlabelled write is treated as foreign input', () => {
      // The failure this inversion exists to prevent is a NEW input path that forgets to
      // announce itself. Over-counting is a self-correcting hold; under-counting writes a
      // message onto somebody's draft.
      const { session } = makeSession();
      session.write('x');
      expect(session.inputSeq).toBe(1);
    });

    it('still bumps when the write is DROPPED', () => {
      // The question the gate asks is "did a foreign writer put input at this session?", not
      // "did it land". A dropped write cannot masquerade as `busy` instead of `no-live-pty`
      // either, because the delivery precheck tests `writable` before it tests the token.
      const { session, setConnected } = makeSession();
      setConnected(false);
      const before = session.inputSeq;
      expect(session.write('typed at a dead socket')).toBe(false);
      expect(session.inputSeq).toBeGreaterThan(before);
    });
  });

  describe('terminal replies are filtered out of the signal but NOT out of the PTY', () => {
    it('a DA reply moves neither signal', () => {
      const { session } = makeSession();
      now = 3_000_000;
      session.write(DA_REPLY);
      expect(session.inputSeq).toBe(0);
      expect(session.lastInputAt).toBe(0);
    });

    it('handleUserInput(DA reply) leaves inputSeq unchanged AND writes it to the PTY verbatim', () => {
      // This is the one way the change could break every attached terminal: applications
      // BLOCK waiting on their DA/DSR answers. Signal-only means signal-only.
      const { session, ptyWrites } = makeSession();
      session.handleUserInput(DA_REPLY);
      expect(session.inputSeq).toBe(0);
      expect(ptyWrites).toContain(DA_REPLY);
    });

    it('keeps the human residue of a mixed chunk and still writes the whole chunk', () => {
      const { session, ptyWrites } = makeSession();
      const chunk = `a${ESC}[12;40Rb`;
      session.write(chunk);
      expect(session.inputSeq).toBe(2); // 'a' + 'b'
      expect(ptyWrites).toContain(chunk);
    });

    it('counts a mouse report — a click can change the composer', () => {
      const { session } = makeSession();
      session.write(`${ESC}[<0;10;5M`);
      expect(session.inputSeq).toBeGreaterThan(0);
    });
  });

  describe('handleUserInput still drives composing/submit', () => {
    it('records input and marks composing for a plain keystroke', () => {
      const { session } = makeSession();
      now = 4_000_000;
      session.handleUserInput('h');
      expect(session.composing).toBe(true);
      expect(session.inputSeq).toBe(1);
      expect(session.lastInputAt).toBe(4_000_000);
    });

    it('clears composing on Enter and still counts the Enter as input', () => {
      const { session } = makeSession();
      session.handleUserInput('hi');
      session.handleUserInput('\r');
      expect(session.composing).toBe(false);
      expect(session.inputSeq).toBe(3);
    });
  });

  describe('attachShellper must leave the input signals alone', () => {
    it('preserves inputSeq and lastInputAt across a re-attach', () => {
      // `attachShellper` HYDRATES `_lastDataAt` from the shellper's tracker; the input signals
      // have no such source and must not be reset. This object survives the re-attach, and the
      // gate's verdict memo is keyed on object identity plus the change token — so a counter
      // that fell back to 0 could reproduce an earlier token on the same session and alias a
      // stale CLEAN verdict, while a reset timestamp would erase a still-un-echoed keystroke.
      const { session } = makeSession();
      now = 7_000;
      session.write('typed');
      const seq = session.inputSeq;
      const at = session.lastInputAt;
      expect(seq).toBe(5);

      const replacement = new EventEmitter() as unknown as IShellperClient & { connectedState: boolean };
      replacement.connectedState = true;
      Object.defineProperty(replacement, 'lastDataAt', { get: () => 99_999 });
      Object.defineProperty(replacement, 'connected', { get: () => true });
      replacement.write = () => true;
      replacement.resize = () => true;
      session.attachShellper(replacement, Buffer.alloc(0), 5678);

      expect(session.inputSeq).toBe(seq);
      expect(session.lastInputAt).toBe(at);
      expect(session.lastDataAt).toBe(99_999); // the OUTPUT signal is hydrated, as before
    });
  });

  describe('the operator bypasses stay external', () => {
    it("writeEscapeToSession's ESC counts as input", async () => {
      // An `--escape` changes composer state, so it must count. Pinned so a future refactor
      // cannot quietly tag the operator paths `'delivery'` and stop observing them.
      const { writeEscapeToSession } = await import('../../agent-farm/servers/message-write.js');
      const { session } = makeSession();

      writeEscapeToSession(session, true);

      expect(session.inputSeq).toBe(1);
    });

    it('a bare ^C write counts as input', () => {
      // The delayed `^C` (tower-routes) fires UNATTENDED, with no human standing there — and it
      // counts anyway, because it changes what is on the line.
      const { session } = makeSession();
      session.write('\x03');
      expect(session.inputSeq).toBe(1);
    });
  });

  describe('the injectable clock', () => {
    it('is what lets a fake gate clock and a real PtySession share a time base', () => {
      const { session } = makeSession();
      now = 500;
      session.write('k');
      expect(session.lastInputAt).toBe(500);
      now = 900;
      expect(session.isUserIdle(300)).toBe(true);
      expect(session.isUserIdle(500)).toBe(false);
    });
  });
});
